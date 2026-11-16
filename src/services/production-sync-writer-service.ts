import { parseApprovedEmailDomains, isApprovedEmail } from './approved-email-domains';
import { DirectoryPerson, DirectorySourcePort, FieldDiff } from '../domain';
import {
  JiraCustomerDetailWriteClient,
  JiraHttpError,
  JiraWriteOutcomeUnknownError,
  ReadOnlyJiraCustomerTarget,
  assertSyncedFieldsConfigured,
} from '../connectors/jira';
import { DiffPlanner } from './diff-planner';
import { MappingService } from './mapping-service';
import { RunStatus, SystemSettings, WebStore } from '../web/store';
import { NotificationPayload, NotificationService } from './notification-service';
import { Logger, logger } from '../utils/logger';
import {
  Provider,
  buildEntraEmailIndex,
  errorMessage,
  notifySafely,
  resolveProvider,
  sanitizeFailureReason,
} from './run-support';

export interface ProductionWriterOptions {
  writeMinIntervalMs?: number;
  sleepFn?: (ms: number) => Promise<void>;
  /** Returns true when the service is shutting down; checked before every mutation. */
  shouldStop?: () => boolean;
}

export interface AppliedFieldRecord {
  fieldName: string;
  attemptedValue: string;
  verified: boolean;
  /**
   * VERIFIED: written and confirmed by a fresh read.
   * FAILED: rejected by Jira, or the fresh read showed a different value.
   * OUTCOME_UNKNOWN: the request was sent but no answer arrived; Jira may have applied it.
   * VERIFICATION_UNAVAILABLE: Jira accepted the write but the confirming read failed.
   * SKIPPED: not attempted.
   */
  status: 'VERIFIED' | 'FAILED' | 'OUTCOME_UNKNOWN' | 'VERIFICATION_UNAVAILABLE' | 'SKIPPED';
  rejectionStatusCode?: number;
  rejectionRequestId?: string;
  errorMessage?: string;
}

export interface AppliedCustomerRecord {
  customerRef: string;
  customerAccountId: string;
  customerEmail?: string;
  displayName?: string;
  appliedFields: AppliedFieldRecord[];
  status: 'VERIFIED' | 'FAILED' | 'PARTIAL' | 'NOT_ATTEMPTED';
  failureReason?: string;
}

export interface ProductionWriterExecutionResult {
  runId: number;
  previewRunId: number;
  status: 'COMPLETED' | 'PAUSED' | 'FAILED' | 'INTERRUPTED';
  approvalDigest: string;
  totalAttemptedCustomers: number;
  totalVerifiedCustomers: number;
  totalAttemptedFields: number;
  totalVerifiedFields: number;
  stoppedEarly: boolean;
  stopReason?: string;
  records: AppliedCustomerRecord[];
}

interface PlannedChange {
  customerAccountId: string;
  customerEmail: string;
  displayName?: string;
  customerRef: string;
  changedFields: FieldDiff[];
}

interface ApprovedPlan {
  plannedChanges: PlannedChange[];
  approvedEmailDomains: string[];
  previewDomains: string[] | undefined;
}

/** Mutable progress of a rollout, kept outside the try block so it survives unexpected errors. */
interface RolloutProgress {
  records: AppliedCustomerRecord[];
  totalAttemptedCustomers: number;
  totalVerifiedCustomers: number;
  totalAttemptedFields: number;
  totalVerifiedFields: number;
  stoppedEarly: boolean;
  stopReason?: string;
  stopKind?: 'PAUSED' | 'INTERRUPTED' | 'FAILED';
}

/**
 * Applies an approved preview to Jira: re-validates everything against fresh reads, then writes
 * one field at a time with pacing and read-after-write verification. Halts on the first problem.
 * Only updates detail fields of existing customers; never creates, invites, or deletes customers.
 */
export class ProductionSyncWriterService {
  private readonly writeMinIntervalMs: number;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly shouldStop: () => boolean;

  constructor(
    private readonly directorySource: DirectorySourcePort,
    private readonly jiraTarget: Provider<ReadOnlyJiraCustomerTarget>,
    private readonly jiraWriter: Provider<JiraCustomerDetailWriteClient>,
    private readonly store: WebStore,
    private readonly notificationService: NotificationService,
    options?: ProductionWriterOptions,
    private readonly diffPlanner: DiffPlanner = new DiffPlanner(),
    private readonly mappingService: MappingService = new MappingService(),
    private readonly log: Logger = logger,
  ) {
    this.writeMinIntervalMs = options?.writeMinIntervalMs ?? 500;
    this.sleepFn =
      options?.sleepFn ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.shouldStop = options?.shouldStop ?? (() => false);
  }

  async executeLiveRollout(options: {
    runId: number;
    previewRunId: number;
    approvalDigest: string;
    configuredScopeServiceDeskIds?: string[];
    actorUserId?: number | null;
  }): Promise<ProductionWriterExecutionResult> {
    const { runId, previewRunId, approvalDigest, actorUserId } = options;

    const lockAcquired = this.store.acquireRunLock(runId, `writer-worker-${runId}`);
    if (!lockAcquired) {
      const active = this.store.getActiveLock();
      const reason = `Another run (#${active?.runId ?? 'unknown'}) is currently in progress.`;
      this.store.updateRun(runId, {
        status: 'FAILED',
        failureReason: reason,
        completedAt: Date.now(),
      });
      throw new Error(reason);
    }

    this.store.updateRun(runId, { status: 'RUNNING', approvalDigest });
    this.log.info('Production live rollout started', { runId, previewRunId });

    const progress: RolloutProgress = {
      records: [],
      totalAttemptedCustomers: 0,
      totalVerifiedCustomers: 0,
      totalAttemptedFields: 0,
      totalVerifiedFields: 0,
      stoppedEarly: false,
    };
    let notification: NotificationPayload | undefined;

    try {
      const settings = this.store.getSettings();
      this.assertWritesAllowed(settings);

      const jiraTarget = resolveProvider(this.jiraTarget);
      const jiraWriter = resolveProvider(this.jiraWriter);

      // Field discovery must succeed before any mutation; it also supplies this site's field names.
      let jiraFieldNames: Record<string, string> = {};
      if (typeof jiraTarget.discoverFields === 'function') {
        const fieldReport = await jiraTarget.discoverFields();
        assertSyncedFieldsConfigured(fieldReport);
        jiraFieldNames = fieldReport.matchedFieldNames ?? {};
      }

      const plan = this.loadApprovedPlan(runId, previewRunId, approvalDigest, options, settings);
      const assertDomainScope = () => this.assertDomainScope(plan);
      assertDomainScope();

      const totalPlannedCustomers = plan.plannedChanges.length;
      const totalPlannedFields = plan.plannedChanges.reduce(
        (sum, c) => sum + c.changedFields.length,
        0,
      );

      if (
        totalPlannedCustomers > settings.max_customers_threshold ||
        totalPlannedFields > settings.max_fields_threshold
      ) {
        return await this.pauseForThresholds(
          runId,
          previewRunId,
          approvalDigest,
          settings,
          totalPlannedCustomers,
          totalPlannedFields,
          (payload) => (notification = payload),
        );
      }

      // Fresh Entra snapshot for preflight drift checks.
      const entraIndex = buildEntraEmailIndex(await this.directorySource.getPeople());

      for (const planned of plan.plannedChanges) {
        if (this.checkStop(progress)) break;
        await this.applyCustomer(planned, {
          runId,
          entraIndex,
          jiraTarget,
          jiraWriter,
          jiraFieldNames,
          assertDomainScope,
          progress,
        });
        if (progress.stoppedEarly) break;
      }

      const finalStatus: ProductionWriterExecutionResult['status'] = progress.stoppedEarly
        ? (progress.stopKind ?? 'FAILED')
        : 'COMPLETED';

      this.persistProgress(runId, previewRunId, approvalDigest, finalStatus, progress);
      this.store.audit(
        actorUserId ?? null,
        'LIVE_ROLLOUT_EXECUTED',
        `status=${finalStatus}, verifiedFields=${progress.totalVerifiedFields}/${progress.totalAttemptedFields}`,
      );

      notification = {
        severity: finalStatus === 'COMPLETED' ? 'INFO' : 'ERROR',
        title: finalStatus === 'COMPLETED' ? 'Update completed' : 'Update stopped',
        message:
          finalStatus === 'COMPLETED'
            ? `Update #${runId} verified ${progress.totalVerifiedFields} field(s) across ${progress.totalVerifiedCustomers} customer(s).`
            : `Update #${runId} stopped early: ${progress.stopReason ?? 'Unknown error'} Verified ${progress.totalVerifiedFields} field(s).`,
        runId,
        runType: 'LIVE_ROLLOUT',
        status: finalStatus,
        verifiedChanges: progress.totalVerifiedFields,
      };

      return {
        runId,
        previewRunId,
        status: finalStatus,
        approvalDigest,
        totalAttemptedCustomers: progress.totalAttemptedCustomers,
        totalVerifiedCustomers: progress.totalVerifiedCustomers,
        totalAttemptedFields: progress.totalAttemptedFields,
        totalVerifiedFields: progress.totalVerifiedFields,
        stoppedEarly: progress.stoppedEarly,
        stopReason: progress.stopReason,
        records: progress.records,
      };
    } catch (err) {
      const failureReason = sanitizeFailureReason(errorMessage(err));
      this.log.error('Production live rollout failed with unexpected error', {
        runId,
        failureReason,
      });

      // Keep the record of anything already written, even when the failure was unexpected.
      progress.stoppedEarly = true;
      progress.stopReason = progress.stopReason ?? failureReason;
      try {
        this.persistProgress(runId, previewRunId, approvalDigest, 'FAILED', progress);
      } catch {
        this.store.updateRun(runId, { status: 'FAILED', completedAt: Date.now(), failureReason });
      }

      notification = {
        severity: 'ERROR',
        title: 'Update stopped',
        message: `Update #${runId} failed: ${failureReason}`,
        runId,
        runType: 'LIVE_ROLLOUT',
        status: 'FAILED',
      };
      throw err;
    } finally {
      this.store.releaseRunLock(runId);
      if (notification) await notifySafely(this.notificationService, notification, this.log);
    }
  }

  private assertWritesAllowed(settings: SystemSettings): void {
    if (!settings.writes_enabled) {
      throw new Error(
        'Writes are currently disabled in application settings. Enable writes before running live sync.',
      );
    }
    if (settings.commissioning_status === 'UNCOMMISSIONED') {
      throw new Error('Live writes cannot be executed while application is UNCOMMISSIONED.');
    }
    if (settings.paused) {
      throw new Error('System synchronization is currently paused by an administrator.');
    }
  }

  /** Loads the approved preview and enforces digest, scope, single-use, and integrity rules. */
  private loadApprovedPlan(
    runId: number,
    previewRunId: number,
    approvalDigest: string,
    options: { configuredScopeServiceDeskIds?: string[] },
    settings: SystemSettings,
  ): ApprovedPlan {
    const previewRun = this.store.getRun(previewRunId, true);
    if (!previewRun || previewRun.runType !== 'PREVIEW' || previewRun.status !== 'COMPLETED') {
      throw new Error(`Preview #${previewRunId} is not a completed preview run.`);
    }

    const normalizedApproval = (approvalDigest || '').trim();
    const normalizedPreview = (previewRun.previewDigest || '').trim();
    if (!normalizedPreview || !normalizedApproval) {
      throw new Error('Approval digest is required and cannot be empty.');
    }
    if (normalizedPreview.length === 64 && normalizedApproval.length !== 64) {
      throw new Error(
        `Approval digest length mismatch: expected 64 hexadecimal characters, received ${normalizedApproval.length}.`,
      );
    }
    if (normalizedPreview !== normalizedApproval) {
      throw new Error(
        'Approval digest does not match the preview digest. The preview may have drifted or been modified.',
      );
    }

    const currentScope =
      options.configuredScopeServiceDeskIds ?? this.store.getRun(runId)?.scopeServiceDeskIds ?? [];
    if (currentScope.length === 0) {
      throw new Error('Scope check failed: no Jira service desk scope is configured.');
    }
    const previewScopeSorted = [...previewRun.scopeServiceDeskIds].sort();
    const currentScopeSorted = [...currentScope].sort();
    if (
      previewScopeSorted.length !== currentScopeSorted.length ||
      !previewScopeSorted.every((id, idx) => id === currentScopeSorted[idx])
    ) {
      throw new Error(
        'Scope drift detected: preview scope does not match currently configured service desk scope.',
      );
    }

    const existingRollout = this.store.findRunByPreviewIdAndType(
      previewRunId,
      'LIVE_ROLLOUT',
      runId,
    );
    if (existingRollout) {
      throw new Error(
        `Preview #${previewRunId} has already been executed in rollout run #${existingRollout.id}. Generate a fresh preview before rolling out.`,
      );
    }

    const previewDetails = previewRun.details as {
      approvedEmailDomains?: string[];
      proposedChanges?: PlannedChange[];
    } | null;
    if (!previewDetails || !Array.isArray(previewDetails.proposedChanges)) {
      throw new Error(
        `Preview #${previewRunId} details are no longer available (retention or decryption). Generate a fresh preview.`,
      );
    }

    return {
      plannedChanges: previewDetails.proposedChanges,
      approvedEmailDomains: parseApprovedEmailDomains(settings.approved_email_domains),
      previewDomains: previewDetails.approvedEmailDomains,
    };
  }

  private assertDomainScope(plan: ApprovedPlan): void {
    const currentDomains = parseApprovedEmailDomains(
      this.store.getSettings().approved_email_domains,
    );
    if (
      !plan.approvedEmailDomains.length ||
      JSON.stringify(plan.previewDomains) !== JSON.stringify(currentDomains) ||
      plan.plannedChanges.some((change) => !isApprovedEmail(change.customerEmail, currentDomains))
    ) {
      throw new Error(
        'Approved email domain scope changed or is unavailable. Generate a fresh preview.',
      );
    }
  }

  private async pauseForThresholds(
    runId: number,
    previewRunId: number,
    approvalDigest: string,
    settings: SystemSettings,
    totalPlannedCustomers: number,
    totalPlannedFields: number,
    setNotification: (payload: NotificationPayload) => void,
  ): Promise<ProductionWriterExecutionResult> {
    const thresholdMsg = `Threshold exceeded: planned ${totalPlannedCustomers} customer(s) (limit ${settings.max_customers_threshold}) and ${totalPlannedFields} field(s) (limit ${settings.max_fields_threshold}). Execution paused for safety.`;
    this.log.warn(thresholdMsg, { runId, totalPlannedCustomers, totalPlannedFields });

    this.store.updateRun(runId, {
      status: 'PAUSED',
      completedAt: Date.now(),
      failureReason: thresholdMsg,
      proposedCustomerChanges: totalPlannedCustomers,
      proposedFieldChanges: totalPlannedFields,
    });

    setNotification({
      severity: 'WARN',
      title: 'Update held by safety limits',
      message: thresholdMsg,
      runId,
      runType: 'LIVE_ROLLOUT',
      status: 'PAUSED',
      proposedChanges: totalPlannedFields,
    });

    return {
      runId,
      previewRunId,
      status: 'PAUSED',
      approvalDigest,
      totalAttemptedCustomers: 0,
      totalVerifiedCustomers: 0,
      totalAttemptedFields: 0,
      totalVerifiedFields: 0,
      stoppedEarly: true,
      stopReason: thresholdMsg,
      records: [],
    };
  }

  /** Records a pause or shutdown request; returns true when the run must stop now. */
  private checkStop(progress: RolloutProgress): boolean {
    if (this.store.getSettings().paused) {
      progress.stoppedEarly = true;
      progress.stopKind = 'PAUSED';
      progress.stopReason = 'Operation paused by administrator during execution.';
      return true;
    }
    if (this.shouldStop()) {
      progress.stoppedEarly = true;
      progress.stopKind = 'INTERRUPTED';
      progress.stopReason = 'The service is shutting down; remaining updates were not attempted.';
      return true;
    }
    return false;
  }

  private stopWithFailure(progress: RolloutProgress, reason: string): void {
    progress.stoppedEarly = true;
    progress.stopKind = 'FAILED';
    progress.stopReason = reason;
  }

  /** Re-validates one customer against fresh reads, then writes and verifies each planned field. */
  private async applyCustomer(
    planned: PlannedChange,
    context: {
      runId: number;
      entraIndex: Map<string, DirectoryPerson[]>;
      jiraTarget: ReadOnlyJiraCustomerTarget;
      jiraWriter: JiraCustomerDetailWriteClient;
      jiraFieldNames: Record<string, string>;
      assertDomainScope: () => void;
      progress: RolloutProgress;
    },
  ): Promise<void> {
    const { runId, progress } = context;
    const customerRef = planned.customerRef;
    progress.totalAttemptedCustomers++;
    const customerRecord: AppliedCustomerRecord = {
      customerRef,
      customerAccountId: planned.customerAccountId,
      customerEmail: planned.customerEmail,
      displayName: planned.displayName,
      appliedFields: [],
      status: 'NOT_ATTEMPTED',
    };
    progress.records.push(customerRecord);

    const failCustomer = (reason: string) => {
      this.stopWithFailure(progress, reason);
      customerRecord.status = 'FAILED';
      customerRecord.failureReason = reason;
      this.log.error(reason, { runId, customerRef });
    };

    // Preflight drift checks against a fresh Entra snapshot and a fresh Jira profile.
    const entraCandidates =
      context.entraIndex.get(planned.customerEmail.trim().toLowerCase()) ?? [];
    if (entraCandidates.length !== 1) {
      failCustomer(
        `Drift detected: Entra candidate count for ${customerRef} changed (found ${entraCandidates.length}). Aborting writes.`,
      );
      return;
    }
    const freshCandidate = this.mappingService.mapDirectoryPersonToCustomerDetails(
      entraCandidates[0]!,
    );
    if (!freshCandidate) {
      failCustomer(
        `Drift check failed: Entra candidate for ${customerRef} missing usable email. Aborting writes.`,
      );
      return;
    }

    let freshProfile;
    try {
      freshProfile = await context.jiraTarget.getCustomerProfile(
        planned.customerAccountId,
        planned.customerEmail,
      );
    } catch {
      failCustomer(
        `Drift check failed: unable to read current Jira profile for ${customerRef}. Aborting writes.`,
      );
      return;
    }

    const freshPlan = this.diffPlanner.planDiff(freshCandidate, freshProfile.customerDetails);
    const freshDiffMap = new Map(freshPlan.fieldDiffs.map((d) => [d.fieldName, d.newValue]));
    const planDrifted =
      freshPlan.fieldDiffs.length !== planned.changedFields.length ||
      planned.changedFields.some((f) => freshDiffMap.get(f.fieldName) !== f.newValue);
    if (planDrifted) {
      failCustomer(
        `Drift detected: planned field values for ${customerRef} no longer match fresh calculation. Aborting writes.`,
      );
      return;
    }

    // Sequential, paced writes with immediate read-after-write verification.
    let verifiedForCustomer = 0;
    for (const field of planned.changedFields) {
      context.assertDomainScope();
      if (this.checkStop(progress)) break;

      progress.totalAttemptedFields++;
      const fieldRecord: AppliedFieldRecord = {
        fieldName: field.fieldName,
        attemptedValue: field.newValue ?? '',
        verified: false,
        status: 'SKIPPED',
      };
      customerRecord.appliedFields.push(fieldRecord);

      if (this.writeMinIntervalMs > 0) await this.sleepFn(this.writeMinIntervalMs);
      context.assertDomainScope();

      try {
        await context.jiraWriter.setCustomerDetail(
          planned.customerAccountId,
          field.fieldName,
          field.newValue ?? '',
          context.jiraFieldNames[field.fieldName],
        );
      } catch (writeErr) {
        if (writeErr instanceof JiraWriteOutcomeUnknownError) {
          fieldRecord.status = 'OUTCOME_UNKNOWN';
          fieldRecord.errorMessage = writeErr.message;
          this.stopWithFailure(
            progress,
            `Write outcome unknown for customer ${customerRef} field ${field.fieldName}. Check Jira manually before retrying.`,
          );
        } else {
          fieldRecord.status = 'FAILED';
          const permissionDenied =
            writeErr instanceof JiraHttpError &&
            (writeErr.statusCode === 401 || writeErr.statusCode === 403);
          if (writeErr instanceof JiraHttpError) {
            fieldRecord.rejectionStatusCode = writeErr.statusCode;
            fieldRecord.rejectionRequestId = writeErr.requestId;
          }
          fieldRecord.errorMessage = permissionDenied
            ? `Jira refused the update (status ${(writeErr as JiraHttpError).statusCode}): the Jira connection is not permitted to update customer details.`
            : sanitizeFailureReason(errorMessage(writeErr));
          this.stopWithFailure(
            progress,
            permissionDenied
              ? `Jira refused the update for customer ${customerRef} field ${field.fieldName}: the connection lacks permission to update customer details. Choose Reconnect Jira under Connections and accept all permissions; the signed-in Atlassian account must also be allowed to edit customer details.`
              : `Mutation rejected for customer ${customerRef} field ${field.fieldName}.`,
          );
        }
        this.log.error(progress.stopReason!, { runId, customerRef, fieldName: field.fieldName });
        break;
      }

      let postWriteProfile;
      try {
        postWriteProfile = await context.jiraTarget.getCustomerProfile(
          planned.customerAccountId,
          planned.customerEmail,
        );
      } catch {
        fieldRecord.status = 'VERIFICATION_UNAVAILABLE';
        fieldRecord.errorMessage = 'Jira accepted the update, but the confirming read failed.';
        this.stopWithFailure(
          progress,
          `Verification unavailable for customer ${customerRef} field ${field.fieldName}. Check Jira manually.`,
        );
        this.log.error(progress.stopReason!, { runId, customerRef, fieldName: field.fieldName });
        break;
      }

      // Verified when a fresh comparison no longer proposes a change for this field.
      const remaining = this.diffPlanner.planDiff(freshCandidate, postWriteProfile.customerDetails);
      if (!remaining.fieldDiffs.some((d) => d.fieldName === field.fieldName)) {
        fieldRecord.verified = true;
        fieldRecord.status = 'VERIFIED';
        progress.totalVerifiedFields++;
        verifiedForCustomer++;
      } else {
        fieldRecord.status = 'FAILED';
        fieldRecord.errorMessage =
          field.fieldName === 'emailAddress'
            ? 'Verification failed: Jira Email Address value did not match expected value.'
            : 'Verification failed: the value read back from Jira did not match the update.';
        this.stopWithFailure(
          progress,
          `Field verification failed for customer ${customerRef} field ${field.fieldName}.`,
        );
        this.log.error(progress.stopReason!, { runId, customerRef, fieldName: field.fieldName });
        break;
      }
    }

    if (verifiedForCustomer === planned.changedFields.length) {
      customerRecord.status = 'VERIFIED';
      progress.totalVerifiedCustomers++;
    } else if (verifiedForCustomer > 0) {
      customerRecord.status = 'PARTIAL';
      customerRecord.failureReason = progress.stopReason;
    } else if (customerRecord.appliedFields.length > 0) {
      customerRecord.status = 'FAILED';
      customerRecord.failureReason = progress.stopReason;
    }
  }

  private persistProgress(
    runId: number,
    previewRunId: number,
    approvalDigest: string,
    status: RunStatus,
    progress: RolloutProgress,
  ): void {
    this.store.updateRun(runId, {
      status,
      completedAt: Date.now(),
      appliedCustomerChanges: progress.totalAttemptedCustomers,
      appliedFieldChanges: progress.totalAttemptedFields,
      verifiedFieldChanges: progress.totalVerifiedFields,
      failureReason: progress.stopReason ?? null,
      details: {
        previewRunId,
        approvalDigest,
        totalAttemptedCustomers: progress.totalAttemptedCustomers,
        totalVerifiedCustomers: progress.totalVerifiedCustomers,
        totalAttemptedFields: progress.totalAttemptedFields,
        totalVerifiedFields: progress.totalVerifiedFields,
        stoppedEarly: progress.stoppedEarly,
        stopReason: progress.stopReason ?? null,
        records: progress.records,
      },
    });
  }
}
