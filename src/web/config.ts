import * as fs from 'fs';
import * as path from 'path';
import {
  ConfigError,
  DEFAULT_ATLASSIAN_OAUTH_SCOPES,
  LogLevel,
  PILOT_WRITE_OAUTH_SCOPE,
  firstEnv,
  parseBooleanEnv,
  resolveServiceDeskIds,
  resolveWriteScopeAllowed,
  validateAndNormalizeOAuthScopes,
  withoutEmptyValues,
} from '../config';

export interface GraphCredentials {
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

export interface WebConfig {
  host: string;
  port: number;
  publicBaseUrl: string;
  callbackUrl: string;
  redirectUriMismatch: boolean;
  secureCookies: boolean;
  dataDir: string;
  secretsDir: string;
  tokenPath: string;
  displayName: string;
  logoFile?: string;
  adminUsername: string;
  bootstrapPassword?: string;
  oauthClientId?: string;
  oauthClientSecret?: string;
  oauthScopes: string[];
  oauthWriteScopeAllowed: boolean;
  /** True when the deprecated PILOT_WRITE_SCOPE_ALLOWED name supplied the write-scope setting. */
  legacyWriteScopeName: boolean;
  /** Optional `*.atlassian.net` URL that selects one site when the token can reach several. */
  atlassianSiteUrl?: string;
  /** Optional explicit Atlassian Cloud ID; skips site discovery. */
  atlassianCloudId?: string;
  graph?: GraphCredentials;
  graphConfigured: boolean;
  serviceDeskIds: string[];
  trustProxy: boolean | string;
  allowInsecureRemoteHttp: boolean;
  logLevel: LogLevel;
}

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

/**
 * Checks whether a given hostname is loopback (localhost, 127.0.0.1, ::1, or 127.x.x.x).
 */
export function isLoopbackHost(hostname: string): boolean {
  const lower = hostname.toLowerCase().trim();
  const clean = lower.startsWith('[') && lower.endsWith(']') ? lower.slice(1, -1) : lower;

  if (clean === 'localhost' || clean === '127.0.0.1' || clean === '::1') return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(clean)) return true;

  return false;
}

function readSecret(
  env: NodeJS.ProcessEnv,
  valueName: string,
  fileName: string,
  allowMissingFile = false,
): string | undefined {
  const file = env[fileName]?.trim();
  if (file) {
    if (allowMissingFile && !fs.existsSync(file)) return undefined;
    try {
      return fs.readFileSync(file, 'utf8').replace(/[\r\n]+$/, '');
    } catch {
      throw new ConfigError(`${fileName} could not be read.`);
    }
  }
  return env[valueName]?.trim() || undefined;
}

function parsePort(value: string | undefined, name: string, fallback: number): number {
  const port = Number(value ?? fallback);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`${name} must be an integer between 1 and 65535.`);
  }
  return port;
}

/** Treats unset values and `placeholder…` sample values as not configured. */
function isConfigured(value: string | undefined): value is string {
  return Boolean(value && !value.toLowerCase().startsWith('placeholder'));
}

export function loadWebConfig(
  rawEnv: NodeJS.ProcessEnv = process.env,
  rootDir: string = process.cwd(),
): WebConfig {
  // Blank values (NAME=) behave as unset.
  const env = withoutEmptyValues(rawEnv) as NodeJS.ProcessEnv;

  const port = parsePort(env.WEB_PORT, 'WEB_PORT', 8080);
  if (env.NODE_ENV === 'production' && !env.PUBLIC_BASE_URL) {
    throw new ConfigError('PUBLIC_BASE_URL is required in production.');
  }

  let publicUrl: URL;
  try {
    publicUrl = new URL(env.PUBLIC_BASE_URL ?? `http://127.0.0.1:${port}`);
  } catch {
    throw new ConfigError('PUBLIC_BASE_URL must be a valid URL such as https://sync.example.com.');
  }
  if (
    !['http:', 'https:'].includes(publicUrl.protocol) ||
    publicUrl.username ||
    publicUrl.password ||
    publicUrl.pathname !== '/' ||
    publicUrl.search ||
    publicUrl.hash
  ) {
    throw new ConfigError(
      'PUBLIC_BASE_URL must be an HTTP(S) origin without a path or credentials.',
    );
  }
  const isLoopback = isLoopbackHost(publicUrl.hostname);
  const allowInsecureRemoteHttp =
    parseBooleanEnv(env.ALLOW_INSECURE_REMOTE_HTTP, false, 'ALLOW_INSECURE_REMOTE_HTTP') ||
    parseBooleanEnv(env.ALLOW_INSECURE_HTTP, false, 'ALLOW_INSECURE_HTTP');
  if (publicUrl.protocol !== 'https:' && !isLoopback && !allowInsecureRemoteHttp) {
    throw new ConfigError(
      'PUBLIC_BASE_URL must use HTTPS for non-loopback deployments. To allow plain HTTP for testing only, set ALLOW_INSECURE_REMOTE_HTTP=true.',
    );
  }

  let trustProxy: boolean | string = false;
  const rawTrust = env.WEB_TRUST_PROXY?.trim();
  if (rawTrust) {
    const lower = rawTrust.toLowerCase();
    if (lower === 'true' || lower === '1') trustProxy = true;
    else if (lower === 'false' || lower === '0') trustProxy = false;
    else trustProxy = rawTrust; // proxy IP or CIDR list
  }

  const publicBaseUrl = publicUrl.origin;
  const callbackUrl = `${publicBaseUrl}/auth/atlassian/callback`;
  const registeredRedirect = env.ATLASSIAN_OAUTH_REDIRECT_URI?.trim();
  const dataDir = path.resolve(rootDir, env.WEB_DATA_DIR ?? 'data');
  const secretsDir = path.resolve(rootDir, env.WEB_SECRETS_DIR ?? 'secrets');
  const tokenPath = path.resolve(
    secretsDir,
    env.WEB_OAUTH_TOKEN_FILENAME ?? 'atlassian-oauth.json',
  );
  if (!tokenPath.startsWith(secretsDir + path.sep)) {
    throw new ConfigError('WEB_OAUTH_TOKEN_FILENAME must remain inside WEB_SECRETS_DIR.');
  }

  const oauthWriteScopeAllowed = resolveWriteScopeAllowed(env);
  const legacyWriteScopeName =
    !env.JIRA_WRITE_SCOPE_ALLOWED && Boolean(env.PILOT_WRITE_SCOPE_ALLOWED);
  let oauthScopes: string[];
  try {
    oauthScopes = validateAndNormalizeOAuthScopes(
      env.ATLASSIAN_OAUTH_SCOPES ?? DEFAULT_ATLASSIAN_OAUTH_SCOPES,
      { allowPilotCustomerDetailWrite: oauthWriteScopeAllowed },
    );
  } catch (err) {
    throw new ConfigError(
      err instanceof Error ? err.message : 'ATLASSIAN_OAUTH_SCOPES is invalid.',
    );
  }
  // Allowing updates means requesting the permission for them: without it Jira answers 401.
  if (oauthWriteScopeAllowed && !oauthScopes.includes(PILOT_WRITE_OAUTH_SCOPE)) {
    oauthScopes.push(PILOT_WRITE_OAUTH_SCOPE);
  }

  const displayName = (env.APP_DISPLAY_NAME?.trim() || 'Customer Sync').slice(0, 80);
  const adminUsername = env.ADMIN_USERNAME?.trim() || 'admin';
  if (!/^[a-zA-Z0-9._-]{3,64}$/.test(adminUsername)) {
    throw new ConfigError(
      'ADMIN_USERNAME must be 3–64 letters, digits, periods, hyphens, or underscores.',
    );
  }

  const logLevel = (env.LOG_LEVEL?.trim().toLowerCase() ?? 'info') as LogLevel;
  if (!LOG_LEVELS.includes(logLevel)) {
    throw new ConfigError('LOG_LEVEL must be one of: debug, info, warn, error.');
  }

  const tenantId = firstEnv(env, 'MICROSOFT_TENANT_ID', 'ENTRA_TENANT_ID');
  const clientId = firstEnv(env, 'MICROSOFT_CLIENT_ID', 'ENTRA_CLIENT_ID');
  const clientSecret =
    readSecret(env, 'MICROSOFT_CLIENT_SECRET', 'MICROSOFT_CLIENT_SECRET_FILE') ??
    firstEnv(env, 'ENTRA_CLIENT_SECRET');
  const graph =
    isConfigured(tenantId) && isConfigured(clientId) && isConfigured(clientSecret)
      ? { tenantId, clientId, clientSecret }
      : undefined;

  return {
    host: env.WEB_HOST?.trim() || '0.0.0.0',
    port,
    publicBaseUrl,
    callbackUrl,
    redirectUriMismatch: Boolean(registeredRedirect && registeredRedirect !== callbackUrl),
    secureCookies: publicUrl.protocol === 'https:',
    dataDir,
    secretsDir,
    tokenPath,
    displayName,
    logoFile: env.APP_LOGO_FILE?.trim() || undefined,
    adminUsername,
    bootstrapPassword: readSecret(
      env,
      'ADMIN_INITIAL_PASSWORD',
      'ADMIN_INITIAL_PASSWORD_FILE',
      true,
    ),
    oauthClientId: env.ATLASSIAN_OAUTH_CLIENT_ID?.trim() || undefined,
    oauthClientSecret: readSecret(
      env,
      'ATLASSIAN_OAUTH_CLIENT_SECRET',
      'ATLASSIAN_OAUTH_CLIENT_SECRET_FILE',
    ),
    oauthScopes,
    oauthWriteScopeAllowed,
    legacyWriteScopeName,
    atlassianSiteUrl: isConfigured(env.ATLASSIAN_SITE_URL) ? env.ATLASSIAN_SITE_URL : undefined,
    atlassianCloudId: isConfigured(env.ATLASSIAN_CLOUD_ID) ? env.ATLASSIAN_CLOUD_ID : undefined,
    graph,
    graphConfigured: Boolean(graph),
    serviceDeskIds: resolveServiceDeskIds(env),
    trustProxy,
    allowInsecureRemoteHttp,
    logLevel,
  };
}
