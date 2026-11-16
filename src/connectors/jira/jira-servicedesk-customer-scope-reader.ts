/**
 * Jira Service Management Customer Scope Reader.
 *
 * ARCHITECTURAL PRINCIPLE:
 * In Jira-first synchronization architecture, Jira defines the synchronization scope authority.
 * This adapter enumerates existing customers exclusively from configured JSM service projects using:
 * GET /rest/servicedeskapi/servicedesk/{serviceDeskId}/customer
 *
 * FAIL-CLOSED REQUIREMENTS:
 * 1. Must ONLY return customers proven to belong to an explicitly configured JSM service project.
 * 2. 401 response -> stops immediately with sanitized ENUMERATION_UNAUTHORIZED.
 * 3. 403 response -> stops immediately with sanitized ENUMERATION_FORBIDDEN.
 * 4. 404 response -> stops immediately with sanitized ENUMERATION_ENDPOINT_OR_SCOPE_INVALID.
 * 5. Unsupported auth method -> stops immediately with ENUMERATION_AUTHENTICATION_UNSUPPORTED.
 * 6. NEVER automatically calls /rest/api/3/users/search.
 * 7. NEVER automatically switches between Atlassian gateway and other hosts.
 * 8. NEVER treats Jira platform accounts as JSM customers merely because accountType !== 'app',
 *    email is visible, active is true, or CSM profile endpoint accepts its accountId.
 *
 * Strictly Read-Only:
 * - Uses GetOnlyJiraHttpClient (mutation verbs reject immediately)
 * - Honors RequestBudgetGuard under category 'customerEnumerationPage'
 * - Emits zero customer PII in logs
 * - Adapts raw vendor JSM customer objects to neutral ExistingCustomerReference domain models
 */

import { ExistingCustomerReference, ExistingCustomerScopeReaderPort } from '../../domain';
import { GetOnlyJiraHttpClient, JiraHttpError, HttpResponse } from './readonly-http-client';
import { JsmPagedCustomerResponse } from './jira-csm-types';
import { RequestBudgetGuard } from './request-budget-guard';
import { Logger, logger } from '../../utils/logger';
import { extractSanitizedErrorCode } from '../../utils/privacy';

export type JsmApiAuthMode = 'scoped-api-token' | 'oauth-3lo' | 'basic-api-token';

export type ScopeReaderFailureReason =
  | 'ENUMERATION_UNAUTHORIZED'
  | 'ENUMERATION_FORBIDDEN'
  | 'ENUMERATION_ENDPOINT_OR_SCOPE_INVALID'
  | 'ENUMERATION_AUTHENTICATION_UNSUPPORTED'
  | 'ENUMERATION_ROUTING_FAILED';

export class CustomerScopeEnumerationError extends Error {
  public readonly reason: ScopeReaderFailureReason;
  public readonly statusCode?: number;
  public readonly sanitizedRequestId?: string;
  public readonly sanitizedErrorCode?: string;

  constructor(
    reason: ScopeReaderFailureReason,
    message: string,
    options?: { statusCode?: number; sanitizedRequestId?: string; sanitizedErrorCode?: string },
  ) {
    super(message);
    this.name = 'CustomerScopeEnumerationError';
    this.reason = reason;
    this.statusCode = options?.statusCode;
    this.sanitizedRequestId = options?.sanitizedRequestId;
    this.sanitizedErrorCode = options?.sanitizedErrorCode;
  }
}

export interface JiraServiceDeskCustomerScopeReaderOptions {
  cloudId?: string | (() => Promise<string>);
  siteUrl?: string;
  httpClient: GetOnlyJiraHttpClient;
  serviceDeskIds: readonly string[];
  authMode?: JsmApiAuthMode;
  budgetGuard?: RequestBudgetGuard;
  pageSize?: number;
  maxPagesPerDesk?: number;
  log?: Logger;
}

export class JiraServiceDeskCustomerScopeReader implements ExistingCustomerScopeReaderPort {
  private readonly cloudId?: string | (() => Promise<string>);
  private readonly siteUrl?: string;
  private readonly httpClient: GetOnlyJiraHttpClient;
  private readonly serviceDeskIds: readonly string[];
  private readonly authMode: JsmApiAuthMode;
  private readonly budgetGuard?: RequestBudgetGuard;
  private readonly pageSize: number;
  private readonly maxPagesPerDesk: number;
  private readonly log: Logger;
  private resolvedCloudId?: string;

  constructor(options: JiraServiceDeskCustomerScopeReaderOptions) {
    if (!options.httpClient) {
      throw new Error('GetOnlyJiraHttpClient is required for JiraServiceDeskCustomerScopeReader.');
    }
    if (!options.serviceDeskIds || options.serviceDeskIds.length === 0) {
      throw new Error(
        'At least one serviceDeskId is required for JiraServiceDeskCustomerScopeReader.',
      );
    }
    if (!options.siteUrl && !options.cloudId) {
      throw new Error(
        'Either siteUrl or cloudId is required for JiraServiceDeskCustomerScopeReader.',
      );
    }

    this.cloudId = options.cloudId;
    this.siteUrl = options.siteUrl?.trim().replace(/\/+$/, '');
    this.httpClient = options.httpClient;
    this.serviceDeskIds = options.serviceDeskIds;
    this.authMode = options.authMode ?? (options.cloudId ? 'scoped-api-token' : 'basic-api-token');
    this.budgetGuard = options.budgetGuard;
    this.pageSize = Math.min(Math.max(1, options.pageSize ?? 50), 100);
    this.maxPagesPerDesk = Math.max(1, options.maxPagesPerDesk ?? 100);
    this.log = options.log ?? logger;
  }

  private async getCloudId(): Promise<string> {
    if (this.resolvedCloudId) {
      return this.resolvedCloudId;
    }
    if (!this.cloudId) {
      throw new Error(
        'Valid Atlassian Cloud ID is required to enumerate service desk customers via scoped gateway.',
      );
    }
    const id = typeof this.cloudId === 'function' ? await this.cloudId() : this.cloudId;
    if (!id || id.trim().length === 0 || id.startsWith('placeholder')) {
      throw new Error('Valid Atlassian Cloud ID is required to enumerate service desk customers.');
    }
    this.resolvedCloudId = id.trim();
    return this.resolvedCloudId;
  }

  /**
   * Resolves the single deterministic JSM API base URL according to configured authMode.
   * STRICT GUARANTEE: Never dynamically falls back or switches hosts.
   */
  private async getDeterministicBaseUrl(): Promise<string> {
    if (this.authMode === 'oauth-3lo') {
      const cloudId = await this.getCloudId();
      return `https://api.atlassian.com/ex/jira/${encodeURIComponent(cloudId)}/rest/servicedeskapi`;
    }

    if (this.authMode === 'scoped-api-token') {
      const cloudId = await this.getCloudId();
      return `https://api.atlassian.com/ex/jira/${encodeURIComponent(cloudId)}/rest/servicedeskapi`;
    }

    if (this.authMode === 'basic-api-token') {
      if (!this.siteUrl) {
        throw new CustomerScopeEnumerationError(
          'ENUMERATION_ROUTING_FAILED',
          'Site URL is required for basic-api-token authentication routing.',
        );
      }
      return `${this.siteUrl}/rest/servicedeskapi`;
    }

    throw new CustomerScopeEnumerationError(
      'ENUMERATION_AUTHENTICATION_UNSUPPORTED',
      `Unsupported JSM_API_AUTH_MODE: '${this.authMode}'.`,
    );
  }

  /**
   * Enumerates existing customer references strictly proven to belong to configured service projects.
   * Fails closed immediately on 400, 401, 403, 404, or routing failure without any fallback.
   * Deduplicates customers across multiple configured service projects by stable Jira accountId.
   */
  async *listExistingCustomers(): AsyncIterable<ExistingCustomerReference> {
    const baseUrl = await this.getDeterministicBaseUrl();
    const seenGlobalAccountIds = new Set<string>();

    for (const serviceDeskId of this.serviceDeskIds) {
      let start = 0;
      let isLastPage = false;
      let pageNumber = 1;
      const seenStarts = new Set<number>();

      while (!isLastPage) {
        if (pageNumber > this.maxPagesPerDesk) {
          throw new CustomerScopeEnumerationError(
            'ENUMERATION_ROUTING_FAILED',
            `Customer enumeration exceeded maximum page limit (${this.maxPagesPerDesk}) for service desk ${serviceDeskId}.`,
          );
        }

        if (seenStarts.has(start)) {
          throw new CustomerScopeEnumerationError(
            'ENUMERATION_ROUTING_FAILED',
            `Pagination loop detected at start offset ${start} for service desk ${serviceDeskId}.`,
          );
        }
        seenStarts.add(start);

        this.budgetGuard?.recordOperation('customerEnumerationPage');

        const url = `${baseUrl}/servicedesk/${encodeURIComponent(
          serviceDeskId,
        )}/customer?start=${start}&limit=${this.pageSize}`;

        this.log.debug('Fetching customer page from JSM service desk', {
          pageNumber,
          start,
          limit: this.pageSize,
          authMode: this.authMode,
        });

        let response: HttpResponse<JsmPagedCustomerResponse>;
        try {
          response = await this.httpClient.get<JsmPagedCustomerResponse>(url, {
            'X-ExperimentalApi': 'opt-in',
          });
        } catch (err) {
          if (err instanceof JiraHttpError) {
            const sanitizedErrorCode = extractSanitizedErrorCode(err.responseBody);
            const sanitizedRequestId = err.requestId;

            if (err.statusCode === 400) {
              this.log.error(
                'JSM customer enumeration bad request (400). Stopping with fail-closed result.',
                {
                  statusCode: 400,
                  sanitizedErrorCode,
                  sanitizedRequestId,
                  authMode: this.authMode,
                },
              );
              throw new CustomerScopeEnumerationError(
                'ENUMERATION_ROUTING_FAILED',
                'JSM service project customer endpoint returned 400 Bad Request.',
                { statusCode: 400, sanitizedRequestId, sanitizedErrorCode },
              );
            }

            if (err.statusCode === 401) {
              this.log.error(
                'JSM customer enumeration unauthorized (401). Stopping with fail-closed result.',
                {
                  statusCode: 401,
                  sanitizedErrorCode,
                  sanitizedRequestId,
                  authMode: this.authMode,
                },
              );
              throw new CustomerScopeEnumerationError(
                'ENUMERATION_UNAUTHORIZED',
                'JSM service project customer endpoint returned 401 Unauthorized.',
                { statusCode: 401, sanitizedRequestId, sanitizedErrorCode },
              );
            }

            if (err.statusCode === 403) {
              this.log.error(
                'JSM customer enumeration forbidden (403). Stopping with fail-closed result.',
                {
                  statusCode: 403,
                  sanitizedErrorCode,
                  sanitizedRequestId,
                  authMode: this.authMode,
                },
              );
              throw new CustomerScopeEnumerationError(
                'ENUMERATION_FORBIDDEN',
                'JSM service project customer endpoint returned 403 Forbidden.',
                { statusCode: 403, sanitizedRequestId, sanitizedErrorCode },
              );
            }

            if (err.statusCode === 404) {
              this.log.error(
                'JSM customer enumeration endpoint or scope invalid (404). Stopping with fail-closed result.',
                {
                  statusCode: 404,
                  sanitizedErrorCode,
                  sanitizedRequestId,
                  authMode: this.authMode,
                },
              );
              throw new CustomerScopeEnumerationError(
                'ENUMERATION_ENDPOINT_OR_SCOPE_INVALID',
                'JSM service project customer endpoint or service desk ID invalid (404 Not Found).',
                { statusCode: 404, sanitizedRequestId, sanitizedErrorCode },
              );
            }

            throw new CustomerScopeEnumerationError(
              'ENUMERATION_ROUTING_FAILED',
              `JSM customer enumeration HTTP request failed with status ${err.statusCode}.`,
              { statusCode: err.statusCode, sanitizedRequestId, sanitizedErrorCode },
            );
          }

          const msg = err instanceof Error ? err.message : String(err);
          throw new CustomerScopeEnumerationError('ENUMERATION_ROUTING_FAILED', msg);
        }

        const data = response.data;
        if (!data || typeof data !== 'object') {
          throw new CustomerScopeEnumerationError(
            'ENUMERATION_ROUTING_FAILED',
            'Unexpected response shape from JSM customer enumeration endpoint: root is not an object.',
          );
        }

        const values = Array.isArray(data.values) ? data.values : [];

        // Validate contradictory pagination
        if (
          data.isLastPage === true &&
          typeof data.size === 'number' &&
          data.size > 0 &&
          values.length === 0
        ) {
          throw new CustomerScopeEnumerationError(
            'ENUMERATION_ROUTING_FAILED',
            'Contradictory pagination metadata returned from JSM customer enumeration endpoint.',
          );
        }

        // Validate next-page link if present
        const linksRecord =
          data._links && typeof data._links === 'object'
            ? (data._links as Record<string, unknown>)
            : undefined;
        const nextLink =
          linksRecord && typeof linksRecord.next === 'string' ? linksRecord.next : undefined;

        if (nextLink && nextLink.length > 0) {
          try {
            const nextUrl = new URL(nextLink);
            const expectedHost =
              this.authMode === 'basic-api-token' && this.siteUrl
                ? new URL(this.siteUrl).hostname
                : 'api.atlassian.com';

            if (nextUrl.hostname !== expectedHost) {
              throw new CustomerScopeEnumerationError(
                'ENUMERATION_ROUTING_FAILED',
                `Untrusted host in next page link: '${nextUrl.hostname}'. Expected '${expectedHost}'.`,
              );
            }
            if (!nextUrl.pathname.includes('/rest/servicedeskapi/')) {
              throw new CustomerScopeEnumerationError(
                'ENUMERATION_ROUTING_FAILED',
                'Invalid API path family in next page link.',
              );
            }
          } catch (urlErr) {
            if (urlErr instanceof CustomerScopeEnumerationError) throw urlErr;
            throw new CustomerScopeEnumerationError(
              'ENUMERATION_ROUTING_FAILED',
              'Malformed next page URL in customer enumeration response.',
            );
          }
        }

        for (const user of values) {
          // Reject customer records missing stable identifier
          if (!user || typeof user.accountId !== 'string' || user.accountId.trim().length === 0) {
            throw new CustomerScopeEnumerationError(
              'ENUMERATION_ROUTING_FAILED',
              'Customer record missing stable Jira identifier (accountId).',
            );
          }

          // Deduplicate by stable Jira identifier across configured service desks
          if (seenGlobalAccountIds.has(user.accountId)) {
            continue;
          }
          seenGlobalAccountIds.add(user.accountId);

          const normalizedEmail =
            typeof user.emailAddress === 'string' && user.emailAddress.trim().length > 0
              ? user.emailAddress.trim().toLowerCase()
              : null;

          const isActive = typeof user.active === 'boolean' ? user.active : null;

          const displayName =
            typeof user.displayName === 'string' && user.displayName.trim().length > 0
              ? user.displayName.trim()
              : typeof user.name === 'string' && user.name.trim().length > 0
                ? user.name.trim()
                : null;

          yield {
            sourceCustomerId: user.accountId,
            displayName,
            normalizedEmail,
            isActive,
            sourceScopeReferences: [serviceDeskId],
          };
        }

        // Jira's isLastPage is authoritative when present: a short page is not proof of the end,
        // because the server may cap the page size below the requested limit.
        if (data.isLastPage === true) {
          isLastPage = true;
        } else if (data.isLastPage === false) {
          if (values.length === 0) {
            throw new CustomerScopeEnumerationError(
              'ENUMERATION_ROUTING_FAILED',
              'Jira reported more customers but returned an empty page; enumeration cannot be completed.',
            );
          }
          start += values.length;
          pageNumber++;
        } else if (values.length === 0 || values.length < this.pageSize) {
          isLastPage = true;
        } else {
          start += values.length;
          pageNumber++;
        }
      }
    }
  }
}
