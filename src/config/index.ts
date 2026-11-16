import * as dotenv from 'dotenv';
import { z } from 'zod';
import { maskEmail } from '../utils/privacy';
import {
  ConfigError,
  parseBooleanEnv,
  resolveServiceDeskIds,
  resolveWriteScopeAllowed,
  withoutEmptyValues,
} from './env';

export * from './env';

// Load environment variables from .env file into process.env if present
dotenv.config();

export const LogLevelSchema = z.enum(['debug', 'info', 'warn', 'error']);
export type LogLevel = z.infer<typeof LogLevelSchema>;

export const NodeEnvSchema = z.enum(['development', 'production', 'test']);
export type NodeEnv = z.infer<typeof NodeEnvSchema>;

export const DirectorySourceTypeSchema = z.enum(['memory', 'entra']);
export type DirectorySourceType = z.infer<typeof DirectorySourceTypeSchema>;

export const CustomerTargetTypeSchema = z.enum(['memory', 'jira-readonly']);
export type CustomerTargetType = z.infer<typeof CustomerTargetTypeSchema>;

export const SyncScopeSourceSchema = z.enum(['jira', 'entra']);
export type SyncScopeSource = z.infer<typeof SyncScopeSourceSchema>;

export const JsmApiAuthModeSchema = z.enum(['scoped-api-token', 'oauth-3lo', 'basic-api-token']);
export type JsmApiAuthMode = z.infer<typeof JsmApiAuthModeSchema>;

export const DEFAULT_ATLASSIAN_OAUTH_SCOPES = [
  'offline_access',
  'read:servicedesk.customer:jira-service-management',
  'read:user:jira',
  'read:customer.detail-field:jira-service-management',
  'read:customer.profile:jira-service-management',
];
export const PILOT_WRITE_OAUTH_SCOPE = 'write:customer.detail:jira-service-management';

/**
 * Validates and normalizes the OAuth scopes array.
 * Strictly requires 'read:servicedesk.customer:jira-service-management' and 'offline_access'.
 * Forbids substitution or write/deletion/customer-management scopes.
 */
export function validateAndNormalizeOAuthScopes(
  scopesInput: string | string[] | undefined,
  options: { allowPilotCustomerDetailWrite?: boolean } = {},
): string[] {
  let rawList: string[];
  if (!scopesInput) {
    rawList = [...DEFAULT_ATLASSIAN_OAUTH_SCOPES];
  } else if (Array.isArray(scopesInput)) {
    rawList = scopesInput;
  } else {
    const trimmed = scopesInput.trim();
    if (trimmed.length === 0) {
      throw new Error('Invalid configuration: ATLASSIAN_OAUTH_SCOPES cannot be empty.');
    }
    rawList = trimmed.split(/\s+/);
  }

  // Normalize repeated whitespace and remove duplicate scope entries safely
  const uniqueScopes = Array.from(
    new Set(rawList.map((s) => s.trim()).filter((s) => s.length > 0)),
  );

  if (uniqueScopes.length === 0) {
    throw new Error('Invalid configuration: ATLASSIAN_OAUTH_SCOPES cannot be empty.');
  }

  // Check for forbidden hyphenated version
  if (uniqueScopes.includes('read:servicedesk-customer:jira-service-management')) {
    throw new Error(
      "Invalid configuration: ATLASSIAN_OAUTH_SCOPES must use 'read:servicedesk.customer:jira-service-management' (with dot), not 'read:servicedesk-customer:jira-service-management'.",
    );
  }

  // 1. Require read:servicedesk.customer:jira-service-management
  if (!uniqueScopes.includes('read:servicedesk.customer:jira-service-management')) {
    throw new Error(
      "Invalid configuration: ATLASSIAN_OAUTH_SCOPES must include required scope 'read:servicedesk.customer:jira-service-management'.",
    );
  }

  // 2. Require offline_access
  if (!uniqueScopes.includes('offline_access')) {
    throw new Error(
      "Invalid configuration: ATLASSIAN_OAUTH_SCOPES must include required scope 'offline_access'.",
    );
  }

  // 3. Do not substitute read:customer:jira-service-management
  if (uniqueScopes.includes('read:customer:jira-service-management')) {
    throw new Error(
      "Invalid configuration: ATLASSIAN_OAUTH_SCOPES must not substitute 'read:customer:jira-service-management' for 'read:servicedesk.customer:jira-service-management'.",
    );
  }

  // 4-7. Disallow write, deletion, or management scopes
  for (const scope of uniqueScopes) {
    const lower = scope.toLowerCase();
    if (lower === PILOT_WRITE_OAUTH_SCOPE && options.allowPilotCustomerDetailWrite) {
      continue;
    }
    if (
      lower === 'manage:servicedesk-customer' ||
      lower === 'manage:servicedesk.customer' ||
      lower === 'manage:servicedesk-customer:jira-service-management' ||
      lower === 'manage:servicedesk.customer:jira-service-management'
    ) {
      throw new Error(
        `Invalid configuration: ATLASSIAN_OAUTH_SCOPES must not include customer management scope '${scope}'.`,
      );
    }
    if (
      lower.startsWith('write:') ||
      lower.startsWith('delete:') ||
      lower.startsWith('manage:') ||
      lower.startsWith('admin:') ||
      lower.includes(':write') ||
      lower.includes(':delete')
    ) {
      throw new Error(
        `Safety violation: ATLASSIAN_OAUTH_SCOPES must not include write, delete, or management scopes: '${scope}'.`,
      );
    }
  }

  return uniqueScopes;
}

/**
 * Validates the OAuth redirect URI without modifying or normalizing loopback hostnames.
 */
export function validateOAuthRedirectUri(uri: string | undefined): string {
  if (!uri || uri.trim().length === 0) {
    return 'http://127.0.0.1:8080/callback';
  }
  const trimmed = uri.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(
      `Invalid configuration: ATLASSIAN_OAUTH_REDIRECT_URI must be a valid URL. Received: "${uri}".`,
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      'Invalid configuration: ATLASSIAN_OAUTH_REDIRECT_URI must use http or https protocol.',
    );
  }
  // DO NOT normalize localhost to 127.0.0.1 or 127.0.0.1 to localhost
  return trimmed;
}

/**
 * Validates token path rejecting parent-path traversal.
 */
export function validateOAuthTokenPath(tokenPath: string | undefined): string {
  if (!tokenPath || tokenPath.trim().length === 0) {
    return 'secrets/atlassian-oauth.json';
  }
  const trimmed = tokenPath.trim();
  if (trimmed.includes('..')) {
    throw new Error(
      'Invalid configuration: Parent-path traversal is prohibited in ATLASSIAN_OAUTH_TOKEN_PATH.',
    );
  }
  return trimmed;
}

export const ConfigSchema = z.object({
  environment: NodeEnvSchema.default('development'),
  entra: z.object({
    tenantId: z.string().min(1, 'Microsoft Tenant ID is required'),
    clientId: z.string().min(1, 'Microsoft Client ID is required'),
    clientSecret: z.string().min(1, 'Microsoft Client Secret is required'),
    includeGuestUsers: z.boolean().default(false),
    managerLookupConcurrency: z.number().int().min(1).max(20).default(3),
    maxRetries: z.number().int().min(0).max(10).default(3),
    retryDelayMs: z.number().int().min(50).max(10000).default(500),
  }),
  jira: z.object({
    siteUrl: z.string().url('Atlassian Site URL must be a valid URL'),
    cloudId: z.string().min(1, 'Atlassian Cloud ID is required'),
    userEmail: z.string().email('Atlassian User Email must be a valid email address'),
    apiToken: z.string().min(1, 'Atlassian API Token is required'),
    authMode: JsmApiAuthModeSchema.default('scoped-api-token'),
    oauth: z.object({
      clientId: z.string().default('placeholder-oauth-client-id'),
      clientSecret: z.string().default('placeholder-oauth-client-secret'),
      redirectUri: z.string().default('http://127.0.0.1:8080/callback'),
      scopes: z.array(z.string()).default(DEFAULT_ATLASSIAN_OAUTH_SCOPES),
      tokenPath: z.string().default('secrets/atlassian-oauth.json'),
    }),
    maxRetries: z.number().int().min(0).max(10).default(3),
    retryDelayMs: z.number().int().min(50).max(10000).default(500),
  }),
  sync: z.object({
    dryRun: z.boolean().default(true),
    directorySource: DirectorySourceTypeSchema.default('memory'),
    customerTarget: CustomerTargetTypeSchema.default('memory'),
    discoveryOnly: z.boolean().default(false),
    validateExistingCustomer: z.boolean().default(false),
    validateCustomerEnumeration: z.boolean().default(false),
    investigateAuth: z.boolean().default(false),
    jsmApiAuthMode: JsmApiAuthModeSchema.default('scoped-api-token'),
    syncScopeSource: SyncScopeSourceSchema.default('entra'),
    jsmServiceDeskIds: z.array(z.string()).default([]),
    testCustomerEmail: z.string().optional(),
    pilotMode: z.boolean().default(false),
    pilotCustomerEmail: z.string().optional(),
    endToEndDryRun: z.boolean().default(false),
    endToEndMaxRecords: z.number().int().min(1).max(500).default(10),
    jiraLookupConcurrency: z.number().int().min(1).max(5).default(2),
    dryRunReportPath: z.string().optional(),
    pilotWriteScopeAllowed: z.boolean().default(false),
    pilotWriteEnabled: z.boolean().default(false),
    pilotWriteConfirmation: z.string().optional(),
    pilotWriteMaxFields: z.literal(1).default(1),
    pilotWriteReportPath: z.string().optional(),
    rolloutWriteEnabled: z.boolean().default(false),
    rolloutPreflightOnly: z.boolean().default(false),
    rolloutWriteConfirmation: z.string().optional(),
    rolloutWriteMaxCustomers: z.number().int().min(1).max(5).default(1),
    rolloutWriteMaxFieldsPerCustomer: z.number().int().min(1).max(4).default(1),
    rolloutWriteMinIntervalMs: z.number().int().min(0).max(60000).default(5000),
    rolloutApprovedReportPath: z.string().optional(),
    rolloutApprovedReportSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/i)
      .optional(),
    rolloutWriteReportPath: z.string().optional(),
    fullDirectoryDryRunAcknowledged: z.boolean().default(false),
    customerEnumerationValidated: z.boolean().default(false),
  }),
  logging: z.object({
    level: LogLevelSchema.default('info'),
  }),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

/**
 * Parses raw environment variables into a strongly-typed AppConfig object.
 * Applies safe defaults and validates formats.
 */
export function parseConfig(rawEnv: Record<string, string | undefined> = process.env): AppConfig {
  // Blank values (NAME=) behave as unset so they never mask defaults or legacy aliases.
  const env = withoutEmptyValues(rawEnv);
  const parseBoolean = parseBooleanEnv;

  const parseInteger = (val: string | undefined, defaultValue: number): number => {
    if (val === undefined || val === '') return defaultValue;
    const parsed = parseInt(val.trim(), 10);
    if (isNaN(parsed)) return defaultValue;
    return parsed;
  };

  const parseBoundedInteger = (
    val: string | undefined,
    defaultValue: number,
    min: number,
    max: number,
    varName: string,
  ): number => {
    if (val === undefined || val === '') return defaultValue;
    const parsed = parseInt(val.trim(), 10);
    if (isNaN(parsed) || parsed < min || parsed > max) {
      throw new Error(
        `Invalid configuration: ${varName} must be an integer between ${min} and ${max}.`,
      );
    }
    return parsed;
  };

  const parseMaxRecords = (val: string | undefined, defaultValue: number): number => {
    if (val === undefined || val === '') return defaultValue;
    const trimmed = val.trim().toLowerCase();
    if (
      trimmed === 'all' ||
      trimmed === 'unlimited' ||
      trimmed === 'infinity' ||
      trimmed === 'nan'
    ) {
      throw new Error(
        'Invalid configuration: END_TO_END_MAX_RECORDS must be a positive integer up to 500 (unlimited runs are not permitted).',
      );
    }
    if (!/^\d+$/.test(trimmed)) {
      throw new Error(
        'Invalid configuration: END_TO_END_MAX_RECORDS must be a positive finite integer.',
      );
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 500) {
      throw new Error(
        'Invalid configuration: END_TO_END_MAX_RECORDS must be a positive integer between 1 and 500.',
      );
    }
    return parsed;
  };

  const parseDirectorySource = (val: string | undefined): DirectorySourceType => {
    if (!val || val.trim() === '') return 'memory';
    const normalized = val.trim().toLowerCase();
    if (normalized === 'entra') return 'entra';
    return 'memory';
  };

  const parseCustomerTarget = (val: string | undefined): CustomerTargetType => {
    if (!val || val.trim() === '') return 'memory';
    const normalized = val.trim().toLowerCase();
    if (normalized === 'jira-readonly' || normalized === 'jira') {
      return 'jira-readonly';
    }
    return 'memory';
  };

  const parseSyncScopeSource = (val: string | undefined): SyncScopeSource => {
    if (!val || val.trim() === '') return 'entra';
    const normalized = val.trim().toLowerCase();
    if (normalized === 'jira') return 'jira';
    return 'entra';
  };

  const parseAuthMode = (val: string | undefined): JsmApiAuthMode => {
    if (!val || val.trim() === '') return 'scoped-api-token';
    const normalized = val.trim().toLowerCase();
    if (normalized === 'oauth-3lo') return 'oauth-3lo';
    if (normalized === 'basic-api-token') return 'basic-api-token';
    if (normalized === 'scoped-api-token') return 'scoped-api-token';

    if (val.startsWith('ATATT') || val.length > 25) {
      throw new Error(
        "Invalid configuration: JSM_API_AUTH_MODE received a token-like string instead of an authentication routing mode. JSM_API_AUTH_MODE must be one of: 'scoped-api-token', 'oauth-3lo', 'basic-api-token'. Please place Atlassian API tokens in ATLASSIAN_API_TOKEN or JIRA_API_TOKEN.",
      );
    }

    const sanitizedVal = /^[a-zA-Z0-9_-]+$/.test(val) ? val : '[unrecognized-value]';
    throw new Error(
      `Invalid configuration: JSM_API_AUTH_MODE must be one of: 'scoped-api-token', 'oauth-3lo', 'basic-api-token'. Received: '${sanitizedVal}'.`,
    );
  };

  const authMode = parseAuthMode(env.JSM_API_AUTH_MODE);
  const pilotWriteEnabled = parseBoolean(env.PILOT_WRITE_ENABLED, false, 'PILOT_WRITE_ENABLED');
  const pilotWriteScopeAllowed = resolveWriteScopeAllowed(env);
  const rolloutWriteEnabled = parseBoolean(
    env.ROLLOUT_WRITE_ENABLED,
    false,
    'ROLLOUT_WRITE_ENABLED',
  );
  const rolloutPreflightOnly = parseBoolean(
    env.ROLLOUT_PREFLIGHT_ONLY,
    false,
    'ROLLOUT_PREFLIGHT_ONLY',
  );

  const rawConfig = {
    environment: env.NODE_ENV ?? 'development',
    entra: {
      tenantId: env.MICROSOFT_TENANT_ID ?? env.ENTRA_TENANT_ID ?? 'placeholder-entra-tenant-id',
      clientId: env.MICROSOFT_CLIENT_ID ?? env.ENTRA_CLIENT_ID ?? 'placeholder-entra-client-id',
      clientSecret:
        env.MICROSOFT_CLIENT_SECRET ?? env.ENTRA_CLIENT_SECRET ?? 'placeholder-entra-client-secret',
      includeGuestUsers: parseBoolean(env.INCLUDE_GUEST_USERS, false, 'INCLUDE_GUEST_USERS'),
      managerLookupConcurrency: parseInteger(env.MANAGER_LOOKUP_CONCURRENCY, 3),
      maxRetries: parseInteger(env.GRAPH_MAX_RETRIES, 3),
      retryDelayMs: parseInteger(env.GRAPH_RETRY_DELAY_MS, 500),
    },
    jira: {
      siteUrl: env.ATLASSIAN_SITE_URL ?? env.JIRA_SITE_URL ?? 'https://placeholder.atlassian.net',
      cloudId: env.ATLASSIAN_CLOUD_ID ?? env.JIRA_CLOUD_ID ?? 'placeholder-jira-cloud-id',
      userEmail:
        env.ATLASSIAN_USER_EMAIL ??
        env.JIRA_USER_EMAIL ??
        'service-account@placeholder.example.com',
      apiToken: env.ATLASSIAN_API_TOKEN ?? env.JIRA_API_TOKEN ?? 'placeholder-jira-api-token',
      authMode,
      oauth: {
        clientId: env.ATLASSIAN_OAUTH_CLIENT_ID ?? 'placeholder-oauth-client-id',
        clientSecret: env.ATLASSIAN_OAUTH_CLIENT_SECRET ?? 'placeholder-oauth-client-secret',
        redirectUri: validateOAuthRedirectUri(env.ATLASSIAN_OAUTH_REDIRECT_URI),
        scopes: validateAndNormalizeOAuthScopes(env.ATLASSIAN_OAUTH_SCOPES, {
          allowPilotCustomerDetailWrite:
            pilotWriteScopeAllowed || pilotWriteEnabled || rolloutWriteEnabled,
        }),
        tokenPath: validateOAuthTokenPath(env.ATLASSIAN_OAUTH_TOKEN_PATH),
      },
      maxRetries: parseInteger(env.JIRA_MAX_RETRIES ?? env.ATLASSIAN_MAX_RETRIES, 3),
      retryDelayMs: parseInteger(env.JIRA_RETRY_DELAY_MS ?? env.ATLASSIAN_RETRY_DELAY_MS, 500),
    },
    sync: {
      dryRun: parseBoolean(env.SYNC_DRY_RUN, true, 'SYNC_DRY_RUN'),
      directorySource: parseDirectorySource(env.DIRECTORY_SOURCE),
      customerTarget: parseCustomerTarget(env.CUSTOMER_TARGET),
      discoveryOnly: parseBoolean(env.DISCOVERY_ONLY, false, 'DISCOVERY_ONLY'),
      validateExistingCustomer: parseBoolean(
        env.JIRA_VALIDATE_EXISTING_CUSTOMER,
        false,
        'JIRA_VALIDATE_EXISTING_CUSTOMER',
      ),
      validateCustomerEnumeration: parseBoolean(
        env.JIRA_VALIDATE_CUSTOMER_ENUMERATION,
        false,
        'JIRA_VALIDATE_CUSTOMER_ENUMERATION',
      ),
      investigateAuth: parseBoolean(
        env.JIRA_INVESTIGATE_AUTH ?? env.JSM_INVESTIGATE_AUTH,
        false,
        'JIRA_INVESTIGATE_AUTH',
      ),
      jsmApiAuthMode: authMode,
      syncScopeSource: parseSyncScopeSource(env.SYNC_SCOPE_SOURCE),
      jsmServiceDeskIds: resolveServiceDeskIds(env),
      testCustomerEmail: env.JIRA_TEST_CUSTOMER_EMAIL?.trim() || undefined,
      // Pilot Mode Resolution Rules:
      // 1. If JIRA_PILOT_MODE is explicitly set to true/false, that setting takes precedence.
      // 2. If JIRA_PILOT_MODE is unset or empty, providing a non-empty JIRA_PILOT_CUSTOMER_EMAIL
      //    implicitly enables pilotMode (pilotMode = true).
      // 3. When pilotMode is enabled:
      //    - Effective pilotCustomerEmail uses JIRA_PILOT_CUSTOMER_EMAIL if provided.
      //    - Otherwise, falls back to JIRA_TEST_CUSTOMER_EMAIL.
      //    - If neither provides a non-empty, syntactically valid email, configuration rejects startup immediately.
      ...(() => {
        const rawPilotEnv = env.JIRA_PILOT_MODE;
        const explicitPilotMode =
          rawPilotEnv !== undefined && rawPilotEnv.trim().length > 0
            ? parseBoolean(rawPilotEnv, false, 'JIRA_PILOT_MODE')
            : undefined;

        const rawPilotEmail = env.JIRA_PILOT_CUSTOMER_EMAIL?.trim();
        const hasExplicitPilotEmail = Boolean(rawPilotEmail && rawPilotEmail.length > 0);

        const pilotMode =
          explicitPilotMode !== undefined ? explicitPilotMode : hasExplicitPilotEmail;

        const rawTestEmail = env.JIRA_TEST_CUSTOMER_EMAIL?.trim();
        const effectivePilotEmail = pilotMode
          ? (hasExplicitPilotEmail ? rawPilotEmail : rawTestEmail) || undefined
          : undefined;

        return {
          pilotMode,
          pilotCustomerEmail: effectivePilotEmail,
        };
      })(),
      endToEndDryRun: parseBoolean(
        env.END_TO_END_DRY_RUN ?? env.SYNC_END_TO_END_DRY_RUN,
        false,
        'END_TO_END_DRY_RUN',
      ),
      endToEndMaxRecords: parseMaxRecords(env.END_TO_END_MAX_RECORDS, 10),
      jiraLookupConcurrency: parseBoundedInteger(
        env.JIRA_LOOKUP_CONCURRENCY,
        2,
        1,
        5,
        'JIRA_LOOKUP_CONCURRENCY',
      ),
      dryRunReportPath: env.DRY_RUN_REPORT_PATH?.trim() || undefined,
      pilotWriteScopeAllowed,
      pilotWriteEnabled,
      pilotWriteConfirmation: env.PILOT_WRITE_CONFIRMATION?.trim() || undefined,
      pilotWriteMaxFields: parseBoundedInteger(
        env.PILOT_WRITE_MAX_FIELDS,
        1,
        1,
        1,
        'PILOT_WRITE_MAX_FIELDS',
      ) as 1,
      pilotWriteReportPath: env.PILOT_WRITE_REPORT_PATH?.trim() || undefined,
      rolloutWriteEnabled,
      rolloutPreflightOnly,
      rolloutWriteConfirmation: env.ROLLOUT_WRITE_CONFIRMATION?.trim() || undefined,
      rolloutWriteMaxCustomers: parseBoundedInteger(
        env.ROLLOUT_WRITE_MAX_CUSTOMERS,
        1,
        1,
        5,
        'ROLLOUT_WRITE_MAX_CUSTOMERS',
      ),
      rolloutWriteMaxFieldsPerCustomer: parseBoundedInteger(
        env.ROLLOUT_WRITE_MAX_FIELDS_PER_CUSTOMER,
        1,
        1,
        4,
        'ROLLOUT_WRITE_MAX_FIELDS_PER_CUSTOMER',
      ),
      rolloutWriteMinIntervalMs: parseBoundedInteger(
        env.ROLLOUT_WRITE_MIN_INTERVAL_MS,
        5000,
        0,
        60000,
        'ROLLOUT_WRITE_MIN_INTERVAL_MS',
      ),
      rolloutApprovedReportPath: env.ROLLOUT_APPROVED_REPORT_PATH?.trim() || undefined,
      rolloutApprovedReportSha256:
        env.ROLLOUT_APPROVED_REPORT_SHA256?.trim().toLowerCase() || undefined,
      rolloutWriteReportPath: env.ROLLOUT_WRITE_REPORT_PATH?.trim() || undefined,
      fullDirectoryDryRunAcknowledged: parseBoolean(
        env.FULL_DIRECTORY_DRY_RUN_ACKNOWLEDGED,
        false,
        'FULL_DIRECTORY_DRY_RUN_ACKNOWLEDGED',
      ),
      customerEnumerationValidated: parseBoolean(
        env.CUSTOMER_ENUMERATION_VALIDATED ?? env.JIRA_CUSTOMER_ENUMERATION_VALIDATED,
        false,
        'CUSTOMER_ENUMERATION_VALIDATED',
      ),
    },
    logging: {
      level: env.LOG_LEVEL ? env.LOG_LEVEL.trim().toLowerCase() : 'info',
    },
  };

  const result = ConfigSchema.safeParse(rawConfig);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'config'}: ${issue.message}`)
      .join('; ');
    throw new ConfigError(`Invalid configuration: ${issues}`);
  }
  const parsed = result.data;

  if (parsed.sync.pilotWriteEnabled && parsed.sync.rolloutWriteEnabled) {
    throw new Error(
      'Safety violation: Pilot and bounded rollout write modes are mutually exclusive.',
    );
  }

  if (parsed.sync.rolloutPreflightOnly && parsed.sync.rolloutWriteEnabled) {
    throw new Error(
      'Safety violation: Bounded rollout preflight and write execution are mutually exclusive.',
    );
  }

  if (parsed.sync.rolloutPreflightOnly) {
    if (!parsed.sync.dryRun || parsed.sync.endToEndDryRun || parsed.sync.pilotMode) {
      throw new Error(
        'Safety violation: Bounded rollout preflight requires SYNC_DRY_RUN=true, END_TO_END_DRY_RUN=false, and JIRA_PILOT_MODE=false.',
      );
    }
    if (
      parsed.sync.directorySource !== 'entra' ||
      parsed.sync.customerTarget !== 'jira-readonly' ||
      parsed.sync.syncScopeSource !== 'jira' ||
      parsed.sync.jsmApiAuthMode !== 'oauth-3lo'
    ) {
      throw new Error(
        'Safety violation: Bounded rollout preflight requires Entra, Jira-first scope, jira-readonly target, and OAuth 3LO.',
      );
    }
    if (
      !parsed.sync.customerEnumerationValidated ||
      !parsed.sync.rolloutApprovedReportPath ||
      !parsed.sync.rolloutApprovedReportSha256
    ) {
      throw new Error(
        'Safety violation: Bounded rollout preflight requires validated enumeration and an approved report path and SHA-256 digest.',
      );
    }
  }

  if (parsed.sync.rolloutWriteEnabled) {
    if (!parsed.sync.pilotWriteScopeAllowed) {
      throw new Error(
        'Safety violation: Bounded rollout write requires JIRA_WRITE_SCOPE_ALLOWED=true (legacy name: PILOT_WRITE_SCOPE_ALLOWED=true).',
      );
    }
    if (parsed.sync.dryRun || parsed.sync.endToEndDryRun) {
      throw new Error(
        'Safety violation: Bounded rollout write requires SYNC_DRY_RUN=false and END_TO_END_DRY_RUN=false.',
      );
    }
    if (parsed.sync.pilotMode) {
      throw new Error('Safety violation: Bounded rollout write requires JIRA_PILOT_MODE=false.');
    }
    if (parsed.sync.rolloutWriteConfirmation !== 'APPLY_BOUNDED_CUSTOMER_DETAIL_UPDATES') {
      throw new Error(
        'Safety violation: ROLLOUT_WRITE_CONFIRMATION must equal APPLY_BOUNDED_CUSTOMER_DETAIL_UPDATES.',
      );
    }
    if (
      parsed.sync.directorySource !== 'entra' ||
      parsed.sync.customerTarget !== 'jira-readonly' ||
      parsed.sync.syncScopeSource !== 'jira' ||
      parsed.sync.jsmApiAuthMode !== 'oauth-3lo'
    ) {
      throw new Error(
        'Safety violation: Bounded rollout write requires Entra, Jira-first scope, jira-readonly target, and OAuth 3LO.',
      );
    }
    if (!parsed.sync.customerEnumerationValidated) {
      throw new Error(
        'Safety violation: Bounded rollout write requires CUSTOMER_ENUMERATION_VALIDATED=true.',
      );
    }
    if (
      parsed.sync.discoveryOnly ||
      parsed.sync.validateExistingCustomer ||
      parsed.sync.validateCustomerEnumeration ||
      parsed.sync.investigateAuth
    ) {
      throw new Error(
        'Invalid configuration: Validation and discovery modes must be disabled in bounded rollout write mode.',
      );
    }
    if (!parsed.sync.rolloutApprovedReportPath || !parsed.sync.rolloutApprovedReportSha256) {
      throw new Error(
        'Safety violation: Bounded rollout write requires an approved report path and SHA-256 digest.',
      );
    }
    if (parsed.sync.endToEndMaxRecords < parsed.sync.rolloutWriteMaxCustomers) {
      throw new Error(
        'Safety violation: END_TO_END_MAX_RECORDS cannot be lower than ROLLOUT_WRITE_MAX_CUSTOMERS.',
      );
    }
    if (!parsed.jira.oauth.scopes.includes(PILOT_WRITE_OAUTH_SCOPE)) {
      throw new Error(
        `Safety violation: Bounded rollout write requires OAuth scope '${PILOT_WRITE_OAUTH_SCOPE}'.`,
      );
    }
  }

  if (parsed.sync.pilotWriteEnabled) {
    if (!parsed.sync.pilotWriteScopeAllowed) {
      throw new Error(
        'Safety violation: Pilot write requires JIRA_WRITE_SCOPE_ALLOWED=true (legacy name: PILOT_WRITE_SCOPE_ALLOWED=true).',
      );
    }
    if (parsed.sync.dryRun) {
      throw new Error('Safety violation: Pilot write requires SYNC_DRY_RUN=false.');
    }
    if (parsed.sync.endToEndDryRun) {
      throw new Error(
        'Invalid configuration: END_TO_END_DRY_RUN must be false in pilot write mode.',
      );
    }
    if (!parsed.sync.pilotMode || !parsed.sync.pilotCustomerEmail) {
      throw new Error(
        'Safety violation: Pilot write requires JIRA_PILOT_MODE=true and a valid pilot customer email.',
      );
    }
    if (parsed.sync.pilotWriteConfirmation !== 'APPLY_SINGLE_CUSTOMER_DETAIL_UPDATE') {
      throw new Error(
        'Safety violation: PILOT_WRITE_CONFIRMATION must equal APPLY_SINGLE_CUSTOMER_DETAIL_UPDATE.',
      );
    }
    if (parsed.sync.directorySource !== 'entra') {
      throw new Error(
        "Invalid configuration: DIRECTORY_SOURCE must be 'entra' in pilot write mode.",
      );
    }
    if (parsed.sync.customerTarget !== 'jira-readonly') {
      throw new Error(
        "Invalid configuration: CUSTOMER_TARGET must be 'jira-readonly' in pilot write mode.",
      );
    }
    if (parsed.sync.syncScopeSource !== 'jira') {
      throw new Error(
        "Invalid configuration: SYNC_SCOPE_SOURCE must be 'jira' in pilot write mode.",
      );
    }
    if (parsed.sync.jsmApiAuthMode !== 'oauth-3lo') {
      throw new Error("Safety violation: Pilot write requires JSM_API_AUTH_MODE='oauth-3lo'.");
    }
    if (!parsed.sync.customerEnumerationValidated) {
      throw new Error(
        'Safety violation: Pilot write requires CUSTOMER_ENUMERATION_VALIDATED=true.',
      );
    }
    if (
      parsed.sync.discoveryOnly ||
      parsed.sync.validateExistingCustomer ||
      parsed.sync.validateCustomerEnumeration ||
      parsed.sync.investigateAuth
    ) {
      throw new Error(
        'Invalid configuration: Validation and discovery modes must be disabled in pilot write mode.',
      );
    }
    if (!parsed.jira.oauth.scopes.includes(PILOT_WRITE_OAUTH_SCOPE)) {
      throw new Error(
        `Safety violation: Pilot write requires OAuth scope '${PILOT_WRITE_OAUTH_SCOPE}'.`,
      );
    }
  }

  // Mutual exclusion checks for validation modes
  if (parsed.sync.validateCustomerEnumeration && parsed.sync.validateExistingCustomer) {
    throw new Error(
      'Invalid configuration: JIRA_VALIDATE_EXISTING_CUSTOMER must be false when JIRA_VALIDATE_CUSTOMER_ENUMERATION is true.',
    );
  }

  // Single existing-customer validation mode
  if (parsed.sync.validateExistingCustomer) {
    if (parsed.sync.discoveryOnly) {
      throw new Error(
        'Invalid configuration: DISCOVERY_ONLY must be false when JIRA_VALIDATE_EXISTING_CUSTOMER is true.',
      );
    }
    if (parsed.sync.customerTarget !== 'jira-readonly') {
      throw new Error(
        "Invalid configuration: CUSTOMER_TARGET must be 'jira-readonly' when JIRA_VALIDATE_EXISTING_CUSTOMER is true.",
      );
    }
    if (!parsed.sync.dryRun) {
      throw new Error(
        'Safety violation: Write mode is prohibited in single-customer validation (SYNC_DRY_RUN must be true).',
      );
    }
    if (!parsed.sync.testCustomerEmail || parsed.sync.testCustomerEmail.length === 0) {
      throw new Error(
        'Missing configuration: JIRA_TEST_CUSTOMER_EMAIL is required when JIRA_VALIDATE_EXISTING_CUSTOMER is true.',
      );
    }
    const emailResult = z.string().email().safeParse(parsed.sync.testCustomerEmail);
    if (!emailResult.success) {
      throw new Error(
        'Invalid configuration: JIRA_TEST_CUSTOMER_EMAIL must be a syntactically valid email address.',
      );
    }
  }

  // End-to-end dry-run mode
  if (parsed.sync.endToEndDryRun) {
    if (!parsed.sync.dryRun) {
      throw new Error(
        'Safety violation: Write mode is prohibited in end-to-end dry-run (SYNC_DRY_RUN must be true).',
      );
    }
    if (parsed.sync.directorySource !== 'entra') {
      throw new Error(
        "Invalid configuration: DIRECTORY_SOURCE must be 'entra' when END_TO_END_DRY_RUN is true.",
      );
    }
    if (parsed.sync.customerTarget !== 'jira-readonly') {
      throw new Error(
        "Invalid configuration: CUSTOMER_TARGET must be 'jira-readonly' when END_TO_END_DRY_RUN is true.",
      );
    }
    if (parsed.sync.discoveryOnly) {
      throw new Error(
        'Invalid configuration: DISCOVERY_ONLY must be false when END_TO_END_DRY_RUN is true.',
      );
    }
    if (parsed.sync.validateExistingCustomer) {
      throw new Error(
        'Invalid configuration: JIRA_VALIDATE_EXISTING_CUSTOMER must be false when END_TO_END_DRY_RUN is true.',
      );
    }
    if (parsed.sync.validateCustomerEnumeration) {
      throw new Error(
        'Invalid configuration: JIRA_VALIDATE_CUSTOMER_ENUMERATION must be false when END_TO_END_DRY_RUN is true.',
      );
    }
    if (parsed.sync.syncScopeSource === 'jira' && parsed.sync.customerTarget === 'jira-readonly') {
      if (parsed.sync.jsmServiceDeskIds.length === 0) {
        throw new Error(
          "Invalid configuration: At least one service-desk ID must be configured in JSM_SERVICE_DESK_IDS when SYNC_SCOPE_SOURCE is 'jira'.",
        );
      }
      for (const id of parsed.sync.jsmServiceDeskIds) {
        if (
          id.startsWith('<') ||
          id.endsWith('>') ||
          id.toLowerCase().includes('placeholder') ||
          id.toLowerCase().includes('service_desk_id')
        ) {
          throw new Error(
            `Invalid configuration: JSM_SERVICE_DESK_IDS contains placeholder '${id}'. Please replace it with your actual Jira Service Management service desk ID (e.g. '1') or project key (e.g. 'IT').`,
          );
        }
      }
    }
    if (parsed.sync.endToEndMaxRecords > 25 && !parsed.sync.fullDirectoryDryRunAcknowledged) {
      throw new Error(
        'Safety violation: Running more than 25 records in end-to-end dry-run requires FULL_DIRECTORY_DRY_RUN_ACKNOWLEDGED=true.',
      );
    }
  }

  // Pilot Mode Validation Constraints
  if (parsed.sync.pilotMode) {
    if (!parsed.sync.pilotCustomerEmail || parsed.sync.pilotCustomerEmail.trim().length === 0) {
      throw new Error(
        'Missing configuration: A valid pilot customer email is required when pilot mode is enabled (set JIRA_PILOT_CUSTOMER_EMAIL or JIRA_TEST_CUSTOMER_EMAIL).',
      );
    }
    const pilotEmail = parsed.sync.pilotCustomerEmail.trim();
    if (
      pilotEmail.startsWith('<') ||
      pilotEmail.endsWith('>') ||
      pilotEmail.toLowerCase().includes('placeholder')
    ) {
      throw new Error(
        `Invalid configuration: Pilot customer email '${pilotEmail}' contains a placeholder. Please provide a real customer email address.`,
      );
    }
    const emailResult = z.string().email().safeParse(pilotEmail);
    if (!emailResult.success) {
      throw new Error(
        `Invalid configuration: Pilot customer email '${pilotEmail}' must be a syntactically valid email address.`,
      );
    }
  }

  // Customer enumeration validation mode
  if (parsed.sync.validateCustomerEnumeration) {
    if (!parsed.sync.dryRun) {
      throw new Error(
        'Safety violation: Write mode is prohibited in customer enumeration validation (SYNC_DRY_RUN must be true).',
      );
    }
    if (parsed.sync.customerTarget !== 'jira-readonly') {
      throw new Error(
        "Invalid configuration: CUSTOMER_TARGET must be 'jira-readonly' when JIRA_VALIDATE_CUSTOMER_ENUMERATION is true.",
      );
    }
    if (parsed.sync.discoveryOnly) {
      throw new Error(
        'Invalid configuration: DISCOVERY_ONLY must be false when JIRA_VALIDATE_CUSTOMER_ENUMERATION is true.',
      );
    }
    if (parsed.sync.validateExistingCustomer) {
      throw new Error(
        'Invalid configuration: JIRA_VALIDATE_EXISTING_CUSTOMER must be false when JIRA_VALIDATE_CUSTOMER_ENUMERATION is true.',
      );
    }
    if (parsed.sync.jsmServiceDeskIds.length !== 1) {
      throw new Error(
        'Invalid configuration: JSM_SERVICE_DESK_IDS must contain exactly one service-desk ID when JIRA_VALIDATE_CUSTOMER_ENUMERATION is true.',
      );
    }
    const deskId = parsed.sync.jsmServiceDeskIds[0] ?? '';
    if (
      deskId.startsWith('<') ||
      deskId.endsWith('>') ||
      deskId.toLowerCase().includes('placeholder') ||
      deskId.toLowerCase().includes('service_desk_id')
    ) {
      throw new Error(
        `Invalid configuration: JSM_SERVICE_DESK_IDS contains placeholder '${deskId}'. Please replace it with your actual Jira Service Management service desk ID (e.g. '1') or project key (e.g. 'IT').`,
      );
    }
  }

  // Authentication Investigation Mode Constraints
  if (parsed.sync.investigateAuth) {
    if (!parsed.sync.dryRun) {
      throw new Error(
        'Safety violation: Write mode is prohibited in authentication investigation mode (SYNC_DRY_RUN must be true).',
      );
    }
    if (parsed.sync.jsmServiceDeskIds.length !== 1) {
      throw new Error(
        'Invalid configuration: JSM_SERVICE_DESK_IDS must contain exactly one service-desk ID when JIRA_INVESTIGATE_AUTH is true.',
      );
    }
  }

  // Pilot Customer Email Syntax Validation
  if (parsed.sync.pilotCustomerEmail) {
    const emailResult = z.string().email().safeParse(parsed.sync.pilotCustomerEmail);
    if (!emailResult.success) {
      throw new Error(
        'Invalid configuration: JIRA_PILOT_CUSTOMER_EMAIL must be a syntactically valid email address.',
      );
    }
  }

  return parsed;
}

/**
 * Returns a sanitized copy of the configuration safe for logging or debugging.
 * Secrets are masked so credentials are never leaked.
 */
export function getSanitizedConfig(config: AppConfig): Record<string, unknown> {
  return {
    environment: config.environment,
    entra: {
      tenantId: '********',
      clientId: '********',
      clientSecret: '********',
      includeGuestUsers: config.entra.includeGuestUsers,
      managerLookupConcurrency: config.entra.managerLookupConcurrency,
    },
    jira: {
      siteUrl: '********',
      cloudId: '********',
      userEmail: maskEmail(config.jira.userEmail),
      apiToken: '********',
      authMode: config.jira.authMode,
      oauth:
        config.jira.authMode === 'oauth-3lo'
          ? {
              clientId: '********',
              clientSecret: '********',
              redirectUri: config.jira.oauth.redirectUri,
              configuredScopeNames: config.jira.oauth.scopes,
            }
          : undefined,
      maxRetries: config.jira.maxRetries,
      retryDelayMs: config.jira.retryDelayMs,
    },
    sync: {
      dryRun: config.sync.dryRun,
      directorySource: config.sync.directorySource,
      customerTarget: config.sync.customerTarget,
      discoveryOnly: config.sync.discoveryOnly,
      validateExistingCustomer: config.sync.validateExistingCustomer,
      validateCustomerEnumeration: config.sync.validateCustomerEnumeration,
      investigateAuth: config.sync.investigateAuth,
      jsmApiAuthMode: config.sync.jsmApiAuthMode,
      syncScopeSource: config.sync.syncScopeSource,
      serviceDeskIdsConfigured: config.sync.jsmServiceDeskIds.length > 0,
      endToEndDryRun: config.sync.endToEndDryRun,
      endToEndMaxRecords: config.sync.endToEndMaxRecords,
      jiraLookupConcurrency: config.sync.jiraLookupConcurrency,
      dryRunReportPath: config.sync.dryRunReportPath,
      pilotWriteScopeAllowed: config.sync.pilotWriteScopeAllowed,
      pilotWriteEnabled: config.sync.pilotWriteEnabled,
      pilotWriteMaxFields: config.sync.pilotWriteMaxFields,
      pilotWriteReportPath: config.sync.pilotWriteReportPath,
      rolloutWriteEnabled: config.sync.rolloutWriteEnabled,
      rolloutPreflightOnly: config.sync.rolloutPreflightOnly,
      rolloutWriteMaxCustomers: config.sync.rolloutWriteMaxCustomers,
      rolloutWriteMaxFieldsPerCustomer: config.sync.rolloutWriteMaxFieldsPerCustomer,
      rolloutWriteMinIntervalMs: config.sync.rolloutWriteMinIntervalMs,
      rolloutApprovedReportPath: config.sync.rolloutApprovedReportPath,
      rolloutWriteReportPath: config.sync.rolloutWriteReportPath,
      fullDirectoryDryRunAcknowledged: config.sync.fullDirectoryDryRunAcknowledged,
      customerEnumerationValidated: config.sync.customerEnumerationValidated,
      testCustomerEmail: config.sync.testCustomerEmail
        ? maskEmail(config.sync.testCustomerEmail)
        : undefined,
      pilotMode: config.sync.pilotMode,
      pilotCustomerEmail: config.sync.pilotCustomerEmail
        ? maskEmail(config.sync.pilotCustomerEmail)
        : undefined,
    },
    logging: {
      level: config.logging.level,
    },
  };
}

/**
 * Convenience function to load configuration from current process environment.
 */
export function loadConfig(): AppConfig {
  return parseConfig(process.env);
}
