import { Logger, logger } from '../../utils/logger';

export interface RetryPolicyOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  log?: Logger;
  sleepFn?: (ms: number) => Promise<void>;
}

export interface GraphErrorInfo {
  statusCode?: number;
  code?: string;
  message?: string;
  requestId?: string;
  clientRequestId?: string;
  retryAfterSeconds?: number;
  isTransient: boolean;
}

/**
 * Extracts normalized error information from Microsoft Graph SDK / HTTP errors.
 */
export function extractGraphErrorInfo(error: unknown): GraphErrorInfo {
  if (!error || typeof error !== 'object') {
    return {
      message: String(error),
      isTransient: false,
    };
  }

  const err = error as Record<string, unknown>;
  const statusCode =
    typeof err.statusCode === 'number'
      ? err.statusCode
      : typeof err.status === 'number'
        ? err.status
        : undefined;

  let requestId: string | undefined;
  let clientRequestId: string | undefined;

  // Extract Graph request IDs from inner error or headers
  if (err.innerError && typeof err.innerError === 'object') {
    const inner = err.innerError as Record<string, unknown>;
    requestId = typeof inner['request-id'] === 'string' ? inner['request-id'] : undefined;
    clientRequestId =
      typeof inner['client-request-id'] === 'string' ? inner['client-request-id'] : undefined;
  }

  if (!requestId && err.headers && typeof err.headers === 'object') {
    const headers = err.headers as Record<string, string>;
    requestId = headers['request-id'] ?? headers['sprequestguid'];
    clientRequestId = headers['client-request-id'];
  }

  // Parse Retry-After header
  let retryAfterSeconds: number | undefined;
  if (err.headers && typeof err.headers === 'object') {
    const headers = err.headers as Record<string, string>;
    const rawRetry = headers['retry-after'] ?? headers['Retry-After'];
    if (rawRetry) {
      const parsedSec = parseInt(rawRetry, 10);
      if (!isNaN(parsedSec) && parsedSec >= 0) {
        retryAfterSeconds = parsedSec;
      }
    }
  }

  // Classify transient vs permanent error
  // Transient: 429 (throttled), 500, 502, 503, 504
  // Permanent: 400, 401, 403, 404
  const isTransient =
    statusCode === 429 ||
    statusCode === 500 ||
    statusCode === 502 ||
    statusCode === 503 ||
    statusCode === 504 ||
    err.code === 'ECONNRESET' ||
    err.code === 'ETIMEDOUT' ||
    err.code === 'ENOTFOUND';

  return {
    statusCode,
    code: typeof err.code === 'string' ? err.code : undefined,
    message: typeof err.message === 'string' ? err.message : String(error),
    requestId,
    clientRequestId,
    retryAfterSeconds,
    isTransient,
  };
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Executes an async operation with bounded exponential backoff and jitter,
 * honoring Microsoft Graph Retry-After headers for 429 throttling and 5xx errors.
 */
export async function executeWithRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryPolicyOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 30000;
  const log = options.log ?? logger;
  const sleep = options.sleepFn ?? defaultSleep;

  let attempt = 0;

  while (true) {
    try {
      return await operation(attempt);
    } catch (error) {
      attempt++;
      const errorInfo = extractGraphErrorInfo(error);

      // Do not retry non-transient errors (e.g. 400, 401, 403, 404) or if limit reached
      if (!errorInfo.isTransient || attempt > maxRetries) {
        throw error;
      }

      // Calculate backoff delay
      let delayMs: number;
      if (errorInfo.retryAfterSeconds !== undefined && errorInfo.retryAfterSeconds > 0) {
        delayMs = errorInfo.retryAfterSeconds * 1000;
      } else {
        const exponential = baseDelayMs * Math.pow(2, attempt - 1);
        const jitter = Math.floor(Math.random() * (baseDelayMs / 2));
        delayMs = exponential + jitter;
      }

      // Cap delay to maxDelayMs
      delayMs = Math.min(delayMs, maxDelayMs);

      log.warn('Microsoft Graph transient error encountered; retrying request', {
        attempt,
        maxRetries,
        delayMs,
        statusCode: errorInfo.statusCode,
        requestId: errorInfo.requestId,
        clientRequestId: errorInfo.clientRequestId,
      });

      await sleep(delayMs);
    }
  }
}
