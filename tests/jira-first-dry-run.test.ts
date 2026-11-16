import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import {
  JiraFirstDryRunService,
  EndToEndDryRunService,
  DiffPlanner,
  MappingService,
} from '../src/services';
import {
  ReadOnlyJiraCustomerTarget,
  RequestBudgetGuard,
  BasicJiraAuthProvider,
  GetOnlyJiraHttpClient,
  DiscoveredFieldReport,
} from '../src/connectors/jira';
import { InMemoryDirectorySource, InMemoryCustomerScopeReader } from '../src/connectors/memory';
import {
  DirectoryPerson,
  DirectorySourcePort,
  ExistingCustomerReference,
  CustomerDetails,
  CustomerIdentityResolverPort,
  ExistingCustomerScopeReaderPort,
} from '../src/domain';
import { parseConfig } from '../src/config';
import { hashIdentifier } from '../src/utils/privacy';
import { Logger } from '../src/utils/logger';

const testLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  setLevel: vi.fn(),
} as unknown as Logger;

describe('Jira-First Synchronization Scope Architecture (25 Validation Points)', () => {
  const mockJiraFieldResponse = {
    results: [
      { id: 'field-title', name: 'Title', type: { name: 'STRING' } },
      {
        id: 'field-phone',
        name: 'Office Phone Number',
        type: { name: 'STRING' },
      },
      { id: 'field-supervisor', name: 'Supervisor', type: { name: 'STRING' } },
      {
        id: 'field-office',
        name: 'Office/Classroom',
        type: { name: 'STRING' },
      },
      {
        id: 'field-email',
        name: 'Email Address',
        type: { name: 'STRING' },
      },
    ],
  };

  const mockDiscoveryReport: DiscoveredFieldReport = {
    fields: [
      { id: 'field-title', name: 'Title', typeName: 'STRING', required: false },
      { id: 'field-phone', name: 'Office Phone Number', typeName: 'STRING', required: false },
      { id: 'field-supervisor', name: 'Supervisor', typeName: 'STRING', required: false },
      { id: 'field-office', name: 'Office/Classroom', typeName: 'STRING', required: false },
      { id: 'field-email', name: 'Email Address', typeName: 'STRING', required: false },
    ],
    fieldCount: 5,
    matchedDomainFields: {
      title: 'field-title',
      officePhoneNumber: 'field-phone',
      supervisor: 'field-supervisor',
      officeClassroom: 'field-office',
      emailAddress: 'field-email',
    },
    missingDomainFields: [],
    ambiguousDomainFields: {},
    unmappedFields: [],
    unknownTypes: [],
  };

  const scopeReader = new InMemoryCustomerScopeReader([]);

  const createMockJiraTarget = (
    profiles: Record<string, CustomerDetails>,
    requestLog?: string[],
  ) => {
    const authProvider = new BasicJiraAuthProvider('test@example.com', 'tok');
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      requestLog?.push(url);

      if (url.includes('/api/v1/customer/details')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify(mockJiraFieldResponse),
          headers: new Headers(),
        };
      }

      const profileMatch = url.match(/\/api\/v1\/customer\/profile\/([^/?]+)/);
      if (profileMatch) {
        const customerId = profileMatch[1]!;
        const profile = profiles[customerId];
        if (profile) {
          return {
            ok: true,
            status: 200,
            text: async () =>
              JSON.stringify({
                customerId,
                details: [
                  { id: 'field-title', name: 'Title', value: profile.title },
                  {
                    id: 'field-phone',
                    name: 'Office Phone Number',
                    value: profile.officePhoneNumber,
                  },
                  {
                    id: 'field-supervisor',
                    name: 'Supervisor',
                    value: profile.supervisor,
                  },
                  {
                    id: 'field-office',
                    name: 'Office/Classroom',
                    value: profile.officeClassroom,
                  },
                  {
                    id: 'field-email',
                    name: 'Email Address',
                    value: profile.emailAddress ?? null,
                  },
                ],
              }),
            headers: new Headers(),
          };
        }
      }

      return {
        ok: false,
        status: 404,
        text: async () => 'Not Found',
        headers: new Headers(),
      };
    });

    const httpClient = new GetOnlyJiraHttpClient(authProvider, {
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    return new ReadOnlyJiraCustomerTarget({
      cloudId: 'cloud-123',
      siteUrl: 'https://test.atlassian.net',
      httpClient,
      log: testLogger,
    });
  };

  // Test 1: Entra is loaded exactly once per synchronization run.
  it('1. Entra is loaded exactly once per synchronization run', async () => {
    const mockPeople: DirectoryPerson[] = [
      { sourceId: 'e1', displayName: 'User 1', email: 'user1@example.com' },
      { sourceId: 'e2', displayName: 'User 2', email: 'user2@example.com' },
    ];
    const getPeopleSpy = vi.fn().mockResolvedValue(mockPeople);
    const dirSource: DirectorySourcePort = { getPeople: getPeopleSpy };

    const jiraCustomers: ExistingCustomerReference[] = [
      {
        sourceCustomerId: 'acc-1',
        normalizedEmail: 'user1@example.com',
        isActive: true,
        sourceScopeReferences: ['sd-1'],
      },
      {
        sourceCustomerId: 'acc-2',
        normalizedEmail: 'user2@example.com',
        isActive: true,
        sourceScopeReferences: ['sd-1'],
      },
    ];
    const scopeReader = new InMemoryCustomerScopeReader(jiraCustomers);
    const jiraTarget = createMockJiraTarget({
      'acc-1': { email: 'user1@example.com', title: 'T1' },
      'acc-2': { email: 'user2@example.com', title: 'T2' },
    });

    const service = new JiraFirstDryRunService(
      dirSource,
      scopeReader,
      jiraTarget,
      { maxRecords: 10, concurrency: 1 },
      new RequestBudgetGuard({ global: 50 }),
      new DiffPlanner(),
      new MappingService(),
      testLogger,
    );

    await service.executeDryRun();
    expect(getPeopleSpy).toHaveBeenCalledTimes(1);
  });

  // Test 2: A new run loads a new Entra snapshot.
  it('2. A new run loads a new Entra snapshot', async () => {
    let callCount = 0;
    const dirSource: DirectorySourcePort = {
      getPeople: vi.fn().mockImplementation(async () => {
        callCount++;
        return [
          {
            sourceId: `e${callCount}`,
            displayName: `User ${callCount}`,
            email: `user${callCount}@example.com`,
          },
        ];
      }),
    };

    const scopeReader = new InMemoryCustomerScopeReader([
      {
        sourceCustomerId: 'acc-1',
        normalizedEmail: 'user1@example.com',
        isActive: true,
        sourceScopeReferences: ['sd-1'],
      },
    ]);
    const jiraTarget = createMockJiraTarget({
      'acc-1': { email: 'user1@example.com' },
    });

    const service = new JiraFirstDryRunService(
      dirSource,
      scopeReader,
      jiraTarget,
      { maxRecords: 10, concurrency: 1 },
      new RequestBudgetGuard({ global: 50 }),
      new DiffPlanner(),
      new MappingService(),
      testLogger,
    );

    await service.executeDryRun();
    await service.executeDryRun();

    expect(dirSource.getPeople).toHaveBeenCalledTimes(2);
  });

  // Test 3: No Graph lookup occurs per Jira customer.
  it('3. No Graph lookup occurs per Jira customer', async () => {
    const getPeopleSpy = vi.fn().mockResolvedValue([
      { sourceId: 'e1', displayName: 'User 1', email: 'u1@example.com' },
      { sourceId: 'e2', displayName: 'User 2', email: 'u2@example.com' },
      { sourceId: 'e3', displayName: 'User 3', email: 'u3@example.com' },
    ]);
    const dirSource: DirectorySourcePort = { getPeople: getPeopleSpy };

    const jiraCustomers: ExistingCustomerReference[] = [
      {
        sourceCustomerId: 'acc-1',
        normalizedEmail: 'u1@example.com',
        isActive: true,
        sourceScopeReferences: ['sd-1'],
      },
      {
        sourceCustomerId: 'acc-2',
        normalizedEmail: 'u2@example.com',
        isActive: true,
        sourceScopeReferences: ['sd-1'],
      },
      {
        sourceCustomerId: 'acc-3',
        normalizedEmail: 'u3@example.com',
        isActive: true,
        sourceScopeReferences: ['sd-1'],
      },
    ];

    const scopeReader = new InMemoryCustomerScopeReader(jiraCustomers);
    const jiraTarget = createMockJiraTarget({
      'acc-1': { email: 'u1@example.com' },
      'acc-2': { email: 'u2@example.com' },
      'acc-3': { email: 'u3@example.com' },
    });

    const service = new JiraFirstDryRunService(
      dirSource,
      scopeReader,
      jiraTarget,
      { maxRecords: 10, concurrency: 1 },
      new RequestBudgetGuard({ global: 50 }),
      new DiffPlanner(),
      new MappingService(),
      testLogger,
    );

    await service.executeDryRun();
    // 3 customers processed, but getPeople is only called once!
    expect(getPeopleSpy).toHaveBeenCalledTimes(1);
  });

  // Test 4: Jira customer enumeration drives the processing scope.
  it('4. Jira customer enumeration drives the processing scope', async () => {
    const dirSource = new InMemoryDirectorySource([
      { sourceId: 'e1', displayName: 'Alice', email: 'alice@example.com' },
      { sourceId: 'e2', displayName: 'Bob', email: 'bob@example.com' },
      { sourceId: 'e3', displayName: 'Charlie', email: 'charlie@example.com' },
    ]);

    // Only Bob is enumerated in Jira
    const scopeReader = new InMemoryCustomerScopeReader([
      {
        sourceCustomerId: 'acc-bob',
        normalizedEmail: 'bob@example.com',
        isActive: true,
        sourceScopeReferences: ['sd-1'],
      },
    ]);

    const jiraTarget = createMockJiraTarget({
      'acc-bob': { email: 'bob@example.com' },
    });

    const service = new JiraFirstDryRunService(
      dirSource,
      scopeReader,
      jiraTarget,
      { maxRecords: 10, concurrency: 1 },
      new RequestBudgetGuard({ global: 50 }),
      new DiffPlanner(),
      new MappingService(),
      testLogger,
    );

    const report = await service.executeDryRun();
    expect(report.summary.jiraCustomersEnumerated).toBe(1);
    expect(report.summary.uniqueJiraCustomersProcessed).toBe(1);
    expect(report.records).toHaveLength(1);
    expect(report.records[0]?.customerRef).toBe(hashIdentifier('bob@example.com'));
  });

  // Test 5: An Entra-only user is never processed in Jira-first mode.
  it('5. An Entra-only user is never processed in Jira-first mode', async () => {
    const dirSource = new InMemoryDirectorySource([
      { sourceId: 'e-only', displayName: 'Entra Only', email: 'entraonly@example.com' },
    ]);

    const scopeReader = new InMemoryCustomerScopeReader([]);
    const jiraTarget = createMockJiraTarget({});

    const service = new JiraFirstDryRunService(
      dirSource,
      scopeReader,
      jiraTarget,
      { maxRecords: 10, concurrency: 1 },
      new RequestBudgetGuard({ global: 50 }),
      new DiffPlanner(),
      new MappingService(),
      testLogger,
    );

    const report = await service.executeDryRun();
    expect(report.summary.uniqueJiraCustomersProcessed).toBe(0);
    expect(report.records).toHaveLength(0);
  });

  // Test 6: A Jira customer with one exact eligible Entra match is diffed.
  it('6. A Jira customer with one exact eligible Entra match is diffed', async () => {
    const dirSource = new InMemoryDirectorySource([
      {
        sourceId: 'e1',
        displayName: 'Match User',
        email: 'match@example.com',
        jobTitle: 'Lead Architect',
      },
    ]);

    const scopeReader = new InMemoryCustomerScopeReader([
      {
        sourceCustomerId: 'acc-match',
        normalizedEmail: 'match@example.com',
        isActive: true,
        sourceScopeReferences: ['sd-1'],
      },
    ]);

    const jiraTarget = createMockJiraTarget({
      'acc-match': {
        email: 'match@example.com',
        title: 'Junior Architect',
        emailAddress: 'match@example.com',
      },
    });

    const service = new JiraFirstDryRunService(
      dirSource,
      scopeReader,
      jiraTarget,
      { maxRecords: 10, concurrency: 1 },
      new RequestBudgetGuard({ global: 50 }),
      new DiffPlanner(),
      new MappingService(),
      testLogger,
    );

    const report = await service.executeDryRun();
    expect(report.summary.exactEntraMatches).toBe(1);
    expect(report.summary.customersWithPlannedUpdates).toBe(1);
    expect(report.records[0]?.resultCategory).toBe('UPDATE_PLANNED');
    expect(report.records[0]?.changedFieldNames).toEqual(['title']);
  });

  // Test 7: A Jira customer with no Entra match is skipped.
  it('7. A Jira customer with no Entra match is skipped', async () => {
    const dirSource = new InMemoryDirectorySource([]);
    const scopeReader = new InMemoryCustomerScopeReader([
      {
        sourceCustomerId: 'acc-orphan',
        normalizedEmail: 'orphan@example.com',
        isActive: true,
        sourceScopeReferences: ['sd-1'],
      },
    ]);

    const jiraTarget = createMockJiraTarget({});

    const service = new JiraFirstDryRunService(
      dirSource,
      scopeReader,
      jiraTarget,
      { maxRecords: 10, concurrency: 1 },
      new RequestBudgetGuard({ global: 50 }),
      new DiffPlanner(),
      new MappingService(),
      testLogger,
    );

    const report = await service.executeDryRun();
    expect(report.summary.entraNotFound).toBe(1);
    expect(report.summary.profilesRetrieved).toBe(0);
    expect(report.records[0]?.resultCategory).toBe('NOT_FOUND');
  });

  // Test 8: A Jira customer with duplicate Entra matches is skipped.
  it('8. A Jira customer with duplicate Entra matches is skipped', async () => {
    const dirSource = new InMemoryDirectorySource([
      { sourceId: 'e1', displayName: 'Dupe 1', email: 'dupe@example.com' },
      { sourceId: 'e2', displayName: 'Dupe 2', email: 'dupe@example.com' },
    ]);

    const scopeReader = new InMemoryCustomerScopeReader([
      {
        sourceCustomerId: 'acc-dupe',
        normalizedEmail: 'dupe@example.com',
        isActive: true,
        sourceScopeReferences: ['sd-1'],
      },
    ]);

    const jiraTarget = createMockJiraTarget({});

    const service = new JiraFirstDryRunService(
      dirSource,
      scopeReader,
      jiraTarget,
      { maxRecords: 10, concurrency: 1 },
      new RequestBudgetGuard({ global: 50 }),
      new DiffPlanner(),
      new MappingService(),
      testLogger,
    );

    const report = await service.executeDryRun();
    expect(report.summary.ambiguousEntraMatches).toBe(1);
    expect(report.summary.profilesRetrieved).toBe(0);
    expect(report.records[0]?.resultCategory).toBe('AMBIGUOUS');
  });

  // Test 9: A Jira customer without visible email is skipped.
  it('9. A Jira customer without visible email is skipped', async () => {
    const dirSource = new InMemoryDirectorySource([
      { sourceId: 'e1', displayName: 'Some User', email: 'some@example.com' },
    ]);

    const scopeReader = new InMemoryCustomerScopeReader([
      {
        sourceCustomerId: 'acc-no-email',
        normalizedEmail: null,
        isActive: true,
        sourceScopeReferences: ['sd-1'],
      },
    ]);

    const jiraTarget = createMockJiraTarget({});

    const service = new JiraFirstDryRunService(
      dirSource,
      scopeReader,
      jiraTarget,
      { maxRecords: 10, concurrency: 1 },
      new RequestBudgetGuard({ global: 50 }),
      new DiffPlanner(),
      new MappingService(),
      testLogger,
    );

    const report = await service.executeDryRun();
    expect(report.summary.jiraCustomersWithoutVisibleEmail).toBe(1);
    expect(report.summary.profilesRetrieved).toBe(0);
    expect(report.records[0]?.resultCategory).toBe('EMAIL_UNAVAILABLE');
  });

  // Test 10: An inactive Jira customer is skipped.
  it('10. An inactive Jira customer is skipped', async () => {
    const dirSource = new InMemoryDirectorySource([
      { sourceId: 'e1', displayName: 'Former User', email: 'former@example.com' },
    ]);

    const scopeReader = new InMemoryCustomerScopeReader([
      {
        sourceCustomerId: 'acc-former',
        normalizedEmail: 'former@example.com',
        isActive: false, // inactive
        sourceScopeReferences: ['sd-1'],
      },
    ]);

    const jiraTarget = createMockJiraTarget({});

    const service = new JiraFirstDryRunService(
      dirSource,
      scopeReader,
      jiraTarget,
      { maxRecords: 10, concurrency: 1 },
      new RequestBudgetGuard({ global: 50 }),
      new DiffPlanner(),
      new MappingService(),
      testLogger,
    );

    const report = await service.executeDryRun();
    expect(report.summary.jiraInactiveCustomers).toBe(1);
    expect(report.summary.profilesRetrieved).toBe(0);
    expect(report.records[0]?.resultCategory).toBe('JIRA_INACTIVE');
  });

  // Test 11: A disabled Entra user is excluded from the index.
  it('11. A disabled Entra user is excluded from the index', async () => {
    // EntraDirectorySource excludes accountEnabled === false
    // When excluded, it does not exist in the snapshot
    const dirSource = new InMemoryDirectorySource([]);
    const scopeReader = new InMemoryCustomerScopeReader([
      {
        sourceCustomerId: 'acc-disabled-staff',
        normalizedEmail: 'disabled@example.com',
        isActive: true,
        sourceScopeReferences: ['sd-1'],
      },
    ]);

    const jiraTarget = createMockJiraTarget({});

    const service = new JiraFirstDryRunService(
      dirSource,
      scopeReader,
      jiraTarget,
      { maxRecords: 10, concurrency: 1 },
      new RequestBudgetGuard({ global: 50 }),
      new DiffPlanner(),
      new MappingService(),
      testLogger,
    );

    const report = await service.executeDryRun();
    expect(report.summary.entraNotFound).toBe(1);
    expect(report.records[0]?.resultCategory).toBe('NOT_FOUND');
  });

  // Test 12: A deleted or absent Entra user causes no Jira deletion or deactivation.
  it('12. A deleted or absent Entra user causes no Jira deletion or deactivation', async () => {
    const dirSource = new InMemoryDirectorySource([]);
    const scopeReader = new InMemoryCustomerScopeReader([
      {
        sourceCustomerId: 'acc-deleted-staff',
        normalizedEmail: 'deleted@example.com',
        isActive: true,
        sourceScopeReferences: ['sd-1'],
      },
    ]);

    const requestLog: string[] = [];
    const jiraTarget = createMockJiraTarget({}, requestLog);

    const service = new JiraFirstDryRunService(
      dirSource,
      scopeReader,
      jiraTarget,
      { maxRecords: 10, concurrency: 1 },
      new RequestBudgetGuard({ global: 50 }),
      new DiffPlanner(),
      new MappingService(),
      testLogger,
    );

    const report = await service.executeDryRun();
    expect(report.summary.entraNotFound).toBe(1);
    // Verified: No deletion, deactivation, or profile call was issued
    expect(requestLog.filter((u) => u.includes('profile'))).toHaveLength(0);
  });

  // Test 13: A stable Jira identifier prevents a second Jira user search.
  it('13. A stable Jira identifier prevents a second Jira user search', async () => {
    const dirSource = new InMemoryDirectorySource([
      {
        sourceId: 'e1',
        displayName: 'Direct User',
        email: 'direct@example.com',
        jobTitle: 'Specialist',
      },
    ]);

    const scopeReader = new InMemoryCustomerScopeReader([
      {
        sourceCustomerId: 'acc-stable-id-12345',
        normalizedEmail: 'direct@example.com',
        isActive: true,
        sourceScopeReferences: ['sd-1'],
      },
    ]);

    const requestLog: string[] = [];
    const jiraTarget = createMockJiraTarget(
      {
        'acc-stable-id-12345': {
          email: 'direct@example.com',
          title: 'Specialist',
        },
      },
      requestLog,
    );

    const service = new JiraFirstDryRunService(
      dirSource,
      scopeReader,
      jiraTarget,
      { maxRecords: 10, concurrency: 1 },
      new RequestBudgetGuard({ global: 50 }),
      new DiffPlanner(),
      new MappingService(),
      testLogger,
    );

    await service.executeDryRun();

    // Verify profile was requested directly with acc-stable-id-12345
    expect(requestLog.some((u) => u.includes('/api/v1/customer/profile/acc-stable-id-12345'))).toBe(
      true,
    );

    // Verify ZERO user search requests were made
    expect(requestLog.some((u) => u.includes('/rest/api/3/user/search'))).toBe(false);
  });

  // Test 14: Multiple service-desk appearances are deduplicated.
  it('14. Multiple service-desk appearances are deduplicated', async () => {
    const dirSource = new InMemoryDirectorySource([
      { sourceId: 'e1', displayName: 'Shared User', email: 'shared@example.com' },
    ]);

    const scopeReader = new InMemoryCustomerScopeReader([
      {
        sourceCustomerId: 'acc-shared',
        normalizedEmail: 'shared@example.com',
        isActive: true,
        sourceScopeReferences: ['sd-1'],
      },
      {
        sourceCustomerId: 'acc-shared', // Same customer in second service desk
        normalizedEmail: 'shared@example.com',
        isActive: true,
        sourceScopeReferences: ['sd-2'],
      },
    ]);

    const jiraTarget = createMockJiraTarget({
      'acc-shared': { email: 'shared@example.com' },
    });

    const service = new JiraFirstDryRunService(
      dirSource,
      scopeReader,
      jiraTarget,
      { maxRecords: 10, concurrency: 1 },
      new RequestBudgetGuard({ global: 50 }),
      new DiffPlanner(),
      new MappingService(),
      testLogger,
    );

    const report = await service.executeDryRun();
    expect(report.summary.jiraCustomersEnumerated).toBe(2);
    expect(report.summary.duplicateJiraCustomersDeduplicated).toBe(1);
    expect(report.summary.uniqueJiraCustomersProcessed).toBe(1);
    expect(report.records).toHaveLength(1);
  });

  // Test 15: Pagination is completed.
  it('15. Pagination is completed across customer enumeration', async () => {
    const customers = Array.from({ length: 15 }, (_, i) => ({
      sourceCustomerId: `acc-${i}`,
      normalizedEmail: `u${i}@example.com`,
      isActive: true,
      sourceScopeReferences: ['sd-1'],
    }));

    const scopeReader = new InMemoryCustomerScopeReader(customers);
    const dirSource = new InMemoryDirectorySource([]);
    const jiraTarget = createMockJiraTarget({});

    const service = new JiraFirstDryRunService(
      dirSource,
      scopeReader,
      jiraTarget,
      { maxRecords: 20, concurrency: 1 },
      new RequestBudgetGuard({ global: 50 }),
      new DiffPlanner(),
      new MappingService(),
      testLogger,
    );

    const report = await service.executeDryRun();
    expect(report.summary.jiraCustomersEnumerated).toBe(15);
    expect(report.summary.uniqueJiraCustomersProcessed).toBe(15);
  });

  // Test 16: Page and customer limits are enforced.
  it('16. Page and customer limits are enforced', async () => {
    const customers = Array.from({ length: 50 }, (_, i) => ({
      sourceCustomerId: `acc-${i}`,
      normalizedEmail: `u${i}@example.com`,
      isActive: true,
      sourceScopeReferences: ['sd-1'],
    }));

    const scopeReader = new InMemoryCustomerScopeReader(customers);
    const dirSource = new InMemoryDirectorySource([]);
    const jiraTarget = createMockJiraTarget({});

    const service = new JiraFirstDryRunService(
      dirSource,
      scopeReader,
      jiraTarget,
      { maxRecords: 10, concurrency: 1 }, // limit is 10
      new RequestBudgetGuard({ global: 50 }),
      new DiffPlanner(),
      new MappingService(),
      testLogger,
    );

    const report = await service.executeDryRun();
    expect(report.summary.uniqueJiraCustomersProcessed).toBe(10);
    expect(report.records).toHaveLength(10);
  });

  // Test 17: The request budget no longer allocates a search per Entra record.
  it('17. The request budget no longer allocates a search per Entra record', async () => {
    const budgetGuard = new RequestBudgetGuard({
      userSearch: 0, // Zero user search allowed!
      customerProfile: 5,
      global: 20,
    });

    const dirSource = new InMemoryDirectorySource([
      { sourceId: 'e1', displayName: 'User 1', email: 'u1@example.com' },
    ]);

    const scopeReader = new InMemoryCustomerScopeReader([
      {
        sourceCustomerId: 'acc-1',
        normalizedEmail: 'u1@example.com',
        isActive: true,
        sourceScopeReferences: ['sd-1'],
      },
    ]);

    const jiraTarget = createMockJiraTarget({
      'acc-1': { email: 'u1@example.com' },
    });

    const service = new JiraFirstDryRunService(
      dirSource,
      scopeReader,
      jiraTarget,
      { maxRecords: 10, concurrency: 1 },
      budgetGuard,
      new DiffPlanner(),
      new MappingService(),
      testLogger,
    );

    // Must not throw RequestBudgetExceededError because userSearch count is 0
    await service.executeDryRun();
    expect(budgetGuard.getCounts().userSearch).toBe(0);
  });

  // Test 18: Only exact existing Jira customers are eligible for profile retrieval.
  it('18. Only exact existing Jira customers are eligible for profile retrieval', async () => {
    const dirSource = new InMemoryDirectorySource([
      { sourceId: 'e1', displayName: 'Exact', email: 'exact@example.com' },
      { sourceId: 'e2a', displayName: 'Ambig 1', email: 'ambig@example.com' },
      { sourceId: 'e2b', displayName: 'Ambig 2', email: 'ambig@example.com' },
    ]);

    const scopeReader = new InMemoryCustomerScopeReader([
      {
        sourceCustomerId: 'acc-exact',
        normalizedEmail: 'exact@example.com',
        isActive: true,
        sourceScopeReferences: ['sd-1'],
      },
      {
        sourceCustomerId: 'acc-ambig',
        normalizedEmail: 'ambig@example.com',
        isActive: true,
        sourceScopeReferences: ['sd-1'],
      },
      {
        sourceCustomerId: 'acc-notfound',
        normalizedEmail: 'notfound@example.com',
        isActive: true,
        sourceScopeReferences: ['sd-1'],
      },
      {
        sourceCustomerId: 'acc-noemail',
        normalizedEmail: null,
        isActive: true,
        sourceScopeReferences: ['sd-1'],
      },
      {
        sourceCustomerId: 'acc-inactive',
        normalizedEmail: 'inactive@example.com',
        isActive: false,
        sourceScopeReferences: ['sd-1'],
      },
    ]);

    const requestLog: string[] = [];
    const jiraTarget = createMockJiraTarget(
      {
        'acc-exact': { email: 'exact@example.com' },
      },
      requestLog,
    );

    const service = new JiraFirstDryRunService(
      dirSource,
      scopeReader,
      jiraTarget,
      { maxRecords: 10, concurrency: 1 },
      new RequestBudgetGuard({ global: 50 }),
      new DiffPlanner(),
      new MappingService(),
      testLogger,
    );

    const report = await service.executeDryRun();
    expect(report.summary.profilesRetrieved).toBe(1);

    const profileCalls = requestLog.filter((u) => u.includes('/customer/profile/'));
    expect(profileCalls).toHaveLength(1);
    expect(profileCalls[0]).toContain('acc-exact');
  });

  // Test 19: No customer creation capability exists.
  it('19. No customer creation capability exists', () => {
    const authProvider = new BasicJiraAuthProvider('test@example.com', 'tok');
    const httpClient = new GetOnlyJiraHttpClient(authProvider);
    const jiraTarget = new ReadOnlyJiraCustomerTarget({
      cloudId: 'cloud-123',
      siteUrl: 'https://test.atlassian.net',
      httpClient,
      log: testLogger,
    });

    expect((jiraTarget as unknown as Record<string, unknown>).createCustomer).toBeUndefined();
    expect((jiraTarget as unknown as Record<string, unknown>).addCustomer).toBeUndefined();
  });

  // Test 20: No customer invitation capability exists.
  it('20. No customer invitation capability exists', () => {
    const authProvider = new BasicJiraAuthProvider('test@example.com', 'tok');
    const httpClient = new GetOnlyJiraHttpClient(authProvider);
    const jiraTarget = new ReadOnlyJiraCustomerTarget({
      cloudId: 'cloud-123',
      siteUrl: 'https://test.atlassian.net',
      httpClient,
      log: testLogger,
    });

    expect((jiraTarget as unknown as Record<string, unknown>).inviteCustomer).toBeUndefined();
    expect((jiraTarget as unknown as Record<string, unknown>).sendInvitation).toBeUndefined();
  });

  // Test 21: No service-project membership write exists.
  it('21. No service-project membership write exists', () => {
    const authProvider = new BasicJiraAuthProvider('test@example.com', 'tok');
    const httpClient = new GetOnlyJiraHttpClient(authProvider);
    const jiraTarget = new ReadOnlyJiraCustomerTarget({
      cloudId: 'cloud-123',
      siteUrl: 'https://test.atlassian.net',
      httpClient,
      log: testLogger,
    });

    expect(
      (jiraTarget as unknown as Record<string, unknown>).addCustomerToServiceDesk,
    ).toBeUndefined();
    expect(
      (jiraTarget as unknown as Record<string, unknown>).removeCustomerFromServiceDesk,
    ).toBeUndefined();
  });

  // Test 22: No organization membership write exists.
  it('22. No organization membership write exists', () => {
    const authProvider = new BasicJiraAuthProvider('test@example.com', 'tok');
    const httpClient = new GetOnlyJiraHttpClient(authProvider);
    const jiraTarget = new ReadOnlyJiraCustomerTarget({
      cloudId: 'cloud-123',
      siteUrl: 'https://test.atlassian.net',
      httpClient,
      log: testLogger,
    });

    expect((jiraTarget as unknown as Record<string, unknown>).createOrganization).toBeUndefined();
    expect(
      (jiraTarget as unknown as Record<string, unknown>).addCustomerToOrganization,
    ).toBeUndefined();
  });

  // Test 23: No non-GET request occurs in the validation milestone.
  it('23. No non-GET request occurs in the validation milestone', async () => {
    const authProvider = new BasicJiraAuthProvider('test@example.com', 'tok');
    const httpClient = new GetOnlyJiraHttpClient(authProvider);

    // GetOnlyJiraHttpClient literally has no post, put, delete, or patch methods
    expect((httpClient as unknown as Record<string, unknown>).post).toBeUndefined();
    expect((httpClient as unknown as Record<string, unknown>).put).toBeUndefined();
    expect((httpClient as unknown as Record<string, unknown>).patch).toBeUndefined();
    expect((httpClient as unknown as Record<string, unknown>).delete).toBeUndefined();
  });

  // Test 24: Reports contain no prohibited identifiers or values.
  it('24. Reports contain no prohibited identifiers or values', async () => {
    const reportPath = 'reports/jira-first-artifact-test.json';
    if (fs.existsSync(reportPath)) {
      fs.unlinkSync(reportPath);
    }

    const dirSource = new InMemoryDirectorySource([
      {
        sourceId: 'entra-sec-1',
        displayName: 'Secret Employee',
        email: 'secret.emp@example.com',
        jobTitle: 'Secret Chief',
        officePhone: '+1-555-9999',
        supervisorName: 'Secret Boss',
        officeLocation: 'Secret Vault 42',
      },
    ]);

    const scopeReader = new InMemoryCustomerScopeReader([
      {
        sourceCustomerId: 'acc-secret-id-999',
        normalizedEmail: 'secret.emp@example.com',
        isActive: true,
        sourceScopeReferences: ['sd-classified'],
      },
    ]);

    const jiraTarget = createMockJiraTarget({
      'acc-secret-id-999': {
        email: 'secret.emp@example.com',
        title: 'Old Secret Title',
      },
    });

    const service = new JiraFirstDryRunService(
      dirSource,
      scopeReader,
      jiraTarget,
      { maxRecords: 10, concurrency: 1, reportPath },
      new RequestBudgetGuard({ global: 50 }),
      new DiffPlanner(),
      new MappingService(),
      testLogger,
    );

    const report = await service.executeDryRun();
    expect(report.reportPath).toBeDefined();
    expect(fs.existsSync(report.reportPath!)).toBe(true);
    const content = fs.readFileSync(report.reportPath!, 'utf8');

    // Prohibited strings
    expect(content).not.toContain('secret.emp@example.com');
    expect(content).not.toContain('Secret Employee');
    expect(content).not.toContain('Secret Chief');
    expect(content).not.toContain('Old Secret Title');
    expect(content).not.toContain('+1-555-9999');
    expect(content).not.toContain('Secret Boss');
    expect(content).not.toContain('Secret Vault 42');
    expect(content).not.toContain('acc-secret-id-999');

    if (report.reportPath && fs.existsSync(report.reportPath)) {
      fs.unlinkSync(report.reportPath);
    }
  });

  // Test 25: Existing Entra-first tests remain available until the Jira-first flow is live-validated.
  it('25. Existing Entra-first tests remain available until the Jira-first flow is live-validated', () => {
    // Both services exist and can be instantiated
    expect(EndToEndDryRunService).toBeDefined();
    expect(JiraFirstDryRunService).toBeDefined();

    const configEntra = parseConfig({
      SYNC_SCOPE_SOURCE: 'entra',
    });
    expect(configEntra.sync.syncScopeSource).toBe('entra');

    const configJira = parseConfig({
      SYNC_SCOPE_SOURCE: 'jira',
    });
    expect(configJira.sync.syncScopeSource).toBe('jira');
  });

  // Test 26: Deterministic pilot customer selection via identityResolver
  it('26. Deterministic pilot customer selection evaluates single customer and plans diffs', async () => {
    const pilotEmail = 'pilot@example.com';
    const dirSource = new InMemoryDirectorySource([
      {
        sourceId: 'entra-pilot-1',
        displayName: 'Pilot Person',
        email: pilotEmail,
        jobTitle: 'Senior Specialist',
        officePhone: '+1-555-1234',
        supervisorName: 'Lead Boss',
        officeLocation: 'Suite 100',
      },
      {
        sourceId: 'entra-other-2',
        displayName: 'Other Person',
        email: 'other@example.com',
      },
    ]);

    const scopeReader = new InMemoryCustomerScopeReader([]); // Empty scope reader - pilot uses identityResolver

    const mockIdentityResolver: CustomerIdentityResolverPort = {
      resolveCustomerIdentity: vi.fn().mockResolvedValue({
        outcome: 'RESOLVED',
        accountId: 'acc-pilot-99',
        emailAddress: pilotEmail,
        displayName: 'Pilot Person',
      }),
    };

    const jiraTarget = createMockJiraTarget({
      'acc-pilot-99': {
        email: pilotEmail,
        title: 'Junior Specialist',
        officePhoneNumber: '+1-555-1234',
        supervisor: 'Old Boss',
        officeClassroom: 'Suite 50',
      },
    });

    const reportPath = 'reports/test-pilot-report-26.json';
    if (fs.existsSync(reportPath)) fs.unlinkSync(reportPath);

    const service = new JiraFirstDryRunService(
      dirSource,
      scopeReader,
      jiraTarget,
      {
        maxRecords: 1,
        concurrency: 1,
        pilotCustomerEmail: pilotEmail,
        reportPath,
      },
      new RequestBudgetGuard({ global: 50, userSearch: 5, customerProfile: 5 }),
      new DiffPlanner(),
      new MappingService(),
      testLogger,
      mockIdentityResolver,
    );

    const report = await service.executeDryRun();
    expect(report.success).toBe(true);
    expect(report.pilotCustomerConfigured).toBe(true);
    expect(report.pilotCustomerFoundInServiceDesk).toBe(true);
    expect(report.summary.customersEvaluated).toBe(1);
    expect(report.summary.exactEntraMatches).toBe(1);
    expect(report.summary.customersWithPlannedUpdates).toBe(1);
    expect(report.summary.plannedFieldBreakdown.title).toBe(1);
    expect(report.summary.plannedFieldBreakdown.supervisor).toBe(1);
    expect(report.summary.plannedFieldBreakdown.officeClassroom).toBe(1);
    // officePhoneNumber was already identical (+1-555-1234), so 0 planned change
    expect(report.summary.plannedFieldBreakdown.officePhoneNumber).toBe(0);

    if (report.reportPath && fs.existsSync(report.reportPath)) {
      fs.unlinkSync(report.reportPath);
    }
  });

  // Test 27: Pilot customer missing in Entra directory results in NOT_FOUND and success: false
  it('27. Pilot customer missing in Entra results in NOT_FOUND and success: false', async () => {
    const pilotEmail = 'missing.in.entra@example.com';
    const dirSource = new InMemoryDirectorySource([
      {
        sourceId: 'entra-someone-else',
        displayName: 'Someone Else',
        email: 'someone.else@example.com',
      },
    ]);

    const scopeReader = new InMemoryCustomerScopeReader([]);

    const mockIdentityResolver: CustomerIdentityResolverPort = {
      resolveCustomerIdentity: vi.fn().mockResolvedValue({
        outcome: 'RESOLVED',
        accountId: 'acc-missing-in-entra',
        emailAddress: pilotEmail,
        displayName: 'Missing In Entra',
      }),
    };

    const jiraTarget = createMockJiraTarget({
      'acc-missing-in-entra': {
        email: pilotEmail,
        title: 'Specialist',
      },
    });

    const reportPath = 'reports/test-pilot-report-27.json';
    if (fs.existsSync(reportPath)) fs.unlinkSync(reportPath);

    const service = new JiraFirstDryRunService(
      dirSource,
      scopeReader,
      jiraTarget,
      {
        maxRecords: 1,
        concurrency: 1,
        pilotCustomerEmail: pilotEmail,
        reportPath,
      },
      new RequestBudgetGuard({ global: 50, userSearch: 5, customerProfile: 5 }),
      new DiffPlanner(),
      new MappingService(),
      testLogger,
      mockIdentityResolver,
    );

    const report = await service.executeDryRun();
    expect(report.success).toBe(false);
    expect(report.summary.customersEvaluated).toBe(1);
    expect(report.summary.entraNotFound).toBe(1);
    expect(report.summary.customersWithPlannedUpdates).toBe(0);

    if (report.reportPath && fs.existsSync(report.reportPath)) {
      fs.unlinkSync(report.reportPath);
    }
  });

  // Test 28: Non-erasure invariant for pilot customer
  it('28. Non-erasure invariant: empty Entra fields never clear populated Jira customer fields', async () => {
    const pilotEmail = 'non-erasure@example.com';
    const dirSource = new InMemoryDirectorySource([
      {
        sourceId: 'entra-pilot-partial',
        displayName: 'Partial Person',
        email: pilotEmail,
        jobTitle: 'New Title',
        // officePhone, supervisorName, and officeLocation are undefined / empty in Entra
      },
    ]);

    const scopeReader = new InMemoryCustomerScopeReader([]);

    const mockIdentityResolver: CustomerIdentityResolverPort = {
      resolveCustomerIdentity: vi.fn().mockResolvedValue({
        outcome: 'RESOLVED',
        accountId: 'acc-partial-1',
        emailAddress: pilotEmail,
        displayName: 'Partial Person',
      }),
    };

    const jiraTarget = createMockJiraTarget({
      'acc-partial-1': {
        email: pilotEmail,
        title: 'Old Title',
        officePhoneNumber: '+1-555-9876',
        supervisor: 'Existing Supervisor',
        officeClassroom: 'Room 303',
        emailAddress: pilotEmail,
      },
    });

    const reportPath = 'reports/test-pilot-report-28.json';
    if (fs.existsSync(reportPath)) fs.unlinkSync(reportPath);

    const service = new JiraFirstDryRunService(
      dirSource,
      scopeReader,
      jiraTarget,
      {
        maxRecords: 1,
        concurrency: 1,
        pilotCustomerEmail: pilotEmail,
        reportPath,
      },
      new RequestBudgetGuard({ global: 50, userSearch: 5, customerProfile: 5 }),
      new DiffPlanner(),
      new MappingService(),
      testLogger,
      mockIdentityResolver,
    );

    const report = await service.executeDryRun();
    expect(report.success).toBe(true);
    expect(report.summary.customersEvaluated).toBe(1);
    expect(report.summary.customersWithPlannedUpdates).toBe(1);
    // Only title should be planned for update; other 3 fields are non-erased
    expect(report.summary.plannedFieldChanges).toBe(1);
    expect(report.summary.plannedFieldBreakdown.title).toBe(1);
    expect(report.summary.plannedFieldBreakdown.officePhoneNumber).toBe(0);
    expect(report.summary.plannedFieldBreakdown.supervisor).toBe(0);
    expect(report.summary.plannedFieldBreakdown.officeClassroom).toBe(0);

    if (report.reportPath && fs.existsSync(report.reportPath)) {
      fs.unlinkSync(report.reportPath);
    }
  });

  // Test 29: Structured field decisions cover all 4 mapped fields with accurate reason codes and zero PII
  it('29. Structured field decisions cover all 4 mapped fields with accurate reason codes and zero PII', async () => {
    const pilotEmail = 'field.decisions@example.com';
    const reportPath = 'reports/test-pilot-field-decisions.json';

    const entraPerson: DirectoryPerson = {
      sourceId: 'entra-fd-1',
      displayName: 'Field Test',
      email: pilotEmail,
      jobTitle: 'Updated Title',
      officePhone: '+1-555-1111',
      supervisorName: 'Same Supervisor',
      officeLocation: null, // empty source -> PRESERVED_SOURCE_EMPTY
      managerLookupStatus: 'RESOLVED',
    };

    const jiraProfile: CustomerDetails = {
      email: pilotEmail,
      title: 'Current Title', // diff -> UPDATE_PLANNED
      officePhoneNumber: '+1-555-1111', // equal -> UNCHANGED_EQUAL
      supervisor: 'Same Supervisor', // equal -> UNCHANGED_EQUAL
      officeClassroom: 'Room 404', // empty source -> PRESERVED_SOURCE_EMPTY
    };

    const dirSource = new InMemoryDirectorySource([entraPerson]);
    const mockIdentityResolver: CustomerIdentityResolverPort = {
      resolveCustomerIdentity: vi.fn().mockResolvedValue({
        outcome: 'RESOLVED',
        accountId: 'acc-fd-1',
        emailAddress: pilotEmail,
        displayName: 'Field Test',
        verifiedServiceDeskIds: ['sd-desk-1'],
      }),
    };

    const mockTarget = {
      discoverFields: vi.fn().mockResolvedValue(mockDiscoveryReport),
      getCustomerProfile: vi.fn().mockResolvedValue({
        retrievalStatus: 'RETRIEVED',
        customerDetails: jiraProfile,
        populatedMappedFieldCount: 4,
        emptyMappedFieldCount: 0,
        unmappedFieldCount: 0,
      }),
      ensureCloudId: vi.fn().mockResolvedValue('cloud-123'),
    } as unknown as ReadOnlyJiraCustomerTarget;

    const service = new JiraFirstDryRunService(
      dirSource,
      scopeReader,
      mockTarget,
      {
        maxRecords: 1,
        concurrency: 1,
        pilotMode: true,
        pilotCustomerEmail: pilotEmail,
        reportPath,
      },
      new RequestBudgetGuard({ global: 50, userSearch: 5, customerProfile: 5 }),
      new DiffPlanner(),
      new MappingService(),
      testLogger,
      mockIdentityResolver,
    );

    const report = await service.executeDryRun();
    expect(report.success).toBe(true);
    expect(report.records).toHaveLength(1);

    const decisions = report.records[0]!.fieldDecisions;
    expect(decisions).toBeDefined();
    expect(decisions).toHaveLength(4);

    const titleDecision = decisions!.find((d) => d.fieldName === 'title');
    expect(titleDecision?.decision).toBe('UPDATE_PLANNED');
    expect(titleDecision?.statusDescription).not.toContain('Current Title');
    expect(titleDecision?.statusDescription).not.toContain('Updated Title');

    const phoneDecision = decisions!.find((d) => d.fieldName === 'officePhoneNumber');
    expect(phoneDecision?.decision).toBe('UNCHANGED_EQUAL');

    const supervisorDecision = decisions!.find((d) => d.fieldName === 'supervisor');
    expect(supervisorDecision?.decision).toBe('UNCHANGED_EQUAL');

    const officeDecision = decisions!.find((d) => d.fieldName === 'officeClassroom');
    expect(officeDecision?.decision).toBe('PRESERVED_SOURCE_EMPTY');

    if (report.reportPath && fs.existsSync(report.reportPath)) {
      fs.unlinkSync(report.reportPath);
    }
  });

  // Test 30: Verified service desk IDs are captured into sourceScopeReferences and selectedCustomerMetrics
  it('30. Verified service desk IDs are captured into sourceScopeReferences and selectedCustomerMetrics', async () => {
    const pilotEmail = 'membership.proof@example.com';
    const reportPath = 'reports/test-pilot-membership.json';

    const entraPerson: DirectoryPerson = {
      sourceId: 'entra-mem-1',
      displayName: 'Member Test',
      email: pilotEmail,
      jobTitle: 'Analyst',
      officePhone: null,
      supervisorName: null,
      officeLocation: null,
      managerLookupStatus: 'NO_MANAGER',
    };

    const dirSource = new InMemoryDirectorySource([entraPerson]);
    const mockIdentityResolver: CustomerIdentityResolverPort = {
      resolveCustomerIdentity: vi.fn().mockResolvedValue({
        outcome: 'RESOLVED',
        accountId: 'acc-mem-1',
        emailAddress: pilotEmail,
        displayName: 'Member Test',
        verifiedServiceDeskIds: ['sd-ops', 'sd-it-support'],
      }),
    };

    const mockTarget = {
      discoverFields: vi.fn().mockResolvedValue(mockDiscoveryReport),
      getCustomerProfile: vi.fn().mockResolvedValue({
        retrievalStatus: 'RETRIEVED',
        customerDetails: { email: pilotEmail, title: 'Analyst' },
        populatedMappedFieldCount: 1,
        emptyMappedFieldCount: 3,
        unmappedFieldCount: 0,
      }),
      ensureCloudId: vi.fn().mockResolvedValue('cloud-123'),
    } as unknown as ReadOnlyJiraCustomerTarget;

    const service = new JiraFirstDryRunService(
      dirSource,
      scopeReader,
      mockTarget,
      {
        maxRecords: 1,
        concurrency: 1,
        pilotMode: true,
        pilotCustomerEmail: pilotEmail,
        reportPath,
      },
      new RequestBudgetGuard({ global: 50, userSearch: 5, customerProfile: 5 }),
      new DiffPlanner(),
      new MappingService(),
      testLogger,
      mockIdentityResolver,
    );

    const report = await service.executeDryRun();
    expect(report.success).toBe(true);
    expect(report.records[0]!.sourceScopeReferences).toEqual(['sd-ops', 'sd-it-support']);
    expect(report.selectedCustomerMetrics?.verifiedServiceDeskIds).toEqual([
      'sd-ops',
      'sd-it-support',
    ]);
    expect(report.selectedCustomerMetrics?.verifiedInServiceDesk).toBe(true);

    if (report.reportPath && fs.existsSync(report.reportPath)) {
      fs.unlinkSync(report.reportPath);
    }
  });

  // Test 31: Incomplete Graph manager lookup sets supervisor decision to PRESERVED_SOURCE_UNAVAILABLE and fails the run
  it('31. Incomplete Graph manager lookup sets supervisor decision to PRESERVED_SOURCE_UNAVAILABLE and fails the run', async () => {
    const pilotEmail = 'manager.fail@example.com';
    const reportPath = 'reports/test-pilot-manager-fail.json';

    const entraPerson: DirectoryPerson = {
      sourceId: 'entra-mf-1',
      displayName: 'Manager Fail Test',
      email: pilotEmail,
      jobTitle: 'Developer',
      officePhone: null,
      supervisorName: null,
      officeLocation: null,
      managerLookupStatus: 'LOOKUP_FAILED',
      managerLookupError: 'HTTP 500 error connecting to Graph',
    };

    const dirSource = new InMemoryDirectorySource([entraPerson]);
    const mockIdentityResolver: CustomerIdentityResolverPort = {
      resolveCustomerIdentity: vi.fn().mockResolvedValue({
        outcome: 'RESOLVED',
        accountId: 'acc-mf-1',
        emailAddress: pilotEmail,
        displayName: 'Manager Fail Test',
        verifiedServiceDeskIds: ['sd-desk-1'],
      }),
    };

    const mockTarget = {
      discoverFields: vi.fn().mockResolvedValue(mockDiscoveryReport),
      getCustomerProfile: vi.fn().mockResolvedValue({
        retrievalStatus: 'RETRIEVED',
        customerDetails: {
          email: pilotEmail,
          title: 'Developer',
          supervisor: 'Existing Supervisor',
        },
        populatedMappedFieldCount: 2,
        emptyMappedFieldCount: 2,
        unmappedFieldCount: 0,
      }),
      ensureCloudId: vi.fn().mockResolvedValue('cloud-123'),
    } as unknown as ReadOnlyJiraCustomerTarget;

    const service = new JiraFirstDryRunService(
      dirSource,
      scopeReader,
      mockTarget,
      {
        maxRecords: 1,
        concurrency: 1,
        pilotMode: true,
        pilotCustomerEmail: pilotEmail,
        reportPath,
      },
      new RequestBudgetGuard({ global: 50, userSearch: 5, customerProfile: 5 }),
      new DiffPlanner(),
      new MappingService(),
      testLogger,
      mockIdentityResolver,
    );

    const report = await service.executeDryRun();
    expect(report.success).toBe(false);
    expect(report.failureReason).toBe('PILOT_CUSTOMER_GRAPH_MANAGER_LOOKUP_FAILED');

    const supDecision = report.records[0]!.fieldDecisions?.find(
      (d) => d.fieldName === 'supervisor',
    );
    expect(supDecision?.decision).toBe('PRESERVED_SOURCE_UNAVAILABLE');
    expect(report.selectedCustomerMetrics?.comparisonComplete).toBe(false);
    expect(report.selectedCustomerMetrics?.managerLookupStatus).toBe('LOOKUP_FAILED');

    if (report.reportPath && fs.existsSync(report.reportPath)) {
      fs.unlinkSync(report.reportPath);
    }
  });

  // Test 32: Jira metrics are attached to report artifact
  it('32. Jira metrics are attached to report artifact', async () => {
    const pilotEmail = 'metrics@example.com';
    const reportPath = 'reports/test-pilot-metrics.json';

    const entraPerson: DirectoryPerson = {
      sourceId: 'entra-m-1',
      displayName: 'Metrics Test',
      email: pilotEmail,
      jobTitle: 'Tester',
      officePhone: null,
      supervisorName: null,
      officeLocation: null,
      managerLookupStatus: 'NO_MANAGER',
    };

    const dirSource = new InMemoryDirectorySource([entraPerson]);
    const mockIdentityResolver: CustomerIdentityResolverPort = {
      resolveCustomerIdentity: vi.fn().mockResolvedValue({
        outcome: 'RESOLVED',
        accountId: 'acc-m-1',
        emailAddress: pilotEmail,
        displayName: 'Metrics Test',
        verifiedServiceDeskIds: ['sd-desk-1'],
      }),
    };

    const mockTarget = {
      discoverFields: vi.fn().mockResolvedValue(mockDiscoveryReport),
      getCustomerProfile: vi.fn().mockResolvedValue({
        retrievalStatus: 'RETRIEVED',
        customerDetails: { email: pilotEmail, title: 'Tester' },
        populatedMappedFieldCount: 1,
        emptyMappedFieldCount: 3,
        unmappedFieldCount: 0,
      }),
      ensureCloudId: vi.fn().mockResolvedValue('cloud-123'),
    } as unknown as ReadOnlyJiraCustomerTarget;

    const budgetGuard = new RequestBudgetGuard({ global: 50, userSearch: 5, customerProfile: 5 });
    budgetGuard.recordOperation('userSearch');

    const service = new JiraFirstDryRunService(
      dirSource,
      scopeReader,
      mockTarget,
      {
        maxRecords: 1,
        concurrency: 1,
        pilotMode: true,
        pilotCustomerEmail: pilotEmail,
        reportPath,
      },
      budgetGuard,
      new DiffPlanner(),
      new MappingService(),
      testLogger,
      mockIdentityResolver,
    );

    const report = await service.executeDryRun();
    expect(report.jiraMetrics).toBeDefined();
    expect(report.jiraMetrics?.scope).toBe('JIRA_CUSTOMER_TARGET');
    expect(report.jiraMetrics?.requestBudgetUsed).toBe(1);

    if (report.reportPath && fs.existsSync(report.reportPath)) {
      fs.unlinkSync(report.reportPath);
    }
  });

  // Test 33: Prohibits silent fallback to enumeration when pilotMode is true but pilot email is missing
  it('33. Prohibits silent fallback to enumeration when pilotMode is true but pilot email is missing', async () => {
    const getPeopleSpy = vi.fn().mockResolvedValue([]);
    const dirSource: DirectorySourcePort = { getPeople: getPeopleSpy };

    const discoverFieldsSpy = vi.fn().mockResolvedValue(mockDiscoveryReport);
    const ensureCloudIdSpy = vi.fn().mockResolvedValue('cloud-123');
    const mockTarget = {
      discoverFields: discoverFieldsSpy,
      ensureCloudId: ensureCloudIdSpy,
    } as unknown as ReadOnlyJiraCustomerTarget;

    const listExistingCustomersSpy = vi.fn(() =>
      (async function* (): AsyncIterable<ExistingCustomerReference> {})(),
    );
    const mockScopeReader: ExistingCustomerScopeReaderPort = {
      listExistingCustomers: listExistingCustomersSpy,
    };

    const resolveCustomerIdentitySpy = vi.fn();
    const mockIdentityResolver: CustomerIdentityResolverPort = {
      resolveCustomerIdentity: resolveCustomerIdentitySpy,
    };

    const testReportPath = 'reports/test-pilot-guard-should-not-exist.json';
    if (fs.existsSync(testReportPath)) {
      fs.unlinkSync(testReportPath);
    }

    const service = new JiraFirstDryRunService(
      dirSource,
      mockScopeReader,
      mockTarget,
      {
        maxRecords: 10,
        concurrency: 1,
        pilotMode: true,
        pilotCustomerEmail: '', // Missing pilot email while pilotMode is true
        reportPath: testReportPath,
      },
      new RequestBudgetGuard({ global: 50 }),
      new DiffPlanner(),
      new MappingService(),
      testLogger,
      mockIdentityResolver,
    );

    // 1. executeDryRun rejects
    await expect(service.executeDryRun()).rejects.toThrow(
      /Pilot mode is enabled, but pilot customer email is missing or empty/,
    );

    // 2. discoverFields is not called
    expect(discoverFieldsSpy).not.toHaveBeenCalled();

    // 3. getPeople is not called
    expect(getPeopleSpy).not.toHaveBeenCalled();

    // 4. the identity resolver is not called
    expect(resolveCustomerIdentitySpy).not.toHaveBeenCalled();

    // 5. customer enumeration is not started
    expect(listExistingCustomersSpy).not.toHaveBeenCalled();

    // 6. no report is created for this configuration error
    expect(fs.existsSync(testReportPath)).toBe(false);
  });

  // Test 34: Exclusive report persistence failure sets report.success to false and failureReason to REPORT_PERSISTENCE_FAILED
  it('34. Exclusive report persistence failure sets report.success to false and failureReason to REPORT_PERSISTENCE_FAILED', async () => {
    const pilotEmail = 'persist.fail@example.com';
    const reportPath = 'reports/test-persist-fail.json';

    const entraPerson: DirectoryPerson = {
      sourceId: 'entra-pf-1',
      displayName: 'Persist Fail',
      email: pilotEmail,
      jobTitle: 'Specialist',
      officePhone: null,
      supervisorName: null,
      officeLocation: null,
      managerLookupStatus: 'NO_MANAGER',
    };

    const dirSource = new InMemoryDirectorySource([entraPerson]);
    const mockIdentityResolver: CustomerIdentityResolverPort = {
      resolveCustomerIdentity: vi.fn().mockResolvedValue({
        outcome: 'RESOLVED',
        accountId: 'acc-pf-1',
        emailAddress: pilotEmail,
        displayName: 'Persist Fail',
        verifiedServiceDeskIds: ['sd-1'],
      }),
    };

    const mockTarget = {
      discoverFields: vi.fn().mockResolvedValue(mockDiscoveryReport),
      getCustomerProfile: vi.fn().mockResolvedValue({
        retrievalStatus: 'RETRIEVED',
        customerDetails: { email: pilotEmail, title: 'Specialist' },
        populatedMappedFieldCount: 1,
        emptyMappedFieldCount: 3,
        unmappedFieldCount: 0,
      }),
      ensureCloudId: vi.fn().mockResolvedValue('cloud-123'),
    } as unknown as ReadOnlyJiraCustomerTarget;

    const reportPathValidatorModule = await import('../src/services/report-path-validator');
    const writeSpy = vi
      .spyOn(reportPathValidatorModule, 'writeReportExclusively')
      .mockImplementationOnce(() => {
        throw new Error('EACCES: permission denied, open reports/test-persist-fail.json');
      });

    const service = new JiraFirstDryRunService(
      dirSource,
      scopeReader,
      mockTarget,
      {
        maxRecords: 1,
        concurrency: 1,
        pilotMode: true,
        pilotCustomerEmail: pilotEmail,
        reportPath,
      },
      new RequestBudgetGuard({ global: 50, userSearch: 5, customerProfile: 5 }),
      new DiffPlanner(),
      new MappingService(),
      testLogger,
      mockIdentityResolver,
    );

    const report = await service.executeDryRun();
    expect(report.success).toBe(false);
    expect(report.failureReason).toBe('REPORT_PERSISTENCE_FAILED');

    writeSpy.mockRestore();
  });
});
