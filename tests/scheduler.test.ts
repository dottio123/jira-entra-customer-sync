import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WebStore } from '../src/web/store';
import { NotificationService } from '../src/services/notification-service';
import {
  ProductionSyncPreviewService,
  ProductionPreviewResult,
} from '../src/services/production-sync-preview-service';
import {
  ProductionSyncWriterService,
  ProductionWriterExecutionResult,
} from '../src/services/production-sync-writer-service';
import { SchedulerService } from '../src/services/scheduler-service';

class MockPreviewService {
  public executedCount = 0;
  public returnProposedChanges = 1;

  async executePreview(options: { runId: number }): Promise<ProductionPreviewResult> {
    this.executedCount++;
    return {
      runId: options.runId,
      previewDigest: 'scheduled-preview-digest',
      scopeServiceDeskIds: ['sd-1'],
      totalEnumerated: 10,
      uniqueCustomers: 10,
      matchedEntraCustomers: 8,
      skippedCustomersCount: 2,
      proposedCustomerChangesCount: this.returnProposedChanges,
      proposedFieldChangesCount: this.returnProposedChanges,
      proposedChanges: [],
      skippedRecords: [],
    };
  }
}

class MockWriterService {
  public executedCount = 0;

  async executeLiveRollout(options: { runId: number }): Promise<ProductionWriterExecutionResult> {
    this.executedCount++;
    return {
      runId: options.runId,
      previewRunId: 1,
      status: 'COMPLETED',
      approvalDigest: 'scheduled-preview-digest',
      totalAttemptedCustomers: 1,
      totalVerifiedCustomers: 1,
      totalAttemptedFields: 1,
      totalVerifiedFields: 1,
      stoppedEarly: false,
      records: [],
    };
  }
}

describe('SchedulerService', () => {
  let tmp: string;
  let store: WebStore | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'test-scheduler-'));
  });

  afterEach(async () => {
    if (store) {
      store.close();
      store = undefined;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('triggers preview at scheduled time 02:00 America/New_York but does not execute writes when uncommissioned', async () => {
    store = new WebStore(path.join(tmp, 'web.sqlite'));
    store.bootstrapAdmin('admin', 'Password12345!');

    const mockPreview = new MockPreviewService();
    const mockWriter = new MockWriterService();
    const notification = new NotificationService(store);

    // 02:00:00 in America/New_York is 06:00:00 UTC (EDT) or 07:00:00 UTC (EST)
    // 2026-10-02T02:00:00 in America/New_York (EDT) is 2026-10-02T06:00:00.000Z
    const simulatedDate = new Date('2026-10-02T06:00:00.000Z');

    const scheduler = new SchedulerService(
      store,
      mockPreview as unknown as ProductionSyncPreviewService,
      mockWriter as unknown as ProductionSyncWriterService,
      notification,
      {
        scopeServiceDeskIds: ['sd-1'],
        now: () => simulatedDate,
      },
    );

    await scheduler.tick();

    expect(mockPreview.executedCount).toBe(1);
    expect(mockWriter.executedCount).toBe(0); // Uncommissioned -> NO writes!

    // Second tick on same calendar day does not run again (DST / duplicate protection)
    await scheduler.tick();
    expect(mockPreview.executedCount).toBe(1);
  });

  it('executes automated live rollout only when commissioned and automation enabled', async () => {
    store = new WebStore(path.join(tmp, 'web.sqlite'));
    store.bootstrapAdmin('admin', 'Password12345!');
    store.updateSettings(
      {
        commissioning_status: 'COMMISSIONED_AUTOMATED',
        automation_enabled: true,
        writes_enabled: true,
      },
      1,
    );

    const mockPreview = new MockPreviewService();
    const mockWriter = new MockWriterService();
    const notification = new NotificationService(store);

    const simulatedDate = new Date('2026-10-03T06:00:00.000Z');

    const scheduler = new SchedulerService(
      store,
      mockPreview as unknown as ProductionSyncPreviewService,
      mockWriter as unknown as ProductionSyncWriterService,
      notification,
      {
        scopeServiceDeskIds: ['sd-1'],
        now: () => simulatedDate,
      },
    );

    await scheduler.tick();

    expect(mockPreview.executedCount).toBe(1);
    expect(mockWriter.executedCount).toBe(1); // Commissioned & automated -> live rollout executed!
  });

  it('skips scheduled tick when system is paused', async () => {
    store = new WebStore(path.join(tmp, 'web.sqlite'));
    store.bootstrapAdmin('admin', 'Password12345!');
    store.updateSettings({ paused: true }, 1);

    const mockPreview = new MockPreviewService();
    const mockWriter = new MockWriterService();
    const notification = new NotificationService(store);

    const simulatedDate = new Date('2026-10-04T06:00:00.000Z');

    const scheduler = new SchedulerService(
      store,
      mockPreview as unknown as ProductionSyncPreviewService,
      mockWriter as unknown as ProductionSyncWriterService,
      notification,
      {
        scopeServiceDeskIds: ['sd-1'],
        now: () => simulatedDate,
      },
    );

    await scheduler.tick();

    expect(mockPreview.executedCount).toBe(0);
    expect(mockWriter.executedCount).toBe(0);
  });
});
