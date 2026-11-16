/**
 * Jira Service Management Service Desk Customer Identity Resolver.
 *
 * ARCHITECTURAL PRINCIPLE:
 * This adapter implements CustomerIdentityResolverPort by querying the project-scoped
 * customer endpoint for configured JSM service desk(s):
 * GET /rest/servicedeskapi/servicedesk/{serviceDeskId}/customer?query={email}
 *
 * Unlike Jira platform user search (/rest/api/3/user/search), this resolver:
 * 1. Only resolves customers proven to belong to configured JSM service project(s).
 * 2. Uses the JSM customer scope (read:servicedesk.customer:jira-service-management).
 * 3. Never requires global Jira platform user search scopes (e.g. read:jira-user).
 *
 * Strict Resolution Rules:
 * 1. Require emailAddress to be present (return EMAIL_UNAVAILABLE if missing or hidden).
 * 2. Require exact case-insensitive match on normalized email (reject all fuzzy results).
 * 3. Require account to be active (active !== false).
 * 4. Require exactly one matching account (return AMBIGUOUS if > 1 distinct accountIds match).
 * 5. Fail-closed: 401, 403, 404, 500, network errors, and request budget failures remain ERROR.
 * 6. Never return RESOLVED from partial results if another required service-desk query failed.
 * 7. Paginate within explicit request budget; do not treat an incomplete first page as conclusive.
 */

import { CustomerIdentityResolverPort, IdentityResolutionResult } from '../../domain';
import { GetOnlyJiraHttpClient, JiraHttpError, HttpResponse } from './readonly-http-client';
import { JsmPagedCustomerResponse, JsmCustomerUser } from './jira-csm-types';
import { RequestBudgetGuard, RequestBudgetExceededError } from './request-budget-guard';
import { JsmApiAuthMode } from './jira-servicedesk-customer-scope-reader';
import { Logger, logger } from '../../utils/logger';
import { hashIdentifier } from '../../utils/privacy';

export interface JsmServiceDeskCustomerResolverOptions {
  cloudId?: string | (() => Promise<string> | string);
  siteUrl?: string;
  httpClient: GetOnlyJiraHttpClient;
  serviceDeskIds: readonly string[];
  authMode?: JsmApiAuthMode;
  budgetGuard?: RequestBudgetGuard;
  maxPagesPerDesk?: number;
  log?: Logger;
}

export class JsmServiceDeskCustomerResolver implements CustomerIdentityResolverPort {
  private readonly cloudId?: string | (() => Promise<string> | string);
  private readonly siteUrl?: string;
  private readonly httpClient: GetOnlyJiraHttpClient;
  private readonly serviceDeskIds: readonly string[];
  private readonly authMode: JsmApiAuthMode;
  private readonly budgetGuard?: RequestBudgetGuard;
  private readonly maxPagesPerDesk: number;
  private readonly log: Logger;

  constructor(options: JsmServiceDeskCustomerResolverOptions) {
    if (!options.httpClient) {
      throw new Error('GetOnlyJiraHttpClient is required for JsmServiceDeskCustomerResolver.');
    }
    if (!options.serviceDeskIds || options.serviceDeskIds.length === 0) {
      throw new Error('At least one serviceDeskId is required for JsmServiceDeskCustomerResolver.');
    }
    if (!options.cloudId && !options.siteUrl) {
      throw new Error(
        'Either Cloud ID or Site URL is required for JsmServiceDeskCustomerResolver.',
      );
    }

    this.cloudId = options.cloudId;
    this.siteUrl = options.siteUrl?.trim().replace(/\/+$/, '');
    this.httpClient = options.httpClient;
    this.serviceDeskIds = options.serviceDeskIds;
    this.authMode = options.authMode ?? (options.cloudId ? 'oauth-3lo' : 'basic-api-token');
    this.budgetGuard = options.budgetGuard;
    this.maxPagesPerDesk = Math.max(1, options.maxPagesPerDesk ?? 10);
    this.log = options.log ?? logger;
  }

  private async getCloudId(): Promise<string> {
    if (!this.cloudId) {
      throw new Error(
        'Cloud ID is required for JsmServiceDeskCustomerResolver when siteUrl is not provided.',
      );
    }
    const raw = typeof this.cloudId === 'function' ? await this.cloudId() : this.cloudId;
    const trimmed = (raw || '').trim();
    if (!trimmed || trimmed.startsWith('placeholder')) {
      throw new Error(
        'Atlassian Cloud ID could not be determined for customer search. Please set ATLASSIAN_CLOUD_ID or verify tenant info.',
      );
    }
    return trimmed;
  }

  private async getDeterministicBaseUrl(): Promise<string> {
    if (this.authMode === 'oauth-3lo' || this.authMode === 'scoped-api-token') {
      const cloudId = await this.getCloudId();
      return `https://api.atlassian.com/ex/jira/${encodeURIComponent(cloudId)}/rest/servicedeskapi`;
    }

    if (this.authMode === 'basic-api-token') {
      if (!this.siteUrl) {
        throw new Error('Site URL is required for basic-api-token customer resolution.');
      }
      return `${this.siteUrl}/rest/servicedeskapi`;
    }

    throw new Error(`Unsupported JSM_API_AUTH_MODE: '${this.authMode}'.`);
  }

  private extractSanitizedErrorCode(responseBody: unknown): string | undefined {
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
    }
    return undefined;
  }

  async resolveCustomerIdentity(normalizedEmail: string): Promise<IdentityResolutionResult> {
    const targetEmail = normalizedEmail.trim().toLowerCase();
    const customerRef = hashIdentifier(targetEmail);

    if (!targetEmail) {
      return {
        outcome: 'NOT_FOUND',
        reason: 'Provided email is empty or whitespace',
      };
    }

    const baseUrl = await this.getDeterministicBaseUrl();
    const candidateMap = new Map<string, JsmCustomerUser>();
    const accountServiceDesksMap = new Map<string, Set<string>>();

    for (const serviceDeskId of this.serviceDeskIds) {
      let start = 0;
      let isLastPage = false;
      let pageNumber = 1;
      const seenStarts = new Set<number>();

      while (!isLastPage) {
        if (pageNumber > this.maxPagesPerDesk) {
          this.log.error('Customer search pagination exceeded maximum page limit', {
            customerRef,
            serviceDeskId,
            maxPages: this.maxPagesPerDesk,
          });
          return {
            outcome: 'ERROR',
            reason: `Customer search pagination exceeded maximum page limit (${this.maxPagesPerDesk}) for service desk ${serviceDeskId}`,
          };
        }

        if (seenStarts.has(start)) {
          this.log.error('Pagination loop detected during customer search', {
            customerRef,
            serviceDeskId,
            start,
          });
          return {
            outcome: 'ERROR',
            reason: `Pagination loop detected at start offset ${start} for service desk ${serviceDeskId}`,
          };
        }
        seenStarts.add(start);

        // Record budget operation for actual network request
        try {
          this.budgetGuard?.recordOperation('userSearch');
        } catch (err) {
          if (err instanceof RequestBudgetExceededError) {
            this.log.error('Request budget exceeded during customer resolution', {
              customerRef,
              serviceDeskId,
              error: err.message,
            });
            return {
              outcome: 'ERROR',
              reason: `Request budget exceeded during customer resolution: ${err.message}`,
            };
          }
          throw err;
        }

        const url = `${baseUrl}/servicedesk/${encodeURIComponent(
          serviceDeskId,
        )}/customer?query=${encodeURIComponent(targetEmail)}&start=${start}&limit=50`;

        this.log.debug('Searching JSM service desk customers by email query', {
          customerRef,
          serviceDeskId,
          start,
          pageNumber,
        });

        let response: HttpResponse<JsmPagedCustomerResponse>;
        try {
          response = await this.httpClient.get<JsmPagedCustomerResponse>(url, {
            'X-ExperimentalApi': 'opt-in',
          });
        } catch (err) {
          if (err instanceof RequestBudgetExceededError) {
            this.log.error('Request budget exceeded during customer resolution', {
              customerRef,
              serviceDeskId,
              error: err.message,
            });
            return {
              outcome: 'ERROR',
              reason: `Request budget exceeded during customer resolution: ${err.message}`,
            };
          }

          if (err instanceof JiraHttpError) {
            const sanitizedErrorCode = this.extractSanitizedErrorCode(err.responseBody);
            this.log.error('JSM service desk customer query failed with HTTP error', {
              customerRef,
              serviceDeskId,
              statusCode: err.statusCode,
              sanitizedRequestId: err.requestId,
              sanitizedErrorCode,
            });
            return {
              outcome: 'ERROR',
              reason: `JSM service desk customer endpoint returned HTTP ${err.statusCode}`,
              statusCode: err.statusCode,
              sanitizedRequestId: err.requestId,
              sanitizedErrorCode,
            };
          }

          this.log.error(
            'Network or unexpected error querying JSM service desk customer endpoint',
            {
              customerRef,
              serviceDeskId,
              reason: 'CUSTOMER_QUERY_FAILED',
            },
          );
          return {
            outcome: 'ERROR',
            reason: 'JSM service desk customer query failed due to network or unexpected error',
          };
        }

        const data = response.data;
        if (
          !data ||
          typeof data !== 'object' ||
          !Array.isArray(data.values) ||
          typeof data.isLastPage !== 'boolean'
        ) {
          this.log.error('Malformed response from JSM service desk customer endpoint', {
            customerRef,
            serviceDeskId,
          });
          return {
            outcome: 'ERROR',
            reason:
              'Malformed response from JSM service desk customer endpoint: missing values array or non-boolean isLastPage',
            statusCode: response.status,
            sanitizedRequestId: response.requestId,
          };
        }

        // Empty nonfinal page detection: pagination cannot make forward progress and is incomplete
        if (!data.isLastPage && data.values.length === 0) {
          this.log.error('Customer search pagination received empty non-final page', {
            customerRef,
            serviceDeskId,
            start,
            pageNumber,
          });
          return {
            outcome: 'ERROR',
            reason: `Incomplete customer search pagination: received 0 results on non-final page at start offset ${start} for service desk ${serviceDeskId}`,
            statusCode: response.status,
            sanitizedRequestId: response.requestId,
          };
        }

        for (const user of data.values) {
          if (user.accountId) {
            if (!candidateMap.has(user.accountId)) {
              candidateMap.set(user.accountId, user);
            }
            let deskSet = accountServiceDesksMap.get(user.accountId);
            if (!deskSet) {
              deskSet = new Set<string>();
              accountServiceDesksMap.set(user.accountId, deskSet);
            }
            deskSet.add(serviceDeskId);
          }
        }

        isLastPage = data.isLastPage;
        if (!isLastPage) {
          start += data.values.length;
          pageNumber++;
        }
      }
    }

    const allCandidates = Array.from(candidateMap.values());

    if (allCandidates.length === 0) {
      this.log.debug('No JSM customer found for query in configured service desks', {
        customerRef,
      });
      return {
        outcome: 'NOT_FOUND',
        reason: 'No customer found matching email address query in configured service desk(s)',
      };
    }

    // Rule: Require emailAddress to be present
    const usersWithEmail = allCandidates.filter(
      (u) => typeof u.emailAddress === 'string' && u.emailAddress.trim().length > 0,
    );

    if (usersWithEmail.length === 0) {
      this.log.debug('Customer query returned candidates but all emails are hidden or missing', {
        customerRef,
        candidateCount: allCandidates.length,
      });
      return {
        outcome: 'EMAIL_UNAVAILABLE',
        reason:
          'Candidate customer(s) returned by search but emailAddress is missing or hidden due to privacy settings',
        candidateCount: allCandidates.length,
      };
    }

    // Rule: Require exact normalized match to requested email (reject fuzzy results)
    const exactEmailMatches = usersWithEmail.filter(
      (u) => u.emailAddress!.trim().toLowerCase() === targetEmail,
    );

    if (exactEmailMatches.length === 0) {
      this.log.debug(
        'Customer search returned candidates but none matched normalized email exactly; rejecting fuzzy matches',
        {
          customerRef,
          candidateCount: allCandidates.length,
        },
      );
      return {
        outcome: 'NOT_FOUND',
        reason:
          'Search returned candidates but none matched normalized email exactly (fuzzy results rejected)',
        candidateCount: allCandidates.length,
      };
    }

    // Rule: Require account to be active
    const activeExactMatches = exactEmailMatches.filter((u) => u.active !== false);

    if (activeExactMatches.length === 0) {
      this.log.debug('Matching customer found but account is inactive', {
        customerRef,
      });
      const firstInactive = exactEmailMatches[0];
      const verifiedServiceDeskIds = firstInactive?.accountId
        ? Array.from(accountServiceDesksMap.get(firstInactive.accountId) ?? [])
        : [];
      return {
        outcome: 'INACTIVE',
        reason: 'Matching customer account found but account is inactive',
        candidateCount: exactEmailMatches.length,
        verifiedServiceDeskIds,
      };
    }

    // Rule: Require exactly one matching account
    if (activeExactMatches.length > 1) {
      this.log.warn(
        'Multiple active accounts matched normalized email; rejecting ambiguous resolution',
        {
          customerRef,
          candidateCount: activeExactMatches.length,
        },
      );
      const allDesks = new Set<string>();
      for (const m of activeExactMatches) {
        if (m.accountId) {
          const desks = accountServiceDesksMap.get(m.accountId);
          if (desks) {
            for (const d of desks) allDesks.add(d);
          }
        }
      }
      return {
        outcome: 'AMBIGUOUS',
        reason: 'Multiple active accounts matched email address',
        candidateCount: activeExactMatches.length,
        verifiedServiceDeskIds: Array.from(allDesks),
      };
    }

    const resolved = activeExactMatches[0]!;
    const verifiedServiceDeskIds = Array.from(accountServiceDesksMap.get(resolved.accountId) ?? []);
    this.log.debug('Successfully resolved customer identity from JSM service desk', {
      customerRef,
      verifiedServiceDeskIds,
    });

    return {
      outcome: 'RESOLVED',
      accountId: resolved.accountId,
      emailAddress: resolved.emailAddress!,
      displayName: resolved.displayName,
      verifiedServiceDeskIds,
    };
  }
}
