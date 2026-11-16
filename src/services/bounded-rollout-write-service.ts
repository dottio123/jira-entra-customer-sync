import * as crypto from 'crypto';
import * as fs from 'fs';
import {
  CustomerDetails,
  DirectoryPerson,
  DirectorySourcePort,
  ExistingCustomerReference,
  ExistingCustomerScopeReaderPort,
  FieldDiff,
} from '../domain';
import {
  JiraCustomerDetailWriteClient,
  JiraHttpError,
  ReadOnlyJiraCustomerTarget,
} from '../connectors/jira';
import { DiffPlanner } from './diff-planner';
import { MappingService } from './mapping-service';
import { hashIdentifier } from '../utils/privacy';
import { Logger, logger } from '../utils/logger';
import { validateAndResolveReportPath, writeReportExclusively } from './report-path-validator';

type RolloutRecordStatus = 'VERIFIED' | 'FAILED' | 'NOT_ATTEMPTED';

export interface BoundedRolloutWriteOptions {
  maxRecords: number;
  maxCustomers: number;
  maxFieldsPerCustomer: number;
  writeMinIntervalMs?: number;
  approvedReportPath: string;
  approvedReportSha256: string;
  reportPath?: string;
  preflightOnly?: boolean;
  sleepFn?: (milliseconds: number) => Promise<void>;
}

export interface BoundedRolloutWriteRecord {
  customerRef: string;
  plannedFieldNames: string[];
  appliedFieldNames: string[];
  verifiedFieldNames: string[];
  status: RolloutRecordStatus;
  failureReason: string | null;
  rejectionStatusCode: number | null;
  rejectionRequestId: string | null;
  manualReviewRequired: boolean;
}

export interface BoundedRolloutWriteReport {
  mode: 'JIRA_FIRST_BOUNDED_ROLLOUT_WRITE';
  startedAt: string;
  completedAt: string;
  success: boolean;
  preflightOnly: boolean;
  approvedReportSha256: string;
  preflightMatchedApproval: boolean;
  approvedCustomerCount: number;
  attemptedCustomerCount: number;
  verifiedCustomerCount: number;
  attemptedFieldCount: number;
  verifiedFieldCount: number;
  stoppedEarly: boolean;
  failureReason: string | null;
  records: BoundedRolloutWriteRecord[];
  reportPath?: string;
}

interface ApprovedRecord {
  customerRef: string;
  changedFieldNames: string[];
}

interface FreshPlan {
  customer: ExistingCustomerReference;
  person: DirectoryPerson;
  candidate: CustomerDetails;
  diffs: FieldDiff[];
  customerRef: string;
}

export class BoundedRolloutWriteService {
  constructor(
    private readonly directorySource: DirectorySourcePort,
    private readonly scopeReader: ExistingCustomerScopeReaderPort,
    private readonly jiraReader: ReadOnlyJiraCustomerTarget,
    private readonly jiraWriter: JiraCustomerDetailWriteClient,
    private readonly options: BoundedRolloutWriteOptions,
    private readonly diffPlanner: DiffPlanner = new DiffPlanner(),
    private readonly mappingService: MappingService = new MappingService(),
    private readonly log: Logger = logger,
  ) {}

  private persistReport(report: BoundedRolloutWriteReport): void {
    const resolved = validateAndResolveReportPath(
      this.options.reportPath ?? 'reports/bounded-rollout-write-report.json',
    );
    const writtenPath = writeReportExclusively(resolved.filePath, (candidatePath) => {
      report.reportPath = candidatePath;
      return JSON.stringify(report, null, 2);
    });
    report.reportPath = writtenPath;
  }

  private loadApproval(): ApprovedRecord[] {
    const resolved = validateAndResolveReportPath(this.options.approvedReportPath);
    if (!fs.existsSync(resolved.filePath)) {
      throw new Error('Approved dry-run report was not found in the reports directory.');
    }
    const bytes = fs.readFileSync(resolved.filePath);
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    if (digest !== this.options.approvedReportSha256.toLowerCase()) {
      throw new Error('Approved dry-run report SHA-256 does not match the configured digest.');
    }
    const parsed = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
    if (
      parsed.mode !== 'JIRA_FIRST_DRY_RUN' ||
      parsed.readOnly !== true ||
      parsed.success !== true
    ) {
      throw new Error('Approved report must be a successful Jira-first read-only dry run.');
    }
    if (!Array.isArray(parsed.records)) {
      throw new Error('Approved dry-run report records are missing.');
    }
    const approved = parsed.records
      .filter(
        (record): record is Record<string, unknown> =>
          Boolean(record) &&
          typeof record === 'object' &&
          (record as Record<string, unknown>).resultCategory === 'UPDATE_PLANNED',
      )
      .map((record) => ({
        customerRef: typeof record.customerRef === 'string' ? record.customerRef : '',
        changedFieldNames: Array.isArray(record.changedFieldNames)
          ? record.changedFieldNames.filter((field): field is string => typeof field === 'string')
          : [],
      }));
    if (approved.length === 0 || approved.some((record) => !record.customerRef)) {
      throw new Error('Approved dry-run report has no valid update candidates.');
    }
    if (approved.length > this.options.maxCustomers) {
      throw new Error('Approved dry-run report exceeds the configured customer write limit.');
    }
    if (
      approved.some(
        (record) =>
          record.changedFieldNames.length === 0 ||
          record.changedFieldNames.length > this.options.maxFieldsPerCustomer,
      )
    ) {
      throw new Error('Approved dry-run report exceeds the configured per-customer field limit.');
    }
    return approved;
  }

  private approvalMatchesFreshPlans(approved: ApprovedRecord[], plans: FreshPlan[]): boolean {
    if (approved.length !== plans.length) return false;
    const freshByRef = new Map(
      plans.map((plan) => [
        plan.customerRef,
        plan.diffs.map((diff) => String(diff.fieldName)).sort(),
      ]),
    );
    return approved.every((record) => {
      const freshFields = freshByRef.get(record.customerRef);
      const approvedFields = [...record.changedFieldNames].sort();
      return freshFields?.join('\u0000') === approvedFields.join('\u0000');
    });
  }

  private async buildFreshPlans(): Promise<FreshPlan[]> {
    const people = await this.directorySource.getPeople();
    const index = new Map<string, DirectoryPerson[]>();
    for (const person of people) {
      const email = person.email?.trim().toLowerCase();
      if (!email) continue;
      const matches = index.get(email) ?? [];
      matches.push(person);
      index.set(email, matches);
    }

    const plans: FreshPlan[] = [];
    let evaluated = 0;
    for await (const customer of this.scopeReader.listExistingCustomers()) {
      if (evaluated >= this.options.maxRecords) break;
      evaluated++;
      const email = customer.normalizedEmail?.trim().toLowerCase();
      if (!email || customer.isActive === false) continue;
      const matches = index.get(email) ?? [];
      if (matches.length !== 1) continue;
      const person = matches[0]!;
      if (
        person.managerLookupStatus === 'LOOKUP_FAILED' ||
        person.managerLookupStatus === 'LOOKUP_SKIPPED'
      ) {
        continue;
      }
      const profile = await this.jiraReader.getCustomerProfile(customer.sourceCustomerId, email);
      const candidate = this.mappingService.mapDirectoryPersonToCustomerDetails(person);
      if (!candidate) continue;
      const diffs = this.diffPlanner.planDiff(candidate, profile.customerDetails).fieldDiffs;
      if (diffs.length === 0) continue;
      if (diffs.length > this.options.maxFieldsPerCustomer) {
        throw new Error('Fresh preflight exceeds the configured per-customer field limit.');
      }
      plans.push({ customer, person, candidate, diffs, customerRef: hashIdentifier(email) });
      if (plans.length > this.options.maxCustomers) {
        throw new Error('Fresh preflight exceeds the configured customer write limit.');
      }
    }
    return plans;
  }

  async execute(): Promise<BoundedRolloutWriteReport> {
    const startedAt = new Date().toISOString();
    const approved = this.loadApproval();
    const fieldReport = await this.jiraReader.discoverFields();
    const plans = await this.buildFreshPlans();
    const records: BoundedRolloutWriteRecord[] = approved.map((record) => ({
      customerRef: record.customerRef,
      plannedFieldNames: [...record.changedFieldNames],
      appliedFieldNames: [],
      verifiedFieldNames: [],
      status: 'NOT_ATTEMPTED',
      failureReason: null,
      rejectionStatusCode: null,
      rejectionRequestId: null,
      manualReviewRequired: false,
    }));

    if (!this.approvalMatchesFreshPlans(approved, plans)) {
      const report: BoundedRolloutWriteReport = {
        mode: 'JIRA_FIRST_BOUNDED_ROLLOUT_WRITE',
        startedAt,
        completedAt: new Date().toISOString(),
        success: false,
        preflightOnly: Boolean(this.options.preflightOnly),
        approvedReportSha256: this.options.approvedReportSha256.toLowerCase(),
        preflightMatchedApproval: false,
        approvedCustomerCount: approved.length,
        attemptedCustomerCount: 0,
        verifiedCustomerCount: 0,
        attemptedFieldCount: 0,
        verifiedFieldCount: 0,
        stoppedEarly: true,
        failureReason: 'APPROVED_PLAN_DRIFTED',
        records,
      };
      this.persistReport(report);
      return report;
    }

    if (this.options.preflightOnly) {
      const report: BoundedRolloutWriteReport = {
        mode: 'JIRA_FIRST_BOUNDED_ROLLOUT_WRITE',
        startedAt,
        completedAt: new Date().toISOString(),
        success: true,
        preflightOnly: true,
        approvedReportSha256: this.options.approvedReportSha256.toLowerCase(),
        preflightMatchedApproval: true,
        approvedCustomerCount: approved.length,
        attemptedCustomerCount: 0,
        verifiedCustomerCount: 0,
        attemptedFieldCount: 0,
        verifiedFieldCount: 0,
        stoppedEarly: false,
        failureReason: null,
        records,
      };
      this.persistReport(report);
      return report;
    }

    let attemptedFieldCount = 0;
    let verifiedFieldCount = 0;
    const attemptedCustomerRefs = new Set<string>();
    let writeAttempted = false;
    let stoppedEarly = false;
    let failureReason: string | null = null;

    for (let planIndex = 0; planIndex < plans.length; planIndex++) {
      const plan = plans[planIndex]!;
      const record = records.find((item) => item.customerRef === plan.customerRef)!;
      for (const diff of plan.diffs) {
        const value = diff.newValue?.trim();
        const fieldId = fieldReport.matchedDomainFields[String(diff.fieldName)];
        const jiraField = fieldReport.fields.find((field) => field.id === fieldId);
        if (!value || !jiraField) {
          record.status = 'FAILED';
          record.failureReason = 'INVALID_FRESH_FIELD_PLAN';
          failureReason = record.failureReason;
          stoppedEarly = true;
          break;
        }
        const writeMinIntervalMs = Math.max(0, this.options.writeMinIntervalMs ?? 0);
        if (writeAttempted && writeMinIntervalMs > 0) {
          this.log.info('Pacing bounded rollout before next Jira write', {
            waitMs: writeMinIntervalMs,
          });
          await (
            this.options.sleepFn ??
            ((milliseconds: number) =>
              new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
          )(writeMinIntervalMs);
        }
        attemptedFieldCount++;
        attemptedCustomerRefs.add(plan.customerRef);
        writeAttempted = true;
        this.log.info('Applying bounded rollout customer detail update', {
          customerRef: plan.customerRef,
          fieldName: diff.fieldName,
        });
        try {
          await this.jiraWriter.setCustomerDetail(
            plan.customer.sourceCustomerId,
            jiraField.name,
            value,
          );
          record.appliedFieldNames.push(String(diff.fieldName));
        } catch (error) {
          record.status = 'FAILED';
          record.failureReason =
            error instanceof JiraHttpError ? 'JIRA_WRITE_REJECTED' : 'JIRA_WRITE_OUTCOME_UNKNOWN';
          record.manualReviewRequired = !(error instanceof JiraHttpError);
          if (error instanceof JiraHttpError) {
            record.rejectionStatusCode = error.statusCode;
            record.rejectionRequestId = error.requestId ?? null;
            this.log.warn('Jira rejected bounded rollout customer detail update', {
              customerRef: plan.customerRef,
              fieldName: diff.fieldName,
              statusCode: error.statusCode,
              requestId: error.requestId,
            });
          }
          failureReason = record.failureReason;
          stoppedEarly = true;
          break;
        }

        try {
          const email = plan.customer.normalizedEmail!.trim().toLowerCase();
          const profile = await this.jiraReader.getCustomerProfile(
            plan.customer.sourceCustomerId,
            email,
          );
          const remaining = this.diffPlanner.planDiff(plan.candidate, profile.customerDetails);
          if (remaining.fieldDiffs.some((item) => item.fieldName === diff.fieldName)) {
            record.status = 'FAILED';
            record.failureReason = 'POST_WRITE_VERIFICATION_FAILED';
            record.manualReviewRequired = true;
            failureReason = record.failureReason;
            stoppedEarly = true;
            break;
          }
          record.verifiedFieldNames.push(String(diff.fieldName));
          verifiedFieldCount++;
        } catch {
          record.status = 'FAILED';
          record.failureReason = 'POST_WRITE_VERIFICATION_UNAVAILABLE';
          record.manualReviewRequired = true;
          failureReason = record.failureReason;
          stoppedEarly = true;
          break;
        }
      }
      if (stoppedEarly) break;
      record.status = 'VERIFIED';
    }

    const report: BoundedRolloutWriteReport = {
      mode: 'JIRA_FIRST_BOUNDED_ROLLOUT_WRITE',
      startedAt,
      completedAt: new Date().toISOString(),
      success: !stoppedEarly && records.every((record) => record.status === 'VERIFIED'),
      preflightOnly: false,
      approvedReportSha256: this.options.approvedReportSha256.toLowerCase(),
      preflightMatchedApproval: true,
      approvedCustomerCount: approved.length,
      attemptedCustomerCount: attemptedCustomerRefs.size,
      verifiedCustomerCount: records.filter((record) => record.status === 'VERIFIED').length,
      attemptedFieldCount,
      verifiedFieldCount,
      stoppedEarly,
      failureReason,
      records,
    };
    this.persistReport(report);
    return report;
  }
}
