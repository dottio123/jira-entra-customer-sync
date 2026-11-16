import { IJiraAuthProvider } from './jira-auth';
import { JiraHttpError } from './readonly-http-client';
import { RequestBudgetGuard } from './request-budget-guard';
import { getSyncedField } from './field-catalog';
import { Logger, logger } from '../../utils/logger';
import { USER_AGENT } from '../../version';

export interface CustomerDetailWriteResult {
  statusCode: number;
  requestId?: string;
}

export interface JiraCustomerDetailWriteClientOptions {
  authProvider: IJiraAuthProvider;
  cloudId: string | (() => Promise<string>);
  budgetGuard: RequestBudgetGuard;
  fetchFn?: typeof fetch;
  log?: Logger;
  /** Maximum time to wait for Jira to answer a write. Defaults to 30 seconds. */
  requestTimeoutMs?: number;
}

/**
 * Raised when a write request was sent but no HTTP answer arrived (network failure or timeout).
 * Jira may or may not have applied the change, so callers must halt and never retry blindly.
 */
export class JiraWriteOutcomeUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JiraWriteOutcomeUnknownError';
  }
}

/** Maps a canonical field key to its default Jira CSM field name. */
export function resolveJiraCsmFieldName(fieldName: string): string {
  return getSyncedField(fieldName)?.jiraName ?? fieldName.trim();
}

export function normalizeJiraCustomerDetailWriteValue(fieldName: string, value: string): string {
  const trimmed = value.trim();
  if (fieldName.trim() === 'emailAddress' || fieldName.trim().toLowerCase() === 'email address') {
    return trimmed.toLowerCase();
  }
  if (!fieldName.trim().toLowerCase().includes('phone')) return trimmed;

  const compact = trimmed.replace(/[()\-.\s]/g, '');
  if (!/^\+?\d+$/.test(compact)) return trimmed;
  return compact.startsWith('+') ? compact.slice(1) : compact;
}

/**
 * Narrow Jira CSM writer for one operation only:
 * PUT /api/v1/customer/{customerId}/details?fieldName={fieldName}
 *
 * It intentionally exposes no generic request method and performs no automatic retries.
 */
export class JiraCustomerDetailWriteClient {
  private readonly authProvider: IJiraAuthProvider;
  private readonly cloudIdProvider: string | (() => Promise<string>);
  private readonly budgetGuard: RequestBudgetGuard;
  private readonly fetchFn: typeof fetch;
  private readonly log: Logger;
  private readonly requestTimeoutMs: number;

  constructor(options: JiraCustomerDetailWriteClientOptions) {
    this.authProvider = options.authProvider;
    this.cloudIdProvider = options.cloudId;
    this.budgetGuard = options.budgetGuard;
    this.fetchFn = options.fetchFn ?? fetch;
    this.log = options.log ?? logger;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  /**
   * @param fieldName canonical field key (for example `title`) or a Jira field name.
   * @param jiraFieldName the field name as discovered on this Jira site; defaults to the
   *   catalog name for the canonical key.
   */
  async setCustomerDetail(
    customerId: string,
    fieldName: string,
    value: string,
    jiraFieldName?: string,
  ): Promise<CustomerDetailWriteResult> {
    const normalizedCustomerId = customerId.trim();
    const normalizedFieldName = fieldName.trim();
    const csmFieldName = jiraFieldName?.trim() || resolveJiraCsmFieldName(normalizedFieldName);
    const normalizedValue = normalizeJiraCustomerDetailWriteValue(normalizedFieldName, value);
    if (!normalizedCustomerId || !normalizedFieldName || !normalizedValue) {
      throw new Error(
        'Customer ID, field name, and non-empty value are required for a customer detail write.',
      );
    }

    this.budgetGuard.recordOperation('customerDetailWrite');
    const cloudId =
      typeof this.cloudIdProvider === 'function'
        ? await this.cloudIdProvider()
        : this.cloudIdProvider;
    const url = `https://api.atlassian.com/jsm/csm/cloudid/${encodeURIComponent(
      cloudId,
    )}/api/v1/customer/${encodeURIComponent(
      normalizedCustomerId,
    )}/details?fieldName=${encodeURIComponent(csmFieldName)}`;

    const authorization = await this.authProvider.getAuthHeader();
    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: 'PUT',
        headers: {
          Authorization: authorization,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-ExperimentalApi': 'opt-in',
          'User-Agent': USER_AGENT,
        },
        body: JSON.stringify({ values: [normalizedValue] }),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (err) {
      const reason =
        err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
          ? 'timed out'
          : 'failed before Jira responded';
      throw new JiraWriteOutcomeUnknownError(
        `Jira customer detail update ${reason}; the outcome is unknown.`,
      );
    }

    const requestId = response.headers.get('x-atlassian-request-id') ?? undefined;
    if (!response.ok) {
      let responseBody: unknown;
      try {
        const text = await response.text();
        responseBody = text ? JSON.parse(text) : undefined;
      } catch {
        responseBody = undefined;
      }
      throw new JiraHttpError(
        `Jira customer detail update failed with status ${response.status}`,
        response.status,
        requestId,
        responseBody,
        undefined,
        new URL(url).pathname,
      );
    }

    this.log.info('Jira customer detail update accepted', {
      fieldName: normalizedFieldName,
      statusCode: response.status,
      requestId,
    });
    return { statusCode: response.status, requestId };
  }
}
