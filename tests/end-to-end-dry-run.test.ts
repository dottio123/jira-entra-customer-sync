import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import { parseConfig } from '../src/config';
import {
  DirectoryPerson,
  DirectorySourcePort,
  CustomerDetails,
  CustomerIdentityResolverPort,
} from '../src/domain';
import {
  BasicJiraAuthProvider,
  GetOnlyJiraHttpClient,
  ReadOnlyJiraCustomerTarget,
  JiraUserSearchResolver,
  RequestBudgetGuard,
  RequestBudgetExceededError,
} from '../src/connectors/jira';
import {
  EndToEndDryRunService,
  EndToEndDryRunReport,
  DiffPlanner,
  MappingService,
} from '../src/services';
import { validateAndResolveReportPath } from '../src/services/report-path-validator';
import { compareDryRunReports } from '../src/services/report-comparator';
import { Logger } from '../src/utils/logger';
import { hashIdentifier } from '../src/utils/privacy';

describe('End-to-End Live-Source Dry-Run Planning', () => {
  let capturedLogs: Array<{ level: string; message: string; context?: Record<string, unknown> }>;
  let testLogger: Logger;

  beforeEach(() => {
    capturedLogs = [];
    testLogger = new Logger('test-dry-run', 'debug');
    vi.spyOn(console, 'log').mockImplementation((msg: string) => {
      try {
        const parsed = JSON.parse(msg);
        capturedLogs.push(parsed);
      } catch {
        // Ignore non-JSON logs
      }
    });
    vi.spyOn(console, 'warn').mockImplementation((msg: string) => {
      try {
        const parsed = JSON.parse(msg);
        capturedLogs.push(parsed);
      } catch {
        // Ignore non-JSON logs
      }
    });
    vi.spyOn(console, 'error').mockImplementation((msg: string) => {
      try {
        const parsed = JSON.parse(msg);
        capturedLogs.push(parsed);
      } catch {
        // Ignore non-JSON logs
      }
    });
  });

  // Mock directory people generator
  const createMockDirectoryPeople = (count: number): DirectoryPerson[] => {
    return Array.from({ length: count }, (_, i) => ({
      sourceId: `entra-person-${i + 1}`,
      displayName: `Fictional User ${i + 1}`,
      email: `fictional.user.${i + 1}@example.com`,
      jobTitle: `Specialist ${i + 1}`,
      officePhone: `+1-555-010${i % 10}`,
      supervisorName: `Manager ${i % 3}`,
      officeLocation: `Office ${i + 100}`,
    }));
  };

  // Standard 6 Jira detail fields as discovered from live Atlassian CSM
  const mockJiraFieldResponse = {
    results: [
      { id: 'field-title', name: 'Title', type: { name: 'STRING' } },
      { id: 'field-phone', name: 'Office Phone Number', type: { name: 'STRING' } },
      { id: 'field-supervisor', name: 'Supervisor', type: { name: 'STRING' } },
      { id: 'field-office', name: 'Office/Classroom', type: { name: 'STRING' } },
      { id: 'field-cell', name: 'Cell Phone Number', type: { name: 'PHONE_NUMBER' } },
      { id: 'field-email', name: 'Email Address', type: { name: 'EMAIL' } },
    ],
  };

  describe('Configuration & Startup Validation Requirements', () => {
    it('Startup rejects write mode (SYNC_DRY_RUN=false)', () => {
      const env = {
        END_TO_END_DRY_RUN: 'true',
        SYNC_DRY_RUN: 'false',
        DIRECTORY_SOURCE: 'entra',
        CUSTOMER_TARGET: 'jira-readonly',
        DISCOVERY_ONLY: 'false',
        JIRA_VALIDATE_EXISTING_CUSTOMER: 'false',
      };

      expect(() => parseConfig(env)).toThrow(
        /Safety violation: Write mode is prohibited in end-to-end dry-run/i,
      );
    });

    it('Requires DIRECTORY_SOURCE=entra', () => {
      const env = {
        END_TO_END_DRY_RUN: 'true',
        SYNC_DRY_RUN: 'true',
        DIRECTORY_SOURCE: 'memory',
        CUSTOMER_TARGET: 'jira-readonly',
        DISCOVERY_ONLY: 'false',
        JIRA_VALIDATE_EXISTING_CUSTOMER: 'false',
      };

      expect(() => parseConfig(env)).toThrow(
        /DIRECTORY_SOURCE must be 'entra' when END_TO_END_DRY_RUN is true/i,
      );
    });

    it('Requires CUSTOMER_TARGET=jira-readonly', () => {
      const env = {
        END_TO_END_DRY_RUN: 'true',
        SYNC_DRY_RUN: 'true',
        DIRECTORY_SOURCE: 'entra',
        CUSTOMER_TARGET: 'memory',
        DISCOVERY_ONLY: 'false',
        JIRA_VALIDATE_EXISTING_CUSTOMER: 'false',
      };

      expect(() => parseConfig(env)).toThrow(
        /CUSTOMER_TARGET must be 'jira-readonly' when END_TO_END_DRY_RUN is true/i,
      );
    });

    it('Requires DISCOVERY_ONLY=false', () => {
      const env = {
        END_TO_END_DRY_RUN: 'true',
        SYNC_DRY_RUN: 'true',
        DIRECTORY_SOURCE: 'entra',
        CUSTOMER_TARGET: 'jira-readonly',
        DISCOVERY_ONLY: 'true',
        JIRA_VALIDATE_EXISTING_CUSTOMER: 'false',
      };

      expect(() => parseConfig(env)).toThrow(
        /DISCOVERY_ONLY must be false when END_TO_END_DRY_RUN is true/i,
      );
    });

    it('Requires JIRA_VALIDATE_EXISTING_CUSTOMER=false', () => {
      const env = {
        END_TO_END_DRY_RUN: 'true',
        SYNC_DRY_RUN: 'true',
        DIRECTORY_SOURCE: 'entra',
        CUSTOMER_TARGET: 'jira-readonly',
        DISCOVERY_ONLY: 'false',
        JIRA_VALIDATE_EXISTING_CUSTOMER: 'true',
        JIRA_TEST_CUSTOMER_EMAIL: 'test@example.com',
      };

      expect(() => parseConfig(env)).toThrow(
        /JIRA_VALIDATE_EXISTING_CUSTOMER must be false when END_TO_END_DRY_RUN is true/i,
      );
    });

    it('Pilot defaults to 10 records', () => {
      const env = {
        END_TO_END_DRY_RUN: 'true',
        SYNC_DRY_RUN: 'true',
        DIRECTORY_SOURCE: 'entra',
        CUSTOMER_TARGET: 'jira-readonly',
        DISCOVERY_ONLY: 'false',
        JIRA_VALIDATE_EXISTING_CUSTOMER: 'false',
      };

      const config = parseConfig(env);
      expect(config.sync.endToEndMaxRecords).toBe(10);
    });

    it('Enforces positive integer for END_TO_END_MAX_RECORDS', () => {
      const envInvalid = {
        END_TO_END_DRY_RUN: 'true',
        SYNC_DRY_RUN: 'true',
        DIRECTORY_SOURCE: 'entra',
        CUSTOMER_TARGET: 'jira-readonly',
        END_TO_END_MAX_RECORDS: '0',
      };

      expect(() => parseConfig(envInvalid)).toThrow(
        /END_TO_END_MAX_RECORDS must be a positive integer/i,
      );
    });

    it('Enforces bounded integer for JIRA_LOOKUP_CONCURRENCY (1..5)', () => {
      const envHigh = {
        END_TO_END_DRY_RUN: 'true',
        SYNC_DRY_RUN: 'true',
        DIRECTORY_SOURCE: 'entra',
        CUSTOMER_TARGET: 'jira-readonly',
        JIRA_LOOKUP_CONCURRENCY: '6',
      };

      expect(() => parseConfig(envHigh)).toThrow(
        /JIRA_LOOKUP_CONCURRENCY must be an integer between 1 and 5/i,
      );
    });
  });

  describe('Architectural Safety: Read-Only Impossibility of Mutation', () => {
    it('No writer is instantiated or accepted in this mode', () => {
      // EndToEndDryRunService does not accept CustomerDetailsWriterPort
      const mockDirSource: DirectorySourcePort = {
        getPeople: async () => [],
      };

      const authProvider = new BasicJiraAuthProvider('fictional@example.com', 'token-123');
      const httpClient = new GetOnlyJiraHttpClient(authProvider);
      const jiraTarget = new ReadOnlyJiraCustomerTarget({
        cloudId: 'mock-cloud',
        siteUrl: 'https://mock.atlassian.net',
        httpClient,
      });

      const resolver = new JiraUserSearchResolver({
        cloudId: 'mock-cloud',
        httpClient,
      });

      const service = new EndToEndDryRunService(
        mockDirSource,
        jiraTarget,
        resolver,
        { maxRecords: 10, concurrency: 2 },
        new RequestBudgetGuard(),
      );

      // Verify service has no write methods
      expect((service as unknown as Record<string, unknown>)['write']).toBeUndefined();
      expect((service as unknown as Record<string, unknown>)['createCustomer']).toBeUndefined();
      expect((service as unknown as Record<string, unknown>)['updateCustomer']).toBeUndefined();
    });

    it('No customer-creation endpoint exists on target', () => {
      const authProvider = new BasicJiraAuthProvider('fictional@example.com', 'token-123');
      const httpClient = new GetOnlyJiraHttpClient(authProvider);
      const jiraTarget = new ReadOnlyJiraCustomerTarget({
        cloudId: 'mock-cloud',
        siteUrl: 'https://mock.atlassian.net',
        httpClient,
      });

      expect((jiraTarget as unknown as Record<string, unknown>)['createCustomer']).toBeUndefined();
      expect((jiraTarget as unknown as Record<string, unknown>)['addCustomer']).toBeUndefined();
      expect((jiraTarget as unknown as Record<string, unknown>)['inviteCustomer']).toBeUndefined();
    });

    it('No non-GET Jira request occurs: GetOnlyJiraHttpClient rejects mutations immediately', async () => {
      const authProvider = new BasicJiraAuthProvider('fictional@example.com', 'token-123');
      const httpClient = new GetOnlyJiraHttpClient(authProvider);

      await expect(
        httpClient.request('POST', 'https://api.atlassian.com/some/endpoint', { foo: 'bar' }),
      ).rejects.toThrow(/GetOnlyJiraHttpClient strictly enforces GET-only requests/i);

      await expect(
        httpClient.request('PUT', 'https://api.atlassian.com/some/endpoint', { foo: 'bar' }),
      ).rejects.toThrow(/GetOnlyJiraHttpClient strictly enforces GET-only requests/i);

      await expect(
        httpClient.request('DELETE', 'https://api.atlassian.com/some/endpoint'),
      ).rejects.toThrow(/GetOnlyJiraHttpClient strictly enforces GET-only requests/i);
    });
  });

  describe('Pilot Limits, Concurrency, and Request Budget', () => {
    it('Pilot limit is enforced: processes exactly maxRecords out of larger eligible pool', async () => {
      const people = createMockDirectoryPeople(25);
      const mockDirSource: DirectorySourcePort = {
        getPeople: async () => people,
      };

      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/api/v1/customer/details')) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify(mockJiraFieldResponse),
            headers: new Headers(),
          };
        }
        if (url.includes('/rest/api/3/user/search')) {
          // Return NOT_FOUND for all
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify([]),
            headers: new Headers(),
          };
        }
        return { ok: false, status: 404, text: async () => '', headers: new Headers() };
      });

      const authProvider = new BasicJiraAuthProvider('fictional@example.com', 'token-123');
      const httpClient = new GetOnlyJiraHttpClient(authProvider, {
        fetchFn: mockFetch as unknown as typeof fetch,
      });
      const budgetGuard = new RequestBudgetGuard({
        global: 30,
        cloudIdDiscovery: 2,
        fieldDiscovery: 2,
        userSearch: 20,
        customerProfile: 20,
      });

      const jiraTarget = new ReadOnlyJiraCustomerTarget({
        cloudId: 'mock-cloud-id',
        siteUrl: 'https://mock.atlassian.net',
        httpClient,
        budgetGuard,
        log: testLogger,
      });

      const resolver = new JiraUserSearchResolver({
        cloudId: 'mock-cloud-id',
        httpClient,
        budgetGuard,
        log: testLogger,
      });

      jiraTarget.setIdentityResolver(resolver);

      const service = new EndToEndDryRunService(
        mockDirSource,
        jiraTarget,
        resolver,
        { maxRecords: 5, concurrency: 2 },
        budgetGuard,
        new DiffPlanner(),
        new MappingService(),
        testLogger,
      );

      const report = await service.executeDryRun();

      expect(report.summary.eligibleDirectoryRecords).toBe(25);
      expect(report.summary.pilotRecordsProcessed).toBe(5);
      expect(report.records.length).toBe(5);
    });

    it('Concurrency limit is enforced: workers adhere to bounded limit', async () => {
      const people = createMockDirectoryPeople(10);
      const mockDirSource: DirectorySourcePort = {
        getPeople: async () => people,
      };

      let activeConcurrentLookups = 0;
      let maxObservedConcurrency = 0;

      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/api/v1/customer/details')) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify(mockJiraFieldResponse),
            headers: new Headers(),
          };
        }
        if (url.includes('/rest/api/3/user/search')) {
          activeConcurrentLookups++;
          if (activeConcurrentLookups > maxObservedConcurrency) {
            maxObservedConcurrency = activeConcurrentLookups;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
          activeConcurrentLookups--;
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify([]),
            headers: new Headers(),
          };
        }
        return { ok: false, status: 404, text: async () => '', headers: new Headers() };
      });

      const authProvider = new BasicJiraAuthProvider('fictional@example.com', 'token-123');
      const httpClient = new GetOnlyJiraHttpClient(authProvider, {
        fetchFn: mockFetch as unknown as typeof fetch,
      });
      const budgetGuard = new RequestBudgetGuard({
        global: 50,
        cloudIdDiscovery: 2,
        fieldDiscovery: 2,
        userSearch: 30,
        customerProfile: 30,
      });

      const jiraTarget = new ReadOnlyJiraCustomerTarget({
        cloudId: 'mock-cloud-id',
        siteUrl: 'https://mock.atlassian.net',
        httpClient,
        budgetGuard,
        log: testLogger,
      });

      const resolver = new JiraUserSearchResolver({
        cloudId: 'mock-cloud-id',
        httpClient,
        budgetGuard,
        log: testLogger,
      });

      jiraTarget.setIdentityResolver(resolver);

      const service = new EndToEndDryRunService(
        mockDirSource,
        jiraTarget,
        resolver,
        { maxRecords: 10, concurrency: 2 },
        budgetGuard,
        new DiffPlanner(),
        new MappingService(),
        testLogger,
      );

      await service.executeDryRun();

      expect(maxObservedConcurrency).toBeLessThanOrEqual(2);
    });

    it('Operation budget is enforced: stops safely when global budget is reached', async () => {
      const people = createMockDirectoryPeople(10);
      const mockDirSource: DirectorySourcePort = {
        getPeople: async () => people,
      };

      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/api/v1/customer/details')) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify(mockJiraFieldResponse),
            headers: new Headers(),
          };
        }
        if (url.includes('/rest/api/3/user/search')) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify([]),
            headers: new Headers(),
          };
        }
        return { ok: false, status: 404, text: async () => '', headers: new Headers() };
      });

      const authProvider = new BasicJiraAuthProvider('fictional@example.com', 'token-123');
      const httpClient = new GetOnlyJiraHttpClient(authProvider, {
        fetchFn: mockFetch as unknown as typeof fetch,
      });
      // Very tight global budget: 3 operations total (1 field discovery + 2 searches -> stops on 3rd search)
      const budgetGuard = new RequestBudgetGuard({
        global: 3,
        cloudIdDiscovery: 5,
        fieldDiscovery: 5,
        userSearch: 5,
        customerProfile: 5,
      });

      const jiraTarget = new ReadOnlyJiraCustomerTarget({
        cloudId: 'mock-cloud-id',
        siteUrl: 'https://mock.atlassian.net',
        httpClient,
        budgetGuard,
        log: testLogger,
      });

      const resolver = new JiraUserSearchResolver({
        cloudId: 'mock-cloud-id',
        httpClient,
        budgetGuard,
        log: testLogger,
      });

      jiraTarget.setIdentityResolver(resolver);

      const service = new EndToEndDryRunService(
        mockDirSource,
        jiraTarget,
        resolver,
        { maxRecords: 10, concurrency: 1 },
        budgetGuard,
        new DiffPlanner(),
        new MappingService(),
        testLogger,
      );

      await expect(service.executeDryRun()).rejects.toThrow(RequestBudgetExceededError);
      expect(budgetGuard.getRequestBudgetUsed()).toBeLessThanOrEqual(4);
    });
  });

  describe('Field Compatibility & Discovery', () => {
    it('Discovers fields and classifies matched, unmapped, and unknown types correctly', async () => {
      const authProvider = new BasicJiraAuthProvider('fictional@example.com', 'token-123');
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(mockJiraFieldResponse),
        headers: new Headers(),
      });
      const httpClient = new GetOnlyJiraHttpClient(authProvider, {
        fetchFn: mockFetch as unknown as typeof fetch,
      });
      const jiraTarget = new ReadOnlyJiraCustomerTarget({
        cloudId: 'mock-cloud-id',
        siteUrl: 'https://mock.atlassian.net',
        httpClient,
        log: testLogger,
      });

      const report = await jiraTarget.discoverFields();

      expect(Object.keys(report.matchedDomainFields)).toEqual([
        'title',
        'officePhoneNumber',
        'supervisor',
        'officeClassroom',
        'emailAddress',
      ]);
      expect(report.missingDomainFields).toHaveLength(0);
      // Cell Phone Number must be unmapped
      expect(report.unmappedFields).toContain('Cell Phone Number');
      // Known unmapped fields must NOT be classified as unknown types
      expect(report.unknownTypes).toHaveLength(0);
    });

    it('Fails safely if required mapped fields are missing in Jira CSM', async () => {
      const mockIncompleteFieldResponse = {
        results: [
          { id: 'field-title', name: 'Title', type: { name: 'STRING' } },
          // Missing Office Phone, Supervisor, Office/Classroom
        ],
      };

      const mockDirSource: DirectorySourcePort = {
        getPeople: async () => createMockDirectoryPeople(2),
      };

      const authProvider = new BasicJiraAuthProvider('fictional@example.com', 'token-123');
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(mockIncompleteFieldResponse),
        headers: new Headers(),
      });
      const httpClient = new GetOnlyJiraHttpClient(authProvider, {
        fetchFn: mockFetch as unknown as typeof fetch,
      });
      const jiraTarget = new ReadOnlyJiraCustomerTarget({
        cloudId: 'mock-cloud-id',
        siteUrl: 'https://mock.atlassian.net',
        httpClient,
        log: testLogger,
      });
      const resolver = new JiraUserSearchResolver({
        cloudId: 'mock-cloud-id',
        httpClient,
        log: testLogger,
      });
      jiraTarget.setIdentityResolver(resolver);

      const service = new EndToEndDryRunService(
        mockDirSource,
        jiraTarget,
        resolver,
        { maxRecords: 2, concurrency: 1 },
        new RequestBudgetGuard({ global: 10 }),
        new DiffPlanner(),
        new MappingService(),
        testLogger,
      );

      await expect(service.executeDryRun()).rejects.toThrow(
        /Field compatibility check failed: Required customer detail field\(s\) missing in Jira CSM/i,
      );
    });
  });

  describe('Identity Resolution & Profiling Outcomes', () => {
    it('Handles all 6 outcome categories: RESOLVED, NOT_FOUND, AMBIGUOUS, EMAIL_UNAVAILABLE, INACTIVE, ERROR', async () => {
      const directoryUsers: DirectoryPerson[] = [
        {
          sourceId: 'p1',
          displayName: 'Resolved User',
          email: 'resolved@example.com',
          jobTitle: 'Senior Architect',
          officePhone: '+1-555-0101',
          supervisorName: 'Sarah Connor',
          officeLocation: 'Building A',
        },
        {
          sourceId: 'p2',
          displayName: 'Not Found User',
          email: 'notfound@example.com',
          jobTitle: 'DevOps Engineer',
        },
        {
          sourceId: 'p3',
          displayName: 'Ambiguous User',
          email: 'ambiguous@example.com',
          jobTitle: 'Consultant',
        },
        {
          sourceId: 'p4',
          displayName: 'Inactive User',
          email: 'inactive@example.com',
          jobTitle: 'Former Employee',
        },
        {
          sourceId: 'p5',
          displayName: 'Error User',
          email: 'error@example.com',
          jobTitle: 'Analyst',
        },
        {
          sourceId: 'p6',
          displayName: 'No Email User',
          email: null,
          jobTitle: 'Contractor',
        },
      ];

      const mockDirSource: DirectorySourcePort = {
        getPeople: async () => directoryUsers,
      };

      const mockResolver: CustomerIdentityResolverPort = {
        resolveCustomerIdentity: vi.fn().mockImplementation(async (email: string) => {
          if (email === 'resolved@example.com') {
            return { outcome: 'RESOLVED', accountId: 'acc-resolved-01' };
          }
          if (email === 'notfound@example.com') {
            return { outcome: 'NOT_FOUND', reason: 'User not found' };
          }
          if (email === 'ambiguous@example.com') {
            return { outcome: 'AMBIGUOUS', reason: 'Multiple matching accounts' };
          }
          if (email === 'inactive@example.com') {
            return {
              outcome: 'INACTIVE',
              reason: 'Matching user account found but account is inactive',
            };
          }
          if (email === 'error@example.com') {
            return { outcome: 'ERROR', reason: 'Network timeout querying user search' };
          }
          return { outcome: 'NOT_FOUND' };
        }),
      };

      const authProvider = new BasicJiraAuthProvider('fictional@example.com', 'token-123');
      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/api/v1/customer/details')) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify(mockJiraFieldResponse),
            headers: new Headers(),
          };
        }
        if (url.includes('/api/v1/customer/profile/acc-resolved-01')) {
          return {
            ok: true,
            status: 200,
            text: async () =>
              JSON.stringify({
                customerId: 'acc-resolved-01',
                details: [
                  { id: 'field-title', name: 'Title', value: 'Junior Architect' }, // Changed
                  { id: 'field-phone', name: 'Office Phone Number', value: '+1-555-0101' }, // Identical
                  { id: 'field-supervisor', name: 'Supervisor', value: 'Sarah Connor' }, // Identical
                  { id: 'field-office', name: 'Office/Classroom', value: 'Building A' }, // Identical
                  { id: 'field-email', name: 'Email Address', value: 'resolved@example.com' }, // Identical
                ],
              }),
            headers: new Headers(),
          };
        }
        return { ok: false, status: 404, text: async () => '', headers: new Headers() };
      });

      const httpClient = new GetOnlyJiraHttpClient(authProvider, {
        fetchFn: mockFetch as unknown as typeof fetch,
      });
      const jiraTarget = new ReadOnlyJiraCustomerTarget({
        cloudId: 'mock-cloud-id',
        siteUrl: 'https://mock.atlassian.net',
        httpClient,
        log: testLogger,
      });

      const service = new EndToEndDryRunService(
        mockDirSource,
        jiraTarget,
        mockResolver,
        { maxRecords: 6, concurrency: 1 },
        new RequestBudgetGuard({ global: 50 }),
        new DiffPlanner(),
        new MappingService(),
        testLogger,
      );

      const report = await service.executeDryRun();

      expect(report.summary.pilotRecordsProcessed).toBe(6);
      expect(report.summary.existingCustomersResolved).toBe(1);
      expect(report.summary.customersWithPlannedUpdates).toBe(1);
      expect(report.summary.customersNotFound).toBe(1);
      expect(report.summary.ambiguousMatches).toBe(1);
      expect(report.summary.inactiveCustomers).toBe(1);
      expect(report.summary.emailUnavailable).toBe(1);
      expect(report.summary.errorCount).toBe(1); // from the resolution error
      expect(report.summary.plannedFieldChanges).toBe(1);

      // Verify individual records
      const resolvedRec = report.records.find((r) => r.resultCategory === 'UPDATE_PLANNED');
      expect(resolvedRec).toBeDefined();
      expect(resolvedRec?.changedFieldNames).toEqual(['title']);
      expect(resolvedRec?.changedFieldCount).toBe(1);

      const notFoundRec = report.records.find((r) => r.resultCategory === 'NOT_FOUND');
      expect(notFoundRec).toBeDefined();

      const ambiguousRec = report.records.find((r) => r.resultCategory === 'AMBIGUOUS');
      expect(ambiguousRec).toBeDefined();

      const inactiveRec = report.records.find((r) => r.resultCategory === 'INACTIVE');
      expect(inactiveRec).toBeDefined();

      const errorRec = report.records.find((r) => r.resultCategory === 'ERROR');
      expect(errorRec).toBeDefined();

      const noEmailRec = report.records.find((r) => r.resultCategory === 'EMAIL_UNAVAILABLE');
      expect(noEmailRec).toBeDefined();
    });

    it('Profile failures are isolated and do not crash or abort remaining records', async () => {
      const directoryUsers: DirectoryPerson[] = [
        {
          sourceId: 'p1',
          displayName: 'Profile Fail User',
          email: 'fail@example.com',
          jobTitle: 'Engineer',
        },
        {
          sourceId: 'p2',
          displayName: 'Profile Success User',
          email: 'success@example.com',
          jobTitle: 'Engineer',
        },
      ];

      const mockDirSource: DirectorySourcePort = {
        getPeople: async () => directoryUsers,
      };

      const mockResolver: CustomerIdentityResolverPort = {
        resolveCustomerIdentity: vi.fn().mockImplementation(async (email: string) => {
          if (email === 'fail@example.com') {
            return {
              outcome: 'RESOLVED',
              accountId: 'acc-fail',
              emailAddress: email,
            };
          }
          return {
            outcome: 'RESOLVED',
            accountId: 'acc-success',
            emailAddress: email,
          };
        }),
      };

      const authProvider = new BasicJiraAuthProvider('fictional@example.com', 'token-123');
      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/api/v1/customer/details')) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify(mockJiraFieldResponse),
            headers: new Headers(),
          };
        }
        if (url.includes('/api/v1/customer/profile/acc-fail')) {
          return {
            ok: false,
            status: 500,
            text: async () => JSON.stringify({ message: 'Internal Server Error' }),
            headers: new Headers(),
          };
        }
        if (url.includes('/api/v1/customer/profile/acc-success')) {
          return {
            ok: true,
            status: 200,
            text: async () =>
              JSON.stringify({
                customerId: 'acc-success',
                details: [],
              }),
            headers: new Headers(),
          };
        }
        return { ok: false, status: 404, text: async () => '', headers: new Headers() };
      });

      const httpClient = new GetOnlyJiraHttpClient(authProvider, {
        fetchFn: mockFetch as unknown as typeof fetch,
        maxRetries: 0,
      });

      const jiraTarget = new ReadOnlyJiraCustomerTarget({
        cloudId: 'mock-cloud-id',
        siteUrl: 'https://mock.atlassian.net',
        httpClient,
        log: testLogger,
      });

      const service = new EndToEndDryRunService(
        mockDirSource,
        jiraTarget,
        mockResolver,
        { maxRecords: 2, concurrency: 1 },
        new RequestBudgetGuard({ global: 10 }),
        new DiffPlanner(),
        new MappingService(),
        testLogger,
      );

      const report = await service.executeDryRun();

      expect(report.summary.pilotRecordsProcessed).toBe(2);
      expect(report.summary.profileRetrievalFailures).toBe(1);
      expect(report.summary.errorCount).toBe(1);
      expect(report.summary.customersWithPlannedUpdates).toBe(1); // second record succeeded
    });
  });

  describe('Diffing Logic & Field Preservation', () => {
    it('Empty source values do not erase Jira values', async () => {
      const planner = new DiffPlanner();
      const candidate: CustomerDetails = {
        email: 'fictional@example.com',
        title: 'Engineer',
        officePhoneNumber: null, // Empty in source
        supervisor: undefined, // Empty in source
        officeClassroom: '', // Empty in source
      };

      const existing: CustomerDetails = {
        email: 'fictional@example.com',
        title: 'Junior Engineer',
        officePhoneNumber: '+1-555-9999', // Existing populated
        supervisor: 'Alice Manager', // Existing populated
        officeClassroom: 'Building C, Room 400', // Existing populated
      };

      const plan = planner.planDiff(candidate, existing);

      expect(plan.hasChanges).toBe(true);
      expect(plan.fieldDiffs).toHaveLength(1);
      expect(plan.fieldDiffs[0]?.fieldName).toBe('title');
      expect(plan.updates.officePhoneNumber).toBeUndefined();
      expect(plan.updates.supervisor).toBeUndefined();
      expect(plan.updates.officeClassroom).toBeUndefined();
    });

    it('Unchanged customers produce no plan', async () => {
      const planner = new DiffPlanner();
      const candidate: CustomerDetails = {
        email: 'fictional@example.com',
        title: 'Engineer',
        officePhoneNumber: '+1-555-0100',
        supervisor: 'Alice Manager',
        officeClassroom: 'Desk 4',
      };

      const existing: CustomerDetails = {
        email: 'fictional@example.com',
        title: 'Engineer',
        officePhoneNumber: '+1-555-0100',
        supervisor: 'Alice Manager',
        officeClassroom: 'Desk 4',
      };

      const plan = planner.planDiff(candidate, existing);

      expect(plan.hasChanges).toBe(false);
      expect(plan.fieldDiffs).toHaveLength(0);
      expect(Object.keys(plan.updates)).toHaveLength(0);
    });

    it('Changed customers contain changed field names only', async () => {
      const planner = new DiffPlanner();
      const candidate: CustomerDetails = {
        email: 'fictional@example.com',
        title: 'Lead Architect', // Changed
        officePhoneNumber: '+1-555-0100', // Unchanged
        supervisor: 'Bob Director', // Changed
        officeClassroom: 'Desk 4', // Unchanged
      };

      const existing: CustomerDetails = {
        email: 'fictional@example.com',
        title: 'Senior Architect',
        officePhoneNumber: '+1-555-0100',
        supervisor: 'Alice Manager',
        officeClassroom: 'Desk 4',
      };

      const plan = planner.planDiff(candidate, existing);

      expect(plan.hasChanges).toBe(true);
      expect(plan.fieldDiffs.map((d) => d.fieldName).sort()).toEqual(['supervisor', 'title']);
      expect(plan.updates.officePhoneNumber).toBeUndefined();
      expect(plan.updates.officeClassroom).toBeUndefined();
    });

    it('Cell Phone Number and Email Address are never modified', async () => {
      const planner = new DiffPlanner();
      const candidate: CustomerDetails = {
        email: 'fictional.new@example.com',
        title: 'Specialist',
      };

      const existing: CustomerDetails = {
        email: 'fictional.old@example.com',
        title: 'Specialist',
      };

      const plan = planner.planDiff(candidate, existing);

      // Email is matching key, never updatable
      expect((plan.updates as Record<string, unknown>)['email']).toBeUndefined();
      expect((plan.updates as Record<string, unknown>)['cellPhoneNumber']).toBeUndefined();
      expect((plan.updates as Record<string, unknown>)['emailAddress']).toBeUndefined();
    });
  });

  describe('Privacy Controls and Output Artifact', () => {
    it('No logs contain emails, names, phone numbers, or field values', async () => {
      const people = [
        {
          sourceId: 'entra-pii-test',
          displayName: 'Secret Employee Name',
          email: 'secret.pii.employee@example.com',
          jobTitle: 'Secret Executive Title',
          officePhone: '+1-555-987-6543',
          supervisorName: 'Secret Boss Name',
          officeLocation: 'Secret Vault 42',
        },
      ];

      const mockDirSource: DirectorySourcePort = {
        getPeople: async () => people,
      };

      const mockResolver: CustomerIdentityResolverPort = {
        resolveCustomerIdentity: vi.fn().mockResolvedValue({
          outcome: 'RESOLVED',
          accountId: 'acc-secret-id-999',
        }),
      };

      const authProvider = new BasicJiraAuthProvider('fictional@example.com', 'token-123');
      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/api/v1/customer/details')) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify(mockJiraFieldResponse),
            headers: new Headers(),
          };
        }
        if (url.includes('/api/v1/customer/profile/acc-secret-id-999')) {
          return {
            ok: true,
            status: 200,
            text: async () =>
              JSON.stringify({
                customerId: 'acc-secret-id-999',
                details: [{ id: 'field-title', name: 'Title', value: 'Old Secret Title' }],
              }),
            headers: new Headers(),
          };
        }
        return { ok: false, status: 404, text: async () => '', headers: new Headers() };
      });

      const httpClient = new GetOnlyJiraHttpClient(authProvider, {
        fetchFn: mockFetch as unknown as typeof fetch,
      });
      const jiraTarget = new ReadOnlyJiraCustomerTarget({
        cloudId: 'mock-cloud-id',
        siteUrl: 'https://mock.atlassian.net',
        httpClient,
        log: testLogger,
      });

      const service = new EndToEndDryRunService(
        mockDirSource,
        jiraTarget,
        mockResolver,
        { maxRecords: 1, concurrency: 1 },
        new RequestBudgetGuard({ global: 10 }),
        new DiffPlanner(),
        new MappingService(),
        testLogger,
      );

      await service.executeDryRun();

      // Check all logged entries
      const allLogStrings = capturedLogs.map((l) => JSON.stringify(l));

      for (const logStr of allLogStrings) {
        expect(logStr).not.toContain('secret.pii.employee@example.com');
        expect(logStr).not.toContain('Secret Employee Name');
        expect(logStr).not.toContain('Secret Executive Title');
        expect(logStr).not.toContain('Old Secret Title');
        expect(logStr).not.toContain('+1-555-987-6543');
        expect(logStr).not.toContain('Secret Boss Name');
        expect(logStr).not.toContain('Secret Vault 42');
        expect(logStr).not.toContain('acc-secret-id-999');
      }
    });

    it('Output JSON report artifact contains correlation references, categories, and field names only, zero IDs or values', async () => {
      const reportPath = 'reports/dry-run-artifact-test.json';
      if (fs.existsSync(reportPath)) {
        fs.unlinkSync(reportPath);
      }

      const people = [
        {
          sourceId: 'entra-art-test',
          displayName: 'Artifact User',
          email: 'artifact.user@example.com',
          jobTitle: 'New Artifact Title',
          officePhone: '+1-555-0101',
          supervisorName: 'Artifact Boss',
          officeLocation: 'Artifact Room 1',
        },
      ];

      const mockDirSource: DirectorySourcePort = {
        getPeople: async () => people,
      };

      const mockResolver: CustomerIdentityResolverPort = {
        resolveCustomerIdentity: vi.fn().mockResolvedValue({
          outcome: 'RESOLVED',
          accountId: 'acc-artifact-id-123',
          emailAddress: 'artifact.user@example.com',
        }),
      };

      const authProvider = new BasicJiraAuthProvider('fictional@example.com', 'token-123');
      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/api/v1/customer/details')) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify(mockJiraFieldResponse),
            headers: new Headers(),
          };
        }
        if (url.includes('/api/v1/customer/profile/acc-artifact-id-123')) {
          return {
            ok: true,
            status: 200,
            text: async () =>
              JSON.stringify({
                customerId: 'acc-artifact-id-123',
                details: [
                  { id: 'field-title', name: 'Title', value: 'Old Artifact Title' },
                  { id: 'field-phone', name: 'Office Phone Number', value: '+1-555-0101' },
                  { id: 'field-supervisor', name: 'Supervisor', value: 'Artifact Boss' },
                  { id: 'field-office', name: 'Office/Classroom', value: 'Artifact Room 1' },
                  { id: 'field-email', name: 'Email Address', value: 'artifact.user@example.com' },
                ],
              }),
            headers: new Headers(),
          };
        }
        return { ok: false, status: 404, text: async () => '', headers: new Headers() };
      });

      const httpClient = new GetOnlyJiraHttpClient(authProvider, {
        fetchFn: mockFetch as unknown as typeof fetch,
      });
      const jiraTarget = new ReadOnlyJiraCustomerTarget({
        cloudId: 'mock-cloud-id',
        siteUrl: 'https://mock.atlassian.net',
        httpClient,
        log: testLogger,
      });

      const service = new EndToEndDryRunService(
        mockDirSource,
        jiraTarget,
        mockResolver,
        { maxRecords: 1, concurrency: 1, reportPath },
        new RequestBudgetGuard({ global: 10 }),
        new DiffPlanner(),
        new MappingService(),
        testLogger,
      );

      const report = await service.executeDryRun();

      expect(report.reportPath).toBeDefined();
      expect(fs.existsSync(report.reportPath!)).toBe(true);
      const rawContent = fs.readFileSync(report.reportPath!, 'utf8');
      const parsedArtifact: EndToEndDryRunReport = JSON.parse(rawContent);

      expect(parsedArtifact.mode).toBe('END_TO_END_DRY_RUN');
      expect(parsedArtifact.summary.pilotRecordsProcessed).toBe(1);
      expect(parsedArtifact.records[0]?.customerRef).toBe(
        hashIdentifier('artifact.user@example.com'),
      );
      expect(parsedArtifact.records[0]?.resultCategory).toBe('UPDATE_PLANNED');
      expect(parsedArtifact.records[0]?.changedFieldNames).toEqual(['title']);

      // Verify ZERO PII in file
      expect(rawContent).not.toContain('artifact.user@example.com');
      expect(rawContent).not.toContain('Artifact User');
      expect(rawContent).not.toContain('acc-artifact-id-123');
      expect(rawContent).not.toContain('New Artifact Title');
      expect(rawContent).not.toContain('Old Artifact Title');

      // Cleanup
      fs.unlinkSync(report.reportPath!);
    });

    it('.gitignore excludes dry-run report output patterns', () => {
      const gitignore = fs.readFileSync('.gitignore', 'utf8');
      expect(gitignore).toMatch(/reports\//);
      expect(gitignore).toMatch(/\*\.report\.json/);
      expect(gitignore).toMatch(/\*dry-run\*\.json/);
    });

    describe('Report Path Protections', () => {
      it('rejects absolute paths', () => {
        expect(() => validateAndResolveReportPath('C:\\reports\\test.json')).toThrow(
          /Absolute paths are prohibited/i,
        );

        expect(() => validateAndResolveReportPath('/reports/test.json')).toThrow(
          /Absolute paths are prohibited/i,
        );
      });

      it("rejects parent directory traversal components ('..')", () => {
        expect(() => validateAndResolveReportPath('reports/../secret.json')).toThrow(
          /Parent directory traversal/i,
        );

        expect(() => validateAndResolveReportPath('../reports/test.json')).toThrow(
          /Parent directory traversal/i,
        );
      });

      it('rejects paths outside reports directory', () => {
        expect(() => validateAndResolveReportPath('data/output.json')).toThrow(
          /Reports must be stored within the 'reports' directory/i,
        );
      });

      it('generates a filename containing a UTC timestamp', () => {
        const fixedDate = new Date('2026-09-29T19:30:00.000Z');
        const resolved = validateAndResolveReportPath('reports/dry-run.json', fixedDate);

        expect(resolved.fileName).toBe('dry-run-2026-09-29T19-30-00Z.json');
        expect(resolved.filePath).toMatch(/reports/);
      });
    });

    describe('Dry-Run Consistency Validation', () => {
      it('proves consecutive equal reports compare as stable', () => {
        const reportA = {
          records: [
            {
              customerRef: 'ref-111',
              resultCategory: 'UPDATE_PLANNED' as const,
              changedFieldNames: ['title', 'supervisor'],
            },
            {
              customerRef: 'ref-222',
              resultCategory: 'UNCHANGED' as const,
              changedFieldNames: [],
            },
          ],
        };

        const reportB = {
          records: [
            // Order reversed to prove order independence
            {
              customerRef: 'ref-222',
              resultCategory: 'UNCHANGED' as const,
              changedFieldNames: [],
            },
            {
              customerRef: 'ref-111',
              resultCategory: 'UPDATE_PLANNED' as const,
              changedFieldNames: ['supervisor', 'title'], // Field order reversed
            },
          ],
        };

        const comparison = compareDryRunReports(reportA, reportB);

        expect(comparison.isConsistent).toBe(true);
        expect(comparison.recordsInRunA).toBe(2);
        expect(comparison.recordsInRunB).toBe(2);
        expect(comparison.recordsInBoth).toBe(2);
        expect(comparison.recordsAdded).toBe(0);
        expect(comparison.recordsRemoved).toBe(0);
        expect(comparison.recordsWithCategoryChanges).toBe(0);
        expect(comparison.recordsWithFieldSetChanges).toBe(0);
        expect(comparison.differences).toHaveLength(0);
      });

      it('detects changed field sets between dry-run reports', () => {
        const reportA = {
          records: [
            {
              customerRef: 'ref-111',
              resultCategory: 'UPDATE_PLANNED' as const,
              changedFieldNames: ['title'],
            },
          ],
        };

        const reportB = {
          records: [
            {
              customerRef: 'ref-111',
              resultCategory: 'UPDATE_PLANNED' as const,
              changedFieldNames: ['title', 'officePhoneNumber'],
            },
          ],
        };

        const comparison = compareDryRunReports(reportA, reportB);

        expect(comparison.isConsistent).toBe(false);
        expect(comparison.recordsWithFieldSetChanges).toBe(1);
        expect(comparison.recordsWithCategoryChanges).toBe(0);
        expect(comparison.differences).toHaveLength(1);
        expect(comparison.differences[0]?.customerRef).toBe('ref-111');
        expect(comparison.differences[0]?.fieldsInA).toEqual(['title']);
        expect(comparison.differences[0]?.fieldsInB).toEqual(['officePhoneNumber', 'title']);
      });

      it('detects result category changes between dry-run reports', () => {
        const reportA = {
          records: [
            {
              customerRef: 'ref-111',
              resultCategory: 'UNCHANGED' as const,
              changedFieldNames: [],
            },
          ],
        };

        const reportB = {
          records: [
            {
              customerRef: 'ref-111',
              resultCategory: 'UPDATE_PLANNED' as const,
              changedFieldNames: ['title'],
            },
          ],
        };

        const comparison = compareDryRunReports(reportA, reportB);

        expect(comparison.isConsistent).toBe(false);
        expect(comparison.recordsWithCategoryChanges).toBe(1);
        expect(comparison.differences[0]?.categoryInA).toBe('UNCHANGED');
        expect(comparison.differences[0]?.categoryInB).toBe('UPDATE_PLANNED');
      });

      it('detects added and removed records and exposes zero employee identity', () => {
        const reportA = {
          records: [
            {
              customerRef: 'ref-aaa',
              resultCategory: 'UNCHANGED' as const,
              changedFieldNames: [],
            },
          ],
        };

        const reportB = {
          records: [
            {
              customerRef: 'ref-bbb',
              resultCategory: 'UPDATE_PLANNED' as const,
              changedFieldNames: ['title'],
            },
          ],
        };

        const comparison = compareDryRunReports(reportA, reportB);

        expect(comparison.isConsistent).toBe(false);
        expect(comparison.recordsRemoved).toBe(1); // ref-aaa removed in B
        expect(comparison.recordsAdded).toBe(1); // ref-bbb added in B
        expect(comparison.differences).toHaveLength(2);

        // Verify differences contains NO emails, names, or account IDs
        const diffJson = JSON.stringify(comparison.differences);
        expect(diffJson).not.toMatch(/@/);
        expect(diffJson).toMatch(/ref-aaa/);
        expect(diffJson).toMatch(/ref-bbb/);
      });
    });
  });
});
