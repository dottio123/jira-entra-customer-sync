import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WebStore } from '../src/web/store';

async function cleanup(dir: string, store?: WebStore) {
  if (store) {
    store.close();
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

describe('WebStore production persistence', () => {
  it('manages runs, locks, settings, and alerts', async () => {
    let clock = 1000000;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'test-store-'));
    let store: WebStore | undefined;
    try {
      const dbPath = path.join(tmp, 'web.sqlite');
      store = new WebStore(dbPath, () => clock);
      store.bootstrapAdmin('admin', 'Password12345!');

      // Default settings initialized
      const settings = store.getSettings();
      expect(settings.commissioning_status).toBe('UNCOMMISSIONED');
      expect(settings.writes_enabled).toBe(false);
      expect(settings.automation_enabled).toBe(false);
      expect(settings.max_customers_threshold).toBe(100);
      expect(settings.max_fields_threshold).toBe(400);

      // Update settings
      store.updateSettings({ max_customers_threshold: 150, writes_enabled: false }, 1);
      const updated = store.getSettings();
      expect(updated.max_customers_threshold).toBe(150);

      // Create Run
      const runId = store.createRun({
        runType: 'PREVIEW',
        triggerSource: 'MANUAL',
        scopeServiceDeskIds: ['1001', '1002'],
        createdByUserId: 1,
      });
      expect(runId).toBeGreaterThan(0);

      // Mutex locking
      const lockAcquired = store.acquireRunLock(runId, 'worker-1');
      expect(lockAcquired).toBe(true);

      const secondLock = store.acquireRunLock(runId + 1, 'worker-2');
      expect(secondLock).toBe(false);

      expect(store.getActiveLock()?.runId).toBe(runId);

      // Update run progress
      store.updateRun(runId, {
        status: 'RUNNING',
        totalCustomersEnumerated: 50,
        uniqueCustomers: 45,
      });

      const run = store.getRun(runId);
      expect(run?.status).toBe('RUNNING');
      expect(run?.totalCustomersEnumerated).toBe(50);

      // Release lock and complete run
      store.releaseRunLock(runId);
      expect(store.getActiveLock()).toBeUndefined();

      store.updateRun(runId, {
        status: 'COMPLETED',
        completedAt: clock + 5000,
        previewDigest: 'sha256-test-digest',
        details: { customerCount: 45, proposedChanges: [] },
      });

      // Retrieve with details decrypted
      const completedRun = store.getRun(runId, true);
      expect(completedRun?.status).toBe('COMPLETED');
      expect(completedRun?.details?.customerCount).toBe(45);

      // Latest completed preview
      const latestPreview = store.getLatestCompletedPreview();
      expect(latestPreview?.id).toBe(runId);

      // Alerts
      const alertId = store.createAlert(
        'WARN',
        'Threshold Warning',
        'More than 100 changes',
        runId,
      );
      expect(alertId).toBeGreaterThan(0);

      const alerts = store.listAlerts(10, true);
      expect(alerts.length).toBe(1);
      expect(alerts[0]!.title).toBe('Threshold Warning');

      store.acknowledgeAlert(alertId);
      expect(store.listAlerts(10, true).length).toBe(0);

      // Prune retention
      clock += 100 * 24 * 60 * 60 * 1000; // +100 days
      const pruneResult = store.pruneRetention(90 * 24 * 60 * 60 * 1000, 365 * 24 * 60 * 60 * 1000);
      expect(pruneResult.prunedRuns).toBe(1);

      // Details should now be pruned
      const prunedRun = store.getRun(runId, true);
      expect(prunedRun?.details).toBeNull();
    } finally {
      await cleanup(tmp, store);
    }
  });

  it('recovers interrupted runs on restart', async () => {
    const clock = 2000000;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'test-store-recovery-'));
    let store1: WebStore | undefined;
    let store2: WebStore | undefined;
    try {
      const dbPath = path.join(tmp, 'web.sqlite');
      store1 = new WebStore(dbPath, () => clock);
      const runId = store1.createRun({
        runType: 'PREVIEW',
        triggerSource: 'MANUAL',
        scopeServiceDeskIds: ['1001'],
      });
      store1.acquireRunLock(runId, 'worker-old');
      store1.updateRun(runId, { status: 'RUNNING' });
      store1.close();
      store1 = undefined;

      // Simulate container restart with a new instance
      store2 = new WebStore(dbPath, () => clock + 1000);
      const recoveredRun = store2.getRun(runId);
      expect(recoveredRun?.status).toBe('INTERRUPTED');
      expect(recoveredRun?.failureReason).toBe('RUN_INTERRUPTED_BY_RESTART');
      expect(store2.getActiveLock()).toBeUndefined();
    } finally {
      if (store1) store1.close();
      await cleanup(tmp, store2);
    }
  });
});
