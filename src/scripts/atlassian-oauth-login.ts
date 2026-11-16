/**
 * One-Time Interactive Atlassian OAuth 2.0 (3LO) Login Helper.
 *
 * ARCHITECTURAL PRINCIPLE:
 * Interactive CLI helper to acquire the initial access-token and rotating refresh-token pair.
 * Binds a temporary loopback HTTP server to receive the authorization code, exchanges it
 * for tokens, atomically writes the token record, shuts down immediately, and exits cleanly.
 * NEVER logs or exposes secrets, tokens, authorization codes, or state.
 */

import * as http from 'http';
import { exec } from 'child_process';
import { loadConfig } from '../config';
import { logger } from '../utils/logger';
import {
  generateOAuthState,
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  OAuthTokenStore,
  OAuthError,
} from '../connectors/jira';

async function openBrowser(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    let command: string;
    if (process.platform === 'win32') {
      command = `start "" "${url}"`;
    } else if (process.platform === 'darwin') {
      command = `open "${url}"`;
    } else {
      command = `xdg-open "${url}"`;
    }

    try {
      exec(command, (err) => {
        if (err) {
          resolve(false);
        } else {
          resolve(true);
        }
      });
    } catch {
      resolve(false);
    }
  });
}

export async function runOAuthLogin(): Promise<void> {
  const config = loadConfig();

  // 1. Validate configuration
  const clientId = config.jira.oauth?.clientId;
  const clientSecret = config.jira.oauth?.clientSecret;
  const redirectUriStr = config.jira.oauth?.redirectUri;
  const scopes = config.jira.oauth?.scopes ?? [
    'offline_access',
    'read:servicedesk.customer:jira-service-management',
    'read:user:jira',
    'read:customer.detail-field:jira-service-management',
    'read:customer.profile:jira-service-management',
  ];
  const tokenPath = config.jira.oauth?.tokenPath ?? 'secrets/atlassian-oauth.json';

  if (!clientId || clientId.startsWith('placeholder')) {
    logger.error('ATLASSIAN_OAUTH_CLIENT_ID is missing or set to placeholder.', {
      hint: 'Please configure ATLASSIAN_OAUTH_CLIENT_ID in .env.',
    });
    process.exit(1);
  }

  if (!clientSecret || clientSecret.startsWith('placeholder')) {
    logger.error('ATLASSIAN_OAUTH_CLIENT_SECRET is missing or set to placeholder.', {
      hint: 'Please configure ATLASSIAN_OAUTH_CLIENT_SECRET in .env.',
    });
    process.exit(1);
  }

  if (!redirectUriStr) {
    logger.error('ATLASSIAN_OAUTH_REDIRECT_URI is missing.', {
      hint: 'Please configure ATLASSIAN_OAUTH_REDIRECT_URI in .env (e.g. http://127.0.0.1:8080/callback).',
    });
    process.exit(1);
  }

  // 2. Validate callback URI and require loopback
  let redirectUrl: URL;
  try {
    redirectUrl = new URL(redirectUriStr);
  } catch {
    logger.error('ATLASSIAN_OAUTH_REDIRECT_URI is not a valid URL.');
    process.exit(1);
  }

  const hostname = redirectUrl.hostname;
  const isLoopback =
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]';

  if (!isLoopback) {
    logger.error(
      'ATLASSIAN_OAUTH_REDIRECT_URI must use a loopback address (127.0.0.1 or localhost).',
    );
    process.exit(1);
  }

  const port = parseInt(redirectUrl.port || (redirectUrl.protocol === 'https:' ? '443' : '80'), 10);
  const callbackPath = redirectUrl.pathname || '/callback';

  // 3. Generate cryptographically secure state
  const state = generateOAuthState();

  // 4. Construct authorization URL
  const authUrl = buildAuthorizationUrl({
    clientId,
    redirectUri: redirectUriStr,
    scopes,
    state,
    allowCustomerDetailWrite: config.sync.pilotWriteScopeAllowed,
  });

  const tokenStore = new OAuthTokenStore({ tokenPath });

  logger.info('Starting temporary OAuth callback listener for login', {
    loopbackHost: hostname,
    port,
    callbackPath,
    scopes,
  });

  return new Promise<void>((resolve, reject) => {
    let callbackReceived = false;
    let server: http.Server | null = null;
    let timeoutTimer: NodeJS.Timeout | null = null;

    const cleanup = () => {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      if (server) {
        server.close();
        server = null;
      }
    };

    server = http.createServer(async (req, res) => {
      // Reject non-loopback remote address
      const remote = req.socket.remoteAddress;
      const isRemoteLoopback =
        !remote || remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';

      if (!isRemoteLoopback) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden: Non-loopback request.');
        return;
      }

      // Check request URL
      const reqUrl = new URL(req.url ?? '/', `http://${redirectUrl.host}`);

      if (reqUrl.pathname !== callbackPath) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
      }

      if (callbackReceived) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Callback already processed.');
        return;
      }

      callbackReceived = true;

      // Check for OAuth error response
      const errorParam = reqUrl.searchParams.get('error');
      if (errorParam) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(
          '<!DOCTYPE html><html><body><h2>Authentication Failed</h2><p>Atlassian OAuth error received.</p></body></html>',
        );
        cleanup();
        reject(
          new OAuthError('OAUTH_GRANT_INVALID', `OAuth callback returned error: ${errorParam}`),
        );
        return;
      }

      // Validate state
      const returnedState = reqUrl.searchParams.get('state');
      if (!returnedState || returnedState !== state) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(
          '<!DOCTYPE html><html><body><h2>Authentication Failed</h2><p>OAuth state validation failed.</p></body></html>',
        );
        cleanup();
        reject(
          new OAuthError('OAUTH_GRANT_INVALID', 'Mismatched or missing OAuth state parameter.'),
        );
        return;
      }

      // Validate authorization code
      const code = reqUrl.searchParams.get('code');
      if (!code || code.trim().length === 0) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(
          '<!DOCTYPE html><html><body><h2>Authentication Failed</h2><p>Missing authorization code.</p></body></html>',
        );
        cleanup();
        reject(
          new OAuthError('OAUTH_GRANT_INVALID', 'Missing authorization code in OAuth callback.'),
        );
        return;
      }

      // Minimal safe success response to browser
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(
        '<!DOCTYPE html><html><body><h2>Authentication Successful</h2><p>You can close this window and return to your terminal.</p></body></html>',
      );

      cleanup();

      logger.info('Received valid OAuth callback. Exchanging authorization code for tokens...');

      try {
        const tokenRecord = await exchangeAuthorizationCode({
          clientId,
          clientSecret,
          code,
          redirectUri: redirectUriStr,
          expectedScopes: scopes,
        });

        tokenStore.writeTokenRecord(tokenRecord);

        logger.info('OAuth 2.0 (3LO) tokens acquired and saved successfully.', {
          status: 'ready',
          tokenPath: 'secrets/atlassian-oauth.json',
        });
        resolve();
      } catch (exchangeErr) {
        reject(exchangeErr);
      }
    });

    server.on('error', (err) => {
      cleanup();
      reject(new OAuthError('OAUTH_STORAGE_FAILED', `Callback listener error: ${err.message}`));
    });

    server.listen(port, hostname, async () => {
      logger.info('Listening for OAuth authorization callback. Opening browser...');
      const opened = await openBrowser(authUrl);
      if (!opened) {
        logger.info(
          'Browser could not be opened automatically. Please open the following URL in your browser:\n\n' +
            authUrl +
            '\n',
        );
      }

      // Bounded timeout: 3 minutes to complete login
      timeoutTimer = setTimeout(() => {
        cleanup();
        reject(
          new OAuthError(
            'OAUTH_GRANT_INVALID',
            'OAuth login timed out after 3 minutes without receiving callback.',
          ),
        );
      }, 180000);
    });
  });
}

// Self-executing CLI wrapper
if (process.argv[1]?.includes('atlassian-oauth-login')) {
  runOAuthLogin()
    .then(() => {
      process.exit(0);
    })
    .catch((err) => {
      logger.error('OAuth login failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      process.exit(1);
    });
}
