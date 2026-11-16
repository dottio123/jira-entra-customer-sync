/**
 * Core Domain Models for Entra JSM Customer Sync.
 *
 * ARCHITECTURAL PRINCIPLE:
 * These domain models represent the canonical internal entities of the system.
 * They are completely vendor-neutral and decouple business synchronization logic
 * from vendor-specific schemas (Microsoft Graph, Jira Service Management REST API).
 */

/**
 * Status of the manager lookup operation from the identity directory.
 */
export type ManagerLookupStatus = 'RESOLVED' | 'NO_MANAGER' | 'LOOKUP_FAILED' | 'LOOKUP_SKIPPED';

/**
 * Vendor-neutral representation of a person from an identity directory (e.g. Microsoft Entra ID).
 */
export interface DirectoryPerson {
  sourceId: string;
  displayName: string;
  email?: string | null;
  jobTitle?: string | null;
  officePhone?: string | null;
  supervisorName?: string | null;
  officeLocation?: string | null;
  managerLookupStatus?: ManagerLookupStatus;
  managerLookupError?: string;
}

/**
 * Vendor-neutral representation of customer details in the target service desk (e.g. Jira Service Management).
 */
export interface CustomerDetails {
  email: string;
  title?: string | null;
  officePhoneNumber?: string | null;
  supervisor?: string | null;
  officeClassroom?: string | null;
  emailAddress?: string | null;
}

/**
 * Updatable fields on CustomerDetails (excluding the immutable matching key 'email').
 */
export type CustomerFieldUpdates = Partial<Omit<CustomerDetails, 'email'>>;

/**
 * Represents a discrete change between an existing target field and a candidate value.
 */
export interface FieldDiff {
  fieldName: keyof CustomerFieldUpdates;
  oldValue: string | null | undefined;
  newValue: string | null | undefined;
}

/**
 * Outcome of a sync evaluation for a single customer.
 */
export type SyncOperation = 'UPDATE' | 'NO_OP' | 'SKIPPED';

/**
 * Represents the planned or executed action for an individual customer record.
 */
export interface SyncAction {
  email: string;
  operation: SyncOperation;
  fieldDiffs: FieldDiff[];
  appliedUpdates?: CustomerFieldUpdates;
  reason?: string;
}

/**
 * Aggregate summary produced at the conclusion of a synchronization cycle.
 */
export interface SyncSummary {
  startedAt: string;
  completedAt: string;
  isDryRun: boolean;
  totalProcessed: number;
  updatedCount: number;
  unchangedCount: number;
  skippedCount: number;
  errorCount: number;
  actions: SyncAction[];
}

/**
 * Reference to an existing customer in Jira Service Management.
 */
export interface ExistingCustomerReference {
  readonly sourceCustomerId: string;
  readonly normalizedEmail?: string | null;
  readonly displayName?: string | null;
  readonly isActive?: boolean | null;
  readonly sourceScopeReferences: readonly string[];
}

/**
 * Reference to a visible Jira user account (for diagnostic/directory inspection only).
 * Note: A visible Jira account does NOT establish membership as a customer in any JSM service project.
 */
export interface JiraAccountReference {
  readonly accountId: string;
  readonly accountType?: string;
  readonly emailAddress?: string | null;
  readonly displayName?: string | null;
  readonly active?: boolean | null;
}
