/**
 * Strictly GET-Only Jira HTTP Client.
 *
 * ARCHITECTURAL PRINCIPLES:
 * 1. Read-Only Safety: This client strictly rejects any non-GET HTTP methods.
 *    Any attempt to execute POST, PUT, PATCH, DELETE, or any other mutating verb
 *    throws an error before any network request can occur.
 * 2. Isolation: Authentication headers are retrieved from IJiraAuthProvider.
 * 3. Resilience: Transient status codes (429, 500, 502, 503, 504) are retried
 *    with bounded backoff and Retry-After header parsing. Permanent errors
 *    (400, 401, 403, 404) fail immediately without retrying.
 * 4. Privacy: Request headers, tokens, and sensitive details are never logged.
 */

import { IJiraAuthProvider } from './jira-auth';
import { Logger, logger } from '../../utils/logger';
import { RequestBudgetGuard } from './request-budget-guard';
import { USER_AGENT } from '../../version';

export class JiraHttpError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly requestId?: string,
    public readonly responseBody?: unknown,
    public readonly loginReason?: string,
    public readonly endpoint?: string,
  ) {
    super(message);
    this.name = 'JiraHttpError';
  }
}

export interface GetOnlyHttpClientOptions {
  maxRetries?: number;
  retryDelayMs?: number;
  maxDelayMs?: number;
  log?: Logger;
  fetchFn?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void>;
  budgetGuard?: RequestBudgetGuard;
  /** Per-attempt timeout; a timed-out GET is retried like any other network error. */
  requestTimeoutMs?: number;
}

export interface HttpResponse<T> {
  data: T;
  status: number;
  headers: Headers;
  requestId?: string;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class GetOnlyJiraHttpClient {
  private readonly authProvider: IJiraAuthProvider;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly log: Logger;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly budgetGuard?: RequestBudgetGuard;
  private readonly requestTimeoutMs: number;
  private retryCount: number = 0;

  constructor(authProvider: IJiraAuthProvider, options: GetOnlyHttpClientOptions = {}) {
    this.authProvider = authProvider;
    this.maxRetries = Math.max(0, options.maxRetries ?? 3);
    this.retryDelayMs = Math.max(50, options.retryDelayMs ?? 500);
    this.maxDelayMs = options.maxDelayMs ?? 30000;
    this.log = options.log ?? logger;
    this.fetchFn = options.fetchFn ?? fetch;
    this.sleep = options.sleepFn ?? defaultSleep;
    this.budgetGuard = options.budgetGuard;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  /**
   * Returns total transient retry attempts executed by this client.
   */
  getRetryCount(): number {
    return this.retryCount;
  }

  /**
   * Executes a GET request with bounded retries for transient failures.
   */
  async get<T>(url: string, extraHeaders?: Record<string, string>): Promise<HttpResponse<T>> {
    return this.executeWithRetry<T>(url, extraHeaders);
  }

  /**
   * Guard method to prevent any mutating requests.
   * If any caller attempts to send a non-GET method, an error is thrown.
   */
  async request(
    method: string,
    url: string,
    _body?: unknown,
    _headers?: Record<string, string>,
  ): Promise<never> {
    const normalizedMethod = (method || '').trim().toUpperCase();
    if (normalizedMethod !== 'GET') {
      throw new Error(
        `GetOnlyJiraHttpClient strictly enforces GET-only requests. Attempted mutating method: ${normalizedMethod} to ${url}`,
      );
    }
    throw new Error('Use get() method for GET requests.');
  }

  private async executeWithRetry<T>(
    url: string,
    extraHeaders?: Record<string, string>,
  ): Promise<HttpResponse<T>> {
    let attempt = 0;

    while (true) {
      const authHeader = await this.authProvider.getAuthHeader();
      const headers: Record<string, string> = {
        Accept: 'application/json',
        'X-Atlassian-Token': 'no-check',
        'User-Agent': USER_AGENT,
        Authorization: authHeader,
        ...extraHeaders,
      };

      try {
        const response = await this.fetchFn(url, {
          method: 'GET',
          headers,
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        });

        const requestId =
          response.headers.get('x-atlassian-request-id') ??
          response.headers.get('x-request-id') ??
          undefined;

        if (response.ok) {
          let data: T;
          const text = await response.text();
          try {
            data = (text.length > 0 ? JSON.parse(text) : {}) as T;
          } catch {
            data = text as unknown as T;
          }

          return {
            data,
            status: response.status,
            headers: response.headers,
            requestId,
          };
        }

        const statusCode = response.status;
        const isTransient =
          statusCode === 429 ||
          statusCode === 500 ||
          statusCode === 502 ||
          statusCode === 503 ||
          statusCode === 504;

        let errorBody: unknown;
        try {
          const text = await response.text();
          try {
            errorBody = JSON.parse(text);
          } catch {
            errorBody = text.slice(0, 300);
          }
        } catch {
          errorBody = undefined;
        }

        const loginReason = response.headers.get('x-seraph-loginreason') ?? undefined;
        let endpoint: string | undefined;
        try {
          endpoint = new URL(url).pathname;
        } catch {
          endpoint = undefined;
        }

        // If non-transient error (400, 401, 403, 404, etc.) or max retries exceeded, throw immediately
        if (!isTransient || attempt >= this.maxRetries) {
          throw new JiraHttpError(
            `Jira API request failed with status ${statusCode}`,
            statusCode,
            requestId,
            errorBody,
            loginReason,
            endpoint,
          );
        }

        attempt++;
        this.retryCount++;
        this.budgetGuard?.recordRetry();

        // Determine backoff delay
        let delayMs: number;
        const retryAfterHeader = response.headers.get('retry-after');
        if (retryAfterHeader) {
          const parsedSec = parseInt(retryAfterHeader, 10);
          if (!isNaN(parsedSec) && parsedSec >= 0) {
            delayMs = parsedSec * 1000;
          } else {
            const dateParsed = Date.parse(retryAfterHeader);
            if (!isNaN(dateParsed)) {
              delayMs = Math.max(0, dateParsed - Date.now());
            } else {
              delayMs = this.calculateExponentialBackoff(attempt);
            }
          }
        } else {
          delayMs = this.calculateExponentialBackoff(attempt);
        }

        delayMs = Math.min(delayMs, this.maxDelayMs);

        this.log.warn('Jira transient HTTP error encountered; retrying request', {
          attempt,
          maxRetries: this.maxRetries,
          delayMs,
          statusCode,
          requestId,
        });

        await this.sleep(delayMs);
      } catch (error) {
        if (error instanceof JiraHttpError) {
          throw error;
        }

        attempt++;
        if (attempt > this.maxRetries) {
          throw new JiraHttpError(
            `Jira network request failed after ${this.maxRetries} retries`,
            0,
          );
        }

        this.retryCount++;
        this.budgetGuard?.recordRetry();

        const delayMs = Math.min(this.calculateExponentialBackoff(attempt), this.maxDelayMs);

        this.log.warn('Jira network error encountered; retrying request', {
          attempt,
          maxRetries: this.maxRetries,
          delayMs,
          reason: 'NETWORK_ERROR',
        });

        await this.sleep(delayMs);
      }
    }
  }

  private calculateExponentialBackoff(attempt: number): number {
    const exponential = this.retryDelayMs * Math.pow(2, attempt - 1);
    const jitter = Math.floor(Math.random() * (this.retryDelayMs / 2));
    return exponential + jitter;
  }
}
