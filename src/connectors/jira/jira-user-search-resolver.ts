/**
 * Jira Platform User Search Customer Identity Resolver.
 *
 * ARCHITECTURAL PRINCIPLE:
 * This adapter implements CustomerIdentityResolverPort using the scoped-token Jira API gateway:
 * (https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3/user/search?query={email}).
 *
 * NOTE: This is treated as an experimental identity-resolution strategy, not a guaranteed
 * production strategy, isolated behind CustomerIdentityResolverPort so it can be replaced
 * independently from customer profile retrieval.
 *
 * Strict Resolution Rules:
 * 1. Require emailAddress to be present (return EMAIL_UNAVAILABLE if missing or hidden).
 * 2. Require exact case-insensitive match on normalized email (reject all fuzzy results).
 * 3. Require account to be active (active === true).
 * 4. Require exactly one matching account (return AMBIGUOUS if > 1).
 */

import { CustomerIdentityResolverPort, IdentityResolutionResult } from '../../domain';
import { GetOnlyJiraHttpClient } from './readonly-http-client';
import { JiraUserSearchResult } from './jira-csm-types';
import { RequestBudgetGuard } from './request-budget-guard';
import { Logger, logger } from '../../utils/logger';
import { hashIdentifier } from '../../utils/privacy';

export interface JiraUserSearchResolverOptions {
  cloudId?: string | (() => Promise<string> | string);
  siteUrl?: string;
  httpClient: GetOnlyJiraHttpClient;
  budgetGuard?: RequestBudgetGuard;
  log?: Logger;
}

export class JiraUserSearchResolver implements CustomerIdentityResolverPort {
  private readonly cloudId?: string | (() => Promise<string> | string);
  private readonly siteUrl?: string;
  private readonly httpClient: GetOnlyJiraHttpClient;
  private readonly budgetGuard?: RequestBudgetGuard;
  private readonly log: Logger;

  constructor(options: JiraUserSearchResolverOptions) {
    if (!options.cloudId && !options.siteUrl) {
      throw new Error('Either Cloud ID or Site URL is required for JiraUserSearchResolver.');
    }

    this.cloudId = options.cloudId;
    this.siteUrl = options.siteUrl?.trim().replace(/\/+$/, '');
    this.httpClient = options.httpClient;
    this.budgetGuard = options.budgetGuard;
    this.log = options.log ?? logger;
  }

  private async getCloudId(): Promise<string> {
    if (!this.cloudId) {
      throw new Error(
        'Cloud ID is required for JiraUserSearchResolver when siteUrl is not provided.',
      );
    }
    const raw = typeof this.cloudId === 'function' ? await this.cloudId() : this.cloudId;
    const trimmed = (raw || '').trim();
    if (!trimmed || trimmed.startsWith('placeholder')) {
      throw new Error(
        'Atlassian Cloud ID could not be determined for user search. Please set ATLASSIAN_CLOUD_ID or verify tenant info.',
      );
    }
    return trimmed;
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

    // Enforce request budget guard before issuing user search query
    this.budgetGuard?.recordOperation('userSearch');

    const url = this.siteUrl
      ? `${this.siteUrl}/rest/api/3/user/search?query=${encodeURIComponent(targetEmail)}`
      : `https://api.atlassian.com/ex/jira/${encodeURIComponent(await this.getCloudId())}/rest/api/3/user/search?query=${encodeURIComponent(targetEmail)}`;

    this.log.debug('Searching Jira users by email query', {
      customerRef,
    });

    const response = await this.httpClient.get<JiraUserSearchResult[]>(url);
    const users = Array.isArray(response.data) ? response.data : [];

    if (users.length === 0) {
      this.log.debug('No Jira user found for query', { customerRef });
      return {
        outcome: 'NOT_FOUND',
        reason: 'No user found matching email address query',
      };
    }

    // Rule: Require emailAddress to be present
    const usersWithEmail = users.filter(
      (u) => typeof u.emailAddress === 'string' && u.emailAddress.trim().length > 0,
    );

    if (usersWithEmail.length === 0) {
      this.log.debug('User search returned candidates but all emails are hidden or missing', {
        customerRef,
        candidateCount: users.length,
      });
      return {
        outcome: 'EMAIL_UNAVAILABLE',
        reason:
          'Candidate user(s) returned by search but emailAddress is missing or hidden due to privacy settings',
      };
    }

    // Rule: Require exact normalized match to requested email (reject fuzzy results)
    const exactEmailMatches = usersWithEmail.filter(
      (u) => u.emailAddress!.trim().toLowerCase() === targetEmail,
    );

    if (exactEmailMatches.length === 0) {
      this.log.debug(
        'User search returned candidates but none matched normalized email exactly; rejecting fuzzy matches',
        {
          customerRef,
          candidateCount: users.length,
        },
      );
      return {
        outcome: 'NOT_FOUND',
        reason:
          'Search returned candidates but none matched normalized email exactly (fuzzy results rejected)',
      };
    }

    // Rule: Require account to be active
    const activeExactMatches = exactEmailMatches.filter((u) => u.active === true);

    if (activeExactMatches.length === 0) {
      this.log.debug('Matching user found but account is inactive', {
        customerRef,
      });
      return {
        outcome: 'NOT_FOUND',
        reason: 'Matching user account found but account is inactive',
      };
    }

    // Rule: Require exactly one matching account
    if (activeExactMatches.length > 1) {
      this.log.warn('Multiple active Jira accounts matched exact email; resolution ambiguous', {
        customerRef,
        matchCount: activeExactMatches.length,
      });
      return {
        outcome: 'AMBIGUOUS',
        reason: `Multiple active accounts (${activeExactMatches.length}) matched the exact email address`,
        candidateCount: activeExactMatches.length,
      };
    }

    const match = activeExactMatches[0]!;
    this.log.debug('Resolved Jira customer identity', {
      customerRef,
    });

    return {
      outcome: 'RESOLVED',
      accountId: match.accountId,
      emailAddress: match.emailAddress!.trim().toLowerCase(),
      displayName: match.displayName,
    };
  }
}
