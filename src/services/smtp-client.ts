import * as net from 'net';
import * as os from 'os';
import * as tls from 'tls';
import { randomBytes } from 'crypto';

export interface SmtpMessage {
  host: string;
  port: number;
  from: string;
  to: string[];
  subject: string;
  body: string;
  username?: string;
  password?: string;
  /**
   * When true (the default for any non-loopback relay), the session must be encrypted:
   * implicit TLS on port 465, otherwise STARTTLS. Mail is never sent in cleartext.
   */
  requireTls: boolean;
  timeoutMs?: number;
  /** Extra TLS options; tests use this to trust a local certificate. */
  tlsOptions?: tls.ConnectionOptions;
}

interface SmtpReply {
  code: number;
  lines: string[];
}

/** Address check that also rules out CR/LF and angle brackets, preventing header/command injection. */
export function isSafeEmailAddress(value: string): boolean {
  return (
    /^[^\s@<>()",;:\\]+@[^\s@<>()",;:\\]+\.[^\s@<>()",;:\\]+$/.test(value) && value.length <= 254
  );
}

/** Removes characters that could start a new header line. */
export function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

/** SMTP transparency (RFC 5321 §4.5.2): lines beginning with "." get an extra ".". */
export function dotStuff(body: string): string {
  return body
    .replace(/\r?\n/g, '\r\n')
    .split('\r\n')
    .map((line) => (line.startsWith('.') ? `.${line}` : line))
    .join('\r\n');
}

function ehloName(): string {
  const name = os.hostname().replace(/[^A-Za-z0-9.-]/g, '');
  return name || 'localhost';
}

/** Minimal line-oriented SMTP session over a plain or TLS socket. */
class SmtpSession {
  private buffer = '';
  private pending: string[] = [];
  private waiter?: { resolve: (r: SmtpReply) => void; reject: (e: Error) => void };
  private failure?: Error;

  constructor(private socket: net.Socket | tls.TLSSocket) {
    this.attach(socket);
  }

  private attach(socket: net.Socket | tls.TLSSocket): void {
    socket.on('data', (data: Buffer) => this.onData(data));
    socket.on('error', (err: Error) => this.fail(err));
    socket.on('close', () => this.fail(new Error('SMTP connection closed unexpectedly')));
  }

  private onData(data: Buffer): void {
    this.buffer += data.toString('utf8');
    const lines = this.buffer.split('\r\n');
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      this.pending.push(line);
      // The final line of a reply has a space (or nothing) after the 3-digit code.
      if (/^\d{3}(?: |$)/.test(line)) this.flush();
    }
  }

  private flush(): void {
    if (!this.waiter) return;
    const lines = this.pending;
    this.pending = [];
    const code = parseInt(lines[lines.length - 1]!.slice(0, 3), 10);
    const { resolve } = this.waiter;
    this.waiter = undefined;
    resolve({ code, lines });
  }

  private fail(err: Error): void {
    if (this.failure) return;
    this.failure = err;
    if (this.waiter) {
      const { reject } = this.waiter;
      this.waiter = undefined;
      reject(err);
    }
  }

  read(): Promise<SmtpReply> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject };
      const last = this.pending[this.pending.length - 1];
      if (last && /^\d{3}(?: |$)/.test(last)) this.flush();
    });
  }

  async command(line: string, expected: number[]): Promise<SmtpReply> {
    this.socket.write(`${line}\r\n`);
    const reply = await this.read();
    if (!expected.includes(reply.code)) {
      // Never echo the command: it may contain credentials.
      throw new Error(`SMTP server rejected the request (reply ${reply.code}).`);
    }
    return reply;
  }

  async upgradeToTls(host: string, extra?: tls.ConnectionOptions): Promise<void> {
    const plain = this.socket;
    plain.removeAllListeners('data');
    plain.removeAllListeners('error');
    plain.removeAllListeners('close');
    const secure = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const socket = tls.connect({ socket: plain, servername: host, ...extra }, () =>
        resolve(socket),
      );
      socket.once('error', reject);
    });
    this.socket = secure;
    this.buffer = '';
    this.pending = [];
    this.attach(secure);
  }

  get encrypted(): boolean {
    return this.socket instanceof tls.TLSSocket;
  }

  close(): void {
    this.socket.destroy();
  }
}

function capabilities(reply: SmtpReply): Set<string> {
  return new Set(reply.lines.map((l) => l.slice(4).trim().toUpperCase()));
}

function authMechanisms(caps: Set<string>): Set<string> {
  for (const cap of caps) {
    if (cap.startsWith('AUTH ') || cap.startsWith('AUTH=')) {
      return new Set(cap.slice(5).split(/\s+/).filter(Boolean));
    }
  }
  return new Set();
}

/**
 * Sends one plain-text message. Uses EHLO, implicit TLS on port 465 or STARTTLS otherwise,
 * and optional AUTH PLAIN/LOGIN. Throws sanitized errors that never contain credentials.
 */
export async function sendSmtpMessage(message: SmtpMessage): Promise<void> {
  const { host, port } = message;
  const timeoutMs = message.timeoutMs ?? 20_000;

  for (const address of [message.from, ...message.to]) {
    if (!isSafeEmailAddress(address)) throw new Error('SMTP address is not a valid email address.');
  }
  if (message.to.length === 0) throw new Error('SMTP message has no recipients.');

  const socket =
    port === 465
      ? tls.connect({ host, port, servername: host, ...message.tlsOptions })
      : net.createConnection({ host, port });
  const session = new SmtpSession(socket);
  const timer = setTimeout(() => socket.destroy(new Error('SMTP connection timed out')), timeoutMs);

  try {
    const greeting = await session.read();
    if (greeting.code !== 220)
      throw new Error(`SMTP server greeting failed (reply ${greeting.code}).`);

    const name = ehloName();
    let caps = capabilities(await session.command(`EHLO ${name}`, [250]));

    if (!session.encrypted) {
      if (caps.has('STARTTLS')) {
        await session.command('STARTTLS', [220]);
        await session.upgradeToTls(host, message.tlsOptions);
        caps = capabilities(await session.command(`EHLO ${name}`, [250]));
      } else if (message.requireTls) {
        throw new Error(
          'SMTP server does not offer STARTTLS; refusing to send without encryption.',
        );
      }
    }

    if (message.username) {
      const mechanisms = authMechanisms(caps);
      const user = message.username;
      const pass = message.password ?? '';
      if (mechanisms.has('PLAIN')) {
        const token = Buffer.from(`\u0000${user}\u0000${pass}`, 'utf8').toString('base64');
        await session.command(`AUTH PLAIN ${token}`, [235]);
      } else if (mechanisms.has('LOGIN')) {
        await session.command('AUTH LOGIN', [334]);
        await session.command(Buffer.from(user, 'utf8').toString('base64'), [334]);
        await session.command(Buffer.from(pass, 'utf8').toString('base64'), [235]);
      } else {
        throw new Error('SMTP server does not offer a supported sign-in method (PLAIN or LOGIN).');
      }
    }

    await session.command(`MAIL FROM:<${message.from}>`, [250]);
    for (const recipient of message.to) {
      await session.command(`RCPT TO:<${recipient}>`, [250, 251]);
    }
    await session.command('DATA', [354]);

    const domain = message.from.split('@')[1] ?? name;
    const raw = [
      `From: <${message.from}>`,
      `To: ${message.to.map((t) => `<${t}>`).join(', ')}`,
      `Subject: ${sanitizeHeaderValue(message.subject)}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${randomBytes(12).toString('hex')}@${domain}>`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      dotStuff(message.body),
    ].join('\r\n');
    await session.command(`${raw}\r\n.`, [250]);
    try {
      await session.command('QUIT', [221]);
    } catch {
      // The message was accepted; a missing QUIT reply is harmless.
    }
  } finally {
    clearTimeout(timer);
    session.close();
  }
}
