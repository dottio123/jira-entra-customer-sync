import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FastifyInstance } from 'fastify';
import { createWebApp } from '../../src/web/app';
import { loadWebConfig, WebConfig } from '../../src/web/config';
import { WebStore } from '../../src/web/store';

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

describe('/schedule web route boundaries', () => {
  let directory: string;
  let config: WebConfig;
  let app: FastifyInstance | undefined;
  let adminCookie: string;
  let adminCsrf: string;

  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-route-test-'));
    config = loadWebConfig(
      {
        NODE_ENV: 'test',
        PUBLIC_BASE_URL: 'http://127.0.0.1:8080',
        WEB_DATA_DIR: path.join(directory, 'data'),
        WEB_SECRETS_DIR: path.join(directory, 'secrets'),
        ADMIN_USERNAME: 'operator',
        ADMIN_INITIAL_PASSWORD: initialPassword,
      },
      directory,
    );

    app = await createWebApp({
      config,
      assetRoot: path.resolve(process.cwd(), 'src/web'),
      startScheduler: false,
    });

    const host = new URL(config.publicBaseUrl).host;

    // Sign in
    const loginPage = await app.inject({
      method: 'GET',
      url: '/login',
      headers: { host },
    });
    const loginCsrfCookie = setCookie(loginPage, 'sync_login_csrf');
    const loginRes = await app.inject({
      method: 'POST',
      url: '/login',
      headers: {
        host,
        cookie: loginCsrfCookie,
        origin: config.publicBaseUrl,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams({
        _csrf: csrf(loginPage.body),
        username: 'operator',
        password: initialPassword,
      }).toString(),
    });

    const sessionCookie = setCookie(loginRes, 'sync_session');

    // Change password to satisfy mustChangePassword
    const pwPage = await app.inject({
      method: 'GET',
      url: '/password',
      headers: { host, cookie: sessionCookie },
    });
    const pwChangeRes = await app.inject({
      method: 'POST',
      url: '/password',
      headers: {
        host,
        cookie: sessionCookie,
        origin: config.publicBaseUrl,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams({
        _csrf: csrf(pwPage.body),
        currentPassword: initialPassword,
        newPassword: 'NewValidPassword123!',
        confirmPassword: 'NewValidPassword123!',
      }).toString(),
    });

    const activeCookie = setCookie(pwChangeRes, 'sync_session');

    // Obtain active session cookie and CSRF token for /schedule
    const schedulePage = await app.inject({
      method: 'GET',
      url: '/schedule',
      headers: { host, cookie: activeCookie },
    });
    expect(schedulePage.statusCode).toBe(200);
    adminCookie = activeCookie;
    adminCsrf = csrf(schedulePage.body);
  });

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('renders the schedule page with current cron and human-readable description', async () => {
    const host = new URL(config.publicBaseUrl).host;
    const res = await app!.inject({
      method: 'GET',
      url: '/schedule',
      headers: { host, cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Schedule &amp; safety limits');
    expect(res.body).toContain('0 2 * * *');
    expect(res.body).toContain('Every day at 2:00 AM');
  });

  it('updates schedule cron and safety ceilings when valid parameters are submitted', async () => {
    const host = new URL(config.publicBaseUrl).host;
    const res = await app!.inject({
      method: 'POST',
      url: '/schedule',
      headers: {
        host,
        cookie: adminCookie,
        origin: config.publicBaseUrl,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams({
        _csrf: adminCsrf,
        schedule_cron: '30 3 * * *',
        max_customers_threshold: '150',
        max_fields_threshold: '500',
      }).toString(),
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/schedule?message=saved');

    // Verify persisted settings in SQLite store
    const store = new WebStore(path.join(config.dataDir, 'web.sqlite'));
    const settings = store.getSettings();
    store.close();

    expect(settings.schedule_cron).toBe('30 3 * * *');
    expect(settings.max_customers_threshold).toBe(150);
    expect(settings.max_fields_threshold).toBe(500);
  });

  it('rejects unsupported interval cron expressions with descriptive validation error', async () => {
    const host = new URL(config.publicBaseUrl).host;
    const res = await app!.inject({
      method: 'POST',
      url: '/schedule',
      headers: {
        host,
        cookie: adminCookie,
        origin: config.publicBaseUrl,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams({
        _csrf: adminCsrf,
        schedule_cron: '*/15 * * * *',
        max_customers_threshold: '100',
        max_fields_threshold: '400',
      }).toString(),
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('/schedule?error=');
    expect(decodeURIComponent(res.headers.location!)).toContain(
      'Interval or multi-execution schedules',
    );
  });

  it('rejects unauthenticated requests to GET and POST /schedule', async () => {
    const host = new URL(config.publicBaseUrl).host;
    const unauthGet = await app!.inject({
      method: 'GET',
      url: '/schedule',
      headers: { host },
    });
    expect(unauthGet.statusCode).toBe(302);
    expect(unauthGet.headers.location).toBe('/login');

    const unauthPost = await app!.inject({
      method: 'POST',
      url: '/schedule',
      headers: {
        host,
        origin: config.publicBaseUrl,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams({
        _csrf: 'fake',
        schedule_cron: '0 2 * * *',
      }).toString(),
    });
    expect(unauthPost.statusCode).toBe(302);
    expect(unauthPost.headers.location).toBe('/login');
  });
});
