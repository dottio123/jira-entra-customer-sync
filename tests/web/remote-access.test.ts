import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FastifyInstance } from 'fastify';
import { createWebApp } from '../../src/web/app';
import { loadWebConfig, WebConfig } from '../../src/web/config';

const initialPassword = 'bootstrap-password-123';

function setCookie(response: { headers: Record<string, unknown> }, name: string): string {
  const values = response.headers['set-cookie'];
  const list = Array.isArray(values) ? values : [values];
  const entry = list.find((value) => typeof value === 'string' && value.startsWith(`${name}=`));
  if (!entry || typeof entry !== 'string') throw new Error(`Missing ${name} cookie`);
  return entry.split(';')[0]!;
}

function csrf(html: string): string {
  const match = html.match(/name="_csrf" value="([a-f0-9]{64})"/);
  if (!match) throw new Error('CSRF token not found');
  return match[1]!;
}

describe('remote access and proxy boundaries', () => {
  let directory: string;
  let config: WebConfig;
  let app: FastifyInstance | undefined;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-access-test-'));
    config = loadWebConfig(
      {
        NODE_ENV: 'test',
        PUBLIC_BASE_URL: 'http://10.20.30.40:8080',
        ALLOW_INSECURE_REMOTE_HTTP: 'true',
        WEB_DATA_DIR: path.join(directory, 'data'),
        WEB_SECRETS_DIR: path.join(directory, 'secrets'),
        ADMIN_USERNAME: 'operator',
        ADMIN_INITIAL_PASSWORD: initialPassword,
        ATLASSIAN_OAUTH_REDIRECT_URI: 'http://10.20.30.40:8080/auth/atlassian/callback',
      },
      directory,
    );
  });

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('permits access from LAN IP, localhost, and 127.0.0.1 on the service port', async () => {
    app = await createWebApp({
      config,
      assetRoot: path.resolve(process.cwd(), 'src/web'),
      startScheduler: false,
    });

    // 1. LAN IP (configured public base URL)
    const lanPage = await app.inject({
      method: 'GET',
      url: '/login',
      headers: { host: '10.20.30.40:8080' },
    });
    expect(lanPage.statusCode).toBe(200);

    // 2. localhost loopback
    const localhostPage = await app.inject({
      method: 'GET',
      url: '/login',
      headers: { host: 'localhost:8080' },
    });
    expect(localhostPage.statusCode).toBe(200);

    // 3. 127.0.0.1 loopback
    const loopbackPage = await app.inject({
      method: 'GET',
      url: '/login',
      headers: { host: '127.0.0.1:8080' },
    });
    expect(loopbackPage.statusCode).toBe(200);
  });

  it('rejects unauthorized hosts and redirects to the configured base URL', async () => {
    app = await createWebApp({
      config,
      assetRoot: path.resolve(process.cwd(), 'src/web'),
      startScheduler: false,
    });

    const unauthorized = await app.inject({
      method: 'GET',
      url: '/login',
      headers: { host: 'unauthorized.example.com:8080' },
    });
    expect(unauthorized.statusCode).toBe(302);
    expect(unauthorized.headers.location).toBe('http://10.20.30.40:8080/login');
  });

  it('accepts form submissions matching publicBaseUrl or loopback origins, and rejects external origins', async () => {
    app = await createWebApp({
      config,
      assetRoot: path.resolve(process.cwd(), 'src/web'),
      startScheduler: false,
    });

    const page = await app.inject({
      method: 'GET',
      url: '/login',
      headers: { host: '10.20.30.40:8080' },
    });
    const headers = {
      cookie: setCookie(page, 'sync_login_csrf'),
      'content-type': 'application/x-www-form-urlencoded',
    };
    const payload = new URLSearchParams({
      _csrf: csrf(page.body),
      username: 'operator',
      password: initialPassword,
    }).toString();

    // Rejected: foreign origin
    const rejected = await app.inject({
      method: 'POST',
      url: '/login',
      headers: { ...headers, origin: 'http://malicious.example.com' },
      payload,
    });
    expect(rejected.statusCode).toBe(303);
    expect(rejected.headers.location).toBe('http://10.20.30.40:8080/login');

    // Accepted: LAN IP origin
    const acceptedLan = await app.inject({
      method: 'POST',
      url: '/login',
      headers: { ...headers, origin: 'http://10.20.30.40:8080' },
      payload,
    });
    expect(acceptedLan.statusCode).toBe(302);
    expect(acceptedLan.headers.location).toBe('/password');
  });

  it('enforces HTTPS for remote/LAN IPs unless ALLOW_INSECURE_REMOTE_HTTP is set', () => {
    // Missing flag throws
    expect(() =>
      loadWebConfig({
        NODE_ENV: 'production',
        PUBLIC_BASE_URL: 'http://10.20.30.40:8080',
      }),
    ).toThrow('ALLOW_INSECURE_REMOTE_HTTP=true');

    // Explicit flag allows plain HTTP on remote IP for testing
    const testConfig = loadWebConfig({
      NODE_ENV: 'production',
      PUBLIC_BASE_URL: 'http://10.20.30.40:8080',
      ALLOW_INSECURE_REMOTE_HTTP: 'true',
    });
    expect(testConfig.allowInsecureRemoteHttp).toBe(true);
    expect(testConfig.secureCookies).toBe(false);

    // HTTPS works without any flag
    const httpsConfig = loadWebConfig({
      NODE_ENV: 'production',
      PUBLIC_BASE_URL: 'https://sync.example.com',
    });
    expect(httpsConfig.secureCookies).toBe(true);
  });

  it('ignores X-Forwarded-Host unless trustProxy is enabled', async () => {
    // Untrusted
    config.trustProxy = false;
    app = await createWebApp({
      config,
      assetRoot: path.resolve(process.cwd(), 'src/web'),
      startScheduler: false,
    });
    const untrusted = await app.inject({
      method: 'GET',
      url: '/login',
      headers: {
        host: '10.20.30.40:8080',
        'x-forwarded-host': 'spoofed.example.com',
      },
    });
    expect(untrusted.statusCode).toBe(200);
    await app.close();

    // Trusted
    config.trustProxy = true;
    config.publicBaseUrl = 'https://sync.example.com';
    app = await createWebApp({
      config,
      assetRoot: path.resolve(process.cwd(), 'src/web'),
      startScheduler: false,
    });
    const trusted = await app.inject({
      method: 'GET',
      url: '/login',
      headers: {
        host: '10.0.0.1:8080',
        'x-forwarded-host': 'sync.example.com',
      },
    });
    expect(trusted.statusCode).toBe(200);
  });
});
