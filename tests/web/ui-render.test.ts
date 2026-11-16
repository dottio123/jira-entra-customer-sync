import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FastifyInstance } from 'fastify';
import { createWebApp } from '../../src/web/app';
import { loadWebConfig, WebConfig } from '../../src/web/config';
import { SystemSettings, WebStore } from '../../src/web/store';
import { OAuthTokenStore } from '../../src/connectors/jira';

const initialPassword = 'bootstrap-password-123';
const digest = 'a'.repeat(64);

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

function expectCspSafe(html: string): void {
  // The CSP is `style-src 'self'; script-src 'self'`, so inline styles and handlers never apply.
  expect(html).not.toMatch(/\sstyle="/);
  expect(html).not.toMatch(/\son[a-z]+="/);
  expect(html).not.toMatch(/<script>(?!\s*<\/script>)/);
}

describe('web UI rendering', () => {
  let directory: string;
  let config: WebConfig;
  let app: FastifyInstance | undefined;
  let cookie: string;
  let host: string;

  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-render-test-'));
    config = loadWebConfig(
      {
        NODE_ENV: 'test',
        PUBLIC_BASE_URL: 'http://127.0.0.1:8080',
        WEB_DATA_DIR: path.join(directory, 'data'),
        WEB_SECRETS_DIR: path.join(directory, 'secrets'),
        ADMIN_USERNAME: 'operator',
        ADMIN_INITIAL_PASSWORD: initialPassword,
        JSM_SERVICE_DESK_IDS: '1',
        JIRA_WRITE_SCOPE_ALLOWED: 'true',
      },
      directory,
    );
    app = await createWebApp({
      config,
      assetRoot: path.resolve(process.cwd(), 'src/web'),
      startScheduler: false,
    });
    host = new URL(config.publicBaseUrl).host;

    const loginPage = await app.inject({ method: 'GET', url: '/login', headers: { host } });
    expectCspSafe(loginPage.body);
    const loginRes = await app.inject({
      method: 'POST',
      url: '/login',
      headers: {
        host,
        cookie: setCookie(loginPage, 'sync_login_csrf'),
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
    const pwPage = await app.inject({
      method: 'GET',
      url: '/password',
      headers: { host, cookie: sessionCookie },
    });
    expectCspSafe(pwPage.body);
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
    cookie = setCookie(pwChangeRes, 'sync_session');
  });

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
    fs.rmSync(directory, { recursive: true, force: true });
  });

  async function get(url: string) {
    const res = await app!.inject({ method: 'GET', url, headers: { host, cookie } });
    expect(res.statusCode).toBe(200);
    return res.body;
  }

  function seedPreview(settings: Partial<SystemSettings>): { previewId: number; failedId: number } {
    const store = new WebStore(
      path.join(config.dataDir, 'web.sqlite'),
      undefined,
      undefined,
      config.secretsDir,
    );
    try {
      store.updateSettings(settings, null);
      const previewId = store.createRun({
        runType: 'PREVIEW',
        triggerSource: 'MANUAL',
        scopeServiceDeskIds: ['1'],
      });
      store.updateRun(previewId, {
        status: 'COMPLETED',
        completedAt: Date.now(),
        previewDigest: digest,
        totalCustomersEnumerated: 3,
        uniqueCustomers: 3,
        matchedEntraCustomers: 1,
        skippedCustomers: 2,
        proposedCustomerChanges: 1,
        proposedFieldChanges: 1,
        details: {
          proposedChanges: [
            {
              customerRef: 'ref-1234567890abcdef',
              customerEmail: 'person@example.com',
              displayName: 'Pat Person',
              changedFields: [{ fieldName: 'title', oldValue: null, newValue: 'Analyst' }],
            },
          ],
          skippedRecords: [
            {
              customerRef: 'ref-2',
              customerEmail: 'other@example.net',
              reason: 'DOMAIN_NOT_APPROVED',
              description: 'Domain outside scope',
            },
            { customerRef: 'ref-3', reason: 'EMAIL_UNAVAILABLE', description: 'No email' },
          ],
        },
      });
      const failedId = store.createRun({
        runType: 'LIVE_ROLLOUT',
        triggerSource: 'MANUAL',
        scopeServiceDeskIds: ['1'],
        previewRunId: previewId,
        approvalDigest: digest,
      });
      store.updateRun(failedId, {
        status: 'FAILED',
        completedAt: Date.now(),
        failureReason: 'PREFLIGHT_DRIFT_DETECTED',
      });
      return { previewId, failedId };
    } finally {
      store.close();
    }
  }

  it('renders every page without inline styles or inline scripts', async () => {
    const { previewId, failedId } = seedPreview({});
    for (const url of [
      '/overview',
      '/runs',
      `/runs/${previewId}`,
      `/runs/${failedId}`,
      '/schedule',
      '/settings',
      '/connections',
      '/password',
    ]) {
      expectCspSafe(await get(url));
    }
  });

  it('starts the Atlassian sign-in from a link in a new tab, not a form', async () => {
    const connections = await get('/connections');
    // Without OAuth client configuration the button is shown disabled.
    expect(connections).toContain('type="button" disabled');
    expect(connections).not.toContain('action="/auth/atlassian/start"');
  });

  it('serves the app logo and vendor logos from the app itself with correct types', async () => {
    for (const [url, type] of [
      ['/assets/logo.svg', 'image/svg+xml'],
      ['/assets/brands/jira.webp', 'image/webp'],
      ['/assets/brands/microsoft.webp', 'image/webp'],
    ]) {
      const res = await app!.inject({ method: 'GET', url: url!, headers: { host } });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain(type!);
    }
    const overview = await get('/overview');
    expect(overview).toContain('class="app-logo"');
    expect(overview).toContain('data-theme-toggle');
    expect(overview).toContain('theme-icon-system');
  });

  it('uses plain-language labels while keeping technical codes available', async () => {
    const { previewId, failedId } = seedPreview({});
    const overview = await get('/overview');
    expect(overview).toContain('1 customer has updates ready for review');
    expect(overview).toContain('Updates to Jira: Off');

    const detail = await get(`/runs/${previewId}`);
    expect(detail).toContain('Job title');
    expect(detail).toContain('Email domain not included');
    expect(detail).toContain('DOMAIN_NOT_APPROVED');
    expect(detail).toContain('person@example.com');
    expect(detail).toContain('Updates can’t be applied yet');
    expect(detail).not.toContain('name="approvalDigest"');

    const failed = await get(`/runs/${failedId}`);
    expect(failed).toContain('Stopped safely');
    expect(failed).toContain('PREFLIGHT_DRIFT_DETECTED');

    // Update runs don't enumerate customers, so history shows a dash rather than 0.
    const history = await get('/runs');
    expect(history).toContain('data-label="Customers checked" class="num">—</td>');
    expect(history).toContain('data-label="Customers checked" class="num">3</td>');
  });

  function saveJiraConnection(scopes: string[]): void {
    const now = new Date().toISOString();
    new OAuthTokenStore({
      tokenPath: config.tokenPath,
      allowedDir: config.secretsDir,
    }).writeTokenRecord({
      schemaVersion: 1,
      tokenType: 'Bearer',
      accessToken: 'access',
      refreshToken: 'refresh',
      accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      scopes,
      createdAt: now,
      updatedAt: now,
    });
  }

  it('asks to reconnect Jira instead of offering approval when the write permission is missing', async () => {
    saveJiraConnection(config.oauthScopes.filter((s) => !s.startsWith('write:')));
    const { previewId } = seedPreview({
      commissioning_status: 'COMMISSIONED_MANUAL_ONLY',
      writes_enabled: true,
    });
    const detail = await get(`/runs/${previewId}`);
    expect(detail).toContain('Jira has not granted permission to update customer details');
    expect(detail).not.toContain('action="/runs/approve"');
    const connections = await get('/connections');
    expect(connections).toContain('Update permission');
    expect(connections).toContain('Choose Reconnect Jira below');
  });

  it('shows the approval form only when updates are allowed, with the digest pattern intact', async () => {
    saveJiraConnection(config.oauthScopes);
    const { previewId } = seedPreview({
      commissioning_status: 'COMMISSIONED_MANUAL_ONLY',
      writes_enabled: true,
    });
    const detail = await get(`/runs/${previewId}`);
    expect(detail).toContain('action="/runs/approve"');
    expect(detail).toContain(`name="previewRunId" value="${previewId}"`);
    expect(detail).toContain(`name="approvalDigest"`);
    expect(detail).toContain(`value="${digest}"`);
    expect(detail).toContain('pattern="^[a-f0-9]{64}$"');
    expect(detail).toContain('Updates to Jira: On — needs approval');
  });
});
