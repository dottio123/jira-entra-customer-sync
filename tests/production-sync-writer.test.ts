import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DirectoryPerson, DirectorySourcePort, CustomerDetails } from '../src/domain';
import {
  JiraCustomerDetailWriteClient,
  ReadOnlyJiraCustomerTarget,
  CustomerProfileFetchResult,
  CustomerDetailWriteResult,
  JiraHttpError,
} from '../src/connectors/jira';
import { WebStore } from '../src/web/store';
import { NotificationService } from '../src/services/notification-service';
import { ProductionSyncWriterService } from '../src/services/production-sync-writer-service';

class MockDirectorySource implements DirectorySourcePort {
  constructor(private people: DirectoryPerson[]) {}

  setPeople(people: DirectoryPerson[]): void {
    this.people = people;
  }

  async getPeople(): Promise<DirectoryPerson[]> {
    return this.people;
  }
}

class MockJiraTarget {
  constructor(private profiles: Map<string, CustomerDetails>) {}

  setProfile(accountId: string, details: CustomerDetails): void {
    this.profiles.set(accountId, details);
  }

  async getCustomerProfile(accountId: string, email: string): Promise<CustomerProfileFetchResult> {
    const details = this.profiles.get(accountId) ?? {
      email,
      title: null,
      officePhoneNumber: null,
      supervisor: null,
      officeClassroom: null,
    };
    return {
      profile: { customerId: accountId, details: [] },
      customerDetails: { ...details },
    };
  }
}

class MockJiraWriter {
  public writes: Array<{ customerId: string; fieldName: string; value: string }> = [];
  public throwErrorOnField?: string;
  public mockTarget?: MockJiraTarget;

  constructor(mockTarget?: MockJiraTarget) {
    this.mockTarget = mockTarget;
  }

  async setCustomerDetail(
    customerId: string,
    fieldName: string,
    value: string,
  ): Promise<CustomerDetailWriteResult> {
    if (this.throwErrorOnField === fieldName) {
      throw new JiraHttpError('Field write rejected by Jira', 400, 'req-400', {
        error: 'INVALID_FIELD',
      });
    }
    this.writes.push({ customerId, fieldName, value });

    // Update target mock if present so read-after-write verification succeeds
    if (this.mockTarget) {
      const res = await this.mockTarget.getCustomerProfile(customerId, 'test@example.com');
      const updated = { ...res.customerDetails, [fieldName]: value };
      this.mockTarget.setProfile(customerId, updated);
    }

    return { statusCode: 200, requestId: 'req-200' };
  }
}

describe('ProductionSyncWriterService', () => {
  let tmp: string;
  let store: WebStore | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'test-writer-'));
  });

  afterEach(async () => {
    if (store) {
      store.close();
      store = undefined;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('fails if web writes are disabled in settings', async () => {
    store = new WebStore(path.join(tmp, 'web.sqlite'));
    store.updateSettings({ approved_email_domains: 'example.com' }, null);
    store.bootstrapAdmin('admin', 'Password12345!');
    // writes_enabled is false by default

    const writerService = new ProductionSyncWriterService(
      new MockDirectorySource([]),
      new MockJiraTarget(new Map()) as unknown as ReadOnlyJiraCustomerTarget,
      new MockJiraWriter() as unknown as JiraCustomerDetailWriteClient,
      store,
      new NotificationService(store),
    );

    const runId = store.createRun({
      runType: 'LIVE_ROLLOUT',
      triggerSource: 'MANUAL',
      scopeServiceDeskIds: ['sd-1'],
    });

    await expect(
      writerService.executeLiveRollout({
        runId,
        previewRunId: 99,
        approvalDigest: 'some-digest',
      }),
    ).rejects.toThrow('Writes are currently disabled in application settings');

    const run = store.getRun(runId);
    expect(run?.status).toBe('FAILED');
    expect(store.getActiveLock()).toBeUndefined();
  });

  it('fails if application is uncommissioned', async () => {
    store = new WebStore(path.join(tmp, 'web.sqlite'));
    store.updateSettings({ approved_email_domains: 'example.com' }, null);
    store.bootstrapAdmin('admin', 'Password12345!');
    store.updateSettings({ writes_enabled: true, commissioning_status: 'UNCOMMISSIONED' }, 1);

    const writerService = new ProductionSyncWriterService(
      new MockDirectorySource([]),
      new MockJiraTarget(new Map()) as unknown as ReadOnlyJiraCustomerTarget,
      new MockJiraWriter() as unknown as JiraCustomerDetailWriteClient,
      store,
      new NotificationService(store),
    );

    const runId = store.createRun({
      runType: 'LIVE_ROLLOUT',
      triggerSource: 'MANUAL',
      scopeServiceDeskIds: ['sd-1'],
    });

    await expect(
      writerService.executeLiveRollout({
        runId,
        previewRunId: 99,
        approvalDigest: 'some-digest',
      }),
    ).rejects.toThrow('Live writes cannot be executed while application is UNCOMMISSIONED');

    const run = store.getRun(runId);
    expect(run?.status).toBe('FAILED');
    expect(store.getActiveLock()).toBeUndefined();
  });

  it('fails if approval digest does not match preview digest', async () => {
    store = new WebStore(path.join(tmp, 'web.sqlite'));
    store.updateSettings({ approved_email_domains: 'example.com' }, null);
    store.bootstrapAdmin('admin', 'Password12345!');
    store.updateSettings(
      { writes_enabled: true, commissioning_status: 'COMMISSIONED_MANUAL_ONLY' },
      1,
    );

    const previewRunId = store.createRun({
      runType: 'PREVIEW',
      triggerSource: 'MANUAL',
      scopeServiceDeskIds: ['sd-1'],
    });
    store.updateRun(previewRunId, {
      status: 'COMPLETED',
      previewDigest: 'valid-digest-12345',
      details: { approvedEmailDomains: ['example.com'], proposedChanges: [] },
    });

    const writerService = new ProductionSyncWriterService(
      new MockDirectorySource([]),
      new MockJiraTarget(new Map()) as unknown as ReadOnlyJiraCustomerTarget,
      new MockJiraWriter() as unknown as JiraCustomerDetailWriteClient,
      store,
      new NotificationService(store),
    );

    const runId = store.createRun({
      runType: 'LIVE_ROLLOUT',
      triggerSource: 'MANUAL',
      scopeServiceDeskIds: ['sd-1'],
    });

    await expect(
      writerService.executeLiveRollout({
        runId,
        previewRunId,
        approvalDigest: 'mismatched-digest',
      }),
    ).rejects.toThrow('Approval digest does not match the preview digest');
  });

  it('pauses before writes if planned customer threshold is exceeded', async () => {
    store = new WebStore(path.join(tmp, 'web.sqlite'));
    store.updateSettings({ approved_email_domains: 'example.com' }, null);
    store.bootstrapAdmin('admin', 'Password12345!');
    store.updateSettings(
      {
        writes_enabled: true,
        commissioning_status: 'COMMISSIONED_MANUAL_ONLY',
        max_customers_threshold: 2,
      },
      1,
    );

    const previewRunId = store.createRun({
      runType: 'PREVIEW',
      triggerSource: 'MANUAL',
      scopeServiceDeskIds: ['sd-1'],
    });

    // 3 customers planned, but threshold is 2
    const digest = 'digest-over-threshold';
    store.updateRun(previewRunId, {
      status: 'COMPLETED',
      previewDigest: digest,
      details: {
        approvedEmailDomains: ['example.com'],
        proposedChanges: [
          {
            customerAccountId: 'c1',
            customerEmail: 'c1@example.com',
            customerRef: 'ref-1',
            changedFields: [{ fieldName: 'title', oldValue: 'A', newValue: 'B' }],
          },
          {
            customerAccountId: 'c2',
            customerEmail: 'c2@example.com',
            customerRef: 'ref-2',
            changedFields: [{ fieldName: 'title', oldValue: 'A', newValue: 'B' }],
          },
          {
            customerAccountId: 'c3',
            customerEmail: 'c3@example.com',
            customerRef: 'ref-3',
            changedFields: [{ fieldName: 'title', oldValue: 'A', newValue: 'B' }],
          },
        ],
      },
    });

    const mockWriter = new MockJiraWriter();
    const writerService = new ProductionSyncWriterService(
      new MockDirectorySource([]),
      new MockJiraTarget(new Map()) as unknown as ReadOnlyJiraCustomerTarget,
      mockWriter as unknown as JiraCustomerDetailWriteClient,
      store,
      new NotificationService(store),
    );

    const runId = store.createRun({
      runType: 'LIVE_ROLLOUT',
      triggerSource: 'MANUAL',
      scopeServiceDeskIds: ['sd-1'],
    });

    const result = await writerService.executeLiveRollout({
      runId,
      previewRunId,
      approvalDigest: digest,
    });

    expect(result.status).toBe('PAUSED');
    expect(result.stoppedEarly).toBe(true);
    expect(result.stopReason).toContain('Threshold exceeded');
    expect(mockWriter.writes.length).toBe(0); // Zero writes executed!

    const run = store.getRun(runId);
    expect(run?.status).toBe('PAUSED');
  });

  it('stops and aborts writes when drift is detected during preflight', async () => {
    store = new WebStore(path.join(tmp, 'web.sqlite'));
    store.updateSettings({ approved_email_domains: 'example.com' }, null);
    store.bootstrapAdmin('admin', 'Password12345!');
    store.updateSettings(
      { writes_enabled: true, commissioning_status: 'COMMISSIONED_MANUAL_ONLY' },
      1,
    );

    const previewRunId = store.createRun({
      runType: 'PREVIEW',
      triggerSource: 'MANUAL',
      scopeServiceDeskIds: ['sd-1'],
    });

    const digest = 'digest-drift-test';
    store.updateRun(previewRunId, {
      status: 'COMPLETED',
      previewDigest: digest,
      details: {
        approvedEmailDomains: ['example.com'],
        proposedChanges: [
          {
            customerAccountId: 'acc-drift',
            customerEmail: 'drift@example.com',
            customerRef: 'ref-drift',
            changedFields: [
              { fieldName: 'title', oldValue: 'Engineer', newValue: 'Lead Engineer' },
            ],
          },
        ],
      },
    });

    // In Entra, title changed to 'Principal Engineer' instead of 'Lead Engineer' -> DRIFT!
    const dirSource = new MockDirectorySource([
      {
        sourceId: 'e-1',
        displayName: 'Drift Test',
        email: 'drift@example.com',
        jobTitle: 'Principal Engineer',
      },
    ]);

    const jiraTarget = new MockJiraTarget(
      new Map([['acc-drift', { email: 'drift@example.com', title: 'Engineer' }]]),
    );

    const mockWriter = new MockJiraWriter(jiraTarget);
    const writerService = new ProductionSyncWriterService(
      dirSource,
      jiraTarget as unknown as ReadOnlyJiraCustomerTarget,
      mockWriter as unknown as JiraCustomerDetailWriteClient,
      store,
      new NotificationService(store),
      { writeMinIntervalMs: 0 },
    );

    const runId = store.createRun({
      runType: 'LIVE_ROLLOUT',
      triggerSource: 'MANUAL',
      scopeServiceDeskIds: ['sd-1'],
    });

    const result = await writerService.executeLiveRollout({
      runId,
      previewRunId,
      approvalDigest: digest,
    });

    expect(result.status).toBe('FAILED');
    expect(result.stoppedEarly).toBe(true);
    expect(result.stopReason).toContain('Drift detected');
    expect(mockWriter.writes.length).toBe(0); // Zero mutations!
  });

  it.each([undefined, ['external.test']])(
    'rejects legacy or changed domain scope before mutations (%j)',
    async (approvedEmailDomains) => {
      store = new WebStore(path.join(tmp, 'web.sqlite'));
      store.updateSettings(
        {
          approved_email_domains: 'example.com',
          writes_enabled: true,
          commissioning_status: 'COMMISSIONED_MANUAL_ONLY',
        },
        null,
      );
      const previewRunId = store.createRun({
        runType: 'PREVIEW',
        triggerSource: 'MANUAL',
        scopeServiceDeskIds: ['sd-1'],
      });
      const digest = 'a'.repeat(64);
      store.updateRun(previewRunId, {
        status: 'COMPLETED',
        previewDigest: digest,
        details: { approvedEmailDomains, proposedChanges: [] },
      });
      const target = new MockJiraTarget(new Map());
      const mutations = new MockJiraWriter(target);
      const writer = new ProductionSyncWriterService(
        new MockDirectorySource([]),
        target as unknown as ReadOnlyJiraCustomerTarget,
        mutations as unknown as JiraCustomerDetailWriteClient,
        store,
        new NotificationService(store),
      );
      const runId = store.createRun({
        runType: 'LIVE_ROLLOUT',
        triggerSource: 'MANUAL',
        scopeServiceDeskIds: ['sd-1'],
      });
      await expect(
        writer.executeLiveRollout({ runId, previewRunId, approvalDigest: digest }),
      ).rejects.toThrow('Approved email domain scope');
      expect(mutations.writes).toHaveLength(0);
    },
  );

  it('performs sequential writes with read-after-write verification on valid matches', async () => {
    store = new WebStore(path.join(tmp, 'web.sqlite'));
    store.updateSettings({ approved_email_domains: 'example.com' }, null);
    store.bootstrapAdmin('admin', 'Password12345!');
    store.updateSettings(
      { writes_enabled: true, commissioning_status: 'COMMISSIONED_MANUAL_ONLY' },
      1,
    );

    const previewRunId = store.createRun({
      runType: 'PREVIEW',
      triggerSource: 'MANUAL',
      scopeServiceDeskIds: ['sd-1'],
    });

    const digest = 'digest-success-test';
    store.updateRun(previewRunId, {
      status: 'COMPLETED',
      previewDigest: digest,
      details: {
        approvedEmailDomains: ['example.com'],
        proposedChanges: [
          {
            customerAccountId: 'acc-success',
            customerEmail: 'success@example.com',
            customerRef: 'ref-success',
            changedFields: [
              { fieldName: 'title', oldValue: 'Junior', newValue: 'Senior' },
              { fieldName: 'officePhoneNumber', oldValue: null, newValue: '555-9999' },
            ],
          },
        ],
      },
    });

    const dirSource = new MockDirectorySource([
      {
        sourceId: 'e-1',
        displayName: 'Success Test',
        email: 'success@example.com',
        jobTitle: 'Senior',
        officePhone: '555-9999',
      },
    ]);

    const jiraTarget = new MockJiraTarget(
      new Map([
        [
          'acc-success',
          {
            email: 'success@example.com',
            title: 'Junior',
            officePhoneNumber: null,
            emailAddress: 'success@example.com',
          },
        ],
      ]),
    );

    const mockWriter = new MockJiraWriter(jiraTarget);
    const writerService = new ProductionSyncWriterService(
      dirSource,
      jiraTarget as unknown as ReadOnlyJiraCustomerTarget,
      mockWriter as unknown as JiraCustomerDetailWriteClient,
      store,
      new NotificationService(store),
      { writeMinIntervalMs: 0 },
    );

    const runId = store.createRun({
      runType: 'LIVE_ROLLOUT',
      triggerSource: 'MANUAL',
      scopeServiceDeskIds: ['sd-1'],
    });

    const result = await writerService.executeLiveRollout({
      runId,
      previewRunId,
      approvalDigest: digest,
    });

    expect(result.status).toBe('COMPLETED');
    expect(result.totalVerifiedFields).toBe(2);
    expect(result.totalVerifiedCustomers).toBe(1);
    expect(mockWriter.writes.length).toBe(2);

    const run = store.getRun(runId);
    expect(run?.status).toBe('COMPLETED');
    expect(run?.verifiedFieldChanges).toBe(2);
  });

  it('aborts if scope drift is detected between preview and rollout', async () => {
    store = new WebStore(path.join(tmp, 'web.sqlite'));
    store.updateSettings({ approved_email_domains: 'example.com' }, null);
    store.bootstrapAdmin('admin', 'Password12345!');
    store.updateSettings(
      { writes_enabled: true, commissioning_status: 'COMMISSIONED_MANUAL_ONLY' },
      1,
    );

    const previewRunId = store.createRun({
      runType: 'PREVIEW',
      triggerSource: 'MANUAL',
      scopeServiceDeskIds: ['sd-1'],
    });
    store.updateRun(previewRunId, {
      status: 'COMPLETED',
      previewDigest: 'digest-scope-drift',
      details: { approvedEmailDomains: ['example.com'], proposedChanges: [] },
    });

    const writerService = new ProductionSyncWriterService(
      new MockDirectorySource([]),
      new MockJiraTarget(new Map()) as unknown as ReadOnlyJiraCustomerTarget,
      new MockJiraWriter() as unknown as JiraCustomerDetailWriteClient,
      store,
      new NotificationService(store),
    );

    const runId = store.createRun({
      runType: 'LIVE_ROLLOUT',
      triggerSource: 'MANUAL',
      scopeServiceDeskIds: ['sd-1', 'sd-2'], // Different scope!
    });

    await expect(
      writerService.executeLiveRollout({
        runId,
        previewRunId,
        approvalDigest: 'digest-scope-drift',
        configuredScopeServiceDeskIds: ['sd-1', 'sd-2'],
      }),
    ).rejects.toThrow('Scope drift detected');
  });

  it('refuses to re-execute a preview that was already executed in another rollout', async () => {
    store = new WebStore(path.join(tmp, 'web.sqlite'));
    store.updateSettings({ approved_email_domains: 'example.com' }, null);
    store.bootstrapAdmin('admin', 'Password12345!');
    store.updateSettings(
      { writes_enabled: true, commissioning_status: 'COMMISSIONED_MANUAL_ONLY' },
      1,
    );

    const previewRunId = store.createRun({
      runType: 'PREVIEW',
      triggerSource: 'MANUAL',
      scopeServiceDeskIds: ['sd-1'],
    });
    store.updateRun(previewRunId, {
      status: 'COMPLETED',
      previewDigest: 'digest-repeat',
      details: { approvedEmailDomains: ['example.com'], proposedChanges: [] },
    });

    // Simulate prior completed rollout for this preview
    const priorRolloutId = store.createRun({
      runType: 'LIVE_ROLLOUT',
      triggerSource: 'MANUAL',
      scopeServiceDeskIds: ['sd-1'],
      previewRunId,
    });
    store.updateRun(priorRolloutId, { status: 'COMPLETED' });

    const writerService = new ProductionSyncWriterService(
      new MockDirectorySource([]),
      new MockJiraTarget(new Map()) as unknown as ReadOnlyJiraCustomerTarget,
      new MockJiraWriter() as unknown as JiraCustomerDetailWriteClient,
      store,
      new NotificationService(store),
    );

    const runId = store.createRun({
      runType: 'LIVE_ROLLOUT',
      triggerSource: 'MANUAL',
      scopeServiceDeskIds: ['sd-1'],
      previewRunId,
    });

    await expect(
      writerService.executeLiveRollout({
        runId,
        previewRunId,
        approvalDigest: 'digest-repeat',
      }),
    ).rejects.toThrow('has already been executed in rollout run');
  });

  it('writes emailAddress sequentially and verifies with case-insensitive equivalence', async () => {
    store = new WebStore(path.join(tmp, 'web.sqlite'));
    store.updateSettings({ approved_email_domains: 'example.com' }, null);
    store.bootstrapAdmin('admin', 'Password12345!');
    store.updateSettings(
      { writes_enabled: true, commissioning_status: 'COMMISSIONED_MANUAL_ONLY' },
      1,
    );

    const previewRunId = store.createRun({
      runType: 'PREVIEW',
      triggerSource: 'MANUAL',
      scopeServiceDeskIds: ['sd-1'],
    });

    const digest = 'digest-email-write-success';
    store.updateRun(previewRunId, {
      status: 'COMPLETED',
      previewDigest: digest,
      details: {
        approvedEmailDomains: ['example.com'],
        proposedChanges: [
          {
            customerAccountId: 'acc-email-1',
            customerEmail: 'user@example.com',
            customerRef: 'ref-email-1',
            changedFields: [
              { fieldName: 'emailAddress', oldValue: null, newValue: 'user@example.com' },
            ],
          },
        ],
      },
    });

    const dirSource = new MockDirectorySource([
      {
        sourceId: 'e-1',
        displayName: 'Email Test',
        email: 'user@example.com',
      },
    ]);

    const jiraTarget = new MockJiraTarget(
      new Map([
        [
          'acc-email-1',
          {
            email: 'user@example.com',
            title: null,
            officePhoneNumber: null,
            emailAddress: null,
          },
        ],
      ]),
    );

    const mockWriter = new MockJiraWriter(jiraTarget);
    const writerService = new ProductionSyncWriterService(
      dirSource,
      jiraTarget as unknown as ReadOnlyJiraCustomerTarget,
      mockWriter as unknown as JiraCustomerDetailWriteClient,
      store,
      new NotificationService(store),
      { writeMinIntervalMs: 0 },
    );

    const runId = store.createRun({
      runType: 'LIVE_ROLLOUT',
      triggerSource: 'MANUAL',
      scopeServiceDeskIds: ['sd-1'],
    });

    const result = await writerService.executeLiveRollout({
      runId,
      previewRunId,
      approvalDigest: digest,
    });

    expect(result.status).toBe('COMPLETED');
    expect(result.totalVerifiedFields).toBe(1);
    expect(result.totalVerifiedCustomers).toBe(1);
    expect(mockWriter.writes.length).toBe(1);
    expect(mockWriter.writes[0]?.fieldName).toBe('emailAddress');
    expect(mockWriter.writes[0]?.value).toBe('user@example.com');
  });

  it('redacts email values from error messages when emailAddress verification fails', async () => {
    store = new WebStore(path.join(tmp, 'web.sqlite'));
    store.updateSettings({ approved_email_domains: 'example.com' }, null);
    store.bootstrapAdmin('admin', 'Password12345!');
    store.updateSettings(
      { writes_enabled: true, commissioning_status: 'COMMISSIONED_MANUAL_ONLY' },
      1,
    );

    const previewRunId = store.createRun({
      runType: 'PREVIEW',
      triggerSource: 'MANUAL',
      scopeServiceDeskIds: ['sd-1'],
    });

    const digest = 'digest-email-verify-fail';
    store.updateRun(previewRunId, {
      status: 'COMPLETED',
      previewDigest: digest,
      details: {
        approvedEmailDomains: ['example.com'],
        proposedChanges: [
          {
            customerAccountId: 'acc-email-fail',
            customerEmail: 'secret.user@example.com',
            customerRef: 'ref-email-fail',
            changedFields: [
              { fieldName: 'emailAddress', oldValue: null, newValue: 'secret.user@example.com' },
            ],
          },
        ],
      },
    });

    const dirSource = new MockDirectorySource([
      {
        sourceId: 'e-1',
        displayName: 'Secret User',
        email: 'secret.user@example.com',
      },
    ]);

    // Target returns mismatched value on readback
    const jiraTarget = new MockJiraTarget(
      new Map([
        [
          'acc-email-fail',
          {
            email: 'secret.user@example.com',
            title: null,
            officePhoneNumber: null,
            emailAddress: null,
          },
        ],
      ]),
    );

    // Writer does NOT update the profile, so read-after-write returns emailAddress: null !== 'secret.user@example.com'
    const mockWriter = {
      setCustomerDetail: vi.fn().mockResolvedValue({ statusCode: 200, requestId: 'req-200' }),
    };

    const writerService = new ProductionSyncWriterService(
      dirSource,
      jiraTarget as unknown as ReadOnlyJiraCustomerTarget,
      mockWriter as unknown as JiraCustomerDetailWriteClient,
      store,
      new NotificationService(store),
      { writeMinIntervalMs: 0 },
    );

    const runId = store.createRun({
      runType: 'LIVE_ROLLOUT',
      triggerSource: 'MANUAL',
      scopeServiceDeskIds: ['sd-1'],
    });

    const result = await writerService.executeLiveRollout({
      runId,
      previewRunId,
      approvalDigest: digest,
    });

    expect(result.status).toBe('FAILED');
    expect(result.totalVerifiedFields).toBe(0);

    const run = store.getRun(runId, true);
    expect(run?.status).toBe('FAILED');
    // Ensure failure message does NOT leak the email address
    expect(run?.failureReason).not.toContain('secret.user@example.com');
    expect(run?.failureReason).toContain(
      'Field verification failed for customer ref-email-fail field emailAddress.',
    );

    const details = run?.details as
      | { records?: Array<{ appliedFields?: Array<{ status?: string; errorMessage?: string }> }> }
      | undefined;
    const appliedField = details?.records?.[0]?.appliedFields?.[0];
    expect(appliedField?.status).toBe('FAILED');
    expect(appliedField?.errorMessage).not.toContain('secret.user@example.com');
    expect(appliedField?.errorMessage).toBe(
      'Verification failed: Jira Email Address value did not match expected value.',
    );
  });
});
