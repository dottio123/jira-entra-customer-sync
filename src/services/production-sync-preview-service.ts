import { parseApprovedEmailDomains, isApprovedEmail } from './approved-email-domains';
import * as crypto from 'crypto';
import {
  DirectoryPerson,
  DirectorySourcePort,
  ExistingCustomerReference,
  ExistingCustomerScopeReaderPort,
  FieldDiff,
} from '../domain';
import {
  ReadOnlyJiraCustomerTarget,
  CustomerScopeEnumerationError,
  assertSyncedFieldsConfigured,
} from '../connectors/jira';
import { DiffPlanner } from './diff-planner';
import { MappingService } from './mapping-service';
import { WebStore } from '../web/store';
import { NotificationPayload, NotificationService } from './notification-service';
import { hashIdentifier } from '../utils/privacy';
import { Logger, logger } from '../utils/logger';
import {
  Provider,
  RunShutdownError,
  buildEntraEmailIndex,
  errorMessage,
  notifySafely,
  resolveProvider,
  sanitizeFailureReason,
} from './run-support';

export interface PlannedCustomerChange {
  customerRef: string;
  customerAccountId: string;
  customerEmail: string;
  displayName?: string;
  changedFields: FieldDiff[];
}

export interface SkippedCustomerRecord {
  customerRef: string;
  customerAccountId: string;
  customerEmail?: string;
  displayName?: string;
  reason:
    | 'ENTRA_NOT_FOUND'
    | 'ENTRA_AMBIGUOUS'
    | 'EMAIL_UNAVAILABLE'
    | 'INACTIVE'
    | 'DOMAIN_NOT_APPROVED';
  description: string;
}

export interface ProductionPreviewResult {
  runId: number;
  previewDigest: string;
  scopeServiceDeskIds: string[];
  totalEnumerated: number;
  uniqueCustomers: number;
  matchedEntraCustomers: number;
  skippedCustomersCount: number;
  proposedCustomerChangesCount: number;
  proposedFieldChangesCount: number;
  proposedChanges: PlannedCustomerChange[];
  skippedRecords: SkippedCustomerRecord[];
}

export interface ProductionPreviewServiceOptions {
  /** Returns true when the service is shutting down and the run should stop. */
  shouldStop?: () => boolean;
}

/**
 * Builds a read-only preview: enumerates the configured Jira customer scope, matches each
 * customer to Microsoft Entra by exact email, and plans non-erasing field updates.
 * Never writes to Jira.
 */
export class ProductionSyncPreviewService {
  private readonly shouldStop: () => boolean;

  constructor(
    private readonly directorySource: DirectorySourcePort,
    private readonly scopeReader: Provider<ExistingCustomerScopeReaderPort>,
    private readonly jiraTarget: Provider<ReadOnlyJiraCustomerTarget>,
    private readonly store: WebStore,
    private readonly notificationService: NotificationService,
    private readonly diffPlanner: DiffPlanner = new DiffPlanner(),
    private readonly mappingService: MappingService = new MappingService(),
    private readonly log: Logger = logger,
    options: ProductionPreviewServiceOptions = {},
  ) {
    this.shouldStop = options.shouldStop ?? (() => false);
  }

  async executePreview(options: {
    runId: number;
    scopeServiceDeskIds: string[];
  }): Promise<ProductionPreviewResult> {
    const { runId, scopeServiceDeskIds } = options;

    if (!scopeServiceDeskIds || scopeServiceDeskIds.length === 0) {
      const reason =
        'Preview scope is empty: at least one Jira service desk ID must be configured.';
      this.store.updateRun(runId, {
        status: 'FAILED',
        failureReason: reason,
        completedAt: Date.now(),
      });
      throw new Error(reason);
    }

    const lockAcquired = this.store.acquireRunLock(runId, `preview-worker-${runId}`);
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

    this.store.updateRun(runId, { status: 'RUNNING' });
    this.log.info('Production preview started', { runId, scopeCount: scopeServiceDeskIds.length });

    let notification: NotificationPayload | undefined;
    try {
      const result = await this.buildPreview(runId, scopeServiceDeskIds);
      notification = {
        severity: 'INFO',
        title: 'Preview ready',
        message: `Preview #${runId} found ${result.proposedCustomerChangesCount} customer(s) with ${result.proposedFieldChangesCount} field change(s) across ${result.uniqueCustomers} customer(s) checked.`,
        runId,
        runType: 'PREVIEW',
        status: 'COMPLETED',
        totalCustomers: result.uniqueCustomers,
        proposedChanges: result.proposedCustomerChangesCount,
      };
      return result;
    } catch (err) {
      const interrupted = err instanceof RunShutdownError;
      const failureReason = sanitizeFailureReason(errorMessage(err));
      this.log.error('Production preview failed', { runId, failureReason });
      this.store.updateRun(runId, {
        status: interrupted ? 'INTERRUPTED' : 'FAILED',
        completedAt: Date.now(),
        failureReason,
      });
      if (!interrupted) {
        notification = {
          severity: 'ERROR',
          title: 'Preview stopped',
          message: `Preview #${runId} stopped: ${failureReason}`,
          runId,
          runType: 'PREVIEW',
          status: 'FAILED',
        };
      }
      throw err;
    } finally {
      this.store.releaseRunLock(runId);
      // Alerts are sent only after the lock is released so slow delivery never blocks other runs.
      if (notification) await notifySafely(this.notificationService, notification, this.log);
    }
  }

  private async buildPreview(
    runId: number,
    scopeServiceDeskIds: string[],
  ): Promise<ProductionPreviewResult> {
    const settings = this.store.getSettings();
    if (settings.paused) {
      throw new Error(
        'Previews and updates are paused. Resume operations before running a preview.',
      );
    }
    const approvedEmailDomains = parseApprovedEmailDomains(settings.approved_email_domains);
    if (!approvedEmailDomains.length) {
      throw new Error('Configure approved email domains in Settings before generating a preview.');
    }

    const jiraTarget = resolveProvider(this.jiraTarget);
    const scopeReader = resolveProvider(this.scopeReader);

    // Field discovery must succeed before any preview can be actionable.
    if (typeof jiraTarget.discoverFields === 'function') {
      assertSyncedFieldsConfigured(await jiraTarget.discoverFields());
    }

    // 1. Fresh Microsoft Entra directory snapshot, indexed by normalized email.
    let people: DirectoryPerson[];
    try {
      people = await this.directorySource.getPeople();
    } catch (err) {
      throw new Error(`Directory ingestion failed: ${errorMessage(err)}`);
    }
    const entraIndex = buildEntraEmailIndex(people);

    // 2. Enumerate the configured Jira scope, deduplicated by Jira account ID.
    const customersByCustomerId = new Map<string, ExistingCustomerReference>();
    let totalEnumerated = 0;
    try {
      for await (const customer of scopeReader.listExistingCustomers()) {
        totalEnumerated++;
        if (!customer.sourceCustomerId) {
          throw new Error('Jira returned a customer without a stable account identifier.');
        }
        if (!customersByCustomerId.has(customer.sourceCustomerId)) {
          customersByCustomerId.set(customer.sourceCustomerId, customer);
        }
      }
    } catch (err) {
      const reason = err instanceof CustomerScopeEnumerationError ? err.reason : errorMessage(err);
      throw new Error(`Jira customer enumeration failed: ${reason}`);
    }

    const uniqueCustomers = Array.from(customersByCustomerId.values());
    const proposedChanges: PlannedCustomerChange[] = [];
    const skippedRecords: SkippedCustomerRecord[] = [];
    let matchedEntraCustomers = 0;
    let proposedFieldChangesCount = 0;

    // 3. Evaluate each customer.
    for (const customer of uniqueCustomers) {
      if (this.shouldStop()) throw new RunShutdownError();

      const email = customer.normalizedEmail;
      const customerRef = hashIdentifier(email || customer.sourceCustomerId);
      const skip = (
        reason: SkippedCustomerRecord['reason'],
        description: string,
        includeEmail = true,
      ) =>
        skippedRecords.push({
          customerRef,
          customerAccountId: customer.sourceCustomerId,
          customerEmail: includeEmail ? (email ?? undefined) : undefined,
          displayName: customer.displayName ?? undefined,
          reason,
          description,
        });

      if (customer.isActive === false) {
        skip('INACTIVE', 'Customer is inactive in Jira');
        continue;
      }
      if (!email || email.trim() === '') {
        skip('EMAIL_UNAVAILABLE', 'Customer email address is unavailable or hidden in Jira', false);
        continue;
      }

      const normalizedEmail = email.trim().toLowerCase();
      if (!isApprovedEmail(normalizedEmail, approvedEmailDomains)) {
        skip('DOMAIN_NOT_APPROVED', 'Customer email domain is outside the approved scope');
        continue;
      }

      const matches = entraIndex.get(normalizedEmail) ?? [];
      if (matches.length === 0) {
        skip('ENTRA_NOT_FOUND', 'No matching user found in Entra directory snapshot');
        continue;
      }
      if (matches.length > 1) {
        skip(
          'ENTRA_AMBIGUOUS',
          `Ambiguous match: found ${matches.length} directory candidates with this email`,
        );
        continue;
      }

      const candidateDetails = this.mappingService.mapDirectoryPersonToCustomerDetails(matches[0]!);
      if (!candidateDetails) {
        skip('ENTRA_NOT_FOUND', 'Entra user has no usable email address');
        continue;
      }
      matchedEntraCustomers++;

      let profileResult;
      try {
        profileResult = await jiraTarget.getCustomerProfile(
          customer.sourceCustomerId,
          normalizedEmail,
        );
      } catch (err) {
        throw new Error(
          `Jira customer profile read failed for customer ref ${customerRef}: ${errorMessage(err)}`,
        );
      }

      const diffPlan = this.diffPlanner.planDiff(candidateDetails, profileResult.customerDetails);
      if (diffPlan.hasChanges && diffPlan.fieldDiffs.length > 0) {
        proposedFieldChangesCount += diffPlan.fieldDiffs.length;
        proposedChanges.push({
          customerRef,
          customerAccountId: customer.sourceCustomerId,
          customerEmail: email,
          displayName: customer.displayName ?? profileResult.profile?.displayName ?? undefined,
          changedFields: diffPlan.fieldDiffs,
        });
      }
    }

    const previewDigest = computePreviewDigest(
      scopeServiceDeskIds,
      approvedEmailDomains,
      proposedChanges,
    );

    // 4. Persist the completed preview.
    this.store.updateRun(runId, {
      status: 'COMPLETED',
      completedAt: Date.now(),
      previewDigest,
      totalCustomersEnumerated: totalEnumerated,
      uniqueCustomers: uniqueCustomers.length,
      matchedEntraCustomers,
      skippedCustomers: skippedRecords.length,
      proposedCustomerChanges: proposedChanges.length,
      proposedFieldChanges: proposedFieldChangesCount,
      details: {
        approvedEmailDomains,
        previewDigest,
        totalEnumerated,
        uniqueCustomers: uniqueCustomers.length,
        matchedEntraCustomers,
        skippedCustomersCount: skippedRecords.length,
        proposedCustomerChangesCount: proposedChanges.length,
        proposedFieldChangesCount,
        proposedChanges,
        skippedRecords,
      },
    });

    this.log.info('Production preview completed successfully', {
      runId,
      previewDigest,
      uniqueCustomers: uniqueCustomers.length,
      proposedChanges: proposedChanges.length,
      proposedFields: proposedFieldChangesCount,
    });

    return {
      runId,
      previewDigest,
      scopeServiceDeskIds,
      totalEnumerated,
      uniqueCustomers: uniqueCustomers.length,
      matchedEntraCustomers,
      skippedCustomersCount: skippedRecords.length,
      proposedCustomerChangesCount: proposedChanges.length,
      proposedFieldChangesCount,
      proposedChanges,
      skippedRecords,
    };
  }
}

/**
 * Deterministic SHA-256 approval code over the scope, the approved domains, and every planned
 * change. Any difference in what would be written produces a different code.
 */
export function computePreviewDigest(
  scopeServiceDeskIds: string[],
  approvedEmailDomains: string[],
  proposedChanges: PlannedCustomerChange[],
): string {
  const changes = proposedChanges
    .map((change) => ({
      accountId: change.customerAccountId,
      diffs: change.changedFields
        .map((d) => ({
          field: d.fieldName,
          oldValue: d.oldValue ?? '',
          newValue: d.newValue ?? '',
        }))
        .sort((a, b) => a.field.localeCompare(b.field)),
    }))
    .sort((a, b) => a.accountId.localeCompare(b.accountId));

  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        scopeServiceDeskIds: [...scopeServiceDeskIds].sort(),
        approvedEmailDomains,
        changes,
      }),
    )
    .digest('hex');
}
