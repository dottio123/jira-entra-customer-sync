/**
 * Request Budget Guard for Jira Service Management Operations.
 *
 * ARCHITECTURAL PRINCIPLE:
 * In single-customer validation mode, network requests must be strictly constrained
 * In single-customer validation mode and dry-run modes, network requests must be strictly constrained
 * to prevent accidental runaway polling, batch crawling, or unbounded queries.
 *
 * Strict Budget Rules:
 * - No more than one user-search operation
 * - No more than one customer-profile operation
 * - Cloud ID and detail-field discovery may run once each
 * - Retries under the existing bounded retry policy are permitted for transient failures
 * - Configurable limits for user-search, profile retrieval, field discovery, enumeration, retries, and global cap
 * - Enforces category-specific ceilings and a global ceiling
 * - Tracks counts and retry attempts for audit reporting
 */

export type OperationCategory =
  | 'cloudIdDiscovery'
  | 'fieldDiscovery'
  | 'userSearch'
  | 'customerProfile'
  | 'customerDetailWrite'
  | 'customerEnumerationPage'
  | 'retry'
  | 'global';

export class RequestBudgetExceededError extends Error {
  constructor(
    public readonly category: OperationCategory,
    public readonly limit: number,
    public readonly attempted: number,
  ) {
    super(
      `Request budget exceeded for operation '${category}'. Maximum allowed: ${limit}, attempted: ${attempted}. Execution safely terminated.`,
    );
    this.name = 'RequestBudgetExceededError';
  }
}

export interface RequestBudgetLimits {
  cloudIdDiscovery?: number;
  fieldDiscovery?: number;
  userSearch?: number;
  customerProfile?: number;
  customerDetailWrite?: number;
  customerEnumerationPage?: number;
  retry?: number;
  global?: number;
}

export class RequestBudgetGuard {
  private readonly limits: Record<OperationCategory, number>;
  private readonly counts: Record<OperationCategory, number>;
  private retryCount: number = 0;

  constructor(customLimits: RequestBudgetLimits = {}) {
    this.limits = {
      cloudIdDiscovery: customLimits.cloudIdDiscovery ?? 1,
      fieldDiscovery: customLimits.fieldDiscovery ?? 1,
      userSearch: customLimits.userSearch ?? 1,
      customerProfile: customLimits.customerProfile ?? 1,
      customerDetailWrite: customLimits.customerDetailWrite ?? 0,
      customerEnumerationPage: customLimits.customerEnumerationPage ?? 50,
      retry: customLimits.retry ?? 10,
      global: customLimits.global ?? 1000,
    };

    this.counts = {
      cloudIdDiscovery: 0,
      fieldDiscovery: 0,
      userSearch: 0,
      customerProfile: 0,
      customerDetailWrite: 0,
      customerEnumerationPage: 0,
      retry: 0,
      global: 0,
    };
  }

  /**
   * Records an attempted logical operation.
   * Throws RequestBudgetExceededError if the budget for that category has been exceeded.
   * Throws RequestBudgetExceededError if the budget for that category or global limit has been exceeded.
   */
  recordOperation(category: OperationCategory): void {
    if (this.counts.global >= this.limits.global) {
      throw new RequestBudgetExceededError('global', this.limits.global, this.counts.global + 1);
    }

    if (this.counts[category] >= this.limits[category]) {
      throw new RequestBudgetExceededError(
        category,
        this.limits[category],
        this.counts[category] + 1,
      );
    }

    this.counts[category]++;
    this.counts.global++;
  }

  /**
   * Records a retry attempt for transient failures.
   */
  recordRetry(): void {
    this.retryCount++;
    this.counts.retry++;
  }

  /**
   * Returns total budget-tracked requests issued (excluding discovery if separate, or sum of active ops).
   */
  getRequestBudgetUsed(): number {
    return (
      this.counts.cloudIdDiscovery +
      this.counts.fieldDiscovery +
      this.counts.userSearch +
      this.counts.customerProfile +
      this.counts.customerDetailWrite +
      this.counts.customerEnumerationPage
    );
  }

  /**
   * Returns total transient retries recorded.
   */
  getRetryCount(): number {
    return this.retryCount;
  }

  /**
   * Returns configured global ceiling.
   */
  getGlobalLimit(): number {
    return this.limits.global;
  }

  /**
   * Returns current operation counts for auditing and reporting.
   */
  getCounts(): Readonly<Record<OperationCategory, number>> {
    return { ...this.counts };
  }

  /**
   * Returns configured limits.
   */
  getLimits(): Readonly<Record<OperationCategory, number>> {
    return { ...this.limits };
  }
}
