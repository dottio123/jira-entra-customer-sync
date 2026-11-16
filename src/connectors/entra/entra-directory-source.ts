import { DirectoryPerson, DirectorySourcePort, ManagerLookupStatus } from '../../domain';
import { IGraphClient } from './graph-client';
import { GraphUserDto, GraphPagedResponse } from './graph-types';
import { executeWithRetry, extractGraphErrorInfo } from './retry-policy';
import { Logger, logger } from '../../utils/logger';
import { hashIdentifier } from '../../utils/privacy';

export interface EntraDirectorySourceOptions {
  includeGuestUsers?: boolean;
  managerLookupConcurrency?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  log?: Logger;
}

export class EntraDirectorySource implements DirectorySourcePort {
  private static readonly SELECTED_PROPERTIES = [
    'id',
    'displayName',
    'mail',
    'userPrincipalName',
    'jobTitle',
    'businessPhones',
    'officeLocation',
    'accountEnabled',
    'userType',
  ];

  /** Upper bound on Graph result pages; exceeding it fails closed instead of looping forever. */
  private static readonly MAX_PAGES = 10_000;

  private graphClient: IGraphClient;
  private includeGuestUsers: boolean;
  private concurrency: number;
  private maxRetries: number;
  private retryDelayMs: number;
  private log: Logger;

  private stats = {
    pagesFetched: 0,
    totalGraphUsers: 0,
    eligibleUsers: 0,
    excludedDisabled: 0,
    excludedGuests: 0,
    excludedNoEmail: 0,
    managerLookupsAttempted: 0,
    managerLookupSuccesses: 0,
    managerNotFoundCount: 0,
    managerLookupFailures: 0,
  };
  private managerResolutionDisabled: boolean = false;
  private managerPermissionError: {
    code?: string;
    statusCode?: number;
    requestId?: string;
  } | null = null;

  constructor(graphClient: IGraphClient, options: EntraDirectorySourceOptions = {}) {
    this.graphClient = graphClient;
    this.includeGuestUsers = options.includeGuestUsers ?? false;
    this.concurrency = Math.max(1, options.managerLookupConcurrency ?? 3);
    this.maxRetries = options.maxRetries ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 500;
    this.log = options.log ?? logger;
  }

  private resetRunState(): void {
    for (const key of Object.keys(this.stats) as Array<keyof typeof this.stats>) {
      this.stats[key] = 0;
    }
    this.managerResolutionDisabled = false;
    this.managerPermissionError = null;
  }

  /**
   * Returns a copy of execution statistics collected during directory operations.
   */
  public getStats() {
    return { ...this.stats };
  }

  /**
   * Returns the preserved permission error if manager lookup was halted due to HTTP 403.
   */
  public getManagerPermissionError() {
    return this.managerPermissionError;
  }

  /**
   * Returns whether manager resolution has been disabled (e.g. after HTTP 403).
   */
  public isManagerResolutionDisabled(): boolean {
    return this.managerResolutionDisabled;
  }

  /**
   * Retrieves active users from Microsoft Graph, processes all pages,
   * concurrently fetches immediate managers, and transforms users into domain DirectoryPerson models.
   */
  async getPeople(): Promise<DirectoryPerson[]> {
    // Each ingestion starts fresh: a long-lived instance must not carry state between runs.
    this.resetRunState();
    this.log.info('Fetching directory users from Microsoft Graph', {
      includeGuestUsers: this.includeGuestUsers,
      managerLookupConcurrency: this.concurrency,
    });

    const rawUsers = await this.fetchAllGraphUsers();
    this.log.info('Retrieved user records from Microsoft Graph', {
      totalGraphUsers: rawUsers.length,
    });

    // Filter active and eligible users with detailed categorical counts
    let excludedDisabled = 0;
    let excludedGuests = 0;
    let excludedNoEmail = 0;

    const eligibleUsers: GraphUserDto[] = [];
    for (const user of rawUsers) {
      if (user.accountEnabled === false) {
        excludedDisabled++;
      } else if (
        !this.includeGuestUsers &&
        ((user.userType && user.userType.toLowerCase() === 'guest') ||
          (user.userPrincipalName && user.userPrincipalName.includes('#EXT#')))
      ) {
        excludedGuests++;
      } else {
        const email = this.resolveEmail(user);
        if (!email || !email.includes('@')) {
          excludedNoEmail++;
        } else {
          eligibleUsers.push(user);
        }
      }
    }

    this.stats.totalGraphUsers = rawUsers.length;
    this.stats.eligibleUsers = eligibleUsers.length;
    this.stats.excludedDisabled = excludedDisabled;
    this.stats.excludedGuests = excludedGuests;
    this.stats.excludedNoEmail = excludedNoEmail;

    this.log.info('Filtered eligible directory users', {
      eligibleCount: eligibleUsers.length,
      excludedCount: rawUsers.length - eligibleUsers.length,
      excludedDisabled,
      excludedGuests,
      excludedNoEmail,
    });

    // Concurrently fetch managers and map to domain DirectoryPerson
    const people = await this.mapUsersToDirectoryPeople(eligibleUsers);

    this.log.info('Microsoft Graph directory processing completed', {
      pagesFetched: this.stats.pagesFetched,
      totalGraphUsers: this.stats.totalGraphUsers,
      eligibleUsers: this.stats.eligibleUsers,
      excludedDisabled: this.stats.excludedDisabled,
      excludedGuests: this.stats.excludedGuests,
      excludedNoEmail: this.stats.excludedNoEmail,
      managerLookupsAttempted: this.stats.managerLookupsAttempted,
      managerLookupSuccesses: this.stats.managerLookupSuccesses,
      managerNotFoundCount: this.stats.managerNotFoundCount,
      managerLookupFailures: this.stats.managerLookupFailures,
    });

    return people;
  }

  /**
   * Paginates through all user pages from Microsoft Graph using @odata.nextLink.
   */
  private async fetchAllGraphUsers(): Promise<GraphUserDto[]> {
    const allUsers: GraphUserDto[] = [];
    let nextLink: string | undefined = undefined;
    let pageNumber = 1;

    // Build initial OData filter (accountEnabled eq true is standard and indexed across Graph tenants)
    const filter = 'accountEnabled eq true';

    do {
      if (pageNumber > EntraDirectorySource.MAX_PAGES) {
        throw new Error(
          `Microsoft Graph returned more than ${EntraDirectorySource.MAX_PAGES} pages of users; directory ingestion stopped.`,
        );
      }
      const currentPage = pageNumber;
      const currentNextLink: string | undefined = nextLink;

      const pagedResponse: GraphPagedResponse<GraphUserDto> = await executeWithRetry(
        () =>
          this.graphClient.getUsers({
            select: EntraDirectorySource.SELECTED_PROPERTIES,
            filter: currentNextLink ? undefined : filter,
            nextLink: currentNextLink,
          }),
        {
          maxRetries: this.maxRetries,
          baseDelayMs: this.retryDelayMs,
          log: this.log,
        },
      );

      if (pagedResponse && Array.isArray(pagedResponse.value)) {
        allUsers.push(...pagedResponse.value);
      }

      this.stats.pagesFetched++;
      nextLink = pagedResponse?.['@odata.nextLink'];
      this.log.debug('Fetched Graph user page', {
        pageNumber: currentPage,
        usersInPage: pagedResponse?.value ? pagedResponse.value.length : 0,
        hasNextPage: Boolean(nextLink),
      });

      pageNumber++;
    } while (nextLink);

    return allUsers;
  }

  /**
   * Resolves email according to matching rules:
   * Mail is preferred when non-empty, otherwise userPrincipalName.
   */
  private resolveEmail(user: GraphUserDto): string | null {
    if (user.mail && user.mail.trim().length > 0) {
      return user.mail.trim();
    }
    if (user.userPrincipalName && user.userPrincipalName.trim().length > 0) {
      return user.userPrincipalName.trim();
    }
    return null;
  }

  /**
   * Extracts the first non-empty business phone number.
   */
  private resolveOfficePhone(user: GraphUserDto): string | null {
    if (Array.isArray(user.businessPhones)) {
      const firstValid = user.businessPhones.find(
        (phone) => typeof phone === 'string' && phone.trim().length > 0,
      );
      if (firstValid) {
        return firstValid.trim();
      }
    }
    return null;
  }

  /**
   * Resolves immediate manager with retry policy and 404 tolerance.
   * Other lookup failures are classified and logged safely without failing the whole sync.
   * If a 403 Forbidden is encountered, halts subsequent manager lookups safely.
   */
  private async resolveManager(user: GraphUserDto): Promise<{
    status: ManagerLookupStatus;
    name: string | null;
    error?: string;
  }> {
    if (this.managerResolutionDisabled) {
      return {
        status: 'LOOKUP_SKIPPED',
        name: null,
        error: 'Manager resolution disabled due to prior permission error (HTTP 403)',
      };
    }

    this.stats.managerLookupsAttempted++;

    try {
      const manager = await executeWithRetry(() => this.graphClient.getManager(user.id), {
        maxRetries: this.maxRetries,
        baseDelayMs: this.retryDelayMs,
        log: this.log,
      });

      if (!manager || !manager.displayName || manager.displayName.trim() === '') {
        this.stats.managerNotFoundCount++;
        return {
          status: 'NO_MANAGER',
          name: null,
        };
      }

      this.stats.managerLookupSuccesses++;
      return {
        status: 'RESOLVED',
        name: manager.displayName.trim(),
      };
    } catch (error) {
      const errorInfo = extractGraphErrorInfo(error);

      if (errorInfo.statusCode === 403 || errorInfo.code === 'Authorization_RequestDenied') {
        this.managerResolutionDisabled = true;
        this.managerPermissionError = {
          code: errorInfo.code,
          statusCode: errorInfo.statusCode,
          requestId: errorInfo.requestId,
        };
        this.stats.managerLookupFailures++;
        this.log.error(
          'Permission denied when retrieving manager from Microsoft Graph (HTTP 403); halting manager resolution for all remaining users.',
          {
            statusCode: errorInfo.statusCode,
            code: errorInfo.code,
            requestId: errorInfo.requestId,
            clientRequestId: errorInfo.clientRequestId,
          },
        );
        return {
          status: 'LOOKUP_FAILED',
          name: null,
          error: errorInfo.code ? `PERMISSION_DENIED_${errorInfo.code}` : 'PERMISSION_DENIED',
        };
      }

      this.stats.managerLookupFailures++;
      this.log.warn('Failed to retrieve manager for directory user; skipping manager field', {
        userRef: hashIdentifier(user.id),
        statusCode: errorInfo.statusCode,
        code: errorInfo.code,
        requestId: errorInfo.requestId,
        clientRequestId: errorInfo.clientRequestId,
        reason: 'GRAPH_MANAGER_LOOKUP_FAILED',
      });
      return {
        status: 'LOOKUP_FAILED',
        name: null,
        error: errorInfo.code || 'MANAGER_LOOKUP_FAILED',
      };
    }
  }

  /**
   * Maps Graph users to DirectoryPerson models with concurrency-limited manager lookups.
   */
  private async mapUsersToDirectoryPeople(users: GraphUserDto[]): Promise<DirectoryPerson[]> {
    const results: DirectoryPerson[] = new Array(users.length);
    let currentIndex = 0;

    const worker = async (): Promise<void> => {
      while (currentIndex < users.length) {
        const index = currentIndex++;
        const user = users[index];
        if (!user) continue;

        const managerResult = await this.resolveManager(user);

        results[index] = {
          sourceId: user.id,
          displayName: user.displayName,
          email: this.resolveEmail(user),
          jobTitle: user.jobTitle?.trim() || null,
          officePhone: this.resolveOfficePhone(user),
          supervisorName: managerResult.name,
          officeLocation: user.officeLocation?.trim() || null,
          managerLookupStatus: managerResult.status,
          managerLookupError: managerResult.error,
        };
      }
    };

    const workerCount = Math.min(this.concurrency, users.length);
    const workers = Array.from({ length: workerCount }, () => worker());
    await Promise.all(workers);

    return results;
  }
}
