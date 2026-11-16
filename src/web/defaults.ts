/** Single source of truth for built-in web control-plane defaults and limits. */

export const DEFAULT_SCHEDULE_CRON = '0 2 * * *';
/** Default for new installations only; existing databases keep their saved time zone. */
export const DEFAULT_SCHEDULE_TIMEZONE = 'UTC';

export const DEFAULT_MAX_CUSTOMERS_THRESHOLD = 100;
export const DEFAULT_MAX_FIELDS_THRESHOLD = 400;
/** Upper bound accepted for either safety limit. */
export const MAX_SAFETY_THRESHOLD = 100_000;

export const DEFAULT_SMTP_PORT = 587;

export const SESSION_ABSOLUTE_TTL_MS = 8 * 60 * 60 * 1000;
export const SESSION_IDLE_TTL_MS = 30 * 60 * 1000;
export const LOGIN_CSRF_TTL_SECONDS = 10 * 60;
export const OAUTH_STATE_TTL_MS = 5 * 60 * 1000;

/** Detailed per-customer run payloads are removed after this period. */
export const RETENTION_DETAILED_MS = 90 * 24 * 60 * 60 * 1000;
/** Audit events and acknowledged alerts are removed after this period. */
export const RETENTION_AUDIT_MS = 365 * 24 * 60 * 60 * 1000;

/** How long shutdown waits for an in-flight run to stop before closing storage. */
export const SHUTDOWN_RUN_WAIT_MS = 25_000;
