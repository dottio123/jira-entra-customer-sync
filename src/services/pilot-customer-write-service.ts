import { CustomerIdentityResolverPort, DirectoryPerson, DirectorySourcePort } from '../domain';
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

export interface PilotCustomerWriteOptions {
  pilotCustomerEmail: string;
  reportPath?: string;
  maxFields: 1;
}

export interface PilotCustomerWriteReport {
  mode: 'JIRA_FIRST_PILOT_WRITE';
  startedAt: string;
  completedAt: string;
  success: boolean;
  customerRef: string;
  verifiedServiceDeskIds: string[];
  plannedFieldNames: string[];
  appliedFieldNames: string[];
  appliedFieldCount: number;
  writeAttempted: boolean;
  writeAccepted: boolean | null;
  verificationComplete: boolean;
  manualReviewRequired: boolean;
  failureReason: string | null;
  jiraWriteStatusCode?: number;
  jiraWriteRequestId?: string;
  reportPath?: string;
}

export class PilotCustomerWriteService {
  constructor(
    private readonly directorySource: DirectorySourcePort,
    private readonly jiraReader: ReadOnlyJiraCustomerTarget,
    private readonly identityResolver: CustomerIdentityResolverPort,
    private readonly jiraWriter: JiraCustomerDetailWriteClient,
    private readonly options: PilotCustomerWriteOptions,
    private readonly diffPlanner: DiffPlanner = new DiffPlanner(),
    private readonly mappingService: MappingService = new MappingService(),
    private readonly log: Logger = logger,
  ) {}

  private persistReport(report: PilotCustomerWriteReport): void {
    const resolved = validateAndResolveReportPath(
      this.options.reportPath ?? 'reports/pilot-write-report.json',
    );
    const writtenPath = writeReportExclusively(resolved.filePath, (candidatePath) => {
      report.reportPath = candidatePath;
      return JSON.stringify(report, null, 2);
    });
    report.reportPath = writtenPath;
  }

  async execute(): Promise<PilotCustomerWriteReport> {
    const startedAt = new Date().toISOString();
    const normalizedEmail = this.options.pilotCustomerEmail.trim().toLowerCase();
    if (!normalizedEmail || this.options.maxFields !== 1) {
      throw new Error('Pilot write requires one configured customer and a one-field maximum.');
    }
    const customerRef = hashIdentifier(normalizedEmail);

    const fieldReport = await this.jiraReader.discoverFields();
    const people = await this.directorySource.getPeople();
    const matches = people.filter(
      (person) => person.email?.trim().toLowerCase() === normalizedEmail,
    );
    if (matches.length !== 1) {
      throw new Error(
        matches.length === 0
          ? 'Pilot customer was not found in the eligible Entra directory snapshot.'
          : 'Pilot customer email is ambiguous in the eligible Entra directory snapshot.',
      );
    }

    const person: DirectoryPerson = matches[0]!;
    if (
      person.managerLookupStatus === 'LOOKUP_FAILED' ||
      person.managerLookupStatus === 'LOOKUP_SKIPPED'
    ) {
      throw new Error('Pilot comparison is incomplete because the manager lookup was unavailable.');
    }

    const resolution = await this.identityResolver.resolveCustomerIdentity(normalizedEmail);
    if (resolution.outcome !== 'RESOLVED') {
      throw new Error(`Pilot customer identity resolution failed: ${resolution.outcome}.`);
    }
    const verifiedServiceDeskIds = resolution.verifiedServiceDeskIds ?? [];
    if (verifiedServiceDeskIds.length === 0) {
      throw new Error('Pilot customer membership was not verified in a configured service desk.');
    }

    const before = await this.jiraReader.getCustomerProfile(resolution.accountId, normalizedEmail);
    const candidate = this.mappingService.mapDirectoryPersonToCustomerDetails(person);
    if (!candidate) {
      throw new Error('Pilot customer does not have a usable Entra email address.');
    }
    const plan = this.diffPlanner.planDiff(candidate, before.customerDetails);
    const plannedFieldNames = plan.fieldDiffs.map((field) => String(field.fieldName));
    if (plan.fieldDiffs.length === 0) {
      const report: PilotCustomerWriteReport = {
        mode: 'JIRA_FIRST_PILOT_WRITE',
        startedAt,
        completedAt: new Date().toISOString(),
        success: true,
        customerRef,
        verifiedServiceDeskIds,
        plannedFieldNames: [],
        appliedFieldNames: [],
        appliedFieldCount: 0,
        writeAttempted: false,
        writeAccepted: false,
        verificationComplete: true,
        manualReviewRequired: false,
        failureReason: null,
      };
      this.persistReport(report);
      return report;
    }
    if (plan.fieldDiffs.length > this.options.maxFields) {
      throw new Error(
        `Pilot write stopped because ${plan.fieldDiffs.length} fields changed; the configured maximum is ${this.options.maxFields}.`,
      );
    }

    const planned = plan.fieldDiffs[0]!;
    const proposedValue = planned.newValue?.trim();
    if (!proposedValue) {
      throw new Error('Pilot write refuses to clear a Jira customer detail field.');
    }
    const matchedFieldId = fieldReport.matchedDomainFields[String(planned.fieldName)];
    const jiraField = fieldReport.fields.find((field) => field.id === matchedFieldId);
    if (!jiraField) {
      throw new Error('The planned domain field could not be mapped to a Jira detail field name.');
    }

    this.log.info('Applying explicitly enabled single-customer, single-field pilot update', {
      customerRef,
      fieldName: planned.fieldName,
    });
    let writeResult;
    try {
      writeResult = await this.jiraWriter.setCustomerDetail(
        resolution.accountId,
        jiraField.name,
        proposedValue,
      );
    } catch (error) {
      const rejected = error instanceof JiraHttpError;
      const report: PilotCustomerWriteReport = {
        mode: 'JIRA_FIRST_PILOT_WRITE',
        startedAt,
        completedAt: new Date().toISOString(),
        success: false,
        customerRef,
        verifiedServiceDeskIds,
        plannedFieldNames,
        appliedFieldNames: [],
        appliedFieldCount: 0,
        writeAttempted: true,
        writeAccepted: rejected ? false : null,
        verificationComplete: false,
        manualReviewRequired: true,
        failureReason: rejected ? 'JIRA_WRITE_REJECTED' : 'JIRA_WRITE_OUTCOME_UNKNOWN',
        ...(rejected
          ? {
              jiraWriteStatusCode: error.statusCode,
              jiraWriteRequestId: error.requestId,
            }
          : {}),
      };
      this.persistReport(report);
      return report;
    }

    let after;
    try {
      after = await this.jiraReader.getCustomerProfile(resolution.accountId, normalizedEmail);
    } catch {
      const report: PilotCustomerWriteReport = {
        mode: 'JIRA_FIRST_PILOT_WRITE',
        startedAt,
        completedAt: new Date().toISOString(),
        success: false,
        customerRef,
        verifiedServiceDeskIds,
        plannedFieldNames,
        appliedFieldNames: [String(planned.fieldName)],
        appliedFieldCount: 1,
        writeAttempted: true,
        writeAccepted: true,
        verificationComplete: false,
        manualReviewRequired: true,
        failureReason: 'POST_WRITE_VERIFICATION_UNAVAILABLE',
        jiraWriteStatusCode: writeResult.statusCode,
        jiraWriteRequestId: writeResult.requestId,
      };
      this.persistReport(report);
      return report;
    }
    const remaining = this.diffPlanner.planDiff(candidate, after.customerDetails);
    const verificationComplete = remaining.fieldDiffs.length === 0;
    const report: PilotCustomerWriteReport = {
      mode: 'JIRA_FIRST_PILOT_WRITE',
      startedAt,
      completedAt: new Date().toISOString(),
      success: verificationComplete,
      customerRef,
      verifiedServiceDeskIds,
      plannedFieldNames,
      appliedFieldNames: [String(planned.fieldName)],
      appliedFieldCount: 1,
      writeAttempted: true,
      writeAccepted: true,
      verificationComplete,
      manualReviewRequired: !verificationComplete,
      failureReason: verificationComplete ? null : 'POST_WRITE_VERIFICATION_FAILED',
      jiraWriteStatusCode: writeResult.statusCode,
      jiraWriteRequestId: writeResult.requestId,
    };
    this.persistReport(report);
    return report;
  }
}
