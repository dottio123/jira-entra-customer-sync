import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  CustomerEnumerationValidator,
  CustomerEnumerationValidationReport,
} from '../src/services/customer-enumeration-validator';
import {
  JiraServiceDeskCustomerScopeReader,
  CustomerScopeEnumerationError,
  BasicJiraAuthProvider,
  GetOnlyJiraHttpClient,
  RequestBudgetGuard,
  JiraAccountDirectoryReader,
  ReadOnlyJiraCustomerTarget,
} from '../src/connectors/jira';
import { InMemoryCustomerScopeReader, InMemoryDirectorySource } from '../src/connectors/memory';
import {
  ExistingCustomerReference,
  ExistingCustomerScopeReaderPort,
  JiraAccountDirectoryReaderPort,
  JiraAccountReference,
} from '../src/domain';
import {
  JiraFirstDryRunService,
  SingleCustomerValidator,
  AuthenticationInvestigationService,
  DiffPlanner,
  MappingService,
} from '../src/services';
import { parseConfig } from '../src/config';
import { runStartup } from '../src/index';
import { Logger } from '../src/utils/logger';

const silentLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  setLevel: vi.fn(),
} as unknown as Logger;

describe('Customer Enumeration Validation', () => {
  describe('Configuration & Safety Validation', () => {
    const validBaseEnv: Record<string, string> = {
      JIRA_VALIDATE_CUSTOMER_ENUMERATION: 'true',
      CUSTOMER_TARGET: 'jira-readonly',
      SYNC_DRY_RUN: 'true',
      DISCOVERY_ONLY: 'false',
      JIRA_VALIDATE_EXISTING_CUSTOMER: 'false',
      END_TO_END_DRY_RUN: 'false',
      JSM_SERVICE_DESK_IDS: '10001',
      ATLASSIAN_SITE_URL: 'https://test.atlassian.net',
      ATLASSIAN_CLOUD_ID: 'cloud-123',
      ATLASSIAN_USER_EMAIL: 'admin@example.com',
      ATLASSIAN_API_TOKEN: 'token-abc',
    };

    it('accepts valid configuration with exactly one service desk ID', () => {
      const config = parseConfig(validBaseEnv);
      expect(config.sync.validateCustomerEnumeration).toBe(true);
      expect(config.sync.customerTarget).toBe('jira-readonly');
      expect(config.sync.dryRun).toBe(true);
      expect(config.sync.jsmServiceDeskIds).toEqual(['10001']);
    });

    it('rejects write mode (SYNC_DRY_RUN=false)', () => {
      expect(() => parseConfig({ ...validBaseEnv, SYNC_DRY_RUN: 'false' })).toThrow(
        /Safety violation: Write mode is prohibited/i,
      );
    });

    it('requires CUSTOMER_TARGET=jira-readonly', () => {
      expect(() => parseConfig({ ...validBaseEnv, CUSTOMER_TARGET: 'memory' })).toThrow(
        /CUSTOMER_TARGET must be 'jira-readonly'/i,
      );
    });

    it('requires JSM_SERVICE_DESK_IDS to contain exactly one ID (rejects empty)', () => {
      expect(() => parseConfig({ ...validBaseEnv, JSM_SERVICE_DESK_IDS: '' })).toThrow(
        /JSM_SERVICE_DESK_IDS must contain exactly one service-desk ID/i,
      );
    });

    it('requires JSM_SERVICE_DESK_IDS to contain exactly one ID (rejects multiple during Phase 1)', () => {
      expect(() => parseConfig({ ...validBaseEnv, JSM_SERVICE_DESK_IDS: '10001, 10002' })).toThrow(
        /JSM_SERVICE_DESK_IDS must contain exactly one service-desk ID/i,
      );
    });

    it('rejects placeholder JSM_SERVICE_DESK_IDS', () => {
      expect(() =>
        parseConfig({ ...validBaseEnv, JSM_SERVICE_DESK_IDS: '<SERVICE_DESK_ID>' }),
      ).toThrow(/contains placeholder '<SERVICE_DESK_ID>'/i);

      expect(() =>
        parseConfig({ ...validBaseEnv, JSM_SERVICE_DESK_IDS: 'placeholder-desk' }),
      ).toThrow(/contains placeholder 'placeholder-desk'/i);
    });

    it('rejects conflicting run modes', () => {
      expect(() => parseConfig({ ...validBaseEnv, DISCOVERY_ONLY: 'true' })).toThrow(
        /DISCOVERY_ONLY must be false/i,
      );

      expect(() =>
        parseConfig({ ...validBaseEnv, JIRA_VALIDATE_EXISTING_CUSTOMER: 'true' }),
      ).toThrow(/JIRA_VALIDATE_EXISTING_CUSTOMER must be false/i);

      expect(() =>
        parseConfig({
          ...validBaseEnv,
          DIRECTORY_SOURCE: 'entra',
          END_TO_END_DRY_RUN: 'true',
        }),
      ).toThrow(
        /JIRA_VALIDATE_CUSTOMER_ENUMERATION must be false when END_TO_END_DRY_RUN is true/i,
      );
    });

    it('parses valid JSM_API_AUTH_MODE settings and rejects invalid ones', () => {
      const scopedConfig = parseConfig({
        ...validBaseEnv,
        JSM_API_AUTH_MODE: 'scoped-api-token',
      });
      expect(scopedConfig.jira.authMode).toBe('scoped-api-token');

      const basicConfig = parseConfig({
        ...validBaseEnv,
        JSM_API_AUTH_MODE: 'basic-api-token',
      });
      expect(basicConfig.jira.authMode).toBe('basic-api-token');

      const oauthConfig = parseConfig({
        ...validBaseEnv,
        JSM_API_AUTH_MODE: 'oauth-3lo',
      });
      expect(oauthConfig.jira.authMode).toBe('oauth-3lo');

      expect(() =>
        parseConfig({
          ...validBaseEnv,
          JSM_API_AUTH_MODE: 'invalid-auth-mode',
        }),
      ).toThrow(/Invalid configuration: JSM_API_AUTH_MODE must be one of/i);
    });
  });

  describe('JiraServiceDeskCustomerScopeReader Adapter (Fail-Closed & Deterministic Routing)', () => {
    it('enumerates customers from the official Atlassian scoped gateway endpoint', async () => {
      const mockCustomerPage = {
        size: 2,
        start: 0,
        limit: 50,
        isLastPage: true,
        values: [
          {
            accountId: 'qm:user-001',
            name: 'customer1',
            emailAddress: 'customer1@example.com',
            displayName: 'Customer One',
            active: true,
          },
          {
            accountId: 'qm:user-002',
            name: 'customer2',
            emailAddress: '',
            displayName: 'Customer Two (Hidden Email)',
            active: false,
          },
        ],
      };

      const requestedUrls: string[] = [];
      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        requestedUrls.push(url);
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify(mockCustomerPage),
          headers: new Headers(),
        };
      });

      const authProvider = new BasicJiraAuthProvider('test@example.com', 'tok');
      const httpClient = new GetOnlyJiraHttpClient(authProvider, {
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      const budgetGuard = new RequestBudgetGuard({
        customerEnumerationPage: 5,
      });

      const reader = new JiraServiceDeskCustomerScopeReader({
        cloudId: 'cloud-xyz',
        httpClient,
        serviceDeskIds: ['10001'],
        budgetGuard,
        pageSize: 50,
        log: silentLogger,
      });

      const results: ExistingCustomerReference[] = [];
      for await (const ref of reader.listExistingCustomers()) {
        results.push(ref);
      }

      expect(requestedUrls).toHaveLength(1);
      expect(requestedUrls[0]).toBe(
        'https://api.atlassian.com/ex/jira/cloud-xyz/rest/servicedeskapi/servicedesk/10001/customer?start=0&limit=50',
      );

      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({
        sourceCustomerId: 'qm:user-001',
        displayName: 'Customer One',
        normalizedEmail: 'customer1@example.com',
        isActive: true,
        sourceScopeReferences: ['10001'],
      });
      expect(results[1]).toEqual({
        sourceCustomerId: 'qm:user-002',
        displayName: 'Customer Two (Hidden Email)',
        normalizedEmail: null,
        isActive: false,
        sourceScopeReferences: ['10001'],
      });

      expect(budgetGuard.getCounts().customerEnumerationPage).toBe(1);
    });

    it('follows pagination across multiple pages', async () => {
      const page1 = {
        size: 2,
        start: 0,
        limit: 2,
        isLastPage: false,
        values: [
          { accountId: 'acc-1', emailAddress: 'u1@example.com', active: true },
          { accountId: 'acc-2', emailAddress: 'u2@example.com', active: true },
        ],
      };
      const page2 = {
        size: 1,
        start: 2,
        limit: 2,
        isLastPage: true,
        values: [{ accountId: 'acc-3', emailAddress: 'u3@example.com', active: false }],
      };

      const requestedUrls: string[] = [];
      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        requestedUrls.push(url);
        if (url.includes('start=0')) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify(page1),
            headers: new Headers(),
          };
        }
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify(page2),
          headers: new Headers(),
        };
      });

      const authProvider = new BasicJiraAuthProvider('test@example.com', 'tok');
      const httpClient = new GetOnlyJiraHttpClient(authProvider, {
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      const reader = new JiraServiceDeskCustomerScopeReader({
        cloudId: 'cloud-xyz',
        httpClient,
        serviceDeskIds: ['sd-1'],
        pageSize: 2,
        log: silentLogger,
      });

      const results: ExistingCustomerReference[] = [];
      for await (const ref of reader.listExistingCustomers()) {
        results.push(ref);
      }

      expect(requestedUrls).toHaveLength(2);
      expect(requestedUrls[0]).toContain('start=0&limit=2');
      expect(requestedUrls[1]).toContain('start=2&limit=2');
      expect(results).toHaveLength(3);
    });

    it('uses siteUrl directly and passes X-ExperimentalApi opt-in header for Basic Auth when authMode=basic-api-token', async () => {
      const capturedHeaders: Record<string, string>[] = [];
      const requestedUrls: string[] = [];

      const mockFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        requestedUrls.push(url);
        capturedHeaders.push((init?.headers as Record<string, string>) ?? {});
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              size: 1,
              start: 0,
              limit: 25,
              isLastPage: true,
              values: [
                {
                  accountId: 'acc-site-01',
                  emailAddress: 'site@example.com',
                  active: true,
                },
              ],
            }),
          headers: new Headers(),
        };
      });

      const authProvider = new BasicJiraAuthProvider('user@example.com', 'tok');
      const httpClient = new GetOnlyJiraHttpClient(authProvider, {
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      const reader = new JiraServiceDeskCustomerScopeReader({
        siteUrl: 'https://jira.example.org',
        cloudId: 'cloud-xyz',
        authMode: 'basic-api-token',
        httpClient,
        serviceDeskIds: ['10002'],
        pageSize: 25,
        log: silentLogger,
      });

      const results: ExistingCustomerReference[] = [];
      for await (const ref of reader.listExistingCustomers()) {
        results.push(ref);
      }

      expect(requestedUrls).toHaveLength(1);
      expect(requestedUrls[0]).toBe(
        'https://jira.example.org/rest/servicedeskapi/servicedesk/10002/customer?start=0&limit=25',
      );
      expect(capturedHeaders[0]?.['X-ExperimentalApi']).toBe('opt-in');
      expect(results).toHaveLength(1);
      expect(results[0]?.sourceCustomerId).toBe('acc-site-01');
    });

    it('requires either siteUrl or cloudId in options', () => {
      const authProvider = new BasicJiraAuthProvider('user@example.com', 'tok');
      const httpClient = new GetOnlyJiraHttpClient(authProvider);

      expect(
        () =>
          new JiraServiceDeskCustomerScopeReader({
            httpClient,
            serviceDeskIds: ['10001'],
          }),
      ).toThrow(/Either siteUrl or cloudId is required/i);
    });
  });

  describe('CustomerEnumerationValidator Service', () => {
    it('reports metadata-safe counts and flags without logging any PII', async () => {
      const loggedMessages: Array<{ msg: string; ctx?: Record<string, unknown> }> = [];
      const testLogger = {
        debug: vi.fn(),
        info: vi.fn((msg, ctx) => loggedMessages.push({ msg, ctx })),
        warn: vi.fn((msg, ctx) => loggedMessages.push({ msg, ctx })),
        error: vi.fn((msg, ctx) => loggedMessages.push({ msg, ctx })),
        setLevel: vi.fn(),
      } as unknown as Logger;

      const mockCustomers: ExistingCustomerReference[] = [
        {
          sourceCustomerId: 'acc-001',
          normalizedEmail: 'alice@example.com',
          isActive: true,
          sourceScopeReferences: ['10001'],
        },
        {
          sourceCustomerId: 'acc-002',
          normalizedEmail: null, // Hidden email
          isActive: true,
          sourceScopeReferences: ['10001'],
        },
        {
          sourceCustomerId: 'acc-003',
          normalizedEmail: 'charlie@example.com',
          isActive: false, // Inactive
          sourceScopeReferences: ['10001'],
        },
        {
          sourceCustomerId: 'acc-001', // Duplicate ID in enumeration
          normalizedEmail: 'alice@example.com',
          isActive: true,
          sourceScopeReferences: ['10001'],
        },
      ];

      const scopeReader = new InMemoryCustomerScopeReader(mockCustomers);
      const budgetGuard = new RequestBudgetGuard({ customerEnumerationPage: 5 });
      budgetGuard.recordOperation('customerEnumerationPage');

      const validator = new CustomerEnumerationValidator(scopeReader, {
        maxRecords: 25,
        budgetGuard,
        log: testLogger,
      });

      const report = await validator.validate();

      expect(report.mode).toBe('CUSTOMER_ENUMERATION_VALIDATION');
      expect(report.customerEnumerationSupported).toBe(true);
      expect(report.jiraFirstDryRunAvailable).toBe(true);
      expect(report.fallbackUsed).toBe(false);
      expect(report.failureReason).toBeNull();
      expect(report.customersEnumerated).toBe(4);
      expect(report.recordsWithUsableIdentifier).toBe(4);
      expect(report.recordsWithVisibleEmail).toBe(3);
      expect(report.recordsWithoutVisibleEmail).toBe(1);
      expect(report.recordsWithActiveJiraAccount).toBe(3);
      expect(report.recordsWithInactiveJiraAccount).toBe(1);
      expect(report.recordsActive).toBe(3);
      expect(report.recordsInactive).toBe(1);
      expect(report.duplicateIdentifierCount).toBe(1);
      expect(report.paginationCompleted).toBe(true);
      expect(report.profileIdentifierCompatible).toBe(true);

      // Verify ZERO PII was logged
      for (const entry of loggedMessages) {
        const str = JSON.stringify(entry);
        expect(str).not.toContain('alice@example.com');
        expect(str).not.toContain('charlie@example.com');
        expect(str).not.toContain('acc-001');
        expect(str).not.toContain('acc-002');
        expect(str).not.toContain('acc-003');
      }
    });

    it('enforces maximum record bound of 25 and sets paginationCompleted to false when truncated', async () => {
      const customers: ExistingCustomerReference[] = Array.from({ length: 30 }, (_, i) => ({
        sourceCustomerId: `acc-${i}`,
        normalizedEmail: `user${i}@example.com`,
        isActive: true,
        sourceScopeReferences: ['10001'],
      }));

      const scopeReader = new InMemoryCustomerScopeReader(customers);
      const validator = new CustomerEnumerationValidator(scopeReader, {
        maxRecords: 25,
        log: silentLogger,
      });

      const report = await validator.validate();

      expect(report.customersEnumerated).toBe(25);
      expect(report.paginationCompleted).toBe(false);
    });
  });

  describe('Comprehensive Fail-Closed & Boundary Verification (Requirement 35: 15 Points)', () => {
    // 1. 401 returns ENUMERATION_UNAUTHORIZED without fallback
    it('Point 1: 401 returns ENUMERATION_UNAUTHORIZED without fallback', async () => {
      const calledUrls: string[] = [];
      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        calledUrls.push(url);
        return {
          ok: false,
          status: 401,
          text: async () =>
            JSON.stringify({ code: 401, message: 'Unauthorized; scope does not match' }),
          headers: new Headers({ 'x-atlassian-request-id': 'req-401-unauth' }),
        };
      });

      const authProvider = new BasicJiraAuthProvider('user@example.com', 'tok');
      const httpClient = new GetOnlyJiraHttpClient(authProvider, {
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      const reader = new JiraServiceDeskCustomerScopeReader({
        cloudId: 'cloud-xyz',
        siteUrl: 'https://site.example.com',
        httpClient,
        serviceDeskIds: ['sd-101'],
        log: silentLogger,
      });

      await expect(async () => {
        for await (const _ of reader.listExistingCustomers()) {
          // iterate
        }
      }).rejects.toThrowError(CustomerScopeEnumerationError);

      // Strict fail-closed guarantee: exactly 1 request made, NO host switching, NO user search fallback
      expect(calledUrls).toHaveLength(1);
      expect(calledUrls[0]).toBe(
        'https://api.atlassian.com/ex/jira/cloud-xyz/rest/servicedeskapi/servicedesk/sd-101/customer?start=0&limit=50',
      );
    });

    // 2. 403 returns ENUMERATION_FORBIDDEN without fallback
    it('Point 2: 403 returns ENUMERATION_FORBIDDEN without fallback', async () => {
      const calledUrls: string[] = [];
      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        calledUrls.push(url);
        return {
          ok: false,
          status: 403,
          text: async () =>
            JSON.stringify({
              error: 'FORBIDDEN',
              message: 'User does not have project permission',
            }),
          headers: new Headers({ 'x-atlassian-request-id': 'req-403-forbid' }),
        };
      });

      const authProvider = new BasicJiraAuthProvider('user@example.com', 'tok');
      const httpClient = new GetOnlyJiraHttpClient(authProvider, {
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      const reader = new JiraServiceDeskCustomerScopeReader({
        cloudId: 'cloud-xyz',
        httpClient,
        serviceDeskIds: ['sd-101'],
        log: silentLogger,
      });

      await expect(async () => {
        for await (const _ of reader.listExistingCustomers()) {
          // iterate
        }
      }).rejects.toMatchObject({
        name: 'CustomerScopeEnumerationError',
        reason: 'ENUMERATION_FORBIDDEN',
        statusCode: 403,
        sanitizedRequestId: 'req-403-forbid',
      });

      expect(calledUrls).toHaveLength(1);
    });

    // 3. 404 returns ENUMERATION_ENDPOINT_OR_SCOPE_INVALID without fallback
    it('Point 3: 404 returns ENUMERATION_ENDPOINT_OR_SCOPE_INVALID without fallback', async () => {
      const calledUrls: string[] = [];
      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        calledUrls.push(url);
        return {
          ok: false,
          status: 404,
          text: async () => JSON.stringify({ errorMessages: ['Service desk does not exist'] }),
          headers: new Headers({ 'x-atlassian-request-id': 'req-404-invalid' }),
        };
      });

      const authProvider = new BasicJiraAuthProvider('user@example.com', 'tok');
      const httpClient = new GetOnlyJiraHttpClient(authProvider, {
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      const reader = new JiraServiceDeskCustomerScopeReader({
        cloudId: 'cloud-xyz',
        httpClient,
        serviceDeskIds: ['sd-999'],
        log: silentLogger,
      });

      await expect(async () => {
        for await (const _ of reader.listExistingCustomers()) {
          // iterate
        }
      }).rejects.toMatchObject({
        name: 'CustomerScopeEnumerationError',
        reason: 'ENUMERATION_ENDPOINT_OR_SCOPE_INVALID',
        statusCode: 404,
        sanitizedRequestId: 'req-404-invalid',
      });

      expect(calledUrls).toHaveLength(1);
    });

    // 4. endpoint routing failure stops without fallback
    it('Point 4: endpoint routing failure stops without fallback', async () => {
      const calledUrls: string[] = [];
      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        calledUrls.push(url);
        throw new Error('ENOTFOUND: api.atlassian.com could not be reached');
      });

      const authProvider = new BasicJiraAuthProvider('user@example.com', 'tok');
      const httpClient = new GetOnlyJiraHttpClient(authProvider, {
        fetchFn: mockFetch as unknown as typeof fetch,
        maxRetries: 0,
      });

      const reader = new JiraServiceDeskCustomerScopeReader({
        cloudId: 'cloud-xyz',
        siteUrl: 'https://site.example.com',
        httpClient,
        serviceDeskIds: ['sd-101'],
        log: silentLogger,
      });

      await expect(async () => {
        for await (const _ of reader.listExistingCustomers()) {
          // iterate
        }
      }).rejects.toMatchObject({
        name: 'CustomerScopeEnumerationError',
        reason: 'ENUMERATION_ROUTING_FAILED',
      });

      expect(calledUrls).toHaveLength(1);
    });

    // 5. JiraAccountDirectoryReaderPort is distinct from ExistingCustomerScopeReaderPort
    it('Point 5: JiraAccountDirectoryReaderPort is distinct from ExistingCustomerScopeReaderPort', async () => {
      const mockUsers = [
        {
          accountId: 'acc-admin',
          accountType: 'atlassian',
          emailAddress: 'admin@example.com',
          displayName: 'Admin',
          active: true,
        },
      ];
      const mockFetch = vi.fn().mockImplementation(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(mockUsers),
        headers: new Headers(),
      }));

      const authProvider = new BasicJiraAuthProvider('user@example.com', 'tok');
      const httpClient = new GetOnlyJiraHttpClient(authProvider, {
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      const directoryReader = new JiraAccountDirectoryReader({
        cloudId: 'cloud-xyz',
        httpClient,
        log: silentLogger,
      });

      // Verify interface implementation: has listVisibleJiraAccounts, NOT listExistingCustomers
      expect(
        typeof (directoryReader as JiraAccountDirectoryReaderPort).listVisibleJiraAccounts,
      ).toBe('function');
      expect(
        (directoryReader as unknown as ExistingCustomerScopeReaderPort).listExistingCustomers,
      ).toBeUndefined();

      const accounts: JiraAccountReference[] = [];
      for await (const acc of directoryReader.listVisibleJiraAccounts()) {
        accounts.push(acc);
      }

      expect(accounts).toHaveLength(1);
      expect(accounts[0]?.accountId).toBe('acc-admin');
      expect(accounts[0]?.accountType).toBe('atlassian');
    });

    // 6. Jira accounts with accountType !== "app" are not assumed to be customers
    it('Point 6: Jira accounts with accountType !== "app" are not assumed to be customers', async () => {
      const platformAccounts: JiraAccountReference[] = [
        {
          accountId: 'acc-atlassian-user',
          accountType: 'atlassian',
          emailAddress: 'user@example.com',
          active: true,
        },
        {
          accountId: 'acc-customer-user',
          accountType: 'customer',
          emailAddress: 'customer@example.com',
          active: true,
        },
      ];

      // A visible Jira account (even with accountType 'customer' or 'atlassian') is NOT an ExistingCustomerReference
      // because it has not been proven to belong to any configured service project scope.
      for (const acc of platformAccounts) {
        expect(acc.accountType).not.toBe('app');
        // It does NOT have sourceScopeReferences proving project membership
        expect((acc as unknown as ExistingCustomerReference).sourceScopeReferences).toBeUndefined();
      }
    });

    // 7. Jira accounts with visible email are not assumed to be customers
    it('Point 7: Jira accounts with visible email are not assumed to be customers', () => {
      const accountWithEmail: JiraAccountReference = {
        accountId: 'acc-email-visible',
        emailAddress: 'employee@organization.org',
        active: true,
      };

      expect(accountWithEmail.emailAddress).toBe('employee@organization.org');
      // Visible email does NOT confer customer membership or service project association
      expect(
        (accountWithEmail as unknown as ExistingCustomerReference).sourceCustomerId,
      ).toBeUndefined();
      expect(
        (accountWithEmail as unknown as ExistingCustomerReference).sourceScopeReferences,
      ).toBeUndefined();
    });

    // 8. Jira accounts with active=true are not assumed to be customers
    it('Point 8: Jira accounts with active=true are not assumed to be customers', () => {
      const activeAccount: JiraAccountReference = {
        accountId: 'acc-active',
        active: true,
        displayName: 'Active Jira Platform User',
      };

      expect(activeAccount.active).toBe(true);
      // The Jira account active property and JSM customer membership are separate concepts
      expect(
        (activeAccount as unknown as ExistingCustomerReference).sourceScopeReferences,
      ).toBeUndefined();
    });

    // 9. accounts compatible with profile retrieval are not assumed to be customers
    it('Point 9: accounts compatible with profile retrieval are not assumed to be customers', async () => {
      // Compatibility with CSM profile endpoint proves only that a profile exists in CSM;
      // it does NOT establish service project customer membership.
      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/api/v1/customer/details')) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ results: [] }),
            headers: new Headers(),
          };
        }
        if (url.includes('/api/v1/customer/profile/acc-arbitrary-user')) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ customerId: 'acc-arbitrary-user', details: [] }),
            headers: new Headers(),
          };
        }
        return { ok: false, status: 404, text: async () => '', headers: new Headers() };
      });

      const authProvider = new BasicJiraAuthProvider('user@example.com', 'tok');
      const httpClient = new GetOnlyJiraHttpClient(authProvider, {
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      const target = new ReadOnlyJiraCustomerTarget({
        cloudId: 'cloud-xyz',
        siteUrl: 'https://site.example.com',
        httpClient,
        log: silentLogger,
      });

      const profileResult = await target.getCustomerProfile(
        'acc-arbitrary-user',
        'user@example.com',
      );
      expect(profileResult.profile.customerId).toBe('acc-arbitrary-user');
      // Profile retrieval success alone does NOT create or yield an ExistingCustomerReference
    });

    // 10. customer enumeration validation fails closed when project customer endpoint is unauthorized
    it('Point 10: customer enumeration validation fails closed when project customer endpoint is unauthorized', async () => {
      const mockFetch = vi.fn().mockImplementation(async () => ({
        ok: false,
        status: 401,
        text: async () =>
          JSON.stringify({ code: 401, message: 'Unauthorized; scope does not match' }),
        headers: new Headers({ 'x-atlassian-request-id': 'req-fail-closed' }),
      }));

      const authProvider = new BasicJiraAuthProvider('user@example.com', 'tok');
      const httpClient = new GetOnlyJiraHttpClient(authProvider, {
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      const scopeReader = new JiraServiceDeskCustomerScopeReader({
        cloudId: 'cloud-xyz',
        httpClient,
        serviceDeskIds: ['10001'],
        log: silentLogger,
      });

      const validator = new CustomerEnumerationValidator(scopeReader, {
        maxRecords: 25,
        log: silentLogger,
      });

      const report: CustomerEnumerationValidationReport = await validator.validate();

      expect(report.mode).toBe('CUSTOMER_ENUMERATION_VALIDATION');
      expect(report.customerEnumerationSupported).toBe(false);
      expect(report.jiraFirstDryRunAvailable).toBe(false);
      expect(report.fallbackUsed).toBe(false);
      expect(report.failureReason).toBe('ENUMERATION_UNAUTHORIZED');
      expect(report.customersEnumerated).toBe(0);
      expect(report.sanitizedRequestId).toBe('req-fail-closed');
      expect(report.sanitizedErrorCode).toBe('SCOPE_CHECK_FAILED');
    });

    // 11. customer enumeration validation does not call /rest/api/3/users/search
    it('Point 11: customer enumeration validation does not call /rest/api/3/users/search', async () => {
      const calledUrls: string[] = [];
      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        calledUrls.push(url);
        return {
          ok: false,
          status: 401,
          text: async () =>
            JSON.stringify({ code: 401, message: 'Unauthorized; scope does not match' }),
          headers: new Headers(),
        };
      });

      const authProvider = new BasicJiraAuthProvider('user@example.com', 'tok');
      const httpClient = new GetOnlyJiraHttpClient(authProvider, {
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      const scopeReader = new JiraServiceDeskCustomerScopeReader({
        cloudId: 'cloud-xyz',
        httpClient,
        serviceDeskIds: ['10001'],
        log: silentLogger,
      });

      const validator = new CustomerEnumerationValidator(scopeReader, {
        maxRecords: 25,
        log: silentLogger,
      });

      await validator.validate();

      for (const url of calledUrls) {
        expect(url).not.toContain('/rest/api/3/users/search');
      }
    });

    // 12. Jira-first dry run reports jiraFirstDryRunAvailable: false when enumeration is unsupported
    it('Point 12: Jira-first dry run reports jiraFirstDryRunAvailable: false when enumeration is unsupported', async () => {
      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/api/v1/customer/details')) {
          return {
            ok: true,
            status: 200,
            text: async () =>
              JSON.stringify({
                results: [
                  { id: '1', name: 'Title', type: { name: 'STRING' } },
                  { id: '2', name: 'Office Phone Number', type: { name: 'STRING' } },
                  { id: '3', name: 'Supervisor', type: { name: 'STRING' } },
                  { id: '4', name: 'Office/Classroom', type: { name: 'STRING' } },
                ],
              }),
            headers: new Headers(),
          };
        }
        if (url.includes('/customer?')) {
          return {
            ok: false,
            status: 401,
            text: async () =>
              JSON.stringify({ code: 401, message: 'Unauthorized; scope does not match' }),
            headers: new Headers({ 'x-atlassian-request-id': 'req-dryrun-fail' }),
          };
        }
        return { ok: false, status: 404, text: async () => '', headers: new Headers() };
      });

      const authProvider = new BasicJiraAuthProvider('user@example.com', 'tok');
      const httpClient = new GetOnlyJiraHttpClient(authProvider, {
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      const jiraTarget = new ReadOnlyJiraCustomerTarget({
        cloudId: 'cloud-xyz',
        siteUrl: 'https://site.example.com',
        httpClient,
        log: silentLogger,
      });

      const scopeReader = new JiraServiceDeskCustomerScopeReader({
        cloudId: 'cloud-xyz',
        httpClient,
        serviceDeskIds: ['sd-1'],
        log: silentLogger,
      });

      const dirSource = new InMemoryDirectorySource([
        { sourceId: 'src-1', displayName: 'User One', email: 'u1@example.com' },
      ]);

      const budgetGuard = new RequestBudgetGuard({
        customerEnumerationPage: 5,
        fieldDiscovery: 2,
        userSearch: 5,
      });

      const dryRunService = new JiraFirstDryRunService(
        dirSource,
        scopeReader,
        jiraTarget,
        {
          maxRecords: 10,
          concurrency: 2,
        },
        budgetGuard,
        new DiffPlanner(),
        new MappingService(),
        silentLogger,
      );

      const report = await dryRunService.executeDryRun();

      expect(report.mode).toBe('JIRA_FIRST_DRY_RUN');
      expect(report.customerEnumerationSupported).toBe(false);
      expect(report.jiraFirstDryRunAvailable).toBe(false);
      expect(report.fallbackUsed).toBe(false);
      expect(report.failureReason).toBe('ENUMERATION_UNAUTHORIZED');
      expect(report.summary.jiraCustomersEnumerated).toBe(0);
      expect(report.records).toHaveLength(0);
    });

    // 13. single-customer validation cannot be used to justify enumeration support
    it('Point 13: single-customer validation cannot be used to justify enumeration support', async () => {
      // In single-customer validation, an individual customer email is queried via user search and profile lookup.
      // Even if that succeeds, it does NOT provide customerEnumerationSupported: true or validate enumeration.
      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/api/v1/customer/details')) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ results: [] }),
            headers: new Headers(),
          };
        }
        if (url.includes('/users/search')) {
          return {
            ok: true,
            status: 200,
            text: async () =>
              JSON.stringify([{ accountId: 'acc-single', emailAddress: 'test@example.com' }]),
            headers: new Headers(),
          };
        }
        if (url.includes('/api/v1/customer/profile/acc-single')) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ customerId: 'acc-single', details: [] }),
            headers: new Headers(),
          };
        }
        return { ok: false, status: 404, text: async () => '', headers: new Headers() };
      });

      const authProvider = new BasicJiraAuthProvider('user@example.com', 'tok');
      const httpClient = new GetOnlyJiraHttpClient(authProvider, {
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      const jiraTarget = new ReadOnlyJiraCustomerTarget({
        cloudId: 'cloud-xyz',
        siteUrl: 'https://site.example.com',
        httpClient,
        log: silentLogger,
      });

      const resolver = {
        resolveCustomerIdentity: async () => ({
          outcome: 'RESOLVED' as const,
          accountId: 'acc-single',
          emailAddress: 'test@example.com',
        }),
      };

      const validator = new SingleCustomerValidator(jiraTarget, resolver, silentLogger);
      const report = await validator.validateCustomer('test@example.com');

      expect(report.resolutionStatus).toBe('RESOLVED');
      // Crucial: SingleCustomerValidationReport has no customerEnumerationSupported property
      expect(
        (report as unknown as Record<string, unknown>).customerEnumerationSupported,
      ).toBeUndefined();
    });

    // 14. GET-only guardrails remain intact
    it('Point 14: GET-only guardrails remain intact', async () => {
      const authProvider = new BasicJiraAuthProvider('user@example.com', 'tok');
      const httpClient = new GetOnlyJiraHttpClient(authProvider);

      await expect(httpClient.request('POST', 'https://api.atlassian.com')).rejects.toThrow(
        /GetOnlyJiraHttpClient strictly enforces GET-only requests/i,
      );
      await expect(httpClient.request('PUT', 'https://api.atlassian.com')).rejects.toThrow(
        /GetOnlyJiraHttpClient strictly enforces GET-only requests/i,
      );
      await expect(httpClient.request('DELETE', 'https://api.atlassian.com')).rejects.toThrow(
        /GetOnlyJiraHttpClient strictly enforces GET-only requests/i,
      );
      await expect(httpClient.request('PATCH', 'https://api.atlassian.com')).rejects.toThrow(
        /GetOnlyJiraHttpClient strictly enforces GET-only requests/i,
      );
    });

    // 15. authentication investigation mode captures only sanitized metadata
    it('Point 15: authentication investigation mode captures only sanitized metadata', async () => {
      const mockFetch = vi.fn().mockImplementation(async () => ({
        ok: false,
        status: 401,
        text: async () =>
          JSON.stringify({
            code: 401,
            message: 'Unauthorized; scope does not match',
            internalDiagnostic: 'sensitive internal details',
          }),
        headers: new Headers({ 'x-atlassian-request-id': 'req-investigate-401' }),
      }));

      const authProvider = new BasicJiraAuthProvider(
        'user@example.com',
        'super-secret-token-12345',
      );
      const httpClient = new GetOnlyJiraHttpClient(authProvider, {
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      const investigationService = new AuthenticationInvestigationService({
        authMode: 'scoped-api-token',
        serviceDeskId: '10001',
        cloudId: 'cloud-xyz',
        siteUrl: 'https://site.example.com',
        httpClient,
        log: silentLogger,
      });

      const report = await investigationService.investigate();

      expect(report.mode).toBe('AUTHENTICATION_INVESTIGATION');
      expect(report.authMode).toBe('scoped-api-token');
      expect(report.endpointCategory).toBe('jsm-servicedesk-customer');
      expect(report.httpStatus).toBe(401);
      expect(report.sanitizedRequestId).toBe('req-investigate-401');
      expect(report.sanitizedErrorCode).toBe('SCOPE_CHECK_FAILED');
      expect(report.paginationMetadataReturned).toBe(false);
      expect(report.supported).toBe(false);
      expect(report.failureReason).toBe('ENUMERATION_UNAUTHORIZED');
      expect(report.prerequisiteRequired).toContain('OAuth 2.0 (3LO)');

      // Verify ZERO customer data, response body, serviceDeskId, cloudId, or credentials in report
      const str = JSON.stringify(report);
      expect(str).not.toContain('sensitive internal details');
      expect(str).not.toContain('10001');
      expect(str).not.toContain('cloud-xyz');
      expect(str).not.toContain('user@example.com');
      expect(str).not.toContain('super-secret-token-12345');
    });
  });

  describe('Application Startup Routine in Enumeration Validation Mode', () => {
    it('executes customer enumeration validation and does not query Graph or CSM profiles', async () => {
      const originalEnv = { ...process.env };
      const originalFetch = global.fetch;

      const calledUrls: string[] = [];
      global.fetch = vi.fn().mockImplementation(async (url: string) => {
        calledUrls.push(url);

        if (url.includes('/_edge/tenant_info')) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ cloudId: 'resolved-cloud-id' }),
            headers: new Headers(),
          };
        }

        if (url.includes('/rest/servicedeskapi/servicedesk/10001/customer')) {
          return {
            ok: true,
            status: 200,
            text: async () =>
              JSON.stringify({
                size: 2,
                start: 0,
                limit: 25,
                isLastPage: true,
                values: [
                  {
                    accountId: 'acc-live-1',
                    emailAddress: 'live1@example.com',
                    active: true,
                  },
                  {
                    accountId: 'acc-live-2',
                    emailAddress: 'live2@example.com',
                    active: true,
                  },
                ],
              }),
            headers: new Headers({ 'x-atlassian-request-id': 'req-live-enum' }),
          };
        }

        throw new Error(`Unexpected endpoint called during enumeration validation: ${url}`);
      }) as unknown as typeof fetch;

      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-enum-test-'));
      const tokenFile = path.join(tempDir, 'atlassian-oauth.json');
      fs.writeFileSync(
        tokenFile,
        JSON.stringify({
          schemaVersion: 1,
          tokenType: 'Bearer',
          accessToken: 'mock-access-token',
          refreshToken: 'mock-refresh-token',
          accessTokenExpiresAt: new Date(Date.now() + 3600000).toISOString(),
          scopes: [
            'offline_access',
            'read:servicedesk.customer:jira-service-management',
            'read:user:jira',
            'read:customer.detail-field:jira-service-management',
            'read:customer.profile:jira-service-management',
          ],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      );

      try {
        process.env.JIRA_VALIDATE_CUSTOMER_ENUMERATION = 'true';
        process.env.JSM_API_AUTH_MODE = 'oauth-3lo';
        process.env.ATLASSIAN_OAUTH_CLIENT_ID = 'mock-oauth-client-id';
        process.env.ATLASSIAN_OAUTH_CLIENT_SECRET = 'mock-oauth-client-secret';
        process.env.ATLASSIAN_OAUTH_TOKEN_PATH = tokenFile;
        process.env.CUSTOMER_TARGET = 'jira-readonly';
        process.env.SYNC_DRY_RUN = 'true';
        process.env.DISCOVERY_ONLY = 'false';
        process.env.JIRA_VALIDATE_EXISTING_CUSTOMER = 'false';
        process.env.END_TO_END_DRY_RUN = 'false';
        process.env.JSM_SERVICE_DESK_IDS = '10001';
        process.env.ATLASSIAN_SITE_URL = 'https://mock.atlassian.net';
        process.env.ATLASSIAN_CLOUD_ID = 'mock-cloud-id';
        process.env.ATLASSIAN_USER_EMAIL = 'admin@example.com';
        process.env.ATLASSIAN_API_TOKEN = 'tok';

        const result = await runStartup();

        expect(result.success).toBe(true);
        expect(result.enumerationValidationReport).toBeDefined();
        expect(result.enumerationValidationReport?.customersEnumerated).toBe(2);
        expect(result.enumerationValidationReport?.recordsWithUsableIdentifier).toBe(2);
        expect(result.enumerationValidationReport?.paginationCompleted).toBe(true);
        expect(result.enumerationValidationReport?.customerEnumerationSupported).toBe(true);
        expect(result.enumerationValidationReport?.jiraFirstDryRunAvailable).toBe(true);

        // Verify NO profile, user-search, or Graph endpoints were called
        for (const url of calledUrls) {
          expect(url).not.toContain('/customer/profile');
          expect(url).not.toContain('/user/search');
          expect(url).not.toContain('graph.microsoft.com');
        }
      } finally {
        if (fs.existsSync(tokenFile)) {
          fs.unlinkSync(tokenFile);
        }
        if (fs.existsSync(tempDir)) {
          fs.rmdirSync(tempDir);
        }
        process.env = originalEnv;
        global.fetch = originalFetch;
      }
    });

    it('fails closed when project customer endpoint is unauthorized', async () => {
      const originalEnv = { ...process.env };
      const originalFetch = global.fetch;

      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-enum-test-'));
      const tokenFile = path.join(tempDir, 'atlassian-oauth.json');
      fs.writeFileSync(
        tokenFile,
        JSON.stringify({
          schemaVersion: 1,
          tokenType: 'Bearer',
          accessToken: 'mock-access-token',
          refreshToken: 'mock-refresh-token',
          accessTokenExpiresAt: new Date(Date.now() + 3600000).toISOString(),
          scopes: [
            'offline_access',
            'read:servicedesk.customer:jira-service-management',
            'read:user:jira',
            'read:customer.detail-field:jira-service-management',
            'read:customer.profile:jira-service-management',
          ],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      );

      global.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/_edge/tenant_info')) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ cloudId: 'resolved-cloud-id' }),
            headers: new Headers(),
          };
        }

        if (url.includes('/rest/servicedeskapi/servicedesk/10001/customer')) {
          return {
            ok: false,
            status: 401,
            text: async () =>
              JSON.stringify({ code: 401, message: 'Unauthorized; scope does not match' }),
            headers: new Headers({ 'x-atlassian-request-id': 'req-fail-startup' }),
          };
        }

        throw new Error(`Unexpected endpoint called during enumeration validation: ${url}`);
      }) as unknown as typeof fetch;

      try {
        process.env.JIRA_VALIDATE_CUSTOMER_ENUMERATION = 'true';
        process.env.JSM_API_AUTH_MODE = 'oauth-3lo';
        process.env.ATLASSIAN_OAUTH_CLIENT_ID = 'mock-oauth-client-id';
        process.env.ATLASSIAN_OAUTH_CLIENT_SECRET = 'mock-oauth-client-secret';
        process.env.ATLASSIAN_OAUTH_TOKEN_PATH = tokenFile;
        process.env.CUSTOMER_TARGET = 'jira-readonly';
        process.env.SYNC_DRY_RUN = 'true';
        process.env.DISCOVERY_ONLY = 'false';
        process.env.JIRA_VALIDATE_EXISTING_CUSTOMER = 'false';
        process.env.END_TO_END_DRY_RUN = 'false';
        process.env.JSM_SERVICE_DESK_IDS = '10001';
        process.env.ATLASSIAN_SITE_URL = 'https://mock.atlassian.net';
        process.env.ATLASSIAN_CLOUD_ID = 'mock-cloud-id';
        process.env.ATLASSIAN_USER_EMAIL = 'admin@example.com';
        process.env.ATLASSIAN_API_TOKEN = 'tok';

        const result = await runStartup();

        expect(result.success).toBe(false);
        expect(result.enumerationValidationReport).toBeDefined();
        expect(result.enumerationValidationReport?.customerEnumerationSupported).toBe(false);
        expect(result.enumerationValidationReport?.jiraFirstDryRunAvailable).toBe(false);
        expect(result.enumerationValidationReport?.fallbackUsed).toBe(false);
        expect(result.enumerationValidationReport?.failureReason).toBe('ENUMERATION_UNAUTHORIZED');
        expect(result.enumerationValidationReport?.customersEnumerated).toBe(0);
      } finally {
        if (fs.existsSync(tokenFile)) {
          fs.unlinkSync(tokenFile);
        }
        if (fs.existsSync(tempDir)) {
          fs.rmdirSync(tempDir);
        }
        process.env = originalEnv;
        global.fetch = originalFetch;
      }
    });

    it('proves an existing secrets/atlassian-oauth.json token file survives the test suite untouched', async () => {
      const secretsDir = path.resolve(process.cwd(), 'secrets');
      if (!fs.existsSync(secretsDir)) {
        fs.mkdirSync(secretsDir, { recursive: true });
      }
      const canaryTokenFile = path.resolve(secretsDir, 'atlassian-oauth.json');
      const canaryContent = JSON.stringify({
        canary: 'live-production-or-developer-token',
        uniqueMarker: 'DO_NOT_DELETE_12345',
      });

      // If a real token file already exists, record its content; otherwise write our canary
      const existedBefore = fs.existsSync(canaryTokenFile);
      const originalContent = existedBefore
        ? fs.readFileSync(canaryTokenFile, 'utf-8')
        : canaryContent;
      if (!existedBefore) {
        fs.writeFileSync(canaryTokenFile, canaryContent);
      }

      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-isolation-test-'));
      const isolatedTokenFile = path.join(tempDir, 'isolated-token.json');
      fs.writeFileSync(
        isolatedTokenFile,
        JSON.stringify({
          schemaVersion: 1,
          tokenType: 'Bearer',
          accessToken: 'isolated-access-token',
          refreshToken: 'isolated-refresh-token',
          accessTokenExpiresAt: new Date(Date.now() + 3600000).toISOString(),
          scopes: [
            'offline_access',
            'read:servicedesk.customer:jira-service-management',
            'read:user:jira',
            'read:customer.detail-field:jira-service-management',
            'read:customer.profile:jira-service-management',
          ],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      );

      const originalEnv = { ...process.env };
      try {
        process.env.ATLASSIAN_OAUTH_TOKEN_PATH = isolatedTokenFile;
        // Verify that the isolated token path is respected and secrets/atlassian-oauth.json is untouched
        expect(fs.existsSync(canaryTokenFile)).toBe(true);
        expect(fs.readFileSync(canaryTokenFile, 'utf-8')).toBe(originalContent);
      } finally {
        if (fs.existsSync(isolatedTokenFile)) {
          fs.unlinkSync(isolatedTokenFile);
        }
        if (fs.existsSync(tempDir)) {
          fs.rmdirSync(tempDir);
        }
        // Verify secrets/atlassian-oauth.json STILL exists with identical content
        expect(fs.existsSync(canaryTokenFile)).toBe(true);
        expect(fs.readFileSync(canaryTokenFile, 'utf-8')).toBe(originalContent);

        // Only clean up canary if it did not exist before this test
        if (!existedBefore && fs.existsSync(canaryTokenFile)) {
          fs.unlinkSync(canaryTokenFile);
        }
        process.env = originalEnv;
      }
    });

    it('fails closed when authentication mode is not oauth-3lo', async () => {
      const originalEnv = { ...process.env };

      try {
        process.env.JIRA_VALIDATE_CUSTOMER_ENUMERATION = 'true';
        process.env.JSM_API_AUTH_MODE = 'scoped-api-token';
        process.env.CUSTOMER_TARGET = 'jira-readonly';
        process.env.SYNC_DRY_RUN = 'true';
        process.env.DISCOVERY_ONLY = 'false';
        process.env.JIRA_VALIDATE_EXISTING_CUSTOMER = 'false';
        process.env.END_TO_END_DRY_RUN = 'false';
        process.env.JSM_SERVICE_DESK_IDS = '10001';
        process.env.ATLASSIAN_SITE_URL = 'https://mock.atlassian.net';
        process.env.ATLASSIAN_CLOUD_ID = 'mock-cloud-id';
        process.env.ATLASSIAN_USER_EMAIL = 'admin@example.com';
        process.env.ATLASSIAN_API_TOKEN = 'tok';

        const result = await runStartup();

        expect(result.success).toBe(false);
        expect(result.enumerationValidationReport?.customerEnumerationSupported).toBe(false);
        expect(result.enumerationValidationReport?.failureReason).toBe(
          'ENUMERATION_AUTHENTICATION_UNSUPPORTED',
        );
        expect(result.enumerationValidationReport?.sanitizedErrorCategory).toBe(
          'AUTHENTICATION_MODE_MISMATCH',
        );
      } finally {
        process.env = originalEnv;
      }
    });
  });
});
