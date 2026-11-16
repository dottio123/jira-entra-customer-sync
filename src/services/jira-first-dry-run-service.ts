/**
 * Jira-First End-to-End Dry-Run Synchronization Planning Service.
 *
 * ARCHITECTURAL PRINCIPLE:
 * In the target architecture, Jira defines the synchronization-scope authority, and
 * Microsoft Entra ID provides the approved detail-field values.
 *
 * Orchestration Flow:
 * 1. Retrieve a fresh eligible Microsoft Entra directory snapshot once per run.
 *    (Note: The Microsoft Graph adapter ingests eligible users and resolves managers
 *    prior to customer comparison).
 * 2. Build an in-memory index from that snapshot: Map<NormalizedEmail, DirectoryPerson[]>
 *    (preserves ambiguity if multiple records share the same normalized email).
 * 3. Enumerate existing customers from configured JSM service projects, or deterministically
 *    select the configured pilot customer.
 * 4. Deduplicate Jira customers across service projects by stable Jira customer identifier.
 * 5. For each unique existing Jira customer:
 *    - Check active status (inactive -> JIRA_INACTIVE).
 *    - Check email availability (missing/hidden -> EMAIL_UNAVAILABLE).
 *    - Match against in-memory Entra index (0 -> NOT_FOUND, >1 -> AMBIGUOUS).
 *    - For exact match: retrieve existing CSM customer profile using the enumeration identifier.
 *    - Calculate diffs for the 4 approved detail fields.
 * 6. Discard the in-memory Entra index at run conclusion (no cross-run persistence).
 * 7. Produce a privacy-safe dry-run report artifact saved under reports/.
 *
 * Read-Only Impossibility:
 * Technically incapable of mutating Jira (uses CustomerDetailsReaderPort and ExistingCustomerScopeReaderPort).
 */

import {
  DirectoryPerson,
  DirectorySourcePort,
  ExistingCustomerReference,
  ExistingCustomerScopeReaderPort,
  CustomerIdentityResolverPort,
} from '../domain';
import {
  ReadOnlyJiraCustomerTarget,
  RequestBudgetGuard,
  RequestBudgetExceededError,
  CustomerProfileFetchResult,
  CustomerScopeEnumerationError,
  ScopeReaderFailureReason,
  JiraHttpError,
} from '../connectors/jira';
import { EntraDirectorySource } from '../connectors/entra';
import { DiffPlanner } from './diff-planner';
import { MappingService } from './mapping-service';
import { Logger, logger } from '../utils/logger';
import { hashIdentifier, extractSanitizedErrorCode } from '../utils/privacy';
import { validateAndResolveReportPath, writeReportExclusively } from './report-path-validator';
import { DryRunResultCategory } from './report-comparator';

export interface JiraFirstDryRunOptions {
  maxRecords: number;
  concurrency: number;
  reportPath?: string;
  environment?: string;
  directorySource?: string;
  customerTarget?: string;
  dryRun?: boolean;
  pilotMode?: boolean;
  pilotCustomerEmail?: string;
}

export interface JiraFirstPlannedFieldBreakdown {
  title: number;
  officePhoneNumber: number;
  supervisor: number;
  officeClassroom: number;
}

export type FieldDecisionReason =
  'UNCHANGED_EQUAL' | 'PRESERVED_SOURCE_EMPTY' | 'PRESERVED_SOURCE_UNAVAILABLE' | 'UPDATE_PLANNED';

export interface FieldDecision {
  fieldName: 'title' | 'officePhoneNumber' | 'supervisor' | 'officeClassroom';
  decision: FieldDecisionReason;
  statusDescription: string;
}

export interface GraphDirectoryMetrics {
  scope: 'FULL_DIRECTORY_INGESTION';
  totalGraphUsers: number;
  eligibleUsers: number;
  excludedDisabled: number;
  excludedGuests: number;
  excludedNoEmail: number;
  pagesFetched: number;
  managerLookupsAttempted: number;
  managerLookupSuccesses: number;
  managerNotFoundCount: number;
  managerLookupFailures: number;
  managerResolutionDisabled: boolean;
  managerPermissionError?: {
    code?: string;
    statusCode?: number;
    requestId?: string;
  } | null;
}

export interface JiraRequestMetrics {
  scope: 'JIRA_CUSTOMER_TARGET';
  requestBudgetUsed: number;
  retryCount: number;
}

export interface SelectedCustomerMetrics {
  customerRef: string;
  verifiedInServiceDesk: boolean;
  verifiedServiceDeskIds: string[];
  exactEntraMatch: boolean;
  managerLookupStatus?: string;
  comparisonComplete: boolean;
}

export interface JiraFirstDryRunSummary {
  pilotCustomerConfigured?: boolean;
  pilotCustomerFoundInServiceDesk?: boolean;
  pilotCorrelationRef?: string;
  customersEvaluated: number;
  jiraCustomersEnumerated: number;
  duplicateJiraCustomersDeduplicated: number;
  uniqueJiraCustomersProcessed: number;
  jiraCustomersWithVisibleEmail: number;
  jiraCustomersWithoutVisibleEmail: number;
  jiraInactiveCustomers: number;
  exactEntraMatches: number;
  entraNotFound: number;
  ambiguousEntraMatches: number;
  profilesRetrieved: number;
  profileRetrievalFailures: number;
  unchangedCustomers: number;
  customersWithPlannedUpdates: number;
  plannedFieldChanges: number;
  skippedCount: number;
  errorCount: number;
  skippedOrErrorReasons: string[];
  requestBudgetUsed: number;
  retryCount: number;
  plannedFieldBreakdown: JiraFirstPlannedFieldBreakdown;
}

export interface JiraFirstDryRunRecord {
  customerRef: string;
  resultCategory: DryRunResultCategory;
  changedFieldNames: string[];
  changedFieldCount: number;
  sourceScopeReferences: readonly string[];
  fieldDecisions?: FieldDecision[];
}

export interface JiraFirstDryRunReport {
  mode: 'JIRA_FIRST_DRY_RUN';
  readOnly: boolean;
  startedAt: string;
  completedAt: string;
  reportPath?: string;
  success: boolean;
  customerEnumerationSupported: boolean;
  jiraFirstDryRunAvailable: boolean;
  fallbackUsed: boolean;
  failureReason?: ScopeReaderFailureReason | string | null;
  pilotCustomerConfigured?: boolean;
  pilotCustomerFoundInServiceDesk?: boolean;
  pilotCorrelationRef?: string;
  summary: JiraFirstDryRunSummary;
  records: JiraFirstDryRunRecord[];
  graphDirectoryMetrics?: GraphDirectoryMetrics;
  jiraMetrics?: JiraRequestMetrics;
  selectedCustomerMetrics?: SelectedCustomerMetrics;
}

export class JiraFirstDryRunService {
  private readonly dirSource: DirectorySourcePort;
  private readonly scopeReader: ExistingCustomerScopeReaderPort;
  private readonly jiraTarget: ReadOnlyJiraCustomerTarget;
  private readonly options: JiraFirstDryRunOptions;
  private readonly budgetGuard: RequestBudgetGuard;
  private readonly diffPlanner: DiffPlanner;
  private readonly mappingService: MappingService;
  private readonly log: Logger;
  private readonly identityResolver?: CustomerIdentityResolverPort;

  constructor(
    dirSource: DirectorySourcePort,
    scopeReader: ExistingCustomerScopeReaderPort,
    jiraTarget: ReadOnlyJiraCustomerTarget,
    options: JiraFirstDryRunOptions,
    budgetGuard: RequestBudgetGuard,
    diffPlanner: DiffPlanner = new DiffPlanner(),
    mappingService: MappingService = new MappingService(),
    log: Logger = logger,
    identityResolver?: CustomerIdentityResolverPort,
  ) {
    if (!dirSource) {
      throw new Error('DirectorySourcePort is required for JiraFirstDryRunService.');
    }
    if (!scopeReader) {
      throw new Error('ExistingCustomerScopeReaderPort is required for JiraFirstDryRunService.');
    }
    if (!jiraTarget) {
      throw new Error('ReadOnlyJiraCustomerTarget is required for JiraFirstDryRunService.');
    }
    this.dirSource = dirSource;
    this.scopeReader = scopeReader;
    this.jiraTarget = jiraTarget;
    this.options = {
      ...options,
      maxRecords: Math.max(1, options.maxRecords ?? 10),
      concurrency: Math.min(Math.max(1, options.concurrency ?? 2), 5),
    };
    this.budgetGuard = budgetGuard;
    this.diffPlanner = diffPlanner;
    this.mappingService = mappingService;
    this.log = log;
    this.identityResolver = identityResolver;
  }

  private extractGraphMetrics(): GraphDirectoryMetrics | undefined {
    if (this.dirSource instanceof EntraDirectorySource) {
      const stats = this.dirSource.getStats();
      return {
        scope: 'FULL_DIRECTORY_INGESTION',
        totalGraphUsers: stats.totalGraphUsers,
        eligibleUsers: stats.eligibleUsers,
        excludedDisabled: stats.excludedDisabled,
        excludedGuests: stats.excludedGuests,
        excludedNoEmail: stats.excludedNoEmail,
        pagesFetched: stats.pagesFetched,
        managerLookupsAttempted: stats.managerLookupsAttempted,
        managerLookupSuccesses: stats.managerLookupSuccesses,
        managerNotFoundCount: stats.managerNotFoundCount,
        managerLookupFailures: stats.managerLookupFailures,
        managerResolutionDisabled: this.dirSource.isManagerResolutionDisabled(),
        managerPermissionError: this.dirSource.getManagerPermissionError(),
      };
    }
    return undefined;
  }

  private extractJiraMetrics(): JiraRequestMetrics {
    return {
      scope: 'JIRA_CUSTOMER_TARGET',
      requestBudgetUsed: this.budgetGuard.getRequestBudgetUsed(),
      retryCount: this.budgetGuard.getRetryCount(),
    };
  }

  private calculateFieldDecisions(
    entraPerson: DirectoryPerson,
    profileResult: CustomerProfileFetchResult,
    diffResult: ReturnType<DiffPlanner['planDiff']>,
  ): FieldDecision[] {
    const candidateDetails = this.mappingService.mapDirectoryPersonToCustomerDetails(entraPerson);
    const existing = profileResult.customerDetails;
    const fields: Array<'title' | 'officePhoneNumber' | 'supervisor' | 'officeClassroom'> = [
      'title',
      'officePhoneNumber',
      'supervisor',
      'officeClassroom',
    ];

    const changedMap = new Map(diffResult.fieldDiffs.map((d) => [d.fieldName, d]));

    return fields.map((fieldName) => {
      const changed = changedMap.get(fieldName);
      if (changed) {
        return {
          fieldName,
          decision: 'UPDATE_PLANNED',
          statusDescription: 'Update planned for field from directory source',
        };
      }

      if (
        fieldName === 'supervisor' &&
        (entraPerson.managerLookupStatus === 'LOOKUP_FAILED' ||
          entraPerson.managerLookupStatus === 'LOOKUP_SKIPPED')
      ) {
        return {
          fieldName,
          decision: 'PRESERVED_SOURCE_UNAVAILABLE',
          statusDescription:
            'Preserved existing Jira supervisor; Microsoft Graph manager lookup was unavailable',
        };
      }

      const sourceVal = candidateDetails ? candidateDetails[fieldName] : null;
      const targetVal = existing ? existing[fieldName] : null;

      const isSourceEmpty =
        sourceVal === null || sourceVal === undefined || sourceVal.trim().length === 0;
      const isTargetEmpty =
        targetVal === null || targetVal === undefined || targetVal.trim().length === 0;

      if (isSourceEmpty && !isTargetEmpty) {
        return {
          fieldName,
          decision: 'PRESERVED_SOURCE_EMPTY',
          statusDescription:
            'Preserved existing Jira value; Microsoft Entra directory field is not populated',
        };
      }

      return {
        fieldName,
        decision: 'UNCHANGED_EQUAL',
        statusDescription:
          isSourceEmpty && isTargetEmpty
            ? 'Both Microsoft Entra directory and Jira customer field are empty'
            : 'Existing Jira value matches Microsoft Entra directory value',
      };
    });
  }

  private persistReport(report: JiraFirstDryRunReport): void {
    const reportPathToUse =
      this.options.reportPath ??
      (this.options.pilotMode
        ? 'reports/pilot-dry-run-report.json'
        : 'reports/jira-first-dry-run-report.json');
    try {
      const resolved = validateAndResolveReportPath(reportPathToUse);
      const writtenPath = writeReportExclusively(
        resolved.filePath,
        (candidatePath) => {
          report.reportPath = candidatePath;
          return JSON.stringify(report, null, 2);
        },
        { maxCollisionRetries: 10 },
      );
      report.reportPath = writtenPath;
      this.log.info('Persisted dry-run report artifact', {
        reportPath: writtenPath,
      });
    } catch {
      report.success = false;
      if (!report.failureReason) {
        report.failureReason = 'REPORT_PERSISTENCE_FAILED';
      }
      this.log.error('Failed to persist dry-run report artifact', {
        reason: 'REPORT_PERSISTENCE_FAILED',
      });
    }
  }

  private logFinalSummary(report: JiraFirstDryRunReport): void {
    this.log.info('Jira-first dry run completed', {
      readOnly: report.readOnly,
      success: report.success,
      pilotCustomerConfigured: report.pilotCustomerConfigured,
      pilotCustomerFoundInServiceDesk: report.pilotCustomerFoundInServiceDesk,
      customersEvaluated: report.summary.customersEvaluated,
      exactEntraMatches: report.summary.exactEntraMatches,
      entraNotFound: report.summary.entraNotFound,
      ambiguousEntraMatches: report.summary.ambiguousEntraMatches,
      profilesRetrieved: report.summary.profilesRetrieved,
      profileRetrievalFailures: report.summary.profileRetrievalFailures,
      unchangedCustomers: report.summary.unchangedCustomers,
      customersWithPlannedUpdates: report.summary.customersWithPlannedUpdates,
      plannedFieldChanges: report.summary.plannedFieldChanges,
      skippedCount: report.summary.skippedCount,
      errorCount: report.summary.errorCount,
      requestBudgetUsed: report.summary.requestBudgetUsed,
      retryCount: report.summary.retryCount,
      plannedFieldBreakdown: report.summary.plannedFieldBreakdown,
      reportPath: report.reportPath,
    });
  }

  async executeDryRun(): Promise<JiraFirstDryRunReport> {
    // Step 0: Invariant Guard - Validate pilot configuration BEFORE any external operations
    if (this.options.pilotMode || this.options.pilotCustomerEmail) {
      if (!this.options.pilotCustomerEmail || this.options.pilotCustomerEmail.trim().length === 0) {
        throw new Error(
          'Pilot mode is enabled, but pilot customer email is missing or empty. Silent fallback to customer enumeration is prohibited.',
        );
      }
    }

    const startedAt = new Date().toISOString();
    this.log.info('Initiating Jira-First End-to-End Dry-Run Planning', {
      maxRecords: this.options.maxRecords,
      concurrency: this.options.concurrency,
      pilotMode: Boolean(this.options.pilotCustomerEmail),
    });

    // Step 1: Field discovery and compatibility check
    const fieldReport = await this.jiraTarget.discoverFields();
    const requiredDomainFields = ['title', 'officePhoneNumber', 'supervisor', 'officeClassroom'];
    const missingRequired = requiredDomainFields.filter((f) => !fieldReport.matchedDomainFields[f]);

    if (missingRequired.length > 0) {
      const err = new Error(
        `Field compatibility check failed: Required customer detail field(s) missing in Jira CSM: ${missingRequired.join(
          ', ',
        )}`,
      );
      this.log.error(err.message, { missingFields: missingRequired });
      throw err;
    }

    // Step 2: Ingest Entra directory users ONCE for this run and build in-memory index
    this.log.info(
      'Ingesting eligible Microsoft Entra directory users once for run (Graph adapter reads the directory and resolves managers before applying Jira customer matching)',
    );
    const allEntraPeople = await this.dirSource.getPeople();

    const entraIndex = new Map<string, DirectoryPerson[]>();
    for (const person of allEntraPeople) {
      if (!person.email || person.email.trim().length === 0) continue;
      const normalized = person.email.trim().toLowerCase();
      const existing = entraIndex.get(normalized);
      if (existing) {
        existing.push(person);
      } else {
        entraIndex.set(normalized, [person]);
      }
    }

    this.log.info('Built in-memory Entra directory index', {
      totalEntraUsers: allEntraPeople.length,
      indexedEmailsCount: entraIndex.size,
    });

    // Step 3: Check if Deterministic Pilot Selection is configured
    if (this.options.pilotMode || this.options.pilotCustomerEmail) {
      if (!this.options.pilotCustomerEmail || this.options.pilotCustomerEmail.trim().length === 0) {
        throw new Error(
          'Pilot mode is enabled, but pilot customer email is missing or empty. Silent fallback to customer enumeration is prohibited.',
        );
      }
      return this.executePilotDryRun(startedAt, entraIndex);
    }

    return this.executeEnumeratedDryRun(startedAt, entraIndex);
  }

  /**
   * Deterministic Pilot Run:
   * Selects exactly the designated pilot customer, verifies membership in the configured JSM
   * service desk through project-scoped customer API, matches against Entra, retrieves profile,
   * compares fields, and produces an inspectable report artifact.
   */
  private async executePilotDryRun(
    startedAt: string,
    entraIndex: Map<string, DirectoryPerson[]>,
  ): Promise<JiraFirstDryRunReport> {
    const targetPilotEmail = this.options.pilotCustomerEmail!.trim().toLowerCase();
    const pilotRef = hashIdentifier(targetPilotEmail);

    this.log.info('Executing deterministic Jira-first pilot dry run for designated customer', {
      customerRef: pilotRef,
    });

    const plannedFieldBreakdown: JiraFirstPlannedFieldBreakdown = {
      title: 0,
      officePhoneNumber: 0,
      supervisor: 0,
      officeClassroom: 0,
    };

    let pilotCustomerFoundInServiceDesk = false;
    let resolvedAccountId: string | undefined;
    let resolutionReason: string | undefined;
    let resolutionOutcome: string = 'NOT_FOUND';
    let verifiedServiceDeskIds: string[] = [];

    // Verify membership in configured service desk through project-scoped customer API
    if (this.identityResolver) {
      const resolution = await this.identityResolver.resolveCustomerIdentity(targetPilotEmail);
      resolutionOutcome = resolution.outcome;
      if (resolution.outcome === 'RESOLVED') {
        pilotCustomerFoundInServiceDesk = true;
        resolvedAccountId = resolution.accountId;
        verifiedServiceDeskIds = resolution.verifiedServiceDeskIds ?? [];
      } else {
        resolutionReason = resolution.reason;
        if (resolution.outcome === 'INACTIVE' || resolution.outcome === 'AMBIGUOUS') {
          pilotCustomerFoundInServiceDesk = true;
          verifiedServiceDeskIds = resolution.verifiedServiceDeskIds ?? [];
        }
      }
    } else {
      // Fallback: search across enumerated customers
      for await (const ref of this.scopeReader.listExistingCustomers()) {
        if (ref.normalizedEmail && ref.normalizedEmail.trim().toLowerCase() === targetPilotEmail) {
          pilotCustomerFoundInServiceDesk = true;
          verifiedServiceDeskIds = [...ref.sourceScopeReferences];
          if (ref.isActive !== false) {
            resolvedAccountId = ref.sourceCustomerId;
            resolutionOutcome = 'RESOLVED';
          } else {
            resolutionOutcome = 'INACTIVE';
            resolutionReason = 'Matching customer found in service desk but account is inactive';
          }
          break;
        }
      }
    }

    // Handle service-desk membership failure
    if (!resolvedAccountId) {
      this.log.warn('Pilot customer not resolved in configured service desk', {
        customerRef: pilotRef,
        resolutionStatus: resolutionOutcome,
        reason: resolutionReason,
      });

      let category: DryRunResultCategory = 'NOT_FOUND';
      if (resolutionOutcome === 'INACTIVE') category = 'JIRA_INACTIVE';
      else if (resolutionOutcome === 'EMAIL_UNAVAILABLE') category = 'EMAIL_UNAVAILABLE';
      else if (resolutionOutcome === 'AMBIGUOUS') category = 'AMBIGUOUS';
      else if (resolutionOutcome === 'ERROR') category = 'ERROR';

      const completedAt = new Date().toISOString();
      entraIndex.clear();

      const summary: JiraFirstDryRunSummary = {
        pilotCustomerConfigured: true,
        pilotCustomerFoundInServiceDesk,
        pilotCorrelationRef: pilotRef,
        customersEvaluated: 0,
        jiraCustomersEnumerated: 0,
        duplicateJiraCustomersDeduplicated: 0,
        uniqueJiraCustomersProcessed: 0,
        jiraCustomersWithVisibleEmail: 0,
        jiraCustomersWithoutVisibleEmail: 0,
        jiraInactiveCustomers: resolutionOutcome === 'INACTIVE' ? 1 : 0,
        exactEntraMatches: 0,
        entraNotFound: 0,
        ambiguousEntraMatches: 0,
        profilesRetrieved: 0,
        profileRetrievalFailures: 0,
        unchangedCustomers: 0,
        customersWithPlannedUpdates: 0,
        plannedFieldChanges: 0,
        skippedCount: 1,
        errorCount: resolutionOutcome === 'ERROR' ? 1 : 0,
        skippedOrErrorReasons: [
          resolutionReason || `Pilot customer resolution returned ${resolutionOutcome}`,
        ],
        requestBudgetUsed: this.budgetGuard.getRequestBudgetUsed(),
        retryCount: this.budgetGuard.getRetryCount(),
        plannedFieldBreakdown,
      };

      const report: JiraFirstDryRunReport = {
        mode: 'JIRA_FIRST_DRY_RUN',
        readOnly: true,
        startedAt,
        completedAt,
        success: false,
        customerEnumerationSupported: true,
        jiraFirstDryRunAvailable: false,
        fallbackUsed: false,
        failureReason: `PILOT_CUSTOMER_${resolutionOutcome}`,
        pilotCustomerConfigured: true,
        pilotCustomerFoundInServiceDesk,
        pilotCorrelationRef: pilotRef,
        summary,
        records: [
          {
            customerRef: pilotRef,
            resultCategory: category,
            changedFieldNames: [],
            changedFieldCount: 0,
            sourceScopeReferences: verifiedServiceDeskIds,
          },
        ],
        graphDirectoryMetrics: this.extractGraphMetrics(),
        jiraMetrics: this.extractJiraMetrics(),
        selectedCustomerMetrics: {
          customerRef: pilotRef,
          verifiedInServiceDesk: pilotCustomerFoundInServiceDesk,
          verifiedServiceDeskIds,
          exactEntraMatch: false,
          comparisonComplete: false,
        },
      };

      this.persistReport(report);
      this.logFinalSummary(report);
      return report;
    }

    // Match pilot customer against Entra index
    const entraMatches = entraIndex.get(targetPilotEmail) ?? [];
    entraIndex.clear();
    this.log.info('Discarded in-memory Entra directory index for this run');

    if (entraMatches.length === 0) {
      this.log.info('Pilot customer not found in Entra directory snapshot', {
        customerRef: pilotRef,
      });

      const completedAt = new Date().toISOString();
      const summary: JiraFirstDryRunSummary = {
        pilotCustomerConfigured: true,
        pilotCustomerFoundInServiceDesk: true,
        pilotCorrelationRef: pilotRef,
        customersEvaluated: 1,
        jiraCustomersEnumerated: 1,
        duplicateJiraCustomersDeduplicated: 0,
        uniqueJiraCustomersProcessed: 1,
        jiraCustomersWithVisibleEmail: 1,
        jiraCustomersWithoutVisibleEmail: 0,
        jiraInactiveCustomers: 0,
        exactEntraMatches: 0,
        entraNotFound: 1,
        ambiguousEntraMatches: 0,
        profilesRetrieved: 0,
        profileRetrievalFailures: 0,
        unchangedCustomers: 0,
        customersWithPlannedUpdates: 0,
        plannedFieldChanges: 0,
        skippedCount: 1,
        errorCount: 0,
        skippedOrErrorReasons: ['Pilot customer not found in Entra directory snapshot'],
        requestBudgetUsed: this.budgetGuard.getRequestBudgetUsed(),
        retryCount: this.budgetGuard.getRetryCount(),
        plannedFieldBreakdown,
      };

      const report: JiraFirstDryRunReport = {
        mode: 'JIRA_FIRST_DRY_RUN',
        readOnly: true,
        startedAt,
        completedAt,
        success: false,
        customerEnumerationSupported: true,
        jiraFirstDryRunAvailable: true,
        fallbackUsed: false,
        failureReason: 'PILOT_CUSTOMER_NOT_FOUND_IN_ENTRA',
        pilotCustomerConfigured: true,
        pilotCustomerFoundInServiceDesk: true,
        pilotCorrelationRef: pilotRef,
        summary,
        records: [
          {
            customerRef: pilotRef,
            resultCategory: 'NOT_FOUND',
            changedFieldNames: [],
            changedFieldCount: 0,
            sourceScopeReferences: verifiedServiceDeskIds,
          },
        ],
        graphDirectoryMetrics: this.extractGraphMetrics(),
        jiraMetrics: this.extractJiraMetrics(),
        selectedCustomerMetrics: {
          customerRef: pilotRef,
          verifiedInServiceDesk: true,
          verifiedServiceDeskIds,
          exactEntraMatch: false,
          comparisonComplete: false,
        },
      };

      this.persistReport(report);
      this.logFinalSummary(report);
      return report;
    }

    if (entraMatches.length > 1) {
      this.log.warn('Multiple Entra users share pilot customer normalized email', {
        customerRef: pilotRef,
        candidateCount: entraMatches.length,
      });

      const completedAt = new Date().toISOString();
      const summary: JiraFirstDryRunSummary = {
        pilotCustomerConfigured: true,
        pilotCustomerFoundInServiceDesk: true,
        pilotCorrelationRef: pilotRef,
        customersEvaluated: 1,
        jiraCustomersEnumerated: 1,
        duplicateJiraCustomersDeduplicated: 0,
        uniqueJiraCustomersProcessed: 1,
        jiraCustomersWithVisibleEmail: 1,
        jiraCustomersWithoutVisibleEmail: 0,
        jiraInactiveCustomers: 0,
        exactEntraMatches: 0,
        entraNotFound: 0,
        ambiguousEntraMatches: 1,
        profilesRetrieved: 0,
        profileRetrievalFailures: 0,
        unchangedCustomers: 0,
        customersWithPlannedUpdates: 0,
        plannedFieldChanges: 0,
        skippedCount: 1,
        errorCount: 0,
        skippedOrErrorReasons: ['Multiple Entra users share pilot customer normalized email'],
        requestBudgetUsed: this.budgetGuard.getRequestBudgetUsed(),
        retryCount: this.budgetGuard.getRetryCount(),
        plannedFieldBreakdown,
      };

      const report: JiraFirstDryRunReport = {
        mode: 'JIRA_FIRST_DRY_RUN',
        readOnly: true,
        startedAt,
        completedAt,
        success: false,
        customerEnumerationSupported: true,
        jiraFirstDryRunAvailable: true,
        fallbackUsed: false,
        failureReason: 'PILOT_CUSTOMER_AMBIGUOUS_IN_ENTRA',
        pilotCustomerConfigured: true,
        pilotCustomerFoundInServiceDesk: true,
        pilotCorrelationRef: pilotRef,
        summary,
        records: [
          {
            customerRef: pilotRef,
            resultCategory: 'AMBIGUOUS',
            changedFieldNames: [],
            changedFieldCount: 0,
            sourceScopeReferences: verifiedServiceDeskIds,
          },
        ],
        graphDirectoryMetrics: this.extractGraphMetrics(),
        jiraMetrics: this.extractJiraMetrics(),
        selectedCustomerMetrics: {
          customerRef: pilotRef,
          verifiedInServiceDesk: true,
          verifiedServiceDeskIds,
          exactEntraMatch: false,
          comparisonComplete: false,
        },
      };

      this.persistReport(report);
      this.logFinalSummary(report);
      return report;
    }

    // Exact Entra Match!
    const entraPerson = entraMatches[0]!;

    // Retrieve Jira CSM Customer Profile
    let profileResult: CustomerProfileFetchResult;
    try {
      profileResult = await this.jiraTarget.getCustomerProfile(resolvedAccountId, targetPilotEmail);
    } catch (err) {
      if (err instanceof RequestBudgetExceededError) {
        throw err;
      }
      let errorReason = 'Failed to retrieve Jira CSM customer profile due to unexpected error';
      if (err instanceof JiraHttpError) {
        const sanitizedErrorCode = extractSanitizedErrorCode(err.responseBody);
        errorReason = `Jira CSM customer profile endpoint returned HTTP ${err.statusCode}`;
        this.log.error('Failed to retrieve Jira CSM customer profile for pilot customer', {
          customerRef: pilotRef,
          statusCode: err.statusCode,
          sanitizedRequestId: err.requestId,
          sanitizedErrorCode,
          reason: 'JIRA_PROFILE_HTTP_ERROR',
        });
      } else {
        this.log.error('Failed to retrieve Jira CSM customer profile for pilot customer', {
          customerRef: pilotRef,
          reason: 'JIRA_PROFILE_QUERY_FAILED',
        });
      }

      const completedAt = new Date().toISOString();
      const summary: JiraFirstDryRunSummary = {
        pilotCustomerConfigured: true,
        pilotCustomerFoundInServiceDesk: true,
        pilotCorrelationRef: pilotRef,
        customersEvaluated: 1,
        jiraCustomersEnumerated: 1,
        duplicateJiraCustomersDeduplicated: 0,
        uniqueJiraCustomersProcessed: 1,
        jiraCustomersWithVisibleEmail: 1,
        jiraCustomersWithoutVisibleEmail: 0,
        jiraInactiveCustomers: 0,
        exactEntraMatches: 1,
        entraNotFound: 0,
        ambiguousEntraMatches: 0,
        profilesRetrieved: 0,
        profileRetrievalFailures: 1,
        unchangedCustomers: 0,
        customersWithPlannedUpdates: 0,
        plannedFieldChanges: 0,
        skippedCount: 0,
        errorCount: 1,
        skippedOrErrorReasons: [errorReason],
        requestBudgetUsed: this.budgetGuard.getRequestBudgetUsed(),
        retryCount: this.budgetGuard.getRetryCount(),
        plannedFieldBreakdown,
      };

      const report: JiraFirstDryRunReport = {
        mode: 'JIRA_FIRST_DRY_RUN',
        readOnly: true,
        startedAt,
        completedAt,
        success: false,
        customerEnumerationSupported: true,
        jiraFirstDryRunAvailable: true,
        fallbackUsed: false,
        failureReason: 'PROFILE_RETRIEVAL_FAILED',
        pilotCustomerConfigured: true,
        pilotCustomerFoundInServiceDesk: true,
        pilotCorrelationRef: pilotRef,
        summary,
        records: [
          {
            customerRef: pilotRef,
            resultCategory: 'ERROR',
            changedFieldNames: [],
            changedFieldCount: 0,
            sourceScopeReferences: verifiedServiceDeskIds,
          },
        ],
        graphDirectoryMetrics: this.extractGraphMetrics(),
        jiraMetrics: this.extractJiraMetrics(),
        selectedCustomerMetrics: {
          customerRef: pilotRef,
          verifiedInServiceDesk: true,
          verifiedServiceDeskIds,
          exactEntraMatch: true,
          managerLookupStatus: entraPerson.managerLookupStatus,
          comparisonComplete: false,
        },
      };

      this.persistReport(report);
      this.logFinalSummary(report);
      return report;
    }

    // Compare the 4 supported fields (empty Entra values do NOT erase populated Jira values)
    const candidateDetails = this.mappingService.mapDirectoryPersonToCustomerDetails(entraPerson);
    const diffResult = this.diffPlanner.planDiff(candidateDetails!, profileResult.customerDetails);

    let resultCategory: DryRunResultCategory;
    let changedFieldNames: string[] = [];

    if (diffResult.hasChanges) {
      resultCategory = 'UPDATE_PLANNED';
      changedFieldNames = diffResult.fieldDiffs.map((d) => d.fieldName as string);
      for (const fn of changedFieldNames) {
        if (fn in plannedFieldBreakdown) {
          plannedFieldBreakdown[fn as keyof JiraFirstPlannedFieldBreakdown]++;
        }
      }
      this.log.info('Planned updates for pilot Jira customer', {
        customerRef: pilotRef,
        resultCategory: 'UPDATE_PLANNED',
        changedFieldCount: diffResult.fieldDiffs.length,
        changedFieldNames,
      });
    } else {
      resultCategory = 'UNCHANGED';
      this.log.info('Pilot Jira customer is up to date; unchanged', {
        customerRef: pilotRef,
        resultCategory: 'UNCHANGED',
      });
    }

    const fieldDecisions = this.calculateFieldDecisions(entraPerson, profileResult, diffResult);

    const isManagerUnavailable =
      entraPerson.managerLookupStatus === 'LOOKUP_FAILED' ||
      entraPerson.managerLookupStatus === 'LOOKUP_SKIPPED';

    const isSuccessful = !isManagerUnavailable;
    const failureReason = isManagerUnavailable
      ? `PILOT_CUSTOMER_GRAPH_MANAGER_${entraPerson.managerLookupStatus}`
      : null;

    if (!isSuccessful) {
      this.log.error('Pilot customer comparison incomplete: Graph manager lookup unavailable', {
        customerRef: pilotRef,
        managerLookupStatus: entraPerson.managerLookupStatus,
        reason: 'GRAPH_MANAGER_LOOKUP_UNAVAILABLE',
      });
    }

    const completedAt = new Date().toISOString();

    const summary: JiraFirstDryRunSummary = {
      pilotCustomerConfigured: true,
      pilotCustomerFoundInServiceDesk: true,
      pilotCorrelationRef: pilotRef,
      customersEvaluated: 1,
      jiraCustomersEnumerated: 1,
      duplicateJiraCustomersDeduplicated: 0,
      uniqueJiraCustomersProcessed: 1,
      jiraCustomersWithVisibleEmail: 1,
      jiraCustomersWithoutVisibleEmail: 0,
      jiraInactiveCustomers: 0,
      exactEntraMatches: 1,
      entraNotFound: 0,
      ambiguousEntraMatches: 0,
      profilesRetrieved: 1,
      profileRetrievalFailures: 0,
      unchangedCustomers: resultCategory === 'UNCHANGED' ? 1 : 0,
      customersWithPlannedUpdates: resultCategory === 'UPDATE_PLANNED' ? 1 : 0,
      plannedFieldChanges: changedFieldNames.length,
      skippedCount: 0,
      errorCount: 0,
      skippedOrErrorReasons: [],
      requestBudgetUsed: this.budgetGuard.getRequestBudgetUsed(),
      retryCount: this.budgetGuard.getRetryCount(),
      plannedFieldBreakdown,
    };

    const report: JiraFirstDryRunReport = {
      mode: 'JIRA_FIRST_DRY_RUN',
      readOnly: true,
      startedAt,
      completedAt,
      success: isSuccessful,
      customerEnumerationSupported: true,
      jiraFirstDryRunAvailable: true,
      fallbackUsed: false,
      failureReason,
      pilotCustomerConfigured: true,
      pilotCustomerFoundInServiceDesk: true,
      pilotCorrelationRef: pilotRef,
      summary,
      records: [
        {
          customerRef: pilotRef,
          resultCategory,
          changedFieldNames,
          changedFieldCount: changedFieldNames.length,
          sourceScopeReferences: verifiedServiceDeskIds,
          fieldDecisions,
        },
      ],
      graphDirectoryMetrics: this.extractGraphMetrics(),
      jiraMetrics: this.extractJiraMetrics(),
      selectedCustomerMetrics: {
        customerRef: pilotRef,
        verifiedInServiceDesk: true,
        verifiedServiceDeskIds,
        exactEntraMatch: true,
        managerLookupStatus: entraPerson.managerLookupStatus,
        comparisonComplete: !isManagerUnavailable,
      },
    };

    this.persistReport(report);
    this.logFinalSummary(report);
    return report;
  }

  /**
   * General Enumeration Dry Run:
   * Enumerates existing Jira customers across configured service desks up to maxRecords.
   */
  private async executeEnumeratedDryRun(
    startedAt: string,
    entraIndex: Map<string, DirectoryPerson[]>,
  ): Promise<JiraFirstDryRunReport> {
    this.log.info('Enumerating existing customers from configured Jira scopes');
    let jiraCustomersEnumerated = 0;
    let duplicateJiraCustomersDeduplicated = 0;

    const deduplicatedCustomers: ExistingCustomerReference[] = [];
    const seenAccountIds = new Set<string>();

    try {
      for await (const ref of this.scopeReader.listExistingCustomers()) {
        jiraCustomersEnumerated++;

        if (seenAccountIds.has(ref.sourceCustomerId)) {
          duplicateJiraCustomersDeduplicated++;
          continue;
        }

        seenAccountIds.add(ref.sourceCustomerId);
        deduplicatedCustomers.push(ref);

        if (deduplicatedCustomers.length >= this.options.maxRecords) {
          this.log.info('Reached configured maxRecords limit during customer enumeration', {
            maxRecords: this.options.maxRecords,
            enumeratedSoFar: jiraCustomersEnumerated,
          });
          break;
        }
      }
    } catch (err) {
      if (err instanceof CustomerScopeEnumerationError) {
        this.log.error(
          'Jira-first dry run stopped: customer enumeration unsupported or failed closed',
          {
            reason: err.reason,
            statusCode: err.statusCode,
            sanitizedRequestId: err.sanitizedRequestId,
            sanitizedErrorCode: err.sanitizedErrorCode,
          },
        );

        const completedAt = new Date().toISOString();
        const emptySummary: JiraFirstDryRunSummary = {
          customersEvaluated: 0,
          jiraCustomersEnumerated: 0,
          duplicateJiraCustomersDeduplicated: 0,
          uniqueJiraCustomersProcessed: 0,
          jiraCustomersWithVisibleEmail: 0,
          jiraCustomersWithoutVisibleEmail: 0,
          jiraInactiveCustomers: 0,
          exactEntraMatches: 0,
          entraNotFound: 0,
          ambiguousEntraMatches: 0,
          profilesRetrieved: 0,
          profileRetrievalFailures: 0,
          unchangedCustomers: 0,
          customersWithPlannedUpdates: 0,
          plannedFieldChanges: 0,
          skippedCount: 0,
          errorCount: 1,
          skippedOrErrorReasons: [err.reason],
          requestBudgetUsed: this.budgetGuard.getRequestBudgetUsed(),
          retryCount: this.budgetGuard.getRetryCount(),
          plannedFieldBreakdown: {
            title: 0,
            officePhoneNumber: 0,
            supervisor: 0,
            officeClassroom: 0,
          },
        };

        const failedReport: JiraFirstDryRunReport = {
          mode: 'JIRA_FIRST_DRY_RUN',
          readOnly: true,
          startedAt,
          completedAt,
          success: false,
          customerEnumerationSupported: false,
          jiraFirstDryRunAvailable: false,
          fallbackUsed: false,
          failureReason: err.reason,
          summary: emptySummary,
          records: [],
          graphDirectoryMetrics: this.extractGraphMetrics(),
          jiraMetrics: this.extractJiraMetrics(),
        };

        this.persistReport(failedReport);
        this.logFinalSummary(failedReport);
        return failedReport;
      }
      throw err;
    }

    this.log.info('Jira customer enumeration and deduplication completed', {
      jiraCustomersEnumerated,
      duplicateJiraCustomersDeduplicated,
      uniqueCustomersToProcess: deduplicatedCustomers.length,
    });

    const plannedFieldBreakdown: JiraFirstPlannedFieldBreakdown = {
      title: 0,
      officePhoneNumber: 0,
      supervisor: 0,
      officeClassroom: 0,
    };

    let jiraCustomersWithVisibleEmail = 0;
    let jiraCustomersWithoutVisibleEmail = 0;
    let jiraInactiveCustomers = 0;
    let exactEntraMatches = 0;
    let entraNotFound = 0;
    let ambiguousEntraMatches = 0;
    let profilesRetrieved = 0;
    let profileRetrievalFailures = 0;
    let unchangedCustomers = 0;
    let customersWithPlannedUpdates = 0;
    let plannedFieldChanges = 0;
    let skippedCount = 0;
    let errorCount = 0;
    const skippedOrErrorReasons: string[] = [];

    const records: JiraFirstDryRunRecord[] = [];
    let budgetExceededError: Error | null = null;
    let currentIndex = 0;

    const worker = async (): Promise<void> => {
      while (currentIndex < deduplicatedCustomers.length) {
        if (budgetExceededError) break;

        const idx = currentIndex++;
        const customer = deduplicatedCustomers[idx]!;
        const correlationRef = customer.normalizedEmail
          ? hashIdentifier(customer.normalizedEmail)
          : hashIdentifier(customer.sourceCustomerId);

        try {
          if (customer.isActive === false) {
            jiraInactiveCustomers++;
            skippedCount++;
            this.log.info('Jira customer is inactive; skipping diffing', {
              customerRef: correlationRef,
              resultCategory: 'JIRA_INACTIVE',
            });
            records.push({
              customerRef: correlationRef,
              resultCategory: 'JIRA_INACTIVE',
              changedFieldNames: [],
              changedFieldCount: 0,
              sourceScopeReferences: customer.sourceScopeReferences,
            });
            continue;
          }

          if (!customer.normalizedEmail) {
            jiraCustomersWithoutVisibleEmail++;
            skippedCount++;
            this.log.info('Jira customer lacks accessible email; skipping diffing', {
              customerRef: correlationRef,
              resultCategory: 'EMAIL_UNAVAILABLE',
            });
            records.push({
              customerRef: correlationRef,
              resultCategory: 'EMAIL_UNAVAILABLE',
              changedFieldNames: [],
              changedFieldCount: 0,
              sourceScopeReferences: customer.sourceScopeReferences,
            });
            continue;
          }

          jiraCustomersWithVisibleEmail++;

          const matches = entraIndex.get(customer.normalizedEmail);
          if (!matches || matches.length === 0) {
            entraNotFound++;
            skippedCount++;
            this.log.info('No matching Entra user found for Jira customer', {
              customerRef: correlationRef,
              resultCategory: 'NOT_FOUND',
            });
            records.push({
              customerRef: correlationRef,
              resultCategory: 'NOT_FOUND',
              changedFieldNames: [],
              changedFieldCount: 0,
              sourceScopeReferences: customer.sourceScopeReferences,
            });
            continue;
          }

          if (matches.length > 1) {
            ambiguousEntraMatches++;
            skippedCount++;
            this.log.warn(
              'Multiple Entra users share same normalized email; matching is ambiguous',
              {
                customerRef: correlationRef,
                matchCount: matches.length,
                resultCategory: 'AMBIGUOUS',
              },
            );
            records.push({
              customerRef: correlationRef,
              resultCategory: 'AMBIGUOUS',
              changedFieldNames: [],
              changedFieldCount: 0,
              sourceScopeReferences: customer.sourceScopeReferences,
            });
            continue;
          }

          exactEntraMatches++;
          const entraPerson = matches[0]!;

          let profileResult: CustomerProfileFetchResult | null = null;
          try {
            profileResult = await this.jiraTarget.getCustomerProfile(
              customer.sourceCustomerId,
              customer.normalizedEmail,
            );
            profilesRetrieved++;
          } catch (profileErr) {
            if (profileErr instanceof RequestBudgetExceededError) {
              throw profileErr;
            }
            profileRetrievalFailures++;
            errorCount++;
            let errorReason =
              'Failed to retrieve Jira CSM customer profile due to unexpected error';
            if (profileErr instanceof JiraHttpError) {
              const sanitizedErrorCode = extractSanitizedErrorCode(profileErr.responseBody);
              errorReason = `Jira CSM customer profile endpoint returned HTTP ${profileErr.statusCode}`;
              this.log.error('Failed to retrieve Jira CSM customer profile for exact match', {
                customerRef: correlationRef,
                statusCode: profileErr.statusCode,
                sanitizedRequestId: profileErr.requestId,
                sanitizedErrorCode,
                reason: 'JIRA_PROFILE_HTTP_ERROR',
              });
            } else {
              this.log.error('Failed to retrieve Jira CSM customer profile for exact match', {
                customerRef: correlationRef,
                reason: 'JIRA_PROFILE_QUERY_FAILED',
              });
            }
            skippedOrErrorReasons.push(errorReason);
            records.push({
              customerRef: correlationRef,
              resultCategory: 'ERROR',
              changedFieldNames: [],
              changedFieldCount: 0,
              sourceScopeReferences: customer.sourceScopeReferences,
            });
            continue;
          }

          const candidateDetails =
            this.mappingService.mapDirectoryPersonToCustomerDetails(entraPerson);
          if (!candidateDetails) {
            skippedCount++;
            records.push({
              customerRef: correlationRef,
              resultCategory: 'EMAIL_UNAVAILABLE',
              changedFieldNames: [],
              changedFieldCount: 0,
              sourceScopeReferences: customer.sourceScopeReferences,
            });
            continue;
          }

          const diffResult = this.diffPlanner.planDiff(
            candidateDetails,
            profileResult?.customerDetails ?? { email: customer.normalizedEmail },
          );

          if (diffResult.hasChanges) {
            customersWithPlannedUpdates++;
            plannedFieldChanges += diffResult.fieldDiffs.length;

            const fieldNames = diffResult.fieldDiffs.map((d) => d.fieldName as string);
            for (const fn of fieldNames) {
              if (fn in plannedFieldBreakdown) {
                plannedFieldBreakdown[fn as keyof JiraFirstPlannedFieldBreakdown]++;
              }
            }

            this.log.info('Planned updates for existing Jira customer', {
              customerRef: correlationRef,
              resultCategory: 'UPDATE_PLANNED',
              changedFieldCount: diffResult.fieldDiffs.length,
              changedFieldNames: fieldNames,
            });

            const fieldDecisions = this.calculateFieldDecisions(
              entraPerson,
              profileResult,
              diffResult,
            );

            records.push({
              customerRef: correlationRef,
              resultCategory: 'UPDATE_PLANNED',
              changedFieldNames: fieldNames,
              changedFieldCount: diffResult.fieldDiffs.length,
              sourceScopeReferences: customer.sourceScopeReferences,
              fieldDecisions,
            });
          } else {
            unchangedCustomers++;
            this.log.info('Existing Jira customer is up to date; unchanged', {
              customerRef: correlationRef,
              resultCategory: 'UNCHANGED',
            });

            const fieldDecisions = this.calculateFieldDecisions(
              entraPerson,
              profileResult,
              diffResult,
            );

            records.push({
              customerRef: correlationRef,
              resultCategory: 'UNCHANGED',
              changedFieldNames: [],
              changedFieldCount: 0,
              sourceScopeReferences: customer.sourceScopeReferences,
              fieldDecisions,
            });
          }
        } catch (err) {
          if (err instanceof RequestBudgetExceededError) {
            this.log.error('Request budget exceeded during dry run; terminating safely.', {
              category: err.category,
              limit: err.limit,
              attempted: err.attempted,
            });
            budgetExceededError = err;
            break;
          }
          errorCount++;
          skippedOrErrorReasons.push('Unexpected error processing customer record');
          this.log.error('Unexpected error processing customer record', {
            customerRef: correlationRef,
            reason: 'CUSTOMER_PROCESSING_UNEXPECTED_ERROR',
          });
          records.push({
            customerRef: correlationRef,
            resultCategory: 'ERROR',
            changedFieldNames: [],
            changedFieldCount: 0,
            sourceScopeReferences: customer.sourceScopeReferences,
          });
        }
      }
    };

    const workerCount = Math.min(this.options.concurrency, deduplicatedCustomers.length || 1);
    const workers = Array.from({ length: workerCount }, () => worker());
    await Promise.all(workers);

    entraIndex.clear();
    this.log.info('Discarded in-memory Entra directory index for this run');

    if (budgetExceededError) {
      throw budgetExceededError;
    }

    const completedAt = new Date().toISOString();

    const summary: JiraFirstDryRunSummary = {
      customersEvaluated: deduplicatedCustomers.length,
      jiraCustomersEnumerated,
      duplicateJiraCustomersDeduplicated,
      uniqueJiraCustomersProcessed: deduplicatedCustomers.length,
      jiraCustomersWithVisibleEmail,
      jiraCustomersWithoutVisibleEmail,
      jiraInactiveCustomers,
      exactEntraMatches,
      entraNotFound,
      ambiguousEntraMatches,
      profilesRetrieved,
      profileRetrievalFailures,
      unchangedCustomers,
      customersWithPlannedUpdates,
      plannedFieldChanges,
      skippedCount,
      errorCount,
      skippedOrErrorReasons,
      requestBudgetUsed: this.budgetGuard.getRequestBudgetUsed(),
      retryCount: this.budgetGuard.getRetryCount(),
      plannedFieldBreakdown,
    };

    const isSuccessful =
      deduplicatedCustomers.length > 0 && profileRetrievalFailures === 0 && errorCount === 0;

    const report: JiraFirstDryRunReport = {
      mode: 'JIRA_FIRST_DRY_RUN',
      readOnly: true,
      startedAt,
      completedAt,
      success: isSuccessful,
      customerEnumerationSupported: true,
      jiraFirstDryRunAvailable: true,
      fallbackUsed: false,
      failureReason: isSuccessful ? null : 'ENUMERATION_PROCESSING_ERRORS',
      summary,
      records,
      graphDirectoryMetrics: this.extractGraphMetrics(),
      jiraMetrics: this.extractJiraMetrics(),
    };

    this.persistReport(report);
    this.logFinalSummary(report);
    return report;
  }
}
