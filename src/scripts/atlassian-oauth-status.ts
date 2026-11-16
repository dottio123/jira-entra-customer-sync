/**
 * CLI: prints the Atlassian OAuth configuration and token status as JSON.
 * Never prints tokens, credentials, client IDs, timestamps, file contents, or file paths.
 */

import { loadConfig } from '../config';
import { OAuthTokenStore, OAuthStatusReport, inspectOAuthStatus } from '../connectors/jira';

export { inspectOAuthStatus };
export type { OAuthStatusReport };

export function getOAuthStatus(): OAuthStatusReport {
  const config = loadConfig();
  return inspectOAuthStatus({
    authenticationMode: config.jira.authMode,
    clientId: config.jira.oauth.clientId,
    clientSecret: config.jira.oauth.clientSecret,
    scopes: config.jira.oauth.scopes,
    tokenStore: new OAuthTokenStore({ tokenPath: config.jira.oauth.tokenPath }),
  });
}

if (process.argv[1]?.includes('atlassian-oauth-status')) {
  const status = getOAuthStatus();
  process.stdout.write(JSON.stringify(status, null, 2) + '\n');
}
