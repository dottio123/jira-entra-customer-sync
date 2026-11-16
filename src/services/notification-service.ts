import { WebStore } from '../web/store';
import { isLoopbackHost } from '../web/config';
import { Logger, logger } from '../utils/logger';
import { USER_AGENT } from '../version';
import { DEFAULT_SMTP_PORT } from '../web/defaults';
import { SmtpMessage, sendSmtpMessage } from './smtp-client';
import { errorMessage, sanitizeFailureReason } from './run-support';

export interface NotificationPayload {
  severity: 'INFO' | 'WARN' | 'ERROR';
  title: string;
  message: string;
  runId?: number | null;
  runType?: string;
  status?: string;
  totalCustomers?: number;
  proposedChanges?: number;
  verifiedChanges?: number;
}

export interface NotificationServiceOptions {
  fetchFn?: typeof fetch;
  log?: Logger;
  /** Replaces SMTP delivery; used by tests. */
  smtpSender?: (message: SmtpMessage) => Promise<void>;
  webhookTimeoutMs?: number;
}

/** Splits a comma/semicolon/whitespace-separated recipient list. */
export function parseRecipients(value: string | undefined): string[] {
  return (value ?? '')
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Records every alert in the dashboard and, when enabled, forwards it by webhook and email.
 * Payloads carry counts and run references only: never customer identities, field values,
 * or credentials. Delivery failures are logged and never thrown.
 */
export class NotificationService {
  private readonly fetchFn: typeof fetch;
  private readonly log: Logger;
  private readonly smtpSender: (message: SmtpMessage) => Promise<void>;
  private readonly webhookTimeoutMs: number;

  constructor(
    private readonly store: WebStore,
    options?: NotificationServiceOptions,
  ) {
    this.fetchFn = options?.fetchFn ?? fetch;
    this.log = options?.log ?? logger;
    this.smtpSender = options?.smtpSender ?? sendSmtpMessage;
    this.webhookTimeoutMs = options?.webhookTimeoutMs ?? 10_000;
  }

  async notify(payload: NotificationPayload): Promise<void> {
    try {
      this.store.createAlert(payload.severity, payload.title, payload.message, payload.runId);
    } catch (err) {
      this.log.error('Failed to create in-dashboard alert', { error: errorMessage(err) });
    }

    const settings = this.store.getSettings();

    if (settings.webhook_enabled && settings.webhook_url) {
      await this.sendWebhook(settings.webhook_url, payload);
    }

    if (settings.smtp_enabled && settings.smtp_host && settings.smtp_to) {
      await this.sendEmail(settings, payload);
    }
  }

  private async sendWebhook(url: string, payload: NotificationPayload): Promise<void> {
    try {
      const body = {
        timestamp: new Date().toISOString(),
        severity: payload.severity,
        title: payload.title,
        message: payload.message,
        runId: payload.runId ?? null,
        runType: payload.runType ?? null,
        status: payload.status ?? null,
        totalCustomers: payload.totalCustomers ?? null,
        proposedChanges: payload.proposedChanges ?? null,
        verifiedChanges: payload.verifiedChanges ?? null,
      };

      const response = await this.fetchFn(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': `${USER_AGENT} (alerts)`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.webhookTimeoutMs),
      });

      if (!response.ok) {
        this.log.warn('Webhook notification returned non-2xx status', {
          statusCode: response.status,
        });
      }
    } catch (err) {
      this.log.error('Webhook notification dispatch failed', {
        error: sanitizeFailureReason(errorMessage(err)),
      });
    }
  }

  private async sendEmail(
    settings: ReturnType<WebStore['getSettings']>,
    payload: NotificationPayload,
  ): Promise<void> {
    const host = settings.smtp_host!;
    const from = settings.smtp_from;
    const to = parseRecipients(settings.smtp_to);
    if (!from || to.length === 0) {
      this.log.warn('Email alert skipped: sender or recipient address is not configured');
      return;
    }

    const body = [
      `Severity: ${payload.severity}`,
      `Title: ${payload.title}`,
      `Message: ${payload.message}`,
      payload.runId ? `Run ID: ${payload.runId}` : '',
      payload.runType ? `Run type: ${payload.runType}` : '',
      payload.status ? `Status: ${payload.status}` : '',
      payload.proposedChanges !== undefined ? `Proposed changes: ${payload.proposedChanges}` : '',
      payload.verifiedChanges !== undefined ? `Verified changes: ${payload.verifiedChanges}` : '',
      '',
      'This is an automated notification. Customer identities and field values are never included.',
    ]
      .filter((line) => line !== '')
      .join('\r\n');

    try {
      await this.smtpSender({
        host,
        port: settings.smtp_port ?? DEFAULT_SMTP_PORT,
        from,
        to,
        subject: `[Sync alert - ${payload.severity}] ${payload.title}`,
        body,
        username: settings.smtp_username,
        password: settings.smtp_username ? this.store.getSmtpPassword() : undefined,
        requireTls: !isLoopbackHost(host),
      });
    } catch (err) {
      this.log.error('SMTP notification dispatch failed', {
        error: sanitizeFailureReason(errorMessage(err)),
      });
    }
  }
}
