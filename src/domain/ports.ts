/**
 * Application Port Contracts.
 *
 * ARCHITECTURAL PRINCIPLE:
 * In Hexagonal Architecture (Ports and Adapters), the application/domain layer
 * defines and owns the port interfaces it needs to interact with the outside world.
 * Adapters (in-memory, Microsoft Graph, Jira Cloud) implement these ports.
 */

import {
  DirectoryPerson,
  CustomerDetails,
  CustomerFieldUpdates,
  ExistingCustomerReference,
  JiraAccountReference,
} from './models';

/**
 * Port for reading directory people from an identity source.
 */
export interface DirectorySourcePort {
  /**
   * Retrieves all candidate directory persons available in the source system.
   */
  getPeople(): Promise<DirectoryPerson[]>;
}

/**
 * Segregated port for reading customer details from a customer target system.
 */
export interface CustomerDetailsReaderPort {
  /**
   * Finds an existing customer record by normalized (trimmed, lowercase) email address.
   * Returns null if no matching customer exists.
   */
  findByEmail(normalizedEmail: string): Promise<CustomerDetails | null>;
}

/**
 * Segregated port for writing/updating customer details in a customer target system.
 */
export interface CustomerDetailsWriterPort {
  /**
   * Updates discrete fields of an existing customer record identified by normalized email.
   * The updates object must contain only the fields that actually changed.
   */
  updateCustomerDetails(normalizedEmail: string, updates: CustomerFieldUpdates): Promise<void>;
}

/**
 * Combined target port for reading and writing customer details.
 * Implemented by full read-write targets like InMemoryCustomerTarget.
 */
export interface CustomerDetailsTargetPort
  extends CustomerDetailsReaderPort, CustomerDetailsWriterPort {}

/**
 * Port for enumerating existing customer references across configured target scopes.
 */
export interface ExistingCustomerScopeReaderPort {
  listExistingCustomers(): AsyncIterable<ExistingCustomerReference>;
}

/**
 * Outcomes for customer identity resolution.
 */
export type IdentityResolutionOutcome =
  'RESOLVED' | 'NOT_FOUND' | 'AMBIGUOUS' | 'EMAIL_UNAVAILABLE' | 'INACTIVE' | 'ERROR';

export interface IdentityResolutionSuccess {
  outcome: 'RESOLVED';
  accountId: string;
  emailAddress: string;
  displayName?: string;
  verifiedServiceDeskIds?: string[];
}

export interface IdentityResolutionFailure {
  outcome: 'NOT_FOUND' | 'AMBIGUOUS' | 'EMAIL_UNAVAILABLE' | 'INACTIVE' | 'ERROR';
  reason: string;
  candidateCount?: number;
  statusCode?: number;
  sanitizedRequestId?: string;
  sanitizedErrorCode?: string;
  verifiedServiceDeskIds?: string[];
}

export type IdentityResolutionResult = IdentityResolutionSuccess | IdentityResolutionFailure;

/**
 * Port for resolving a customer's email address to an account identifier.
 * Separates identity resolution (e.g. Jira platform user search) from profile/detail retrieval.
 */
export interface CustomerIdentityResolverPort {
  resolveCustomerIdentity(normalizedEmail: string): Promise<IdentityResolutionResult>;
}

/**
 * Diagnostic port for enumerating visible Jira accounts across the Jira platform.
 *
 * ARCHITECTURAL PRINCIPLES:
 * 1. This port enumerates Jira platform user accounts visible to the API credential.
 * 2. It does NOT establish that each returned account is an existing customer associated
 *    with an explicitly configured JSM service project.
 * 3. It must NEVER implement or extend ExistingCustomerScopeReaderPort.
 * 4. Jira-first dry-run and future write services must NOT accept this port as their scope authority.
 * 5. Diagnostic output sourced from this port must use the term "Jira accounts", never "customers".
 */
export interface JiraAccountDirectoryReaderPort {
  listVisibleJiraAccounts(): AsyncIterable<JiraAccountReference>;
}
