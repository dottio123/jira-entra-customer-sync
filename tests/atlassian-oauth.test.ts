import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  generateOAuthState,
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  refreshAccessToken,
} from '../src/connectors/jira/oauth-client';
import {
  AtlassianOAuthTokenRecordSchema,
  assertNoForbiddenTokenRecordFields,
  OAuthError,
} from '../src/connectors/jira/oauth-types';
import { OAuthTokenStore } from '../src/connectors/jira/oauth-token-store';
import { OAuth3LoJiraAuthProvider } from '../src/connectors/jira/oauth-jira-auth-provider';
import { GetOnlyJiraHttpClient } from '../src/connectors/jira';
import { Logger } from '../src/utils/logger';

describe('Atlassian OAuth 2.0 (3LO) Authentication & Security Subsystem', () => {
  const silentLogger = new Logger('oauth-test', 'error');
  let tempDir: string;
  let testTokenFile: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-sec-test-'));
    testTokenFile = path.join(tempDir, 'atlassian-oauth.json');
  });

  afterEach(() => {
    if (fs.existsSync(testTokenFile)) {
      fs.unlinkSync(testTokenFile);
    }
    if (fs.existsSync(tempDir)) {
      fs.rmdirSync(tempDir);
    }
  });

  describe('OAuth State & Authorization URL Generation', () => {
    it('generates high-entropy 256-bit cryptographic state tokens', () => {
      const state1 = generateOAuthState();
      const state2 = generateOAuthState();

      expect(state1).toHaveLength(64); // 32 bytes in hex
      expect(state2).toHaveLength(64);
      expect(state1).not.toBe(state2);
      expect(/^[0-9a-f]{64}$/.test(state1)).toBe(true);
    });

    it('builds authorization URL targeting api.atlassian.com audience with prompt=consent', () => {
      const state = generateOAuthState();
      const urlStr = buildAuthorizationUrl({
        clientId: 'mock-oauth-client-id-123',
        redirectUri: 'http://127.0.0.1:8080/callback',
        state,
        scopes: [
          'offline_access',
          'read:servicedesk.customer:jira-service-management',
          'read:user:jira',
        ],
      });

      const parsed = new URL(urlStr);
      expect(parsed.protocol).toBe('https:');
      expect(parsed.hostname).toBe('auth.atlassian.com');
      expect(parsed.pathname).toBe('/authorize');
      expect(parsed.searchParams.get('audience')).toBe('api.atlassian.com');
      expect(parsed.searchParams.get('client_id')).toBe('mock-oauth-client-id-123');
      expect(parsed.searchParams.get('prompt')).toBe('consent');
      expect(parsed.searchParams.get('response_type')).toBe('code');
      expect(parsed.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:8080/callback');
      expect(parsed.searchParams.get('state')).toBe(state);
      expect(parsed.searchParams.get('scope')).toContain(
        'read:servicedesk.customer:jira-service-management',
      );
      expect(parsed.searchParams.get('scope')).toContain('offline_access');
    });

    it('strictly requires read:servicedesk.customer:jira-service-management and offline_access', () => {
      const state = generateOAuthState();

      // Missing customer scope
      expect(() =>
        buildAuthorizationUrl({
          clientId: 'client-1',
          redirectUri: 'http://127.0.0.1:8080/callback',
          state,
          scopes: ['offline_access', 'read:user:jira'],
        }),
      ).toThrow(/requires 'read:servicedesk\.customer:jira-service-management'/);

      // Missing offline_access
      expect(() =>
        buildAuthorizationUrl({
          clientId: 'client-1',
          redirectUri: 'http://127.0.0.1:8080/callback',
          state,
          scopes: ['read:servicedesk.customer:jira-service-management'],
        }),
      ).toThrow(/requires 'offline_access'/);
    });

    it('strictly rejects write, delete, and management scopes in authorization URL', () => {
      const state = generateOAuthState();

      expect(() =>
        buildAuthorizationUrl({
          clientId: 'client-1',
          redirectUri: 'http://127.0.0.1:8080/callback',
          state,
          scopes: [
            'offline_access',
            'read:servicedesk.customer:jira-service-management',
            'write:servicedesk-customer',
          ],
        }),
      ).toThrow(/Disallowed scope in authorization request: 'write:servicedesk-customer'/);

      expect(() =>
        buildAuthorizationUrl({
          clientId: 'client-1',
          redirectUri: 'http://127.0.0.1:8080/callback',
          state,
          scopes: [
            'offline_access',
            'read:servicedesk.customer:jira-service-management',
            'manage:servicedesk-customer',
          ],
        }),
      ).toThrow(/Disallowed scope in authorization request: 'manage:servicedesk-customer'/);
    });

    it('allows only the customer-detail write scope behind the explicit pilot gate', () => {
      const state = generateOAuthState();
      const scopes = [
        'offline_access',
        'read:servicedesk.customer:jira-service-management',
        'write:customer.detail:jira-service-management',
      ];

      expect(() =>
        buildAuthorizationUrl({
          clientId: 'client-1',
          redirectUri: 'http://127.0.0.1:8080/callback',
          state,
          scopes,
        }),
      ).toThrow(/Disallowed scope/);

      const url = buildAuthorizationUrl({
        clientId: 'client-1',
        redirectUri: 'http://127.0.0.1:8080/callback',
        state,
        scopes,
        allowCustomerDetailWrite: true,
      });
      expect(new URL(url).searchParams.get('scope')).toContain(
        'write:customer.detail:jira-service-management',
      );
    });
  });

  describe('Authorization Code Exchange & Direct Token Refresh Functions', () => {
    it('exchanges authorization code via HTTPS POST and parses token record', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'newly-exchanged-access-token',
          refresh_token: 'newly-exchanged-refresh-token',
          expires_in: 3600,
          token_type: 'Bearer',
          scope: 'offline_access read:servicedesk.customer:jira-service-management',
        }),
        headers: new Headers(),
      });

      const tokenRecord = await exchangeAuthorizationCode({
        clientId: 'client-1',
        clientSecret: 'secret-1',
        code: 'auth-code-123',
        redirectUri: 'http://127.0.0.1:8080/callback',
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      expect(tokenRecord.accessToken).toBe('newly-exchanged-access-token');
      expect(tokenRecord.refreshToken).toBe('newly-exchanged-refresh-token');
      expect(tokenRecord.tokenType).toBe('Bearer');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('refreshes access token directly via refreshAccessToken function', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'direct-refreshed-access-token',
          refresh_token: 'direct-refreshed-refresh-token',
          expires_in: 3600,
          token_type: 'Bearer',
        }),
        headers: new Headers(),
      });

      const tokenRecord = await refreshAccessToken({
        clientId: 'client-1',
        clientSecret: 'secret-1',
        refreshToken: 'old-refresh-token',
        existingScopes: ['offline_access', 'read:servicedesk.customer:jira-service-management'],
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      expect(tokenRecord.accessToken).toBe('direct-refreshed-access-token');
      expect(tokenRecord.refreshToken).toBe('direct-refreshed-refresh-token');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('AtlassianOAuthTokenRecordSchema Validation', () => {
    it('validates a correct token record with Bearer type and required scopes', () => {
      const validRecord = {
        schemaVersion: 1,
        tokenType: 'Bearer',
        accessToken: 'access-token-12345',
        refreshToken: 'refresh-token-67890',
        accessTokenExpiresAt: new Date(Date.now() + 3600000).toISOString(),
        scopes: [
          'offline_access',
          'read:servicedesk.customer:jira-service-management',
          'read:user:jira',
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const parsed = AtlassianOAuthTokenRecordSchema.parse(validRecord);
      expect(parsed.schemaVersion).toBe(1);
      expect(parsed.tokenType).toBe('Bearer');
      expect(parsed.accessToken).toBe('access-token-12345');
    });

    it('rejects token records with forbidden credential or customer PII fields', () => {
      const recordWithSecret = {
        schemaVersion: 1,
        tokenType: 'Bearer',
        accessToken: 'access-token-12345',
        refreshToken: 'refresh-token-67890',
        accessTokenExpiresAt: new Date(Date.now() + 3600000).toISOString(),
        scopes: ['offline_access', 'read:servicedesk.customer:jira-service-management'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        clientSecret: 'forbidden-client-secret',
      };

      expect(() => AtlassianOAuthTokenRecordSchema.parse(recordWithSecret)).toThrow();
      expect(() =>
        assertNoForbiddenTokenRecordFields(recordWithSecret as Record<string, unknown>),
      ).toThrow(/Token record contains forbidden field 'clientSecret'/);
    });

    it('rejects token records without required read:servicedesk.customer:jira-service-management', () => {
      const recordMissingScope = {
        schemaVersion: 1,
        tokenType: 'Bearer',
        accessToken: 'access-token-12345',
        refreshToken: 'refresh-token-67890',
        accessTokenExpiresAt: new Date(Date.now() + 3600000).toISOString(),
        scopes: ['offline_access', 'read:user:jira'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      expect(() => AtlassianOAuthTokenRecordSchema.parse(recordMissingScope)).toThrow(
        /scopes must contain 'read:servicedesk\.customer:jira-service-management'/,
      );
    });
  });

  describe('OAuthTokenStore Persistence & Directory Isolation', () => {
    it('writes token record atomically with restricted file permissions and reads it back', () => {
      const store = new OAuthTokenStore({
        tokenPath: testTokenFile,
        allowCustomPath: true,
      });

      const tokenRecord = {
        schemaVersion: 1 as const,
        tokenType: 'Bearer',
        accessToken: 'initial-access-token',
        refreshToken: 'initial-refresh-token',
        accessTokenExpiresAt: new Date(Date.now() + 3600000).toISOString(),
        scopes: [
          'offline_access',
          'read:servicedesk.customer:jira-service-management',
          'read:user:jira',
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      store.writeTokenRecord(tokenRecord);
      expect(fs.existsSync(testTokenFile)).toBe(true);

      const loaded = store.readTokenRecord();
      expect(loaded).toBeDefined();
      expect(loaded.accessToken).toBe('initial-access-token');
      expect(loaded.refreshToken).toBe('initial-refresh-token');
    });

    it('rejects parent-path traversal in token path', () => {
      expect(
        () =>
          new OAuthTokenStore({
            tokenPath: 'secrets/../../etc/passwd',
            allowCustomPath: false,
          }),
      ).toThrow(/Parent-path traversal is prohibited/);
    });

    it('throws OAUTH_TOKEN_RECORD_MISSING when token file does not exist', () => {
      const nonExistentPath = path.join(tempDir, 'does-not-exist.json');
      const store = new OAuthTokenStore({
        tokenPath: nonExistentPath,
        allowCustomPath: true,
      });

      expect(store.hasTokenRecord()).toBe(false);
      expect(() => store.readTokenRecord()).toThrow(OAuthError);
      expect(() => store.readTokenRecord()).toThrow(/OAuth token record file not found/);
    });

    it('masks tokens in serialization and custom inspect', () => {
      const store = new OAuthTokenStore({
        tokenPath: testTokenFile,
        allowCustomPath: true,
      });

      expect(store.toJSON()).toEqual({ type: 'OAuthTokenStore' });
      expect(
        String(
          (store as unknown as Record<symbol, () => string>)[
            Symbol.for('nodejs.util.inspect.custom')
          ]!(),
        ),
      ).toBe('[OAuthTokenStore: safe]');
    });
  });

  describe('OAuth3LoJiraAuthProvider Single-Flight Mutex & Skew Handling', () => {
    it('returns Bearer header and uses valid unexpired access token without refreshing', async () => {
      const store = new OAuthTokenStore({
        tokenPath: testTokenFile,
        allowCustomPath: true,
      });

      const tokenRecord = {
        schemaVersion: 1 as const,
        tokenType: 'Bearer',
        accessToken: 'active-bearer-token-111',
        refreshToken: 'active-refresh-token-222',
        // Expires in 1 hour (far above 5-minute skew window)
        accessTokenExpiresAt: new Date(Date.now() + 3600000).toISOString(),
        scopes: ['offline_access', 'read:servicedesk.customer:jira-service-management'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      store.writeTokenRecord(tokenRecord);

      const mockFetch = vi.fn();
      const provider = new OAuth3LoJiraAuthProvider({
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        tokenStore: store,
        fetchFn: mockFetch as unknown as typeof fetch,
        log: silentLogger,
      });

      const authHeader = await provider.getAuthHeader();
      expect(authHeader).toBe('Bearer active-bearer-token-111');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('refreshes token within 5-minute clock-skew allowance and rotates refresh token', async () => {
      const store = new OAuthTokenStore({
        tokenPath: testTokenFile,
        allowCustomPath: true,
      });

      // Expires in 2 minutes (less than 5-minute skew window -> triggers refresh)
      const tokenRecord = {
        schemaVersion: 1 as const,
        tokenType: 'Bearer',
        accessToken: 'expiring-access-token',
        refreshToken: 'old-rotating-refresh-token',
        accessTokenExpiresAt: new Date(Date.now() + 120000).toISOString(),
        scopes: ['offline_access', 'read:servicedesk.customer:jira-service-management'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      store.writeTokenRecord(tokenRecord);

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'brand-new-access-token-333',
          refresh_token: 'new-rotating-refresh-token-444',
          expires_in: 3600,
          token_type: 'Bearer',
          scope: 'offline_access read:servicedesk.customer:jira-service-management',
        }),
        text: async () =>
          JSON.stringify({
            access_token: 'brand-new-access-token-333',
            refresh_token: 'new-rotating-refresh-token-444',
            expires_in: 3600,
            token_type: 'Bearer',
            scope: 'offline_access read:servicedesk.customer:jira-service-management',
          }),
        headers: new Headers(),
      });

      const provider = new OAuth3LoJiraAuthProvider({
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        tokenStore: store,
        fetchFn: mockFetch as unknown as typeof fetch,
        log: silentLogger,
      });

      const authHeader = await provider.getAuthHeader();
      expect(authHeader).toBe('Bearer brand-new-access-token-333');
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Verify the new token was atomically stored
      const updatedRecord = store.readTokenRecord();
      expect(updatedRecord.accessToken).toBe('brand-new-access-token-333');
      expect(updatedRecord.refreshToken).toBe('new-rotating-refresh-token-444');
    });

    it('serializes concurrent getAuthHeader calls through a single-flight refresh mutex', async () => {
      const store = new OAuthTokenStore({
        tokenPath: testTokenFile,
        allowCustomPath: true,
      });

      // Already expired token
      const tokenRecord = {
        schemaVersion: 1 as const,
        tokenType: 'Bearer',
        accessToken: 'expired-access-token',
        refreshToken: 'refresh-token-to-rotate',
        accessTokenExpiresAt: new Date(Date.now() - 60000).toISOString(),
        scopes: ['offline_access', 'read:servicedesk.customer:jira-service-management'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      store.writeTokenRecord(tokenRecord);

      let refreshCalls = 0;
      const mockFetch = vi.fn().mockImplementation(async () => {
        refreshCalls++;
        // Small delay to test concurrent overlap
        await new Promise((r) => setTimeout(r, 20));
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: 'concurrent-refreshed-token',
            refresh_token: 'concurrent-new-refresh-token',
            expires_in: 3600,
            token_type: 'Bearer',
            scope: 'offline_access read:servicedesk.customer:jira-service-management',
          }),
          text: async () =>
            JSON.stringify({
              access_token: 'concurrent-refreshed-token',
              refresh_token: 'concurrent-new-refresh-token',
              expires_in: 3600,
              token_type: 'Bearer',
              scope: 'offline_access read:servicedesk.customer:jira-service-management',
            }),
          headers: new Headers(),
        };
      });

      const provider = new OAuth3LoJiraAuthProvider({
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        tokenStore: store,
        fetchFn: mockFetch as unknown as typeof fetch,
        log: silentLogger,
      });

      // 5 concurrent requests initiated in parallel
      const results = await Promise.all([
        provider.getAuthHeader(),
        provider.getAuthHeader(),
        provider.getAuthHeader(),
        provider.getAuthHeader(),
        provider.getAuthHeader(),
      ]);

      // All 5 callers get the same fresh Bearer token
      for (const res of results) {
        expect(res).toBe('Bearer concurrent-refreshed-token');
      }

      // Crucial: Single-flight mutex guarantees exactly ONE token refresh HTTP request was fired
      expect(refreshCalls).toBe(1);
    });

    it('fails closed when refresh fails and throws OAUTH_REAUTHORIZATION_REQUIRED on invalid_grant', async () => {
      const store = new OAuthTokenStore({
        tokenPath: testTokenFile,
        allowCustomPath: true,
      });

      const tokenRecord = {
        schemaVersion: 1 as const,
        tokenType: 'Bearer',
        accessToken: 'expired-access-token',
        refreshToken: 'revoked-refresh-token',
        accessTokenExpiresAt: new Date(Date.now() - 60000).toISOString(),
        scopes: ['offline_access', 'read:servicedesk.customer:jira-service-management'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      store.writeTokenRecord(tokenRecord);

      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({
          error: 'invalid_grant',
          error_description: 'The refresh token is invalid or has expired',
        }),
        text: async () =>
          JSON.stringify({
            error: 'invalid_grant',
            error_description: 'The refresh token is invalid or has expired',
          }),
        headers: new Headers({ 'x-atlassian-request-id': 'req-oauth-revoked' }),
      });

      const provider = new OAuth3LoJiraAuthProvider({
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        tokenStore: store,
        fetchFn: mockFetch as unknown as typeof fetch,
        log: silentLogger,
      });

      await expect(provider.getAuthHeader()).rejects.toThrow(/reauthorization required/i);
    });
  });

  describe('GET-Only Jira Client Invariant With OAuth Bearer Tokens', () => {
    it('strictly rejects any write, create, or mutation HTTP method with OAuth auth provider', async () => {
      const store = new OAuthTokenStore({
        tokenPath: testTokenFile,
        allowCustomPath: true,
      });

      store.writeTokenRecord({
        schemaVersion: 1,
        tokenType: 'Bearer',
        accessToken: 'mock-valid-bearer-token',
        refreshToken: 'mock-valid-refresh-token',
        accessTokenExpiresAt: new Date(Date.now() + 3600000).toISOString(),
        scopes: ['offline_access', 'read:servicedesk.customer:jira-service-management'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const provider = new OAuth3LoJiraAuthProvider({
        clientId: 'test-client',
        clientSecret: 'test-secret',
        tokenStore: store,
        log: silentLogger,
      });

      const client = new GetOnlyJiraHttpClient(provider, {
        log: silentLogger,
      });

      // Verification: zero mutation methods allowed
      await expect(
        client.request(
          'POST',
          'https://api.atlassian.com/ex/jira/cloud-id/rest/servicedeskapi/customer',
        ),
      ).rejects.toThrow(/GET-only requests.*POST/i);

      await expect(
        client.request(
          'PUT',
          'https://api.atlassian.com/ex/jira/cloud-id/rest/servicedeskapi/customer',
        ),
      ).rejects.toThrow(/GET-only requests.*PUT/i);

      await expect(
        client.request(
          'DELETE',
          'https://api.atlassian.com/ex/jira/cloud-id/rest/servicedeskapi/customer',
        ),
      ).rejects.toThrow(/GET-only requests.*DELETE/i);
    });
  });
});
