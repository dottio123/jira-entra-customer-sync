/**
 * End-to-End Live Source Dry-Run Planning Service.
 *
 * ARCHITECTURAL PRINCIPLES:
 * 1. Interface Segregation & Safety: Strictly read-only to Jira.
 *    Does NOT instantiate, import, or accept any CustomerDetailsWriterPort.
 *    Technical impossibility of any mutation to Jira customer data.
 * 2. Identity Resolution Strategy:
 *    Evaluates ONLY existing customers in Jira.
 *    Dispatches outcomes: RESOLVED, NOT_FOUND, AMBIGUOUS, EMAIL_UNAVAILABLE, INACTIVE, ERROR.
 *    No unresolved customer can ever trigger creation, invitation, or enrollment.
 * 3. Pilot & Concurrency Limits:
 *    Stops after END_TO_END_MAX_RECORDS (bounded 1..500).
 *    Executes lookups with bounded concurrency (1..5, default 2).
 * 4. Request Budget Enforcement:
 *    Global operation budget derived from pilot limit (2N + 14).
 *    Safely terminates if request budget is exceeded.
 * 5. Field Compatibility:
 *    Discovers custom detail fields first. Requires all 4 domain fields:
 *    Title, Office Phone Number, Supervisor, Office/Classroom.
 *    Fails safely if required fields are missing.
 * 6. Dry-Run Diff & Normalization Behavior:
 *    Uses DiffPlanner with deterministic text and phone normalization.
 *    Empty Entra values never overwrite populated Jira values.
 *    Unchanged customers produce no plan.
 * 7. Privacy:
 *    Logs and reports contain only deterministic, truncated SHA-256 pseudonymous references (ref-xxxxxxxxxx).
 *    Zero customer PII (emails, names, account IDs, phone numbers, titles, locations).
 * 8. Report Safety:
 *    Reports are strictly constrained to the 'reports' directory.
 *    Rejects absolute paths and parent traversal ('..').
 *    Generates a filename containing a UTC timestamp.
 */

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import {
  DirectoryPerson,
  DirectorySourcePort,
  IdentityResolutionOutcome,
  CustomerIdentityResolverPort,
} from '../domain';
import {
  ReadOnlyJiraCustomerTarget,
  RequestBudgetGuard,
  RequestBudgetExceededError,
} from '../connectors/jira';
import { DiffPlanner, IDiffPlanner } from './diff-planner';
import { MappingService } from './mapping-service';
import { Logger, logger } from '../utils/logger';
import { hashIdentifier } from '../utils/privacy';
import { validateAndResolveReportPath } from './report-path-validator';
import { DryRunResultCategory } from './report-comparator';

export { DryRunResultCategory };

export interface EndToEndDryRunOptions {
  maxRecords: number;
  concurrency: number;
  reportPath?: string;
  environment?: string;
  directorySource?: string;
  customerTarget?: string;
  dryRun?: boolean;
  fullDirectoryDryRunAcknowledged?: boolean;
}

export interface DryRunPlannedFieldCounts {
  title: number;
  officePhoneNumber: number;
  supervisor: number;
  officeClassroom: number;
  emailAddress?: number;
}

export interface DryRunResolutionCounts {
  resolved: number;
  notFound: number;
  ambiguous: number;
  emailUnavailable: number;
  inactive: number;
  failed: number;
}

export interface DryRunProfileAndDiffCounts {
  profilesRetrieved: number;
  profileFailures: number;
  unchangedCustomers: number;
  customersWithPlannedUpdates: number;
  plannedFieldChanges: number;
}

export interface DryRunAggregateSummary {
  eligibleDirectoryRecords: number;
  pilotRecordsProcessed: number;
  existingCustomersResolved: number;
  customersNotFound: number;
  ambiguousMatches: number;
  emailUnavailable: number;
  inactiveCustomers: number;
  profileRetrievalFailures: number;
  unchangedCustomers: number;
  customersWithPlannedUpdates: number;
  plannedFieldChanges: number;
  requestBudgetUsed: number;
  retryCount: number;
  errorCount: number;
  plannedFieldBreakdown: DryRunPlannedFieldCounts;
  resolutionBreakdown: DryRunResolutionCounts;
  profileAndDiffCounts: DryRunProfileAndDiffCounts;
}

export interface DryRunRecordReport {
  customerRef: string;
  resolutionStatus: IdentityResolutionOutcome;
  profileRetrievalStatus: 'RETRIEVED' | 'FAILED' | 'SKIPPED';
  changedFieldNames: string[];
  changedFieldCount: number;
  resultCategory: DryRunResultCategory;
}

export interface NonSecretConfigFingerprint {
  environment: string;
  directorySource: string;
  customerTarget: string;
  dryRun: boolean;
  maxRecords: number;
  concurrency: number;
  fullDirectoryDryRunAcknowledged: boolean;
}

export interface EndToEndDryRunReport {
  schemaVersion: string;
  runId: string;
  createdAt: string;
  mode: 'END_TO_END_DRY_RUN';
  limits: {
    maxRecords: number;
    concurrency: number;
    requestBudget: number;
  };
  fields: {
    matchedFields: string[];
    missingFields: string[];
    unmappedFields: string[];
    unknownFieldTypes: string[];
  };
  summary: DryRunAggregateSummary;
  records: DryRunRecordReport[];
  requestBudget: {
    budgetLimit: number;
    budgetUsed: number;
    retryCount: number;
    errorCount: number;
  };
  configFingerprint: NonSecretConfigFingerprint;
  reportPath?: string;
}

export class EndToEndDryRunService {
  private readonly dirSource: DirectorySourcePort;
  private readonly jiraTarget: ReadOnlyJiraCustomerTarget;
  private readonly identityResolver: CustomerIdentityResolverPort;
  private readonly options: EndToEndDryRunOptions;
  private readonly budgetGuard: RequestBudgetGuard;
  private readonly diffPlanner: IDiffPlanner;
  private readonly mapper: MappingService;
  private readonly log: Logger;

  constructor(
    dirSource: DirectorySourcePort,
    jiraTarget: ReadOnlyJiraCustomerTarget,
    identityResolver: CustomerIdentityResolverPort,
    options: EndToEndDryRunOptions,
    budgetGuard: RequestBudgetGuard,
    diffPlanner: IDiffPlanner = new DiffPlanner(),
    mapper: MappingService = new MappingService(),
    log: Logger = logger,
  ) {
    this.dirSource = dirSource;
    this.jiraTarget = jiraTarget;
    this.identityResolver = identityResolver;
    this.options = options;
    this.budgetGuard = budgetGuard;
    this.diffPlanner = diffPlanner;
    this.mapper = mapper;
    this.log = log;
  }

  async executeDryRun(): Promise<EndToEndDryRunReport> {
    const runId = randomUUID();
    const createdAt = new Date().toISOString();

    this.log.info('Starting end-to-end live-source dry-run planning', {
      maxRecords: this.options.maxRecords,
      concurrency: this.options.concurrency,
      requestBudget: this.budgetGuard.getGlobalLimit() ?? 'unbounded',
    });

    // Step 1: Field discovery and validation
    const fieldReport = await this.jiraTarget.discoverFields();
    const requiredDomainFields = [
      'title',
      'officePhoneNumber',
      'supervisor',
      'officeClassroom',
      'emailAddress',
    ];
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

    // Step 2: Ingest directory users
    this.log.info('Ingesting directory users from source');
    const allPeople = await this.dirSource.getPeople();
    const pilotRecords = allPeople.slice(0, this.options.maxRecords);

    this.log.info('Directory users retrieved; applying pilot limit', {
      eligibleDirectoryRecords: allPeople.length,
      pilotRecordsToProcess: pilotRecords.length,
    });

    // Step 3: Concurrently resolve identities and plan diffs
    const recordReports: DryRunRecordReport[] = [];
    const plannedFieldCounts: DryRunPlannedFieldCounts = {
      title: 0,
      officePhoneNumber: 0,
      supervisor: 0,
      officeClassroom: 0,
      emailAddress: 0,
    };
    const resolutionCounts: DryRunResolutionCounts = {
      resolved: 0,
      notFound: 0,
      ambiguous: 0,
      emailUnavailable: 0,
      inactive: 0,
      failed: 0,
    };

    let profileFailures = 0;
    let profilesRetrieved = 0;
    let budgetExceededError: Error | null = null;

    // Process with bounded concurrency
    let currentIndex = 0;
    const worker = async (): Promise<void> => {
      while (currentIndex < pilotRecords.length) {
        if (budgetExceededError) break;

        const idx = currentIndex++;
        const person = pilotRecords[idx]!;

        try {
          const recordResult = await this.processPersonRecord(
            person,
            plannedFieldCounts,
            resolutionCounts,
          );
          recordReports.push(recordResult);
          if (recordResult.profileRetrievalStatus === 'RETRIEVED') {
            profilesRetrieved++;
          } else if (recordResult.profileRetrievalStatus === 'FAILED') {
            profileFailures++;
          }
        } catch (err) {
          if (err instanceof RequestBudgetExceededError) {
            this.log.error(
              'Global request budget exceeded during pilot execution; terminating safely.',
              {
                category: err.category,
                limit: err.limit,
                attempted: err.attempted,
              },
            );
            budgetExceededError = err;
            break;
          }
          this.log.error('Unexpected error processing person record', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    };

    const workerCount = Math.min(this.options.concurrency, pilotRecords.length || 1);
    const workers = Array.from({ length: workerCount }, () => worker());
    await Promise.all(workers);

    if (budgetExceededError) {
      throw budgetExceededError;
    }

    // Step 4: Aggregate metrics
    let unchangedCustomers = 0;
    let customersWithPlannedUpdates = 0;
    let plannedFieldChanges = 0;

    for (const rec of recordReports) {
      if (rec.resultCategory === 'UNCHANGED') {
        unchangedCustomers++;
      } else if (rec.resultCategory === 'UPDATE_PLANNED') {
        customersWithPlannedUpdates++;
        plannedFieldChanges += rec.changedFieldCount;
      }
    }

    const summary: DryRunAggregateSummary = {
      eligibleDirectoryRecords: allPeople.length,
      pilotRecordsProcessed: recordReports.length,
      existingCustomersResolved: resolutionCounts.resolved,
      customersNotFound: resolutionCounts.notFound,
      ambiguousMatches: resolutionCounts.ambiguous,
      emailUnavailable: resolutionCounts.emailUnavailable,
      inactiveCustomers: resolutionCounts.inactive,
      profileRetrievalFailures: profileFailures,
      unchangedCustomers,
      customersWithPlannedUpdates,
      plannedFieldChanges,
      requestBudgetUsed: this.budgetGuard.getRequestBudgetUsed(),
      retryCount: this.budgetGuard.getRetryCount(),
      errorCount: resolutionCounts.failed + profileFailures,
      plannedFieldBreakdown: plannedFieldCounts,
      resolutionBreakdown: resolutionCounts,
      profileAndDiffCounts: {
        profilesRetrieved,
        profileFailures,
        unchangedCustomers,
        customersWithPlannedUpdates,
        plannedFieldChanges,
      },
    };

    const fingerprint: NonSecretConfigFingerprint = {
      environment: this.options.environment ?? 'development',
      directorySource: this.options.directorySource ?? 'entra',
      customerTarget: this.options.customerTarget ?? 'jira-readonly',
      dryRun: this.options.dryRun ?? true,
      maxRecords: this.options.maxRecords,
      concurrency: this.options.concurrency,
      fullDirectoryDryRunAcknowledged: this.options.fullDirectoryDryRunAcknowledged ?? false,
    };

    const report: EndToEndDryRunReport = {
      schemaVersion: '1.0.0',
      runId,
      createdAt,
      mode: 'END_TO_END_DRY_RUN',
      limits: {
        maxRecords: this.options.maxRecords,
        concurrency: this.options.concurrency,
        requestBudget: this.budgetGuard.getGlobalLimit() ?? 0,
      },
      fields: {
        matchedFields: Object.keys(fieldReport.matchedDomainFields),
        missingFields: fieldReport.missingDomainFields,
        unmappedFields: fieldReport.unmappedFields,
        unknownFieldTypes: fieldReport.unknownTypes,
      },
      summary,
      records: recordReports,
      requestBudget: {
        budgetLimit: this.budgetGuard.getGlobalLimit() ?? 0,
        budgetUsed: this.budgetGuard.getRequestBudgetUsed(),
        retryCount: this.budgetGuard.getRetryCount(),
        errorCount: summary.errorCount,
      },
      configFingerprint: fingerprint,
    };

    // Step 5: Write report artifact if configured or default to reports directory
    try {
      const resolvedPath = validateAndResolveReportPath(
        this.options.reportPath,
        new Date(createdAt),
      );
      const targetDir = path.dirname(resolvedPath.filePath);
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }

      fs.writeFileSync(resolvedPath.filePath, JSON.stringify(report, null, 2), 'utf8');
      report.reportPath = resolvedPath.filePath;
      this.log.info('Dry-run JSON report artifact written successfully', {
        artifactConfigured: Boolean(this.options.reportPath),
        fileName: resolvedPath.fileName,
      });
    } catch (writeErr) {
      this.log.error('Failed to write dry-run report artifact', {
        error: writeErr instanceof Error ? writeErr.message : String(writeErr),
      });
      throw writeErr;
    }

    this.log.info('End-to-end dry-run planning completed successfully', {
      ...summary,
    });

    return report;
  }

  private async processPersonRecord(
    person: DirectoryPerson,
    plannedFieldCounts: DryRunPlannedFieldCounts,
    resolutionCounts: DryRunResolutionCounts,
  ): Promise<DryRunRecordReport> {
    const rawEmail = person.email?.trim().toLowerCase() ?? '';
    const customerRef = hashIdentifier(rawEmail || person.sourceId);

    if (!rawEmail) {
      resolutionCounts.emailUnavailable++;
      return {
        customerRef,
        resolutionStatus: 'EMAIL_UNAVAILABLE',
        profileRetrievalStatus: 'SKIPPED',
        changedFieldNames: [],
        changedFieldCount: 0,
        resultCategory: 'EMAIL_UNAVAILABLE',
      };
    }

    // Step A: Exact Identity Resolution
    const identityResult = await this.identityResolver.resolveCustomerIdentity(rawEmail);

    switch (identityResult.outcome) {
      case 'RESOLVED':
        resolutionCounts.resolved++;
        break;
      case 'NOT_FOUND':
        resolutionCounts.notFound++;
        break;
      case 'AMBIGUOUS':
        resolutionCounts.ambiguous++;
        break;
      case 'EMAIL_UNAVAILABLE':
        resolutionCounts.emailUnavailable++;
        break;
      case 'INACTIVE':
        resolutionCounts.inactive++;
        break;
      case 'ERROR':
      default:
        resolutionCounts.failed++;
        break;
    }

    if (identityResult.outcome !== 'RESOLVED' || !identityResult.accountId) {
      const category: DryRunResultCategory =
        identityResult.outcome === 'NOT_FOUND'
          ? 'NOT_FOUND'
          : identityResult.outcome === 'AMBIGUOUS'
            ? 'AMBIGUOUS'
            : identityResult.outcome === 'EMAIL_UNAVAILABLE'
              ? 'EMAIL_UNAVAILABLE'
              : identityResult.outcome === 'INACTIVE'
                ? 'INACTIVE'
                : 'ERROR';

      this.log.info('Processed directory record for dry-run', {
        customerRef,
        resolutionStatus: identityResult.outcome,
        profileRetrievalStatus: 'SKIPPED',
        changedFieldNames: [],
        changedFieldCount: 0,
        resultCategory: category,
      });

      return {
        customerRef,
        resolutionStatus: identityResult.outcome,
        profileRetrievalStatus: 'SKIPPED',
        changedFieldNames: [],
        changedFieldCount: 0,
        resultCategory: category,
      };
    }

    // Step B: Retrieve Profile
    let existingProfile;
    try {
      existingProfile = await this.jiraTarget.getCustomerProfile(
        identityResult.accountId,
        rawEmail,
      );
    } catch (profileErr) {
      if (profileErr instanceof RequestBudgetExceededError) {
        throw profileErr;
      }
      this.log.error('Failed to retrieve existing Jira customer profile', {
        customerRef,
        error: profileErr instanceof Error ? profileErr.message : String(profileErr),
      });
      return {
        customerRef,
        resolutionStatus: 'RESOLVED',
        profileRetrievalStatus: 'FAILED',
        changedFieldNames: [],
        changedFieldCount: 0,
        resultCategory: 'ERROR',
      };
    }

    // Step C: Diff Planning
    const candidateDetails = this.mapper.mapDirectoryPersonToCustomerDetails(person);
    if (!candidateDetails) {
      return {
        customerRef,
        resolutionStatus: 'RESOLVED',
        profileRetrievalStatus: 'SKIPPED',
        changedFieldNames: [],
        changedFieldCount: 0,
        resultCategory: 'EMAIL_UNAVAILABLE',
      };
    }
    const diffPlan = this.diffPlanner.planDiff(
      candidateDetails,
      existingProfile?.customerDetails ?? { email: rawEmail },
    );

    const changedFieldNames = diffPlan.fieldDiffs.map((d) => d.fieldName as string);
    const resultCategory: DryRunResultCategory = diffPlan.hasChanges
      ? 'UPDATE_PLANNED'
      : 'UNCHANGED';

    if (diffPlan.hasChanges) {
      for (const diff of diffPlan.fieldDiffs) {
        const fieldName = diff.fieldName as keyof DryRunPlannedFieldCounts;
        if (fieldName in plannedFieldCounts) {
          plannedFieldCounts[fieldName]++;
        }
      }
    }

    this.log.info('Processed directory record for dry-run', {
      customerRef,
      resolutionStatus: 'RESOLVED',
      profileRetrievalStatus: 'RETRIEVED',
      changedFieldNames,
      changedFieldCount: changedFieldNames.length,
      resultCategory,
    });

    return {
      customerRef,
      resolutionStatus: 'RESOLVED',
      profileRetrievalStatus: 'RETRIEVED',
      changedFieldNames,
      changedFieldCount: changedFieldNames.length,
      resultCategory,
    };
  }
}
