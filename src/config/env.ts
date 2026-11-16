/**
 * Shared environment-variable helpers used by both the web control plane and the CLI.
 */

/** A configuration problem whose message is safe to show to the operator verbatim. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export type Env = Record<string, string | undefined>;

/**
 * Returns a copy of the environment with blank values removed, so `NAME=` in a `.env` file
 * behaves exactly like leaving the variable unset (and never hides a legacy alias).
 */
export function withoutEmptyValues(env: Env): Env {
  const result: Env = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value.trim() !== '') result[key] = value;
  }
  return result;
}

/** First non-blank value among the given variable names, trimmed. */
export function firstEnv(env: Env, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

/** Parses `true`/`false`/`1`/`0` (any case). Unset uses the default; anything else is an error. */
export function parseBooleanEnv(
  value: string | undefined,
  defaultValue: boolean,
  name: string,
): boolean {
  if (value === undefined || value.trim() === '' || value === 'undefined') return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  throw new ConfigError(`Invalid boolean value for ${name}: use true or false.`);
}

/** Documented name first; the rest are accepted for backward compatibility. */
export const SERVICE_DESK_ID_ENV_NAMES = [
  'JSM_SERVICE_DESK_IDS',
  'JSM_SERVICE_DESK_ID',
  'JSM_SERVICEDESK_IDS',
  'JSM_SERVICEDESK_ID',
  'JIRA_SERVICE_DESK_IDS',
  'JIRA_SERVICE_DESK_ID',
  'JIRA_SERVICEDESK_IDS',
  'JIRA_SERVICEDESK_ID',
] as const;

/** Comma-separated Jira service desk IDs from the first configured variable; empty when unset. */
export function resolveServiceDeskIds(env: Env): string[] {
  const raw = firstEnv(env, ...SERVICE_DESK_ID_ENV_NAMES);
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Whether the single permitted Jira write scope may be requested.
 * `JIRA_WRITE_SCOPE_ALLOWED` is preferred; the legacy `PILOT_WRITE_SCOPE_ALLOWED` is still honored.
 */
export function resolveWriteScopeAllowed(env: Env): boolean {
  const preferred = env.JIRA_WRITE_SCOPE_ALLOWED;
  if (preferred !== undefined && preferred.trim() !== '') {
    return parseBooleanEnv(preferred, false, 'JIRA_WRITE_SCOPE_ALLOWED');
  }
  return parseBooleanEnv(env.PILOT_WRITE_SCOPE_ALLOWED, false, 'PILOT_WRITE_SCOPE_ALLOWED');
}
