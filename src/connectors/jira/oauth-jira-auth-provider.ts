/**
 * OAuth 2.0 (3LO) Jira Authentication Provider.
 *
 * ARCHITECTURAL PRINCIPLE:
 * Implements IJiraAuthProvider returning 'Authorization: Bearer <ACCESS_TOKEN>'.
 * Strictly manages rotating refresh tokens, enforces concurrent single-flight refresh,
 * prevents token leakage, and provides atomic token persistence.
 */

import { IJiraAuthProvider } from './jira-auth';
import { OAuthTokenStore } from './oauth-token-store';
import {
  refreshAccessToken,
  getAccessibleResources,
  AtlassianAccessibleResource,
} from './oauth-client';
import { AtlassianOAuthTokenRecord, OAuthError } from './oauth-types';
import { Logger, logger } from '../../utils/logger';

export interface OAuth3LoJiraAuthProviderOptions {
  clientId: string;
  clientSecret: string;
  tokenStore: OAuthTokenStore;
  clockSkewAllowanceMs?: number;
  fetchFn?: typeof fetch;
  log?: Logger;
}

export class OAuth3LoJiraAuthProvider implements IJiraAuthProvider {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly tokenStore: OAuthTokenStore;
  private readonly clockSkewAllowanceMs: number;
  private readonly fetchFn?: typeof fetch;
  private readonly log: Logger;

  private refreshPromise: Promise<string> | null = null;

  constructor(options: OAuth3LoJiraAuthProviderOptions) {
    if (!options.clientId || options.clientId.trim().length === 0) {
      throw new OAuthError(
        'OAUTH_CONFIGURATION_INVALID',
        'ATLASSIAN_OAUTH_CLIENT_ID is required for OAuth3LoJiraAuthProvider.',
      );
    }
    if (!options.clientSecret || options.clientSecret.trim().length === 0) {
      throw new OAuthError(
        'OAUTH_CONFIGURATION_INVALID',
        'ATLASSIAN_OAUTH_CLIENT_SECRET is required for OAuth3LoJiraAuthProvider.',
      );
    }
    if (!options.tokenStore) {
      throw new OAuthError(
        'OAUTH_CONFIGURATION_INVALID',
        'OAuthTokenStore is required for OAuth3LoJiraAuthProvider.',
      );
    }

    this.clientId = options.clientId.trim();
    this.clientSecret = options.clientSecret.trim();
    this.tokenStore = options.tokenStore;
    this.clockSkewAllowanceMs = options.clockSkewAllowanceMs ?? 300000; // 5 minutes default
    this.fetchFn = options.fetchFn;
    this.log = options.log ?? logger;
  }

  /**
   * Retrieves the Bearer authorization header.
   * If the current access token is expiring or expired, performs a serialized refresh.
   */
  async getAuthHeader(): Promise<string> {
    const record = this.tokenStore.readTokenRecord();

    const expiresAt = new Date(record.accessTokenExpiresAt).getTime();
    if (isNaN(expiresAt)) {
      throw new OAuthError(
        'OAUTH_TOKEN_RECORD_INVALID',
        'Invalid accessTokenExpiresAt timestamp in token record.',
      );
    }

    const now = Date.now();
    const isTokenValid = expiresAt - this.clockSkewAllowanceMs > now;

    if (isTokenValid) {
      return `Bearer ${record.accessToken}`;
    }

    // Access token is expired or approaching expiration: execute single-flight refresh
    if (!this.refreshPromise) {
      this.refreshPromise = this.executeRefresh(record).finally(() => {
        this.refreshPromise = null;
      });
    }

    const newAccessToken = await this.refreshPromise;
    return `Bearer ${newAccessToken}`;
  }

  /**
   * Single-flight execution of token refresh with atomic persistence.
   */
  private async executeRefresh(record: AtlassianOAuthTokenRecord): Promise<string> {
    this.log.debug('Executing OAuth token refresh before expiration', {
      authMode: 'oauth-3lo',
    });

    let refreshedRecord: AtlassianOAuthTokenRecord;
    try {
      refreshedRecord = await refreshAccessToken({
        clientId: this.clientId,
        clientSecret: this.clientSecret,
        refreshToken: record.refreshToken,
        existingScopes: record.scopes,
        createdAt: record.createdAt,
        fetchFn: this.fetchFn,
      });
    } catch (err) {
      this.log.error('OAuth token refresh failed', {
        errorCategory: err instanceof OAuthError ? err.category : 'OAUTH_REFRESH_FAILED',
      });
      throw err;
    }

    // Persist new token record atomically
    try {
      this.tokenStore.writeTokenRecord(refreshedRecord);
    } catch (err) {
      this.log.error('Failed to persist refreshed OAuth token record', {
        errorCategory: 'OAUTH_STORAGE_FAILED',
      });
      throw new OAuthError(
        'OAUTH_STORAGE_FAILED',
        `Failed to store refreshed token record: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    this.log.debug('OAuth token refreshed and stored successfully', {
      authMode: 'oauth-3lo',
    });

    return refreshedRecord.accessToken;
  }

  private cachedCloudId?: string;
  private cachedSiteUrl?: string;

  /**
   * Discovers and returns the Atlassian Cloud ID for the authorized Jira instance.
   */
  async getCloudId(preferredSiteUrl?: string): Promise<string> {
    if (this.cachedCloudId) {
      return this.cachedCloudId;
    }

    const authHeader = await this.getAuthHeader();
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    const resources = await getAccessibleResources({
      accessToken: token,
      fetchFn: this.fetchFn,
    });

    if (!resources || resources.length === 0) {
      throw new OAuthError(
        'OAUTH_CONFIGURATION_INVALID',
        'No accessible Jira Cloud resources found for this OAuth token.',
      );
    }

    if (preferredSiteUrl) {
      const normalizedPreferred = preferredSiteUrl.trim().toLowerCase().replace(/\/+$/, '');
      const match = resources.find(
        (r: AtlassianAccessibleResource) =>
          r.url && r.url.trim().toLowerCase().replace(/\/+$/, '') === normalizedPreferred,
      );
      if (match) {
        this.cachedCloudId = match.id;
        this.cachedSiteUrl = match.url;
        return match.id;
      }
    }

    // Never guess between several authorized sites: the wrong site would be read and updated.
    if (resources.length > 1) {
      throw new OAuthError(
        'OAUTH_CONFIGURATION_INVALID',
        preferredSiteUrl
          ? 'ATLASSIAN_SITE_URL does not match any Jira site this connection can access. Use the site address ending in atlassian.net, or set ATLASSIAN_CLOUD_ID.'
          : 'This Jira connection can access more than one site. Set ATLASSIAN_SITE_URL (the address ending in atlassian.net) or ATLASSIAN_CLOUD_ID to choose one.',
      );
    }

    const only = resources[0]!;
    if (preferredSiteUrl) {
      this.log.warn(
        'ATLASSIAN_SITE_URL does not match the only authorized Jira site; using the authorized site',
      );
    }
    this.cachedCloudId = only.id;
    this.cachedSiteUrl = only.url;
    return only.id;
  }

  /**
   * Discovers and returns the Atlassian Site URL if available.
   */
  async getSiteUrl(): Promise<string | undefined> {
    if (this.cachedSiteUrl) {
      return this.cachedSiteUrl;
    }
    await this.getCloudId();
    return this.cachedSiteUrl;
  }

  /**
   * Masked inspector ensuring no client secrets or tokens are ever logged.
   */
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return '[OAuth3LoJiraAuthProvider: safe]';
  }

  toJSON(): Record<string, unknown> {
    return {
      type: 'OAuth3LoJiraAuthProvider',
      authMode: 'oauth-3lo',
    };
  }
}
