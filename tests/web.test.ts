import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FastifyInstance } from 'fastify';
import { createWebApp } from '../src/web/app';
import { isLoopbackHost, loadWebConfig, WebConfig } from '../src/web/config';

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

describe('web control plane', () => {
  let directory: string;
  let config: WebConfig;
  let app: FastifyInstance | undefined;
  let clock: number;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'customer-sync-web-'));
    clock = Date.now();
    config = loadWebConfig(
      {
        NODE_ENV: 'test',
        PUBLIC_BASE_URL: 'http://127.0.0.1:8080',
        WEB_DATA_DIR: path.join(directory, 'data'),
        WEB_SECRETS_DIR: path.join(directory, 'secrets'),
        ADMIN_USERNAME: 'operator',
        ADMIN_INITIAL_PASSWORD: initialPassword,
        ATLASSIAN_OAUTH_CLIENT_ID: 'test-client',
        ATLASSIAN_OAUTH_CLIENT_SECRET: 'test-secret',
        ATLASSIAN_OAUTH_REDIRECT_URI: 'http://127.0.0.1:8080/auth/atlassian/callback',
        ROLLOUT_WRITE_ENABLED: 'true',
        JSM_SERVICE_DESK_IDS: '1',
      },
      directory,
    );
  });

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
    fs.rmSync(directory, { recursive: true, force: true });
  });

  async function start(oauthFetchFn?: typeof fetch): Promise<FastifyInstance> {
    app = await createWebApp({
      config,
      now: () => clock,
      oauthFetchFn,
      assetRoot: path.join(process.cwd(), 'src/web'),
    });
    return app;
  }

  async function login(): Promise<{ cookie: string; csrfToken: string }> {
    const server = app!;
    const page = await server.inject({
      method: 'GET',
      url: '/login',
      headers: { host: new URL(config.publicBaseUrl).host },
    });
    const loginCookie = setCookie(page, 'sync_login_csrf');
    const response = await server.inject({
      method: 'POST',
      url: '/login',
      headers: { cookie: loginCookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        _csrf: csrf(page.body),
        username: 'operator',
        password: initialPassword,
      }).toString(),
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/password');
    return { cookie: setCookie(response, 'sync_session'), csrfToken: csrf(page.body) };
  }

  async function completePasswordChange(): Promise<{ cookie: string; csrfToken: string }> {
    const first = await login();
    const page = await app!.inject({
      method: 'GET',
      url: '/password',
      headers: { cookie: first.cookie },
    });
    const token = csrf(page.body);
    const response = await app!.inject({
      method: 'POST',
      url: '/password',
      headers: { cookie: first.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        _csrf: token,
        currentPassword: initialPassword,
        newPassword: 'updated-password-456',
        confirmPassword: 'updated-password-456',
      }).toString(),
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/overview');
    const cookie = setCookie(response, 'sync_session');
    const overview = await app!.inject({ method: 'GET', url: '/overview', headers: { cookie } });
    expect(overview.statusCode).toBe(200);
    return { cookie, csrfToken: csrf(overview.body) };
  }

  it('protects, validates, and persists the approved domain settings form across restart', async () => {
    let server = await start();
    expect(
      (await server.inject({ method: 'POST', url: '/settings/domains', payload: {} })).headers
        .location,
    ).toBe('/login');
    const current = await completePasswordChange();
    const save = (domains: string, token = current.csrfToken) =>
      server.inject({
        method: 'POST',
        url: '/settings/domains',
        headers: { cookie: current.cookie, 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({ _csrf: token, approved_email_domains: domains }).toString(),
      });
    expect((await save('example.com', 'wrong')).statusCode).toBe(403);
    expect((await save('*.example.com')).statusCode).toBe(400);
    expect((await save('EXAMPLE.ORG,example.com\nexample.org')).statusCode).toBe(302);
    await server.close();
    server = await start();
    const page = await server.inject({
      method: 'GET',
      url: '/settings',
      headers: { cookie: current.cookie },
    });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('example.com\nexample.org</textarea>');
    expect(page.body).toContain('An empty list blocks previews and writes');
  });

  it('bootstraps an admin, requires a password change, and protects pages', async () => {
    const server = await start();
    expect((await server.inject('/health/live')).json()).toEqual({ status: 'alive' });
    expect((await server.inject('/health/ready')).json()).toEqual({ status: 'ready' });
    expect((await server.inject('/overview')).headers.location).toBe('/login');
    const first = await login();
    expect(
      (
        await server.inject({
          method: 'GET',
          url: '/connections',
          headers: { cookie: first.cookie },
        })
      ).headers.location,
    ).toBe('/password');
    const changed = await completePasswordChange();
    expect(
      (
        await server.inject({
          method: 'GET',
          url: '/connections',
          headers: { cookie: changed.cookie },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await server.inject({ method: 'POST', url: '/runs', headers: { cookie: changed.cookie } }))
        .statusCode,
    ).toBe(404);
  });

  it('accepts login from the configured browser origin and rejects a different origin', async () => {
    const server = await start();
    const page = await server.inject({
      method: 'GET',
      url: '/login',
      headers: { host: new URL(config.publicBaseUrl).host },
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
    const rejected = await server.inject({
      method: 'POST',
      url: '/login',
      headers: { ...headers, origin: 'http://malicious.example.com' },
      payload,
    });
    expect(rejected.statusCode).toBe(303);
    expect(rejected.headers.location).toBe(`${config.publicBaseUrl}/login`);
    const accepted = await server.inject({
      method: 'POST',
      url: '/login',
      headers: { ...headers, origin: config.publicBaseUrl },
      payload,
    });
    expect(accepted.statusCode).toBe(302);
    expect(accepted.headers.location).toBe('/password');
  });

  it('redirects a login page opened through an unauthorized host to the configured URL', async () => {
    const server = await start();
    const page = await server.inject({
      method: 'GET',
      url: '/login',
      headers: { host: 'unauthorized.example.com:8080' },
    });
    expect(page.statusCode).toBe(302);
    expect(page.headers.location).toBe(`${config.publicBaseUrl}/login`);
  });

  it('accepts login and navigation through localhost and 127.0.0.1 loopback hosts', async () => {
    const server = await start();
    const localhostPage = await server.inject({
      method: 'GET',
      url: '/login',
      headers: { host: 'localhost:8080' },
    });
    expect(localhostPage.statusCode).toBe(200);

    const loopbackIpPage = await server.inject({
      method: 'GET',
      url: '/login',
      headers: { host: '127.0.0.1:8080' },
    });
    expect(loopbackIpPage.statusCode).toBe(200);

    const headers = {
      cookie: setCookie(localhostPage, 'sync_login_csrf'),
      'content-type': 'application/x-www-form-urlencoded',
    };
    const payload = new URLSearchParams({
      _csrf: csrf(localhostPage.body),
      username: 'operator',
      password: initialPassword,
    }).toString();

    // Origin localhost:8080 accepted
    const acceptedLocalhost = await server.inject({
      method: 'POST',
      url: '/login',
      headers: { ...headers, origin: 'http://localhost:8080', host: 'localhost:8080' },
      payload,
    });
    expect(acceptedLocalhost.statusCode).toBe(302);
    expect(acceptedLocalhost.headers.location).toBe('/password');

    // Origin 127.0.0.1:8080 accepted
    const accepted127 = await server.inject({
      method: 'POST',
      url: '/login',
      headers: { ...headers, origin: 'http://127.0.0.1:8080', host: '127.0.0.1:8080' },
      payload,
    });
    expect(accepted127.statusCode).toBe(302);
    expect(accepted127.headers.location).toBe('/password');
  });

  it('shows a useful rate-limit response instead of masking it as an internal error', async () => {
    const server = await start();
    const page = await server.inject({
      method: 'GET',
      url: '/login',
      headers: { host: new URL(config.publicBaseUrl).host },
    });
    const headers = {
      cookie: setCookie(page, 'sync_login_csrf'),
      origin: config.publicBaseUrl,
      'content-type': 'application/x-www-form-urlencoded',
    };
    const payload = new URLSearchParams({
      _csrf: csrf(page.body),
      username: 'operator',
      password: 'incorrect-password',
    }).toString();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await server.inject({ method: 'POST', url: '/login', headers, payload });
      expect(response.statusCode).toBe(302);
    }
    const limited = await server.inject({ method: 'POST', url: '/login', headers, payload });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
    expect(limited.body).toContain('Too many sign-in attempts.');
    expect(limited.body).not.toContain('An internal error occurred.');
  });

  it('rejects missing CSRF and expires idle sessions', async () => {
    const server = await start();
    const current = await completePasswordChange();
    const denied = await server.inject({
      method: 'POST',
      url: '/logout',
      headers: { cookie: current.cookie },
    });
    expect(denied.statusCode).toBe(403);
    clock += 31 * 60 * 1000;
    const expired = await server.inject({
      method: 'GET',
      url: '/overview',
      headers: { cookie: current.cookie },
    });
    expect(expired.headers.location).toBe('/login');
  });

  it('escapes white-label text and never prints secrets in HTML', async () => {
    config.displayName = '<script>alert(1)</script>';
    const server = await start();
    const loginPage = await server.inject({
      url: '/login',
      headers: { host: new URL(config.publicBaseUrl).host },
    });
    expect(loginPage.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(loginPage.body).not.toContain('<script>alert(1)</script>');
    const current = await completePasswordChange();
    const connections = await server.inject({
      method: 'GET',
      url: '/connections',
      headers: { cookie: current.cookie },
    });
    expect(connections.body).not.toContain('test-secret');
    expect(connections.body).not.toContain('bootstrap-password-123');
  });

  it('completes browser OAuth once and keeps the token after restart', async () => {
    const oauthFetchFn = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            access_token: 'fake-access-token',
            refresh_token: 'fake-refresh-token',
            token_type: 'Bearer',
            expires_in: 3600,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    ) as typeof fetch;
    const server = await start(oauthFetchFn);
    const current = await completePasswordChange();
    const started = await server.inject({
      method: 'POST',
      url: '/auth/atlassian/start',
      headers: { cookie: current.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ _csrf: current.csrfToken }).toString(),
    });
    expect(started.statusCode).toBe(303);
    const connectionsPage = await server.inject({
      method: 'GET',
      url: '/connections',
      headers: { cookie: current.cookie },
    });
    expect(connectionsPage.headers['content-security-policy']).toContain(
      "form-action 'self' https://auth.atlassian.com",
    );
    expect(started.headers['content-security-policy']).toContain(
      "form-action 'self' https://auth.atlassian.com",
    );
    const overviewPage = await server.inject({
      method: 'GET',
      url: '/overview',
      headers: { cookie: current.cookie },
    });
    expect(overviewPage.headers['content-security-policy']).toContain("form-action 'self';");
    expect(overviewPage.headers['content-security-policy']).not.toContain(
      'https://auth.atlassian.com',
    );
    const authorize = new URL(String(started.headers.location));
    expect(authorize.origin).toBe('https://auth.atlassian.com');
    expect(authorize.searchParams.get('redirect_uri')).toBe(config.callbackUrl);
    const state = authorize.searchParams.get('state')!;
    const completed = await server.inject({
      method: 'GET',
      url: `/auth/atlassian/callback?state=${state}&code=fake-code`,
      headers: { cookie: current.cookie },
    });
    expect(completed.headers.location).toBe('/connections?message=connected');
    expect(oauthFetchFn).toHaveBeenCalledTimes(1);
    const replay = await server.inject({
      method: 'GET',
      url: `/auth/atlassian/callback?state=${state}&code=fake-code`,
      headers: { cookie: current.cookie },
    });
    expect(replay.statusCode).toBe(400);
    await server.close();
    app = undefined;
    const restarted = await start();
    const connections = await restarted.inject({
      method: 'GET',
      url: '/connections',
      headers: { cookie: current.cookie },
    });
    expect(connections.body).toContain('Authorized');
    expect(connections.body).not.toContain('fake-access-token');
  });

  it('rejects callbacks without the originating session or after state expiry', async () => {
    const server = await start();
    const current = await completePasswordChange();
    const started = await server.inject({
      method: 'POST',
      url: '/auth/atlassian/start',
      headers: { cookie: current.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ _csrf: current.csrfToken }).toString(),
    });
    const state = new URL(String(started.headers.location)).searchParams.get('state')!;
    const missingSession = await server.inject({
      method: 'GET',
      url: `/auth/atlassian/callback?state=${state}&code=x`,
    });
    expect(missingSession.statusCode).toBe(403);
    clock += 6 * 60 * 1000;
    const expired = await server.inject({
      method: 'GET',
      url: `/auth/atlassian/callback?state=${state}&code=x`,
      headers: { cookie: current.cookie },
    });
    expect(expired.statusCode).toBe(400);
  });

  it('binds OAuth state to the initiating administrator session', async () => {
    const server = await start();
    const current = await completePasswordChange();
    const started = await server.inject({
      method: 'POST',
      url: '/auth/atlassian/start',
      headers: { cookie: current.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ _csrf: current.csrfToken }).toString(),
    });
    const state = new URL(String(started.headers.location)).searchParams.get('state')!;
    const page = await server.inject({
      url: '/login',
      headers: { host: new URL(config.publicBaseUrl).host },
    });
    const secondLogin = await server.inject({
      method: 'POST',
      url: '/login',
      headers: {
        cookie: setCookie(page, 'sync_login_csrf'),
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams({
        _csrf: csrf(page.body),
        username: 'operator',
        password: 'updated-password-456',
      }).toString(),
    });
    const wrongSession = await server.inject({
      method: 'GET',
      url: `/auth/atlassian/callback?state=${state}&code=x`,
      headers: { cookie: setCookie(secondLogin, 'sync_session') },
    });
    expect(wrongSession.statusCode).toBe(400);
  });

  it('invalidates an earlier OAuth attempt when a new one starts', async () => {
    const server = await start();
    const current = await completePasswordChange();
    async function begin(): Promise<string> {
      const response = await server.inject({
        method: 'POST',
        url: '/auth/atlassian/start',
        headers: { cookie: current.cookie, 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({ _csrf: current.csrfToken }).toString(),
      });
      return new URL(String(response.headers.location)).searchParams.get('state')!;
    }
    const firstState = await begin();
    const secondState = await begin();
    expect(firstState).not.toBe(secondState);
    const oldCallback = await server.inject({
      method: 'GET',
      url: `/auth/atlassian/callback?state=${firstState}&code=x`,
      headers: { cookie: current.cookie },
    });
    expect(oldCallback.statusCode).toBe(400);
  });

  it('does not store tokens when authorization is denied or exchange fails', async () => {
    const oauthFetchFn = vi.fn(
      async () => new Response('{"error":"invalid_grant"}', { status: 400 }),
    ) as typeof fetch;
    const server = await start(oauthFetchFn);
    const current = await completePasswordChange();
    async function begin(): Promise<string> {
      const response = await server.inject({
        method: 'POST',
        url: '/auth/atlassian/start',
        headers: { cookie: current.cookie, 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({ _csrf: current.csrfToken }).toString(),
      });
      return new URL(String(response.headers.location)).searchParams.get('state')!;
    }
    const denied = await server.inject({
      method: 'GET',
      url: `/auth/atlassian/callback?state=${await begin()}&error=access_denied`,
      headers: { cookie: current.cookie },
    });
    expect(denied.headers.location).toBe('/connections?message=denied');
    const failed = await server.inject({
      method: 'GET',
      url: `/auth/atlassian/callback?state=${await begin()}&code=x`,
      headers: { cookie: current.cookie },
    });
    expect(failed.headers.location).toBe('/connections?message=failed');
    expect(fs.existsSync(config.tokenPath)).toBe(false);
  });

  it('rejects an OAuth response that omits a required scope', async () => {
    const oauthFetchFn = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            access_token: 'fake-access-token',
            refresh_token: 'fake-refresh-token',
            expires_in: 3600,
            scope: 'offline_access read:servicedesk.customer:jira-service-management',
          }),
          { status: 200 },
        ),
    ) as typeof fetch;
    const server = await start(oauthFetchFn);
    const current = await completePasswordChange();
    const started = await server.inject({
      method: 'POST',
      url: '/auth/atlassian/start',
      headers: { cookie: current.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ _csrf: current.csrfToken }).toString(),
    });
    const state = new URL(String(started.headers.location)).searchParams.get('state')!;
    const callback = await server.inject({
      method: 'GET',
      url: `/auth/atlassian/callback?state=${state}&code=x`,
      headers: { cookie: current.cookie },
    });
    expect(callback.headers.location).toBe('/connections?message=failed');
    expect(fs.existsSync(config.tokenPath)).toBe(false);
  });

  it('starts Atlassian authorization from a same-origin link and refuses cross-site starts', async () => {
    const server = await start();
    const current = await completePasswordChange();

    const page = await server.inject({
      method: 'GET',
      url: '/connections',
      headers: { cookie: current.cookie },
    });
    expect(page.body).toContain('href="/auth/atlassian/start" target="_blank" rel="noopener"');

    const sameOrigin = await server.inject({
      method: 'GET',
      url: '/auth/atlassian/start',
      headers: { cookie: current.cookie, 'sec-fetch-site': 'same-origin' },
    });
    expect(sameOrigin.statusCode).toBe(303);
    const authorize = new URL(String(sameOrigin.headers.location));
    expect(authorize.origin).toBe('https://auth.atlassian.com');
    expect(authorize.searchParams.get('state')).toMatch(/^[a-f0-9]{64}$/);

    const crossSite = await server.inject({
      method: 'GET',
      url: '/auth/atlassian/start',
      headers: { cookie: current.cookie, 'sec-fetch-site': 'cross-site' },
    });
    expect(crossSite.statusCode).toBe(403);

    // Browsers without Fetch Metadata fall back to a same-origin Referer.
    const legacy = await server.inject({
      method: 'GET',
      url: '/auth/atlassian/start',
      headers: { cookie: current.cookie, referer: `${config.publicBaseUrl}/connections` },
    });
    expect(legacy.statusCode).toBe(303);
    const noProof = await server.inject({
      method: 'GET',
      url: '/auth/atlassian/start',
      headers: { cookie: current.cookie },
    });
    expect(noProof.statusCode).toBe(403);
  });

  it('blocks mismatched callback configuration before redirecting to Atlassian', async () => {
    config.redirectUriMismatch = true;
    const server = await start();
    const current = await completePasswordChange();
    const response = await server.inject({
      method: 'POST',
      url: '/auth/atlassian/start',
      headers: { cookie: current.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ _csrf: current.csrfToken }).toString(),
    });
    expect(response.statusCode).toBe(409);
  });

  it('requires HTTPS for a remote public URL and permits a removed bootstrap file after setup', () => {
    expect(() =>
      loadWebConfig({ NODE_ENV: 'production', PUBLIC_BASE_URL: 'http://sync.example.com' }),
    ).toThrow('HTTPS');
    const missing = path.join(directory, 'removed-bootstrap-secret');
    const loaded = loadWebConfig({
      NODE_ENV: 'production',
      PUBLIC_BASE_URL: 'https://sync.example.com',
      ADMIN_INITIAL_PASSWORD_FILE: missing,
    });
    expect(loaded.bootstrapPassword).toBeUndefined();
    expect(loaded.secureCookies).toBe(true);
    expect(loaded.callbackUrl).toBe('https://sync.example.com/auth/atlassian/callback');
  });

  it('correctly classifies loopback vs non-loopback hostnames', () => {
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('127.0.0.2')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('10.20.30.40')).toBe(false);
    expect(isLoopbackHost('192.168.1.1')).toBe(false);
    expect(isLoopbackHost('10.0.0.1')).toBe(false);
    expect(isLoopbackHost('sync.local')).toBe(false);
    expect(isLoopbackHost('sync.internal')).toBe(false);
    expect(isLoopbackHost('sync.example.com')).toBe(false);
  });

  it('requires HTTPS for private IPs and internal hostnames unless ALLOW_INSECURE_REMOTE_HTTP is set', () => {
    // Private IPs must reject plain HTTP without test flag
    expect(() =>
      loadWebConfig({ NODE_ENV: 'production', PUBLIC_BASE_URL: 'http://10.20.30.40:8080' }),
    ).toThrow('ALLOW_INSECURE_REMOTE_HTTP=true');
    expect(() =>
      loadWebConfig({ NODE_ENV: 'production', PUBLIC_BASE_URL: 'http://192.168.1.50:8080' }),
    ).toThrow('ALLOW_INSECURE_REMOTE_HTTP=true');
    expect(() =>
      loadWebConfig({ NODE_ENV: 'production', PUBLIC_BASE_URL: 'http://sync.local:8080' }),
    ).toThrow('ALLOW_INSECURE_REMOTE_HTTP=true');

    // With explicit test flag, plain HTTP on private IP is permitted
    const testConfig = loadWebConfig({
      NODE_ENV: 'production',
      PUBLIC_BASE_URL: 'http://10.20.30.40:8080',
      ALLOW_INSECURE_REMOTE_HTTP: 'true',
    });
    expect(testConfig.allowInsecureRemoteHttp).toBe(true);
    expect(testConfig.secureCookies).toBe(false);
    expect(testConfig.publicBaseUrl).toBe('http://10.20.30.40:8080');

    // HTTPS on private IP works without test flag
    const httpsConfig = loadWebConfig({
      NODE_ENV: 'production',
      PUBLIC_BASE_URL: 'https://10.20.30.40:8443',
    });
    expect(httpsConfig.secureCookies).toBe(true);
  });

  it('trusts x-forwarded-host only when trustProxy is explicitly enabled', async () => {
    // Untrusted proxy: ignores X-Forwarded-Host, only checks Host
    config.trustProxy = false;
    const serverUntrusted = await start();
    const untrustedRes = await serverUntrusted.inject({
      method: 'GET',
      url: '/login',
      headers: {
        host: '127.0.0.1:8080',
        'x-forwarded-host': 'malicious.example.com',
      },
    });
    // Matches publicBaseUrl (127.0.0.1:8080) because X-Forwarded-Host was ignored
    expect(untrustedRes.statusCode).toBe(200);
    await serverUntrusted.close();

    // Trusted proxy: respects X-Forwarded-Host
    config.trustProxy = true;
    config.publicBaseUrl = 'https://sync.example.com';
    const serverTrusted = await createWebApp({
      config,
      assetRoot: path.resolve(process.cwd(), 'src/web'),
      startScheduler: false,
    });
    app = serverTrusted;
    const trustedRes = await serverTrusted.inject({
      method: 'GET',
      url: '/login',
      headers: {
        host: '10.0.0.1:8080',
        'x-forwarded-host': 'sync.example.com',
      },
    });
    // Matches publicBaseUrl because X-Forwarded-Host matches
    expect(trustedRes.statusCode).toBe(200);
  });

  it('fails closed when attempting preview sync before Atlassian Jira is connected', async () => {
    const server = await start();
    const current = await completePasswordChange();

    // Configure approved email domains
    const domainRes = await server.inject({
      method: 'POST',
      url: '/settings/domains',
      headers: { cookie: current.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        _csrf: current.csrfToken,
        approved_email_domains: 'example.com',
      }).toString(),
    });
    expect(domainRes.statusCode).toBe(302);

    // Trigger preview without Jira connected
    const previewRes = await server.inject({
      method: 'POST',
      url: '/runs/preview',
      headers: { cookie: current.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ _csrf: current.csrfToken }).toString(),
    });
    expect(previewRes.statusCode).toBe(302);
    const runIdMatch = previewRes.headers.location?.match(/\/runs\/(\d+)/);
    expect(runIdMatch).toBeTruthy();
    const runId = Number(runIdMatch![1]);

    // Wait briefly for background execution
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Inspect the run: should be marked FAILED with clear reason
    const detailPage = await server.inject({
      method: 'GET',
      url: `/runs/${runId}`,
      headers: { cookie: current.cookie },
    });
    expect(detailPage.statusCode).toBe(200);
    expect(detailPage.body).toContain('Atlassian Jira is not connected');
  });
});
