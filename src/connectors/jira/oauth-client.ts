/**
 * Atlassian OAuth 2.0 (3LO) Client and Authorization Helpers.
 *
 * ARCHITECTURAL PRINCIPLE:
 * Strictly safe authorization-URL builder, authorization-code exchange, and rotating token refresh.
 * Enforces HTTPS, payload limits, bounded timeouts, non-logging of secrets, single-use codes,
 * and sanitized error categories.
 */

import * as crypto from 'crypto';
import { AtlassianOAuthTokenRecord, OAuthError } from './oauth-types';

export interface BuildAuthorizationUrlOptions {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  allowCustomerDetailWrite?: boolean;
}

export interface ExchangeCodeOptions {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  expectedScopes?: string[];
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

export interface RefreshTokenOptions {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  existingScopes: string[];
  createdAt?: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

/**
 * Generates a cryptographically secure random state parameter with 256 bits of entropy.
 */
export function generateOAuthState(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Builds the official Atlassian OAuth 2.0 authorization URL with safe parameter encoding.
 * Never includes the client secret.
 */
export function buildAuthorizationUrl(options: BuildAuthorizationUrlOptions): string {
  if (!options.clientId || options.clientId.trim().length === 0) {
    throw new OAuthError(
      'OAUTH_CONFIGURATION_INVALID',
      'Client ID is required to build authorization URL.',
    );
  }
  if (!options.redirectUri || options.redirectUri.trim().length === 0) {
    throw new OAuthError(
      'OAUTH_CONFIGURATION_INVALID',
      'Redirect URI is required to build authorization URL.',
    );
  }
  if (!options.state || options.state.trim().length === 0) {
    throw new OAuthError(
      'OAUTH_CONFIGURATION_INVALID',
      'State parameter is required to build authorization URL.',
    );
  }

  // Validate required product and offline scopes
  const scopes = Array.from(
    new Set(options.scopes.map((s) => s.trim()).filter((s) => s.length > 0)),
  );
  if (!scopes.includes('read:servicedesk.customer:jira-service-management')) {
    throw new OAuthError(
      'OAUTH_CONFIGURATION_INVALID',
      "Authorization request requires 'read:servicedesk.customer:jira-service-management' scope.",
    );
  }
  if (!scopes.includes('offline_access')) {
    throw new OAuthError(
      'OAUTH_CONFIGURATION_INVALID',
      "Authorization request requires 'offline_access' scope.",
    );
  }

  // Ensure no forbidden write or management scopes
  for (const s of scopes) {
    const lower = s.toLowerCase();
    if (
      lower === 'write:customer.detail:jira-service-management' &&
      options.allowCustomerDetailWrite
    ) {
      continue;
    }
    if (
      lower.startsWith('write:') ||
      lower.startsWith('delete:') ||
      lower.startsWith('manage:') ||
      lower.includes(':write') ||
      lower.includes(':delete')
    ) {
      throw new OAuthError(
        'OAUTH_CONFIGURATION_INVALID',
        `Disallowed scope in authorization request: '${s}'.`,
      );
    }
  }

  const params = new URLSearchParams();
  params.set('audience', 'api.atlassian.com');
  params.set('client_id', options.clientId.trim());
  params.set('scope', scopes.join(' '));
  params.set('redirect_uri', options.redirectUri.trim());
  params.set('state', options.state.trim());
  params.set('response_type', 'code');
  params.set('prompt', 'consent');

  return `https://auth.atlassian.com/authorize?${params.toString()}`;
}

/**
 * Exchanges a single-use authorization code for an initial access and refresh token pair.
 * Single-use: never retries automatically.
 */
export async function exchangeAuthorizationCode(
  options: ExchangeCodeOptions,
): Promise<AtlassianOAuthTokenRecord> {
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15000;

  if (!options.code || options.code.trim().length === 0) {
    throw new OAuthError('OAUTH_GRANT_INVALID', 'Authorization code is missing or empty.');
  }

  const payload = {
    grant_type: 'authorization_code',
    client_id: options.clientId.trim(),
    client_secret: options.clientSecret.trim(),
    code: options.code.trim(),
    redirect_uri: options.redirectUri.trim(),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetchFn('https://auth.atlassian.com/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    throw new OAuthError(
      'OAUTH_GRANT_INVALID',
      `Authorization code exchange network request failed: ${msg}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    let sanitizedError = 'CODE_EXCHANGE_FAILED';
    try {
      const errBody = (await response.json()) as Record<string, unknown>;
      if (typeof errBody.error === 'string') {
        sanitizedError = errBody.error.toUpperCase();
      }
    } catch {
      // ignore json parse error on error response
    }
    throw new OAuthError(
      'OAUTH_GRANT_INVALID',
      `Authorization code exchange failed with HTTP status ${response.status}.`,
      { statusCode: response.status, sanitizedErrorCode: sanitizedError },
    );
  }

  let data: Record<string, unknown>;
  try {
    data = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new OAuthError(
      'OAUTH_TOKEN_RECORD_INVALID',
      'Failed to parse JSON response from Atlassian OAuth token endpoint.',
    );
  }

  if (!data || typeof data !== 'object') {
    throw new OAuthError(
      'OAUTH_TOKEN_RECORD_INVALID',
      'Atlassian OAuth token response is not an object.',
    );
  }

  const accessToken = typeof data.access_token === 'string' ? data.access_token.trim() : '';
  const refreshToken = typeof data.refresh_token === 'string' ? data.refresh_token.trim() : '';
  const tokenType = typeof data.token_type === 'string' ? data.token_type.trim() : 'Bearer';
  const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : -1;

  if (!accessToken) {
    throw new OAuthError(
      'OAUTH_TOKEN_RECORD_INVALID',
      'OAuth token response missing required access_token.',
    );
  }

  if (!refreshToken) {
    throw new OAuthError(
      'OAUTH_TOKEN_RECORD_INVALID',
      'OAuth token response missing required refresh_token. Ensure offline_access was requested.',
    );
  }

  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new OAuthError(
      'OAUTH_TOKEN_RECORD_INVALID',
      `Invalid expires_in value received in OAuth response: ${expiresIn}.`,
    );
  }

  if (tokenType.toLowerCase() !== 'bearer') {
    throw new OAuthError(
      'OAUTH_TOKEN_RECORD_INVALID',
      `Incompatible token_type received: '${tokenType}'. Expected 'Bearer'.`,
    );
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + expiresIn * 1000).toISOString();

  let scopes = options.expectedScopes ?? [
    'offline_access',
    'read:servicedesk.customer:jira-service-management',
    'read:user:jira',
    'read:customer.detail-field:jira-service-management',
    'read:customer.profile:jira-service-management',
  ];

  if (typeof data.scope === 'string' && data.scope.trim().length > 0) {
    const returnedScopes = data.scope.trim().split(/\s+/).filter(Boolean);
    if (returnedScopes.includes('read:servicedesk.customer:jira-service-management')) {
      scopes = returnedScopes;
      if (!scopes.includes('offline_access')) {
        scopes.push('offline_access');
      }
    }
  }

  return {
    schemaVersion: 1,
    tokenType: 'Bearer',
    accessToken,
    refreshToken,
    accessTokenExpiresAt: expiresAt,
    scopes,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

/**
 * Exchanges a rotating refresh token for a replacement access and refresh token pair.
 */
export async function refreshAccessToken(
  options: RefreshTokenOptions,
): Promise<AtlassianOAuthTokenRecord> {
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15000;

  if (!options.refreshToken || options.refreshToken.trim().length === 0) {
    throw new OAuthError(
      'OAUTH_TOKEN_RECORD_INVALID',
      'Refresh token is missing from token record.',
    );
  }

  const payload = {
    grant_type: 'refresh_token',
    client_id: options.clientId.trim(),
    client_secret: options.clientSecret.trim(),
    refresh_token: options.refreshToken.trim(),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetchFn('https://auth.atlassian.com/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    throw new OAuthError(
      'OAUTH_REFRESH_FAILED',
      `OAuth token refresh network request failed: ${msg}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    let sanitizedError = 'REFRESH_FAILED';
    let isInvalidGrant = false;
    try {
      const errBody = (await response.json()) as Record<string, unknown>;
      if (typeof errBody.error === 'string') {
        sanitizedError = errBody.error.toUpperCase();
        if (errBody.error.toLowerCase() === 'invalid_grant') {
          isInvalidGrant = true;
        }
      }
    } catch {
      // ignore
    }

    if (isInvalidGrant || response.status === 400 || response.status === 401) {
      throw new OAuthError(
        'OAUTH_REAUTHORIZATION_REQUIRED',
        'OAuth refresh grant is invalid or expired. Reauthorization required.',
        { statusCode: response.status, sanitizedErrorCode: sanitizedError },
      );
    }

    throw new OAuthError(
      'OAUTH_REFRESH_FAILED',
      `OAuth token refresh failed with HTTP status ${response.status}.`,
      { statusCode: response.status, sanitizedErrorCode: sanitizedError },
    );
  }

  let data: Record<string, unknown>;
  try {
    data = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new OAuthError(
      'OAUTH_TOKEN_RECORD_INVALID',
      'Failed to parse JSON response from Atlassian OAuth token refresh.',
    );
  }

  const accessToken = typeof data.access_token === 'string' ? data.access_token.trim() : '';
  const refreshToken = typeof data.refresh_token === 'string' ? data.refresh_token.trim() : '';
  const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : -1;

  if (!accessToken) {
    throw new OAuthError(
      'OAUTH_REFRESH_FAILED',
      'OAuth refresh response missing replacement access_token.',
    );
  }

  if (!refreshToken) {
    throw new OAuthError(
      'OAUTH_REFRESH_FAILED',
      'OAuth refresh response missing replacement refresh_token.',
    );
  }

  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new OAuthError(
      'OAUTH_REFRESH_FAILED',
      `Invalid expires_in value received in OAuth refresh response: ${expiresIn}.`,
    );
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + expiresIn * 1000).toISOString();

  let scopes = options.existingScopes;
  if (typeof data.scope === 'string' && data.scope.trim().length > 0) {
    const returnedScopes = data.scope.trim().split(/\s+/).filter(Boolean);
    if (returnedScopes.includes('read:servicedesk.customer:jira-service-management')) {
      scopes = returnedScopes;
      if (!scopes.includes('offline_access')) {
        scopes.push('offline_access');
      }
    }
  }

  return {
    schemaVersion: 1,
    tokenType: 'Bearer',
    accessToken,
    refreshToken,
    accessTokenExpiresAt: expiresAt,
    scopes,
    createdAt: options.createdAt ?? now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

export interface AtlassianAccessibleResource {
  id: string;
  url: string;
  name: string;
  scopes: string[];
  avatarUrl?: string;
}

export interface GetAccessibleResourcesOptions {
  accessToken: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Discovers accessible Jira Cloud resources (sites and cloud IDs) for a Bearer token.
 */
export async function getAccessibleResources(
  options: GetAccessibleResourcesOptions,
): Promise<AtlassianAccessibleResource[]> {
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15000;

  if (!options.accessToken || options.accessToken.trim().length === 0) {
    throw new OAuthError(
      'OAUTH_TOKEN_RECORD_INVALID',
      'Access token is required to fetch accessible resources.',
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetchFn('https://api.atlassian.com/oauth/token/accessible-resources', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${options.accessToken.trim()}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    throw new OAuthError('OAUTH_REFRESH_FAILED', `Accessible resources request failed: ${msg}`);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new OAuthError(
      'OAUTH_REFRESH_FAILED',
      `Accessible resources endpoint returned HTTP status ${response.status}.`,
      { statusCode: response.status },
    );
  }

  try {
    const data = (await response.json()) as AtlassianAccessibleResource[];
    return Array.isArray(data) ? data : [];
  } catch {
    throw new OAuthError(
      'OAUTH_TOKEN_RECORD_INVALID',
      'Failed to parse accessible resources response.',
    );
  }
}
