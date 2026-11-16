import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  DirectoryPerson,
  DirectorySourcePort,
  ExistingCustomerReference,
  ExistingCustomerScopeReaderPort,
  CustomerDetails,
} from '../src/domain';
import {
  CustomerScopeEnumerationError,
  ReadOnlyJiraCustomerTarget,
  CustomerProfileFetchResult,
  DiscoveredFieldReport,
} from '../src/connectors/jira';
import { WebStore } from '../src/web/store';
import { NotificationService } from '../src/services/notification-service';
import { ProductionSyncPreviewService } from '../src/services/production-sync-preview-service';

class MockScopeReader implements ExistingCustomerScopeReaderPort {
  constructor(
    private readonly customers: ExistingCustomerReference[],
    private readonly throwError?: Error,
  ) {}

  async *listExistingCustomers(): AsyncIterable<ExistingCustomerReference> {
    if (this.throwError) throw this.throwError;
    for (const c of this.customers) {
      yield c;
    }
  }
}

class MockDirectorySource implements DirectorySourcePort {
  constructor(
    private readonly people: DirectoryPerson[],
    private readonly throwError?: Error,
  ) {}

  async getPeople(): Promise<DirectoryPerson[]> {
    if (this.throwError) throw this.throwError;
    return this.people;
  }
}

class MockJiraCustomerTarget {
  constructor(
    private readonly profiles: Map<string, CustomerDetails>,
    private readonly throwOnId?: string,
    private readonly fieldsReportOverride?: DiscoveredFieldReport,
  ) {}

  async discoverFields(): Promise<DiscoveredFieldReport> {
    if (this.fieldsReportOverride) {
      return this.fieldsReportOverride;
    }
    return {
      fields: [
        { id: '1', name: 'Title', typeName: 'TEXT', required: false },
        { id: '2', name: 'Office Phone Number', typeName: 'PHONE', required: false },
        { id: '3', name: 'Supervisor', typeName: 'USER', required: false },
        { id: '4', name: 'Office/Classroom', typeName: 'TEXT', required: false },
        { id: '5', name: 'Email Address', typeName: 'TEXT', required: false },
      ],
      fieldCount: 5,
      matchedDomainFields: {
        title: '1',
        officePhoneNumber: '2',
        supervisor: '3',
        officeClassroom: '4',
        emailAddress: '5',
      },
      missingDomainFields: [],
      ambiguousDomainFields: {},
      unmappedFields: [],
      unknownTypes: [],
    };
  }

  async getCustomerProfile(accountId: string, email: string): Promise<CustomerProfileFetchResult> {
    if (this.throwOnId === accountId) {
      throw new Error(`Simulated Jira fetch error for ${accountId}`);
    }
    const details = this.profiles.get(accountId) ?? {
      email,
      title: null,
      officePhoneNumber: null,
      supervisor: null,
      officeClassroom: null,
      emailAddress: null,
    };
    return {
      profile: { customerId: accountId, details: [] },
      customerDetails: details,
    };
  }
}

describe('ProductionSyncPreviewService', () => {
  let tmp: string;
  let store: WebStore | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'test-preview-'));
  });

  afterEach(async () => {
    if (store) {
      store.close();
      store = undefined;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('filters exact approved domains before profile reads and binds domains to the digest', async () => {
    store = new WebStore(path.join(tmp, 'web.sqlite'));
    store.updateSettings({ approved_email_domains: 'example.org,example.com' }, null);
    const emails = [
      'a@example.com',
      'b@example.org',
      'c@external.test',
      'd@sub.example.com',
      'e@notexample.com',
    ];
    const customers = emails.map((email, i) => ({
      sourceCustomerId: String(i),
      normalizedEmail: email,
      sourceScopeReferences: ['sd-1'],
    }));
    const people = emails.map((email, i) => ({
      sourceId: String(i),
      email,
      displayName: 'Test',
      jobTitle: 'Engineer',
    }));
    const target = new MockJiraCustomerTarget(new Map(), '2');
    const service = new ProductionSyncPreviewService(
      new MockDirectorySource(people),
      new MockScopeReader(customers),
      target as unknown as ReadOnlyJiraCustomerTarget,
      store,
      new NotificationService(store),
    );
    const execute = () =>
      service.executePreview({
        runId: store!.createRun({
          runType: 'PREVIEW',
          triggerSource: 'MANUAL',
          scopeServiceDeskIds: ['sd-1'],
        }),
        scopeServiceDeskIds: ['sd-1'],
      });
    const first = await execute();
    expect(first.proposedCustomerChangesCount).toBe(2);
    expect(first.skippedRecords.map((r) => r.reason)).toEqual(Array(3).fill('DOMAIN_NOT_APPROVED'));
    expect(first.previewDigest).toMatch(/^[a-f0-9]{64}$/);
    store.updateSettings({ approved_email_domains: 'EXAMPLE.COM,example.org,example.com' }, null);
    expect((await execute()).previewDigest).toBe(first.previewDigest);
    store.updateSettings({ approved_email_domains: 'example.com,example.org,unused.test' }, null);
    expect((await execute()).previewDigest).not.toBe(first.previewDigest);
    store.updateSettings({ approved_email_domains: '' }, null);
    await expect(execute()).rejects.toThrow('Configure approved email domains');
  });

  it('enumerates scope, deduplicates across projects, matches exact email, and detects changes', async () => {
    store = new WebStore(path.join(tmp, 'web.sqlite'));
    store.updateSettings({ approved_email_domains: 'example.com' }, null);
    store.bootstrapAdmin('admin', 'Password12345!');
    const notificationService = new NotificationService(store);

    const customers: ExistingCustomerReference[] = [
      {
        sourceCustomerId: 'acc-1',
        normalizedEmail: 'alice@example.com',
        displayName: 'Alice Smith',
        isActive: true,
        sourceScopeReferences: ['sd-1'],
      },
      // Duplicate customer in another service desk
      {
        sourceCustomerId: 'acc-1',
        normalizedEmail: 'alice@example.com',
        displayName: 'Alice Smith',
        isActive: true,
        sourceScopeReferences: ['sd-2'],
      },
      // Customer with no changes
      {
        sourceCustomerId: 'acc-2',
        normalizedEmail: 'bob@example.com',
        displayName: 'Bob Jones',
        isActive: true,
        sourceScopeReferences: ['sd-1'],
      },
      // Missing in Entra
      {
        sourceCustomerId: 'acc-3',
        normalizedEmail: 'charlie@example.com',
        displayName: 'Charlie Brown',
        isActive: true,
        sourceScopeReferences: ['sd-1'],
      },
      // Inactive customer in Jira
      {
        sourceCustomerId: 'acc-4',
        normalizedEmail: 'dana@example.com',
        displayName: 'Dana White',
        isActive: false,
        sourceScopeReferences: ['sd-1'],
      },
      // Ambiguous match in Entra
      {
        sourceCustomerId: 'acc-5',
        normalizedEmail: 'evan@example.com',
        displayName: 'Evan Green',
        isActive: true,
        sourceScopeReferences: ['sd-1'],
      },
    ];

    const people: DirectoryPerson[] = [
      {
        sourceId: 'entra-1',
        displayName: 'Alice Smith',
        email: 'alice@example.com',
        jobTitle: 'Senior Engineer',
        officePhone: '555-0100',
        supervisorName: 'Director Davis',
        officeLocation: 'Building A-101',
      },
      {
        sourceId: 'entra-2',
        displayName: 'Bob Jones',
        email: 'bob@example.com',
        jobTitle: 'Analyst',
        officePhone: '555-0200',
      },
      // Two Evans with same email -> ambiguous
      {
        sourceId: 'entra-5a',
        displayName: 'Evan Green (Corp)',
        email: 'evan@example.com',
        jobTitle: 'Accountant',
      },
      {
        sourceId: 'entra-5b',
        displayName: 'Evan Green (Branch)',
        email: 'evan@example.com',
        jobTitle: 'Auditor',
      },
    ];

    const profiles = new Map<string, CustomerDetails>();
    // Alice has outdated title in Jira
    profiles.set('acc-1', {
      email: 'alice@example.com',
      title: 'Engineer',
      officePhoneNumber: '555-0100',
      supervisor: 'Director Davis',
      officeClassroom: 'Building A-101',
      emailAddress: 'alice@example.com',
    });
    // Bob has exact same values in Jira
    profiles.set('acc-2', {
      email: 'bob@example.com',
      title: 'Analyst',
      officePhoneNumber: '555-0200',
      supervisor: null,
      officeClassroom: null,
      emailAddress: 'bob@example.com',
    });

    const scopeReader = new MockScopeReader(customers);
    const directorySource = new MockDirectorySource(people);
    const jiraTarget = new MockJiraCustomerTarget(
      profiles,
    ) as unknown as ReadOnlyJiraCustomerTarget;

    const previewService = new ProductionSyncPreviewService(
      directorySource,
      scopeReader,
      jiraTarget,
      store,
      notificationService,
    );

    const runId = store.createRun({
      runType: 'PREVIEW',
      triggerSource: 'MANUAL',
      scopeServiceDeskIds: ['sd-1', 'sd-2'],
    });

    const result = await previewService.executePreview({
      runId,
      scopeServiceDeskIds: ['sd-1', 'sd-2'],
    });

    expect(result.totalEnumerated).toBe(6);
    expect(result.uniqueCustomers).toBe(5);
    expect(result.proposedCustomerChangesCount).toBe(1); // Only Alice
    expect(result.proposedFieldChangesCount).toBe(1); // Title update
    expect(result.proposedChanges[0]!.customerAccountId).toBe('acc-1');
    expect(result.proposedChanges[0]!.changedFields[0]!.fieldName).toBe('title');
    expect(result.proposedChanges[0]!.changedFields[0]!.newValue).toBe('Senior Engineer');

    // Verify skipped records
    const skippedReasons = result.skippedRecords.map((r) => r.reason);
    expect(skippedReasons).toContain('INACTIVE');
    expect(skippedReasons).toContain('ENTRA_NOT_FOUND');
    expect(skippedReasons).toContain('ENTRA_AMBIGUOUS');

    // Digest exists and is a 64-char sha256 hex string
    expect(result.previewDigest).toMatch(/^[a-f0-9]{64}$/);

    // Verify run status in store
    const persisted = store.getRun(runId, true);
    expect(persisted?.status).toBe('COMPLETED');
    expect(persisted?.previewDigest).toBe(result.previewDigest);
    expect(persisted?.details?.proposedCustomerChangesCount).toBe(1);
  });

  it('fails closed on upstream customer enumeration errors and does not produce preview digest', async () => {
    store = new WebStore(path.join(tmp, 'web.sqlite'));
    store.updateSettings({ approved_email_domains: 'example.com' }, null);
    store.bootstrapAdmin('admin', 'Password12345!');
    const notificationService = new NotificationService(store);

    const scopeReader = new MockScopeReader(
      [],
      new CustomerScopeEnumerationError('ENUMERATION_FORBIDDEN', 'Access denied to desk 99'),
    );
    const directorySource = new MockDirectorySource([]);
    const jiraTarget = new MockJiraCustomerTarget(
      new Map(),
    ) as unknown as ReadOnlyJiraCustomerTarget;

    const previewService = new ProductionSyncPreviewService(
      directorySource,
      scopeReader,
      jiraTarget,
      store,
      notificationService,
    );

    const runId = store.createRun({
      runType: 'PREVIEW',
      triggerSource: 'MANUAL',
      scopeServiceDeskIds: ['99'],
    });

    await expect(
      previewService.executePreview({ runId, scopeServiceDeskIds: ['99'] }),
    ).rejects.toThrow('Jira customer enumeration failed');

    const failedRun = store.getRun(runId);
    expect(failedRun?.status).toBe('FAILED');
    expect(failedRun?.previewDigest).toBeNull();
    expect(failedRun?.failureReason).toContain('ENUMERATION_FORBIDDEN');

    // Active lock must be released even after failure
    expect(store.getActiveLock()).toBeUndefined();
  });

  it('preserves existing populated Jira values when Entra values are empty', async () => {
    store = new WebStore(path.join(tmp, 'web.sqlite'));
    store.updateSettings({ approved_email_domains: 'example.com' }, null);
    store.bootstrapAdmin('admin', 'Password12345!');
    const notificationService = new NotificationService(store);

    const customers: ExistingCustomerReference[] = [
      {
        sourceCustomerId: 'acc-preserve',
        normalizedEmail: 'preserve@example.com',
        displayName: 'Preserve Test',
        isActive: true,
        sourceScopeReferences: ['sd-1'],
      },
    ];

    // Entra person has NO phone or supervisor
    const people: DirectoryPerson[] = [
      {
        sourceId: 'entra-p',
        displayName: 'Preserve Test',
        email: 'preserve@example.com',
        jobTitle: 'Preserved Title',
        officePhone: null,
        supervisorName: undefined,
      },
    ];

    // Jira already has phone and supervisor populated
    const profiles = new Map<string, CustomerDetails>();
    profiles.set('acc-preserve', {
      email: 'preserve@example.com',
      title: 'Preserved Title',
      officePhoneNumber: '555-4321',
      supervisor: 'Existing Supervisor',
      officeClassroom: 'Room 10',
      emailAddress: 'preserve@example.com',
    });

    const scopeReader = new MockScopeReader(customers);
    const directorySource = new MockDirectorySource(people);
    const jiraTarget = new MockJiraCustomerTarget(
      profiles,
    ) as unknown as ReadOnlyJiraCustomerTarget;

    const previewService = new ProductionSyncPreviewService(
      directorySource,
      scopeReader,
      jiraTarget,
      store,
      notificationService,
    );

    const runId = store.createRun({
      runType: 'PREVIEW',
      triggerSource: 'MANUAL',
      scopeServiceDeskIds: ['sd-1'],
    });

    const result = await previewService.executePreview({
      runId,
      scopeServiceDeskIds: ['sd-1'],
    });

    // No changes should be proposed because populated Jira values are never erased
    expect(result.proposedCustomerChangesCount).toBe(0);
    expect(result.proposedFieldChangesCount).toBe(0);
  });

  it('fails closed when required target fields are missing in Jira CSM', async () => {
    store = new WebStore(path.join(tmp, 'web.sqlite'));
    store.updateSettings({ approved_email_domains: 'example.com' }, null);
    store.bootstrapAdmin('admin', 'Password12345!');
    const notificationService = new NotificationService(store);

    const scopeReader = new MockScopeReader([
      {
        sourceCustomerId: 'acc-1',
        normalizedEmail: 'alice@example.com',
        displayName: 'Alice Smith',
        isActive: true,
        sourceScopeReferences: ['sd-1'],
      },
    ]);
    const directorySource = new MockDirectorySource([]);
    const jiraTarget = new MockJiraCustomerTarget(new Map(), undefined, {
      fields: [{ id: '1', name: 'Title', typeName: 'TEXT', required: false }],
      fieldCount: 1,
      matchedDomainFields: { title: '1' },
      missingDomainFields: ['officePhoneNumber', 'supervisor', 'officeClassroom', 'emailAddress'],
      ambiguousDomainFields: {},
      unmappedFields: [],
      unknownTypes: [],
    }) as unknown as ReadOnlyJiraCustomerTarget;

    const previewService = new ProductionSyncPreviewService(
      directorySource,
      scopeReader,
      jiraTarget,
      store,
      notificationService,
    );

    const runId = store.createRun({
      runType: 'PREVIEW',
      triggerSource: 'MANUAL',
      scopeServiceDeskIds: ['sd-1'],
    });

    await expect(
      previewService.executePreview({ runId, scopeServiceDeskIds: ['sd-1'] }),
    ).rejects.toThrow('Required Jira customer detail field(s) missing');

    const failedRun = store.getRun(runId);
    expect(failedRun?.status).toBe('FAILED');
    expect(failedRun?.previewDigest).toBeNull();
    expect(failedRun?.failureReason).toContain('Office phone');
    expect(failedRun?.failureReason).toContain('Email address');
  });

  it('fails closed when target fields are ambiguously resolved in Jira CSM', async () => {
    store = new WebStore(path.join(tmp, 'web.sqlite'));
    store.updateSettings({ approved_email_domains: 'example.com' }, null);
    store.bootstrapAdmin('admin', 'Password12345!');
    const notificationService = new NotificationService(store);

    const scopeReader = new MockScopeReader([
      {
        sourceCustomerId: 'acc-1',
        normalizedEmail: 'alice@example.com',
        displayName: 'Alice Smith',
        isActive: true,
        sourceScopeReferences: ['sd-1'],
      },
    ]);
    const directorySource = new MockDirectorySource([]);
    const jiraTarget = new MockJiraCustomerTarget(new Map(), undefined, {
      fields: [
        { id: '1', name: 'Email Address', typeName: 'TEXT', required: false },
        { id: '2', name: 'Email', typeName: 'TEXT', required: false },
      ],
      fieldCount: 2,
      matchedDomainFields: {},
      missingDomainFields: [],
      ambiguousDomainFields: {
        emailAddress: ['Email Address', 'Email'],
      },
      unmappedFields: [],
      unknownTypes: [],
    }) as unknown as ReadOnlyJiraCustomerTarget;

    const previewService = new ProductionSyncPreviewService(
      directorySource,
      scopeReader,
      jiraTarget,
      store,
      notificationService,
    );

    const runId = store.createRun({
      runType: 'PREVIEW',
      triggerSource: 'MANUAL',
      scopeServiceDeskIds: ['sd-1'],
    });

    await expect(
      previewService.executePreview({ runId, scopeServiceDeskIds: ['sd-1'] }),
    ).rejects.toThrow('Required Jira customer detail field(s) ambiguously resolved');

    const failedRun = store.getRun(runId);
    expect(failedRun?.status).toBe('FAILED');
    expect(failedRun?.previewDigest).toBeNull();
    expect(failedRun?.failureReason).toContain('ambiguously resolved');
  });
});
