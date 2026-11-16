/**
 * Jira Account Directory Reader (Diagnostic Adapter).
 *
 * ARCHITECTURAL PRINCIPLES:
 * 1. Diagnostic Boundary: Implements JiraAccountDirectoryReaderPort ONLY.
 *    Does NOT implement or extend ExistingCustomerScopeReaderPort.
 * 2. Separation of Concerns: Global Jira user account enumeration lists accounts visible
 *    to the API credentials. It does NOT establish that each returned account is an existing
 *    customer associated with an explicitly configured JSM service project.
 * 3. Authority Restriction: Jira-first dry-run and future write services must NOT accept
 *    this adapter as their customer scope authority.
 * 4. Terminology: Sourced output describes "Jira accounts", never "customers".
 * 5. Strictly Read-Only: Uses GetOnlyJiraHttpClient (mutation verbs reject immediately).
 */

import { JiraAccountReference, JiraAccountDirectoryReaderPort } from '../../domain';
import { GetOnlyJiraHttpClient, HttpResponse } from './readonly-http-client';
import { JiraUserSearchResult } from './jira-csm-types';
import { RequestBudgetGuard } from './request-budget-guard';
import { Logger, logger } from '../../utils/logger';

export interface JiraAccountDirectoryReaderOptions {
  cloudId?: string | (() => Promise<string>);
  siteUrl?: string;
  httpClient: GetOnlyJiraHttpClient;
  budgetGuard?: RequestBudgetGuard;
  pageSize?: number;
  log?: Logger;
}

export class JiraAccountDirectoryReader implements JiraAccountDirectoryReaderPort {
  private readonly cloudId?: string | (() => Promise<string>);
  private readonly siteUrl?: string;
  private readonly httpClient: GetOnlyJiraHttpClient;
  private readonly budgetGuard?: RequestBudgetGuard;
  private readonly pageSize: number;
  private readonly log: Logger;
  private resolvedCloudId?: string;

  constructor(options: JiraAccountDirectoryReaderOptions) {
    if (!options.httpClient) {
      throw new Error('GetOnlyJiraHttpClient is required for JiraAccountDirectoryReader.');
    }
    if (!options.siteUrl && !options.cloudId) {
      throw new Error('Either siteUrl or cloudId is required for JiraAccountDirectoryReader.');
    }

    this.cloudId = options.cloudId;
    this.siteUrl = options.siteUrl?.trim().replace(/\/+$/, '');
    this.httpClient = options.httpClient;
    this.budgetGuard = options.budgetGuard;
    this.pageSize = Math.min(Math.max(1, options.pageSize ?? 50), 100);
    this.log = options.log ?? logger;
  }

  private async getCloudId(): Promise<string> {
    if (this.resolvedCloudId) {
      return this.resolvedCloudId;
    }
    if (!this.cloudId) {
      throw new Error(
        'Valid Atlassian Cloud ID is required to enumerate Jira accounts when siteUrl is not provided.',
      );
    }
    const id = typeof this.cloudId === 'function' ? await this.cloudId() : this.cloudId;
    if (!id || id.trim().length === 0 || id.startsWith('placeholder')) {
      throw new Error('Valid Atlassian Cloud ID is required to enumerate Jira accounts.');
    }
    this.resolvedCloudId = id.trim();
    return this.resolvedCloudId;
  }

  private async getCandidatePlatformBaseUrls(): Promise<string[]> {
    const urls: string[] = [];
    if (this.cloudId) {
      try {
        const cloudId = await this.getCloudId();
        const gatewayUrl = `https://api.atlassian.com/ex/jira/${encodeURIComponent(cloudId)}/rest/api/3`;
        urls.push(gatewayUrl);
      } catch {
        // ignore if cloudId cannot be resolved
      }
    }
    if (this.siteUrl) {
      const siteUrlPlatform = `${this.siteUrl}/rest/api/3`;
      if (!urls.includes(siteUrlPlatform)) {
        urls.push(siteUrlPlatform);
      }
    }
    return urls;
  }

  /**
   * Enumerates visible Jira user accounts across the Jira platform.
   * Diagnostic use only. Yields JiraAccountReference records.
   */
  async *listVisibleJiraAccounts(): AsyncIterable<JiraAccountReference> {
    const platformBaseUrls = await this.getCandidatePlatformBaseUrls();
    if (platformBaseUrls.length === 0) {
      throw new Error(
        'Neither cloudId nor siteUrl could provide a valid Jira Platform API base URL for user account enumeration.',
      );
    }

    let startAt = 0;
    let isLastPage = false;
    let pageNumber = 1;
    let activePlatformIndex = 0;

    while (!isLastPage) {
      this.budgetGuard?.recordOperation('userSearch');

      let response: HttpResponse<JiraUserSearchResult[]> | undefined;
      let lastPlatformError: unknown;

      for (let i = activePlatformIndex; i < platformBaseUrls.length; i++) {
        const baseUrl = platformBaseUrls[i]!;
        const url = `${baseUrl}/users/search?startAt=${startAt}&maxResults=${this.pageSize}`;

        this.log.debug('Fetching Jira accounts page from Jira Platform API', {
          pageNumber,
          startAt,
          limit: this.pageSize,
        });

        try {
          response = await this.httpClient.get<JiraUserSearchResult[]>(url);
          activePlatformIndex = i;
          break;
        } catch (err) {
          lastPlatformError = err;
          break;
        }
      }

      if (!response) {
        throw lastPlatformError || new Error('Failed to retrieve Jira accounts from Platform API.');
      }

      const users = Array.isArray(response.data) ? response.data : [];

      for (const user of users) {
        if (!user.accountId) continue;

        const normalizedEmail =
          typeof user.emailAddress === 'string' && user.emailAddress.trim().length > 0
            ? user.emailAddress.trim().toLowerCase()
            : null;

        const isActive = typeof user.active === 'boolean' ? user.active : null;

        yield {
          accountId: user.accountId,
          accountType: user.accountType,
          emailAddress: normalizedEmail,
          displayName: user.displayName || null,
          active: isActive,
        };
      }

      if (users.length === 0 || users.length < this.pageSize) {
        isLastPage = true;
      } else {
        startAt += users.length;
        pageNumber++;
      }
    }
  }
}
