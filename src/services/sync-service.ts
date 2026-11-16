import {
  DirectorySourcePort,
  CustomerDetailsReaderPort,
  CustomerDetailsWriterPort,
  SyncAction,
  SyncSummary,
} from '../domain';
import { IMappingService, MappingService } from './mapping-service';
import { IDiffPlanner, DiffPlanner } from './diff-planner';
import { Logger, logger } from '../utils/logger';
import { hashIdentifier } from '../utils/privacy';

export interface SyncOptions {
  dryRun: boolean;
}

export class SyncService {
  private customerWriter?: CustomerDetailsWriterPort;
  private mappingService: IMappingService = new MappingService();
  private diffPlanner: IDiffPlanner = new DiffPlanner();
  private log: Logger = logger;

  constructor(
    private directorySource: DirectorySourcePort,
    private customerReader: CustomerDetailsReaderPort,
    writerOrMapping?: CustomerDetailsWriterPort | IMappingService,
    mappingOrDiff?: IMappingService | IDiffPlanner,
    diffOrLogger?: IDiffPlanner | Logger,
    optionalLogger?: Logger,
  ) {
    let resolvedMapping: IMappingService | undefined;

    if (
      writerOrMapping &&
      'updateCustomerDetails' in writerOrMapping &&
      typeof writerOrMapping.updateCustomerDetails === 'function'
    ) {
      this.customerWriter = writerOrMapping;
    } else if (writerOrMapping && 'normalizeEmail' in writerOrMapping) {
      resolvedMapping = writerOrMapping;
    }

    if (
      !this.customerWriter &&
      'updateCustomerDetails' in customerReader &&
      typeof (customerReader as unknown as CustomerDetailsWriterPort).updateCustomerDetails ===
        'function'
    ) {
      this.customerWriter = customerReader as unknown as CustomerDetailsWriterPort;
    }

    if (!resolvedMapping) {
      if (mappingOrDiff && 'normalizeEmail' in mappingOrDiff) {
        resolvedMapping = mappingOrDiff;
      } else {
        resolvedMapping = new MappingService();
      }
    }
    this.mappingService = resolvedMapping;

    if (mappingOrDiff && 'planDiff' in mappingOrDiff) {
      this.diffPlanner = mappingOrDiff;
    } else if (diffOrLogger && 'planDiff' in diffOrLogger) {
      this.diffPlanner = diffOrLogger;
    } else {
      this.diffPlanner = new DiffPlanner();
    }

    if (optionalLogger) {
      this.log = optionalLogger;
    } else if (diffOrLogger && 'info' in diffOrLogger) {
      this.log = diffOrLogger;
    } else {
      this.log = logger;
    }
  }

  /**
   * Executes a full synchronization cycle across directory source and customer target.
   */
  async executeSync(options: SyncOptions): Promise<SyncSummary> {
    const startedAt = new Date().toISOString();
    const isDryRun = options.dryRun;

    this.log.info('Starting customer synchronization cycle', {
      isDryRun,
    });

    if (!isDryRun && !this.customerWriter) {
      throw new Error(
        'Cannot execute live synchronization: target does not support write operations (CustomerDetailsWriterPort not provided).',
      );
    }

    const people = await this.directorySource.getPeople();
    const actions: SyncAction[] = [];
    let updatedCount = 0;
    let unchangedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;

    for (const person of people) {
      // Rule: Skip directory records without a usable email address
      const normalizedEmail = this.mappingService.normalizeEmail(person.email);
      if (!normalizedEmail) {
        skippedCount++;
        actions.push({
          email: person.email ?? '(missing email)',
          operation: 'SKIPPED',
          fieldDiffs: [],
          reason: 'Directory record missing a usable email address',
        });
        this.log.debug('Skipping directory record with no usable email', {
          sourceId: person.sourceId,
          displayName: person.displayName,
        });
        continue;
      }

      const customerRef = hashIdentifier(normalizedEmail);

      try {
        const candidate = this.mappingService.mapDirectoryPersonToCustomerDetails(person);
        if (!candidate) {
          skippedCount++;
          actions.push({
            email: normalizedEmail,
            operation: 'SKIPPED',
            fieldDiffs: [],
            reason: 'Unable to map directory person to customer details',
          });
          continue;
        }

        // Find customer in target using normalized email as key
        const existing = await this.customerReader.findByEmail(normalizedEmail);
        if (!existing) {
          skippedCount++;
          actions.push({
            email: normalizedEmail,
            operation: 'SKIPPED',
            fieldDiffs: [],
            reason: 'Customer not found in target system',
          });
          this.log.debug('Customer not found in target system', {
            customerRef,
          });
          continue;
        }

        const diffResult = this.diffPlanner.planDiff(candidate, existing);

        // Rule: Treat unchanged values as no-op
        if (!diffResult.hasChanges) {
          unchangedCount++;
          actions.push({
            email: normalizedEmail,
            operation: 'NO_OP',
            fieldDiffs: [],
            reason: 'Customer details already up to date',
          });
          this.log.debug('Customer details unchanged', { customerRef });
          continue;
        }

        // Rule: Dry-run must never call the target update method
        // Rule: Dry-run must return and log the proposed changes
        // Privacy: Log customer reference and changed field names, not full before/after values
        if (isDryRun) {
          updatedCount++;
          actions.push({
            email: normalizedEmail,
            operation: 'UPDATE',
            fieldDiffs: diffResult.fieldDiffs,
            appliedUpdates: diffResult.updates,
            reason: 'Dry-run: changes proposed but not written',
          });

          this.log.info('Dry-run: proposed customer updates', {
            customerRef,
            changedFields: Object.keys(diffResult.updates),
            fieldCount: diffResult.fieldDiffs.length,
          });
        } else {
          // Live mode: apply only changed values to target
          await this.customerWriter!.updateCustomerDetails(normalizedEmail, diffResult.updates);
          updatedCount++;
          actions.push({
            email: normalizedEmail,
            operation: 'UPDATE',
            fieldDiffs: diffResult.fieldDiffs,
            appliedUpdates: diffResult.updates,
            reason: 'Applied updates to customer details',
          });

          this.log.info('Applied customer updates', {
            customerRef,
            changedFields: Object.keys(diffResult.updates),
            fieldCount: diffResult.fieldDiffs.length,
          });
        }
      } catch (err) {
        errorCount++;
        const errorMessage = err instanceof Error ? err.message : String(err);
        actions.push({
          email: normalizedEmail,
          operation: 'SKIPPED',
          fieldDiffs: [],
          reason: `Error during processing: ${errorMessage}`,
        });

        this.log.error('Error synchronizing customer record', {
          customerRef,
          error: errorMessage,
        });
      }
    }

    const completedAt = new Date().toISOString();
    const summary: SyncSummary = {
      startedAt,
      completedAt,
      isDryRun,
      totalProcessed: people.length,
      updatedCount,
      unchangedCount,
      skippedCount,
      errorCount,
      actions,
    };

    this.log.info('Synchronization cycle completed', {
      isDryRun,
      totalProcessed: summary.totalProcessed,
      updatedCount: summary.updatedCount,
      unchangedCount: summary.unchangedCount,
      skippedCount: summary.skippedCount,
      errorCount: summary.errorCount,
    });

    return summary;
  }
}
