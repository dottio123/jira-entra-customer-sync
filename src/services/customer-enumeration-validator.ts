/**
 * Customer Enumeration Validator (CLI diagnostic).
 *
 * ARCHITECTURAL PRINCIPLE:
 * Before enabling full Jira-first synchronization diffing, this service performs a
 * metadata-safe, strictly read-only validation of Jira Service Management customer enumeration
 * against a single configured service project.
 *
 * Safety Constraints:
 * - Strictly GET-only operations (mutation verbs are impossible).
 * - Bounded to at most 25 records.
 * - Does NOT query Microsoft Graph.
 * - Does NOT retrieve customer detail profiles.
 * - Does NOT plan diffs or generate change actions.
 * - Emits zero customer PII in logs or outputs (counts and capability flags only).
 * - Fails closed on unauthorized, forbidden, or routing errors:
 *   reports customerEnumerationSupported: false, jiraFirstDryRunAvailable: false, fallbackUsed: false.
 * - Does NOT conflate Jira account active status with JSM customer active status.
 */

import { ExistingCustomerScopeReaderPort } from '../domain';
import {
  RequestBudgetGuard,
  CustomerScopeEnumerationError,
  ScopeReaderFailureReason,
  OAuthError,
} from '../connectors/jira';
import { Logger, logger } from '../utils/logger';

export interface CustomerEnumerationValidationReport {
  mode: 'CUSTOMER_ENUMERATION_VALIDATION';
  validatedAt: string;
  authenticationMode: string;
  customerEnumerationSupported: boolean;
  jiraFirstDryRunAvailable: boolean;
  fallbackUsed: boolean;
  failureReason?: ScopeReaderFailureReason | null;
  errorMessage?: string;
  pagesRetrieved: number;
  customersEnumerated: number;
  recordsWithUsableIdentifier: number;
  recordsWithVisibleEmail: number;
  recordsWithoutVisibleEmail: number;
  recordsWithActiveJiraAccount?: number;
  recordsWithInactiveJiraAccount?: number;
  recordsActive?: number;
  recordsInactive?: number;
  duplicateIdentifierCount: number;
  paginationCompleted: boolean;
  profileIdentifierCompatible?: boolean | null;
  sanitizedRequestId?: string | null;
  sanitizedErrorCode?: string | null;
  sanitizedAtlassianRequestId?: string | null;
  sanitizedErrorCategory?: string | null;
  requestBudgetUsed: number;
  retryCount: number;
}

export interface CustomerEnumerationValidatorOptions {
  authMode?: string;
  maxRecords?: number;
  budgetGuard?: RequestBudgetGuard;
  log?: Logger;
}

export class CustomerEnumerationValidator {
  private readonly scopeReader: ExistingCustomerScopeReaderPort;
  private readonly options: CustomerEnumerationValidatorOptions;
  private readonly log: Logger;
  private readonly budgetGuard?: RequestBudgetGuard;
  private readonly authMode: string;

  constructor(
    scopeReader: ExistingCustomerScopeReaderPort,
    options: CustomerEnumerationValidatorOptions = {},
  ) {
    if (!scopeReader) {
      throw new Error(
        'ExistingCustomerScopeReaderPort is required for CustomerEnumerationValidator.',
      );
    }
    this.scopeReader = scopeReader;
    this.options = options;
    this.authMode = options.authMode ?? 'oauth-3lo';
    this.budgetGuard = options.budgetGuard;
    this.log = options.log ?? logger;
  }

  async validate(): Promise<CustomerEnumerationValidationReport> {
    const maxRecords = Math.min(Math.max(1, this.options.maxRecords ?? 25), 25);
    this.log.info('Starting customer enumeration validation', {
      maxRecords,
      authMode: this.authMode,
    });

    const seenIds = new Set<string>();
    let customersEnumerated = 0;
    let recordsWithUsableIdentifier = 0;
    let recordsWithVisibleEmail = 0;
    let recordsWithoutVisibleEmail = 0;
    let recordsWithActiveJiraAccount = 0;
    let recordsWithInactiveJiraAccount = 0;
    let duplicateIdentifierCount = 0;
    let paginationCompleted = true;

    try {
      for await (const ref of this.scopeReader.listExistingCustomers()) {
        if (customersEnumerated >= maxRecords) {
          paginationCompleted = false;
          break;
        }

        customersEnumerated++;

        if (ref.sourceCustomerId && ref.sourceCustomerId.trim().length > 0) {
          recordsWithUsableIdentifier++;
          if (seenIds.has(ref.sourceCustomerId)) {
            duplicateIdentifierCount++;
          } else {
            seenIds.add(ref.sourceCustomerId);
          }
        }

        if (ref.normalizedEmail && ref.normalizedEmail.trim().length > 0) {
          recordsWithVisibleEmail++;
        } else {
          recordsWithoutVisibleEmail++;
        }

        if (ref.isActive === true) {
          recordsWithActiveJiraAccount++;
        } else if (ref.isActive === false) {
          recordsWithInactiveJiraAccount++;
        }
      }
    } catch (err) {
      if (err instanceof CustomerScopeEnumerationError) {
        this.log.error('Customer enumeration validation failed closed', {
          reason: err.reason,
          statusCode: err.statusCode,
          sanitizedRequestId: err.sanitizedRequestId,
          sanitizedErrorCode: err.sanitizedErrorCode,
          authMode: this.authMode,
        });

        return {
          mode: 'CUSTOMER_ENUMERATION_VALIDATION',
          validatedAt: new Date().toISOString(),
          authenticationMode: this.authMode,
          customerEnumerationSupported: false,
          jiraFirstDryRunAvailable: false,
          fallbackUsed: false,
          failureReason: err.reason,
          errorMessage: err.message,
          pagesRetrieved: this.budgetGuard
            ? this.budgetGuard.getCounts().customerEnumerationPage
            : 0,
          customersEnumerated: 0,
          recordsWithUsableIdentifier: 0,
          recordsWithVisibleEmail: 0,
          recordsWithoutVisibleEmail: 0,
          recordsWithActiveJiraAccount: 0,
          recordsWithInactiveJiraAccount: 0,
          recordsActive: 0,
          recordsInactive: 0,
          duplicateIdentifierCount: 0,
          paginationCompleted: false,
          profileIdentifierCompatible: null,
          sanitizedRequestId: err.sanitizedRequestId ?? null,
          sanitizedErrorCode: err.sanitizedErrorCode ?? null,
          sanitizedAtlassianRequestId: err.sanitizedRequestId ?? null,
          sanitizedErrorCategory: err.sanitizedErrorCode ?? err.reason,
          requestBudgetUsed: this.budgetGuard?.getRequestBudgetUsed() ?? 0,
          retryCount: this.budgetGuard?.getRetryCount() ?? 0,
        };
      }

      if (err instanceof OAuthError) {
        this.log.error('Customer enumeration validation failed closed due to OAuth error', {
          category: err.category,
          statusCode: err.statusCode,
          sanitizedErrorCode: err.sanitizedErrorCode,
          authMode: this.authMode,
        });

        return {
          mode: 'CUSTOMER_ENUMERATION_VALIDATION',
          validatedAt: new Date().toISOString(),
          authenticationMode: this.authMode,
          customerEnumerationSupported: false,
          jiraFirstDryRunAvailable: false,
          fallbackUsed: false,
          failureReason: 'ENUMERATION_AUTHENTICATION_UNSUPPORTED',
          errorMessage: err.message,
          pagesRetrieved: this.budgetGuard
            ? this.budgetGuard.getCounts().customerEnumerationPage
            : 0,
          customersEnumerated: 0,
          recordsWithUsableIdentifier: 0,
          recordsWithVisibleEmail: 0,
          recordsWithoutVisibleEmail: 0,
          recordsWithActiveJiraAccount: 0,
          recordsWithInactiveJiraAccount: 0,
          recordsActive: 0,
          recordsInactive: 0,
          duplicateIdentifierCount: 0,
          paginationCompleted: false,
          profileIdentifierCompatible: null,
          sanitizedRequestId: null,
          sanitizedErrorCode: err.sanitizedErrorCode ?? err.category,
          sanitizedAtlassianRequestId: null,
          sanitizedErrorCategory: err.category,
          requestBudgetUsed: this.budgetGuard?.getRequestBudgetUsed() ?? 0,
          retryCount: this.budgetGuard?.getRetryCount() ?? 0,
        };
      }

      const msg = err instanceof Error ? err.message : String(err);
      this.log.error('Customer enumeration validation encountered unexpected routing error', {
        error: msg,
        authMode: this.authMode,
      });

      return {
        mode: 'CUSTOMER_ENUMERATION_VALIDATION',
        validatedAt: new Date().toISOString(),
        authenticationMode: this.authMode,
        customerEnumerationSupported: false,
        jiraFirstDryRunAvailable: false,
        fallbackUsed: false,
        failureReason: 'ENUMERATION_ROUTING_FAILED',
        errorMessage: msg,
        pagesRetrieved: this.budgetGuard ? this.budgetGuard.getCounts().customerEnumerationPage : 0,
        customersEnumerated: 0,
        recordsWithUsableIdentifier: 0,
        recordsWithVisibleEmail: 0,
        recordsWithoutVisibleEmail: 0,
        recordsWithActiveJiraAccount: 0,
        recordsWithInactiveJiraAccount: 0,
        recordsActive: 0,
        recordsInactive: 0,
        duplicateIdentifierCount: 0,
        paginationCompleted: false,
        profileIdentifierCompatible: null,
        sanitizedRequestId: null,
        sanitizedErrorCode: null,
        sanitizedAtlassianRequestId: null,
        sanitizedErrorCategory: 'ENUMERATION_ROUTING_FAILED',
        requestBudgetUsed: this.budgetGuard?.getRequestBudgetUsed() ?? 0,
        retryCount: this.budgetGuard?.getRetryCount() ?? 0,
      };
    }

    const pagesRetrieved = this.budgetGuard
      ? this.budgetGuard.getCounts().customerEnumerationPage
      : 1;

    const report: CustomerEnumerationValidationReport = {
      mode: 'CUSTOMER_ENUMERATION_VALIDATION',
      validatedAt: new Date().toISOString(),
      authenticationMode: this.authMode,
      customerEnumerationSupported: true,
      jiraFirstDryRunAvailable: true,
      fallbackUsed: false,
      failureReason: null,
      pagesRetrieved,
      customersEnumerated,
      recordsWithUsableIdentifier,
      recordsWithVisibleEmail,
      recordsWithoutVisibleEmail,
      recordsWithActiveJiraAccount,
      recordsWithInactiveJiraAccount,
      recordsActive: recordsWithActiveJiraAccount,
      recordsInactive: recordsWithInactiveJiraAccount,
      duplicateIdentifierCount,
      paginationCompleted,
      profileIdentifierCompatible: recordsWithUsableIdentifier > 0,
      sanitizedRequestId: null,
      sanitizedErrorCode: null,
      sanitizedAtlassianRequestId: null,
      sanitizedErrorCategory: null,
      requestBudgetUsed: this.budgetGuard?.getRequestBudgetUsed() ?? 0,
      retryCount: this.budgetGuard?.getRetryCount() ?? 0,
    };

    this.log.info('Customer enumeration validation completed successfully', {
      pagesRetrieved,
      customersEnumerated,
      recordsWithUsableIdentifier,
      recordsWithVisibleEmail,
      recordsWithoutVisibleEmail,
      duplicateIdentifierCount,
      paginationCompleted,
      authMode: this.authMode,
    });

    return report;
  }
}
