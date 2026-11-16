import * as crypto from 'crypto';

/**
 * Safely masks an email address for logging without revealing full PII.
 * Example: 'alex.smith@example.com' -> 'al***@example.com'
 */
export function maskEmail(email: string | null | undefined): string {
  if (!email || email.trim() === '') {
    return '(empty)';
  }

  const trimmed = email.trim();
  const parts = trimmed.split('@');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return '***masked***';
  }

  const [local, domain] = parts;
  if (local.length <= 2) {
    return `*@${domain}`;
  }

  return `${local.substring(0, 2)}***@${domain}`;
}

/**
 * Produces a deterministic, truncated SHA-256 pseudonymous reference of an identifier (e.g. email or object ID).
 * Used in audit logs and reports to correlate actions for the same customer without logging cleartext PII.
 * NOTE: This provides pseudonymity for operational log correlation, not keyed HMAC protection or irreversible mathematical anonymity.
 */
export function hashIdentifier(identifier: string | null | undefined): string {
  if (!identifier || identifier.trim() === '') {
    return 'anon-00000000';
  }

  const normalized = identifier.trim().toLowerCase();
  const hash = crypto.createHash('sha256').update(normalized).digest('hex');
  return `ref-${hash.substring(0, 10)}`;
}

/**
 * Safely extracts an allowlisted error code from external response bodies.
 * Returns only alphanumeric uppercase/lowercase codes with underscores or hyphens,
 * or mapped safe categories. Never returns unvalidated or arbitrary text.
 */
export function extractSanitizedErrorCode(responseBody: unknown): string | undefined {
  if (!responseBody || typeof responseBody !== 'object') {
    return undefined;
  }
  const body = responseBody as Record<string, unknown>;
  if (typeof body.code === 'string' && /^[A-Z0-9_-]+$/i.test(body.code)) {
    return body.code;
  }
  if (typeof body.error === 'string' && /^[A-Z0-9_-]+$/i.test(body.error)) {
    return body.error;
  }
  if (Array.isArray(body.errorMessages) && body.errorMessages.length > 0) {
    const first = String(body.errorMessages[0]);
    if (first.toLowerCase().includes('scope')) {
      return 'SCOPE_CHECK_FAILED';
    }
    if (first.toLowerCase().includes('unauthorized')) {
      return 'UNAUTHORIZED';
    }
  }
  if (typeof body.message === 'string') {
    if (body.message.toLowerCase().includes('scope')) {
      return 'SCOPE_CHECK_FAILED';
    }
    if (body.message.toLowerCase().includes('unauthorized')) {
      return 'UNAUTHORIZED';
    }
  }
  return undefined;
}
