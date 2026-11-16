/**
 * Safe OAuth status inspection.
 *
 * Reports ONLY operational booleans and configured or granted scope names.
 * NEVER returns tokens, credentials, client IDs, timestamps, file contents, or file paths.
 */

import { OAuthTokenStore } from './oauth-token-store';

export interface OAuthStatusReport {
  authenticationMode: string;
  configurationAvailable: boolean;
  tokenRecordAvailable: boolean;
  tokenRecordValid: boolean;
  accessTokenExpired: boolean;
  reauthorizationRequired: boolean;
  configuredScopeNames: string[];
  grantedScopeNames: string[];
  requiredScopesGranted: boolean;
}

export function inspectOAuthStatus(options: {
  authenticationMode: string;
  clientId?: string;
  clientSecret?: string;
  scopes: string[];
  tokenStore: OAuthTokenStore;
}): OAuthStatusReport {
  const { clientId, clientSecret, scopes, tokenStore } = options;
  const configurationAvailable = Boolean(
    clientId &&
    clientId.trim().length > 0 &&
    !clientId.startsWith('placeholder') &&
    clientSecret &&
    clientSecret.trim().length > 0 &&
    !clientSecret.startsWith('placeholder'),
  );

  let tokenRecordAvailable = false;
  let tokenRecordValid = false;
  let accessTokenExpired = true;
  let reauthorizationRequired = false;
  let grantedScopeNames: string[] = [];

  try {
    tokenRecordAvailable = tokenStore.hasTokenRecord();

    if (tokenRecordAvailable) {
      try {
        const record = tokenStore.readTokenRecord();
        tokenRecordValid = true;
        grantedScopeNames = [...record.scopes];

        const expiresAt = new Date(record.accessTokenExpiresAt).getTime();
        accessTokenExpired = isNaN(expiresAt) || expiresAt <= Date.now();
      } catch {
        tokenRecordValid = false;
        reauthorizationRequired = true;
      }
    } else {
      reauthorizationRequired = true;
    }
  } catch {
    tokenRecordAvailable = false;
    tokenRecordValid = false;
    reauthorizationRequired = true;
  }

  return {
    authenticationMode: options.authenticationMode,
    configurationAvailable,
    tokenRecordAvailable,
    tokenRecordValid,
    accessTokenExpired,
    reauthorizationRequired,
    configuredScopeNames: scopes,
    grantedScopeNames,
    requiredScopesGranted: scopes.every((scope) => grantedScopeNames.includes(scope)),
  };
}
