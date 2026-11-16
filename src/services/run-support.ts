import type { DirectoryPerson } from '../domain';
import type { Logger } from '../utils/logger';
import type { NotificationPayload, NotificationService } from './notification-service';

/**
 * A dependency supplied either directly or by a factory. Factories are called once at the start
 * of each run, so per-run state (request budgets, cached field discovery) never leaks across runs.
 */
export type Provider<T extends object> = T | (() => T);

export function resolveProvider<T extends object>(provider: Provider<T>): T {
  return typeof provider === 'function' ? (provider as () => T)() : provider;
}

/** Indexes directory people by trimmed, lower-cased email; people without email are omitted. */
export function buildEntraEmailIndex(people: DirectoryPerson[]): Map<string, DirectoryPerson[]> {
  const index = new Map<string, DirectoryPerson[]>();
  for (const person of people) {
    if (!person.email) continue;
    const key = person.email.trim().toLowerCase();
    const list = index.get(key) ?? [];
    list.push(person);
    index.set(key, list);
  }
  return index;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

/**
 * Makes a failure reason safe to store, display, and send in alerts: removes email addresses
 * and line breaks, and bounds the length. Our own messages pass through unchanged.
 */
export function sanitizeFailureReason(message: string): string {
  const cleaned = message
    .replace(EMAIL_PATTERN, '[email]')
    .replace(/[\r\n]+/g, ' ')
    .trim();
  return cleaned.length > 500 ? `${cleaned.slice(0, 497)}...` : cleaned;
}

/** Raised when a run stops because the service is shutting down. */
export class RunShutdownError extends Error {
  constructor() {
    super('The service is shutting down; the run was stopped before completion.');
    this.name = 'RunShutdownError';
  }
}

/** Sends an alert without ever failing the caller; delivery problems are only logged. */
export async function notifySafely(
  service: NotificationService,
  payload: NotificationPayload,
  log: Logger,
): Promise<void> {
  try {
    await service.notify(payload);
  } catch (err) {
    log.error('Alert dispatch failed', { error: sanitizeFailureReason(errorMessage(err)) });
  }
}
