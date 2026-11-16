import { describe, it, expect, vi } from 'vitest';
import { SingleCustomerValidator, SyncService } from '../src/services';
import {
  ReadOnlyJiraCustomerTarget,
  RequestBudgetGuard,
  RequestBudgetExceededError,
  DiscoveredFieldReport,
  BasicJiraAuthProvider,
  GetOnlyJiraHttpClient,
  JiraUserSearchResolver,
} from '../src/connectors/jira';
import { EntraDirectorySource } from '../src/connectors/entra';
import { CustomerIdentityResolverPort } from '../src/domain';
import { InMemoryDirectorySource, InMemoryCustomerTarget } from '../src/connectors/memory';
import { parseConfig, getSanitizedConfig } from '../src/config';
import { Logger, logger } from '../src/utils/logger';
import { runStartup } from '../src/index';

describe('Single Existing-Customer Validation', () => {
  const silentLogger = new Logger('test-single-customer', 'error');

  const mockFieldReport: DiscoveredFieldReport = {
    fields: [
      { id: 'Title', name: 'Title', typeName: 'TEXT', required: false },
      {
        id: 'Office Phone Number',
        name: 'Office Phone Number',
        typeName: 'PHONE',
        required: false,
      },
      {
        id: 'Supervisor',
        name: 'Supervisor',
        typeName: 'TEXT',
        required: false,
      },
      {
        id: 'Office/Classroom',
        name: 'Office/Classroom',
        typeName: 'TEXT',
        required: false,
      },
    ],
    fieldCount: 4,
    matchedDomainFields: {
      title: 'Title',
      officePhoneNumber: 'Office Phone Number',
      supervisor: 'Supervisor',
      officeClassroom: 'Office/Classroom',
    },
    missingDomainFields: [],
    ambiguousDomainFields: {},
    unmappedFields: [],
    unknownTypes: ['PHONE'],
  };

  describe('SingleCustomerValidator Service', () => {
    it('successfully validates resolved customer and retrieves profile exactly once', async () => {
      const mockTarget = {
        discoverFields: vi.fn().mockResolvedValue(mockFieldReport),
        getCustomerProfile: vi.fn().mockResolvedValue({
          profile: {
            customerId: 'jira-acc-001',
            displayName: 'Test User',
            email: 'test.customer@example.com',
            details: [
              { id: 'Title', value: 'Senior Engineer' },
              { id: 'Office Phone Number', value: '+1-555-0199' },
              { id: 'Supervisor', value: 'Jane Boss' },
              { id: 'Office/Classroom', value: 'Suite 400' },
            ],
          },
          customerDetails: {
            email: 'test.customer@example.com',
            title: 'Senior Engineer',
            officePhoneNumber: '+1-555-0199',
            supervisor: 'Jane Boss',
            officeClassroom: 'Suite 400',
          },
          requestId: 'req-atlassian-valid-001',
        }),
      } as unknown as ReadOnlyJiraCustomerTarget;

      const mockResolver: CustomerIdentityResolverPort = {
        resolveCustomerIdentity: vi.fn().mockResolvedValue({
          outcome: 'RESOLVED',
          accountId: 'jira-acc-001',
          emailAddress: 'test.customer@example.com',
          displayName: 'Test User',
        }),
      };

      const validator = new SingleCustomerValidator(mockTarget, mockResolver, silentLogger);

      const report = await validator.validateCustomer('TEST.CUSTOMER@EXAMPLE.COM');

      expect(report.resolutionStatus).toBe('RESOLVED');
      expect(report.profileRetrievalStatus).toBe('RETRIEVED');
      expect(report.correlationReference).toMatch(/^ref-[a-f0-9]{10}$/);
      expect(report.atlassianRequestId).toBe('req-atlassian-valid-001');
      expect(report.populatedMappedFieldCount).toBe(4);
      expect(report.emptyMappedFieldCount).toBe(0);
      expect(report.mappedDomainFieldNames).toEqual([
        'title',
        'officePhoneNumber',
        'supervisor',
        'officeClassroom',
      ]);

      expect(mockTarget.discoverFields).toHaveBeenCalledTimes(1);
      expect(mockResolver.resolveCustomerIdentity).toHaveBeenCalledWith(
        'test.customer@example.com',
      );
      expect(mockTarget.getCustomerProfile).toHaveBeenCalledTimes(1);
      expect(mockTarget.getCustomerProfile).toHaveBeenCalledWith(
        'jira-acc-001',
        'test.customer@example.com',
      );
    });

    it('skips profile retrieval when customer is NOT_FOUND', async () => {
      const mockTarget = {
        discoverFields: vi.fn().mockResolvedValue(mockFieldReport),
        getCustomerProfile: vi.fn(),
      } as unknown as ReadOnlyJiraCustomerTarget;

      const mockResolver: CustomerIdentityResolverPort = {
        resolveCustomerIdentity: vi.fn().mockResolvedValue({
          outcome: 'NOT_FOUND',
          reason: 'No user found matching email address query',
        }),
      };

      const validator = new SingleCustomerValidator(mockTarget, mockResolver, silentLogger);

      const report = await validator.validateCustomer('nonexistent@example.com');

      expect(report.resolutionStatus).toBe('NOT_FOUND');
      expect(report.profileRetrievalStatus).toBe('SKIPPED');
      expect(report.resolutionReason).toContain('No user found');
      expect(report.populatedMappedFieldCount).toBe(0);
      expect(mockTarget.getCustomerProfile).not.toHaveBeenCalled();
    });

    it('skips profile retrieval when resolution is AMBIGUOUS', async () => {
      const mockTarget = {
        discoverFields: vi.fn().mockResolvedValue(mockFieldReport),
        getCustomerProfile: vi.fn(),
      } as unknown as ReadOnlyJiraCustomerTarget;

      const mockResolver: CustomerIdentityResolverPort = {
        resolveCustomerIdentity: vi.fn().mockResolvedValue({
          outcome: 'AMBIGUOUS',
          reason: 'Multiple active accounts (2) matched',
          candidateCount: 2,
        }),
      };

      const validator = new SingleCustomerValidator(mockTarget, mockResolver, silentLogger);

      const report = await validator.validateCustomer('duplicate@example.com');

      expect(report.resolutionStatus).toBe('AMBIGUOUS');
      expect(report.profileRetrievalStatus).toBe('SKIPPED');
      expect(report.resolutionReason).toContain('Multiple active accounts');
      expect(mockTarget.getCustomerProfile).not.toHaveBeenCalled();
    });

    it('skips profile retrieval when email is EMAIL_UNAVAILABLE', async () => {
      const mockTarget = {
        discoverFields: vi.fn().mockResolvedValue(mockFieldReport),
        getCustomerProfile: vi.fn(),
      } as unknown as ReadOnlyJiraCustomerTarget;

      const mockResolver: CustomerIdentityResolverPort = {
        resolveCustomerIdentity: vi.fn().mockResolvedValue({
          outcome: 'EMAIL_UNAVAILABLE',
          reason: 'Candidate user returned but emailAddress is hidden',
        }),
      };

      const validator = new SingleCustomerValidator(mockTarget, mockResolver, silentLogger);

      const report = await validator.validateCustomer('hidden@example.com');

      expect(report.resolutionStatus).toBe('EMAIL_UNAVAILABLE');
      expect(report.profileRetrievalStatus).toBe('SKIPPED');
      expect(mockTarget.getCustomerProfile).not.toHaveBeenCalled();
    });

    it('skips profile retrieval if resolved record has empty accountId', async () => {
      const mockTarget = {
        discoverFields: vi.fn().mockResolvedValue(mockFieldReport),
        getCustomerProfile: vi.fn(),
      } as unknown as ReadOnlyJiraCustomerTarget;

      const mockResolver: CustomerIdentityResolverPort = {
        resolveCustomerIdentity: vi.fn().mockResolvedValue({
          outcome: 'RESOLVED',
          accountId: '   ', // Blank account ID
          emailAddress: 'user@example.com',
        }),
      };

      const validator = new SingleCustomerValidator(mockTarget, mockResolver, silentLogger);

      const report = await validator.validateCustomer('user@example.com');

      expect(report.resolutionStatus).toBe('NOT_FOUND');
      expect(report.profileRetrievalStatus).toBe('SKIPPED');
      expect(mockTarget.getCustomerProfile).not.toHaveBeenCalled();
    });

    it('handles profile retrieval error safely without crashing', async () => {
      const mockTarget = {
        discoverFields: vi.fn().mockResolvedValue(mockFieldReport),
        getCustomerProfile: vi.fn().mockRejectedValue(new Error('500 Internal Server Error')),
      } as unknown as ReadOnlyJiraCustomerTarget;

      const mockResolver: CustomerIdentityResolverPort = {
        resolveCustomerIdentity: vi.fn().mockResolvedValue({
          outcome: 'RESOLVED',
          accountId: 'jira-acc-002',
          emailAddress: 'error@example.com',
        }),
      };

      const validator = new SingleCustomerValidator(mockTarget, mockResolver, silentLogger);

      const report = await validator.validateCustomer('error@example.com');

      expect(report.resolutionStatus).toBe('RESOLVED');
      expect(report.profileRetrievalStatus).toBe('FAILED');
      expect(report.resolutionReason).toContain('500 Internal Server Error');
      expect(report.populatedMappedFieldCount).toBe(0);
    });

    it('never includes raw email address or customer name in log records', async () => {
      const logEntries: Array<{ message: string; context?: unknown }> = [];
      const capturingLogger = {
        debug: (message: string, context?: unknown) => logEntries.push({ message, context }),
        info: (message: string, context?: unknown) => logEntries.push({ message, context }),
        warn: (message: string, context?: unknown) => logEntries.push({ message, context }),
        error: (message: string, context?: unknown) => logEntries.push({ message, context }),
      } as unknown as Logger;

      const sensitiveEmail = 'sensitive.executive@example.org';
      const sensitiveName = 'Sensitive Executive';
      const sensitiveAccountId = 'jira-account-id-sensitive-999';

      const mockTarget = {
        discoverFields: vi.fn().mockResolvedValue(mockFieldReport),
        getCustomerProfile: vi.fn().mockResolvedValue({
          profile: {
            customerId: sensitiveAccountId,
            displayName: sensitiveName,
            email: sensitiveEmail,
            details: [],
          },
          customerDetails: {
            email: sensitiveEmail,
            title: 'Executive Director',
            officePhoneNumber: null,
            supervisor: null,
            officeClassroom: null,
          },
          requestId: 'req-safe-123',
        }),
      } as unknown as ReadOnlyJiraCustomerTarget;

      const mockResolver: CustomerIdentityResolverPort = {
        resolveCustomerIdentity: vi.fn().mockResolvedValue({
          outcome: 'RESOLVED',
          accountId: sensitiveAccountId,
          emailAddress: sensitiveEmail,
          displayName: sensitiveName,
        }),
      };

      const validator = new SingleCustomerValidator(mockTarget, mockResolver, capturingLogger);

      await validator.validateCustomer(sensitiveEmail);

      const serializedLogs = JSON.stringify(logEntries);
      expect(serializedLogs).not.toContain(sensitiveEmail);
      expect(serializedLogs).not.toContain(sensitiveName);
      expect(serializedLogs).not.toContain(sensitiveAccountId);
      expect(serializedLogs).not.toContain('Executive Director');
    });
  });

  describe('RequestBudgetGuard', () => {
    it('allows operations within configured budget', () => {
      const guard = new RequestBudgetGuard({
        userSearch: 1,
        customerProfile: 1,
      });

      expect(() => guard.recordOperation('userSearch')).not.toThrow();
      expect(guard.getCounts().userSearch).toBe(1);

      expect(() => guard.recordOperation('customerProfile')).not.toThrow();
      expect(guard.getCounts().customerProfile).toBe(1);
    });

    it('throws RequestBudgetExceededError when operation exceeds limit', () => {
      const guard = new RequestBudgetGuard({
        userSearch: 1,
      });

      guard.recordOperation('userSearch');

      expect(() => guard.recordOperation('userSearch')).toThrow(RequestBudgetExceededError);
      expect(() => guard.recordOperation('userSearch')).toThrow(
        /Request budget exceeded for operation 'userSearch'/,
      );
    });

    it('enforces default limit of 1 if not specified', () => {
      const guard = new RequestBudgetGuard();

      guard.recordOperation('cloudIdDiscovery');
      expect(() => guard.recordOperation('cloudIdDiscovery')).toThrow(RequestBudgetExceededError);
    });
  });

  describe('Configuration Rules for Single-Customer Validation Mode', () => {
    const validBaseEnv = {
      JIRA_SITE_URL: 'https://myorg.atlassian.net',
      JIRA_USER_EMAIL: 'service@myorg.com',
      JIRA_API_TOKEN: 'api-token-xyz',
      JIRA_VALIDATE_EXISTING_CUSTOMER: 'true',
      CUSTOMER_TARGET: 'jira-readonly',
      SYNC_DRY_RUN: 'true',
      DISCOVERY_ONLY: 'false',
      JIRA_TEST_CUSTOMER_EMAIL: 'target.user@myorg.com',
    };

    it('parses valid single customer validation configuration', () => {
      const config = parseConfig(validBaseEnv);
      expect(config.sync.validateExistingCustomer).toBe(true);
      expect(config.sync.customerTarget).toBe('jira-readonly');
      expect(config.sync.dryRun).toBe(true);
      expect(config.sync.discoveryOnly).toBe(false);
      expect(config.sync.testCustomerEmail).toBe('target.user@myorg.com');
    });

    it('rejects configuration when JIRA_TEST_CUSTOMER_EMAIL is missing', () => {
      const env = { ...validBaseEnv };
      delete (env as Record<string, string | undefined>).JIRA_TEST_CUSTOMER_EMAIL;

      expect(() => parseConfig(env)).toThrow(/JIRA_TEST_CUSTOMER_EMAIL is required/);
    });

    it('rejects configuration when JIRA_TEST_CUSTOMER_EMAIL is invalid email format', () => {
      const env = {
        ...validBaseEnv,
        JIRA_TEST_CUSTOMER_EMAIL: 'not-an-email-address',
      };

      expect(() => parseConfig(env)).toThrow(/must be a syntactically valid email address/);
    });

    it('rejects configuration when SYNC_DRY_RUN is false in validation mode', () => {
      const env = {
        ...validBaseEnv,
        SYNC_DRY_RUN: 'false',
      };

      expect(() => parseConfig(env)).toThrow(
        /Safety violation: Write mode is prohibited in single-customer validation/,
      );
    });

    it('rejects configuration when CUSTOMER_TARGET is not jira-readonly', () => {
      const env = {
        ...validBaseEnv,
        CUSTOMER_TARGET: 'memory',
      };

      expect(() => parseConfig(env)).toThrow(/CUSTOMER_TARGET must be 'jira-readonly'/);
    });

    it('rejects configuration when DISCOVERY_ONLY is true', () => {
      const env = {
        ...validBaseEnv,
        DISCOVERY_ONLY: 'true',
      };

      expect(() => parseConfig(env)).toThrow(/DISCOVERY_ONLY must be false/);
    });

    it('masks JIRA_TEST_CUSTOMER_EMAIL in getSanitizedConfig', () => {
      const config = parseConfig(validBaseEnv);
      const sanitized = getSanitizedConfig(config);

      const serialized = JSON.stringify(sanitized);
      expect(serialized).not.toContain('target.user@myorg.com');
      expect((sanitized.sync as Record<string, unknown>).testCustomerEmail).toBe('ta***@myorg.com');
    });
  });

  describe('Application Startup Routine in Single Customer Mode', () => {
    it('executes single customer validation and does not query Graph or run sync summary', async () => {
      const originalValidate = process.env.JIRA_VALIDATE_EXISTING_CUSTOMER;
      const originalTarget = process.env.CUSTOMER_TARGET;
      const originalDryRun = process.env.SYNC_DRY_RUN;
      const originalDiscovery = process.env.DISCOVERY_ONLY;
      const originalEmail = process.env.JIRA_TEST_CUSTOMER_EMAIL;
      const originalCloudId = process.env.ATLASSIAN_CLOUD_ID;
      const originalAuthMode = process.env.JSM_API_AUTH_MODE;
      const originalFetch = global.fetch;

      try {
        process.env.JIRA_VALIDATE_EXISTING_CUSTOMER = 'true';
        process.env.CUSTOMER_TARGET = 'jira-readonly';
        process.env.SYNC_DRY_RUN = 'true';
        process.env.DISCOVERY_ONLY = 'false';
        process.env.JIRA_TEST_CUSTOMER_EMAIL = 'verified.customer@example.com';
        process.env.ATLASSIAN_CLOUD_ID = 'cloud-test-id-123';
        process.env.JSM_API_AUTH_MODE = 'scoped-api-token';

        const mockFields = {
          results: [
            { id: 'Title', name: 'Title', type: { name: 'STRING' } },
            {
              id: 'Office Phone Number',
              name: 'Office Phone Number',
              type: { name: 'STRING' },
            },
            {
              id: 'Supervisor',
              name: 'Supervisor',
              type: { name: 'STRING' },
            },
            {
              id: 'Office/Classroom',
              name: 'Office/Classroom',
              type: { name: 'STRING' },
            },
          ],
        };

        const mockUserSearch = [
          {
            accountId: 'acc-verified-999',
            displayName: 'Verified Customer',
            emailAddress: 'verified.customer@example.com',
            active: true,
          },
        ];

        const mockProfile = {
          customerId: 'acc-verified-999',
          displayName: 'Verified Customer',
          email: 'verified.customer@example.com',
          details: [
            { id: 'Title', value: 'Software Architect' },
            { id: 'Office Phone Number', value: '+1-555-4321' },
            { id: 'Supervisor', value: 'Jane Director' },
            { id: 'Office/Classroom', value: 'Room 101' },
          ],
        };

        global.fetch = vi.fn().mockImplementation(async (url: string) => {
          // Never call Graph or non-GET endpoints
          expect(url).not.toContain('graph.microsoft.com');

          if (url.includes('/api/v1/customer/details')) {
            return {
              ok: true,
              status: 200,
              text: async () => JSON.stringify(mockFields),
              headers: new Headers({ 'x-atlassian-request-id': 'req-fields' }),
            };
          }
          if (url.includes('/rest/servicedeskapi/servicedesk/')) {
            return {
              ok: true,
              status: 200,
              text: async () =>
                JSON.stringify({
                  size: mockUserSearch.length,
                  start: 0,
                  limit: 50,
                  isLastPage: true,
                  values: mockUserSearch,
                }),
              headers: new Headers({ 'x-atlassian-request-id': 'req-search' }),
            };
          }
          if (url.includes('/rest/api/3/user/search')) {
            return {
              ok: true,
              status: 200,
              text: async () => JSON.stringify(mockUserSearch),
              headers: new Headers({ 'x-atlassian-request-id': 'req-search' }),
            };
          }
          if (url.includes('/api/v1/customer/profile/acc-verified-999')) {
            return {
              ok: true,
              status: 200,
              text: async () => JSON.stringify(mockProfile),
              headers: new Headers({ 'x-atlassian-request-id': 'req-profile' }),
            };
          }
          throw new Error(`Unexpected URL in test: ${url}`);
        }) as unknown as typeof fetch;

        const result = await runStartup();

        expect(result.success).toBe(true);
        expect(result.singleCustomerReport).toBeDefined();
        expect(result.singleCustomerReport?.resolutionStatus).toBe('RESOLVED');
        expect(result.singleCustomerReport?.profileRetrievalStatus).toBe('RETRIEVED');
        expect(result.singleCustomerReport?.populatedMappedFieldCount).toBeGreaterThanOrEqual(1);
        // Summary must not be present
        expect(result.summary).toBeUndefined();
      } finally {
        process.env.JIRA_VALIDATE_EXISTING_CUSTOMER = originalValidate;
        process.env.CUSTOMER_TARGET = originalTarget;
        process.env.SYNC_DRY_RUN = originalDryRun;
        process.env.DISCOVERY_ONLY = originalDiscovery;
        process.env.JIRA_TEST_CUSTOMER_EMAIL = originalEmail;
        process.env.ATLASSIAN_CLOUD_ID = originalCloudId;
        if (originalAuthMode !== undefined) {
          process.env.JSM_API_AUTH_MODE = originalAuthMode;
        } else {
          delete process.env.JSM_API_AUTH_MODE;
        }
        global.fetch = originalFetch;
      }
    });
  });

  describe('Security, Gateway, and Privacy Assurances', () => {
    const authProvider = new BasicJiraAuthProvider('test@user.com', 'token');
    const silentTestLogger = new Logger('test-assurances', 'error');

    it('the site URL never appears in logs', async () => {
      const logEntries: Array<{ message: string; context?: unknown }> = [];
      const capturingLogger = {
        debug: (message: string, context?: unknown) => logEntries.push({ message, context }),
        info: (message: string, context?: unknown) => logEntries.push({ message, context }),
        warn: (message: string, context?: unknown) => logEntries.push({ message, context }),
        error: (message: string, context?: unknown) => logEntries.push({ message, context }),
      } as unknown as Logger;

      const secretSiteUrl = 'https://confidential-tenant-123.atlassian.net';

      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/_edge/tenant_info')) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ cloudId: 'resolved-cloud-id' }),
            headers: new Headers(),
          };
        }
        if (url.includes('/api/v1/customer/details')) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ results: [] }),
            headers: new Headers(),
          };
        }
        throw new Error(`Unexpected URL: ${url}`);
      });

      const httpClient = new GetOnlyJiraHttpClient(authProvider, {
        fetchFn: mockFetch as unknown as typeof fetch,
        log: capturingLogger,
      });

      const dummyResolver = {
        resolveCustomerIdentity: vi.fn(),
      };

      const target = new ReadOnlyJiraCustomerTarget({
        siteUrl: secretSiteUrl,
        httpClient,
        identityResolver: dummyResolver,
        log: capturingLogger,
      });

      await target.discoverFields();

      const serializedLogs = JSON.stringify(logEntries);
      expect(serializedLogs).not.toContain('confidential-tenant-123');
      expect(serializedLogs).not.toContain(secretSiteUrl);
    });

    it('the full sanitized configuration is not logged and boolean readiness indicators are used', async () => {
      const originalValidate = process.env.JIRA_VALIDATE_EXISTING_CUSTOMER;
      const originalTarget = process.env.CUSTOMER_TARGET;
      const originalDryRun = process.env.SYNC_DRY_RUN;
      const originalDiscovery = process.env.DISCOVERY_ONLY;
      const originalEmail = process.env.JIRA_TEST_CUSTOMER_EMAIL;
      const originalCloudId = process.env.ATLASSIAN_CLOUD_ID;
      const originalAuthMode = process.env.JSM_API_AUTH_MODE;
      const originalFetch = global.fetch;

      const logEntries: Array<{
        message: string;
        context?: Record<string, unknown>;
      }> = [];
      const spyInfo = vi.spyOn(logger, 'info').mockImplementation((msg, ctx) => {
        logEntries.push({
          message: msg,
          context: ctx as Record<string, unknown>,
        });
      });

      try {
        process.env.JIRA_VALIDATE_EXISTING_CUSTOMER = 'true';
        process.env.CUSTOMER_TARGET = 'jira-readonly';
        process.env.SYNC_DRY_RUN = 'true';
        process.env.DISCOVERY_ONLY = 'false';
        process.env.JIRA_TEST_CUSTOMER_EMAIL = 'valid.user@example.com';
        process.env.ATLASSIAN_CLOUD_ID = 'cloud-id-abc';
        process.env.JSM_API_AUTH_MODE = 'scoped-api-token';

        global.fetch = vi.fn().mockImplementation(async (url: string) => {
          if (url.includes('/api/v1/customer/details')) {
            return {
              ok: true,
              status: 200,
              text: async () => JSON.stringify({ results: [] }),
              headers: new Headers(),
            };
          }
          if (
            url.includes('/rest/api/3/user/search') ||
            url.includes('/rest/servicedeskapi/servicedesk/')
          ) {
            return {
              ok: true,
              status: 200,
              text: async () => JSON.stringify({ size: 0, values: [] }),
              headers: new Headers(),
            };
          }
          throw new Error(`Unexpected url: ${url}`);
        }) as unknown as typeof fetch;

        await runStartup();

        const startupLog = logEntries.find((e) =>
          e.message.includes('Application started successfully'),
        );
        expect(startupLog).toBeDefined();

        // Must not contain full config object
        expect(startupLog?.context?.config).toBeUndefined();

        // Must contain boolean readiness indicators
        expect(typeof startupLog?.context?.jiraConfigured).toBe('boolean');
        expect(typeof startupLog?.context?.cloudIdConfigured).toBe('boolean');
        expect(typeof startupLog?.context?.authenticationConfigured).toBe('boolean');
        expect(typeof startupLog?.context?.entraConfigured).toBe('boolean');
        expect(typeof startupLog?.context?.dryRun).toBe('boolean');
        expect(typeof startupLog?.context?.directorySource).toBe('string');
        expect(typeof startupLog?.context?.customerTarget).toBe('string');
        expect(typeof startupLog?.context?.discoveryOnly).toBe('boolean');
        expect(typeof startupLog?.context?.validateExistingCustomer).toBe('boolean');
      } finally {
        spyInfo.mockRestore();
        process.env.JIRA_VALIDATE_EXISTING_CUSTOMER = originalValidate;
        process.env.CUSTOMER_TARGET = originalTarget;
        process.env.SYNC_DRY_RUN = originalDryRun;
        process.env.DISCOVERY_ONLY = originalDiscovery;
        process.env.JIRA_TEST_CUSTOMER_EMAIL = originalEmail;
        process.env.ATLASSIAN_CLOUD_ID = originalCloudId;
        if (originalAuthMode !== undefined) {
          process.env.JSM_API_AUTH_MODE = originalAuthMode;
        } else {
          delete process.env.JSM_API_AUTH_MODE;
        }
        global.fetch = originalFetch;
      }
    });

    it('masked customer emails are not logged in synchronization or resolution logs', async () => {
      const logEntries: Array<{ message: string; context?: unknown }> = [];
      const capturingLogger = {
        debug: (message: string, context?: unknown) => logEntries.push({ message, context }),
        info: (message: string, context?: unknown) => logEntries.push({ message, context }),
        warn: (message: string, context?: unknown) => logEntries.push({ message, context }),
        error: (message: string, context?: unknown) => logEntries.push({ message, context }),
      } as unknown as Logger;

      const people = [
        {
          sourceId: 'dir-1',
          displayName: 'Alice',
          email: 'alice.secret@company.org',
          jobTitle: 'Engineer',
        },
      ];
      const customers = [
        {
          email: 'alice.secret@company.org',
          title: 'Junior',
          officePhoneNumber: null,
          supervisor: null,
          officeClassroom: null,
        },
      ];

      const dirSource = new InMemoryDirectorySource(people);
      const custTarget = new InMemoryCustomerTarget(customers);
      const syncService = new SyncService(
        dirSource,
        custTarget,
        custTarget,
        undefined,
        capturingLogger,
      );

      await syncService.executeSync({ dryRun: true });
      await syncService.executeSync({ dryRun: false });

      const serializedLogs = JSON.stringify(logEntries);
      expect(serializedLogs).not.toContain('maskedEmail');
      expect(serializedLogs).not.toContain('al***@company.org');
      expect(serializedLogs).not.toContain('alice.secret@company.org');
      expect(serializedLogs).toContain('customerRef');
    });

    it('user search uses the api.atlassian.com Jira gateway and does not use site URL', async () => {
      let requestedUrl = '';
      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        requestedUrl = url;
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify([]),
          headers: new Headers(),
        };
      });

      const httpClient = new GetOnlyJiraHttpClient(authProvider, {
        fetchFn: mockFetch as unknown as typeof fetch,
        log: silentTestLogger,
      });

      const resolver = new JiraUserSearchResolver({
        cloudId: 'test-cloud-id-gateway',
        httpClient,
        log: silentTestLogger,
      });

      await resolver.resolveCustomerIdentity('search.user@domain.com');

      expect(requestedUrl).toMatch(
        /^https:\/\/api\.atlassian\.com\/ex\/jira\/test-cloud-id-gateway\/rest\/api\/3\/user\/search/,
      );
      expect(requestedUrl).not.toContain('https://mysite.atlassian.net');
    });

    it('user search includes the resolved Cloud ID', async () => {
      let requestedUrl = '';
      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        requestedUrl = url;
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify([]),
          headers: new Headers(),
        };
      });

      const httpClient = new GetOnlyJiraHttpClient(authProvider, {
        fetchFn: mockFetch as unknown as typeof fetch,
        log: silentTestLogger,
      });

      const resolver = new JiraUserSearchResolver({
        cloudId: () => Promise.resolve('dynamic-resolved-cloud-777'),
        httpClient,
        log: silentTestLogger,
      });

      await resolver.resolveCustomerIdentity('target@domain.com');

      expect(requestedUrl).toContain('/ex/jira/dynamic-resolved-cloud-777/rest/api/3/user/search');
    });

    it('CSM requests continue using the CSM gateway', async () => {
      const requestedUrls: string[] = [];
      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        requestedUrls.push(url);
        if (url.includes('/api/v1/customer/details')) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ results: [] }),
            headers: new Headers(),
          };
        }
        if (url.includes('/api/v1/customer/profile')) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ customerId: 'acc-123', details: [] }),
            headers: new Headers(),
          };
        }
        throw new Error(`Unexpected url: ${url}`);
      });

      const httpClient = new GetOnlyJiraHttpClient(authProvider, {
        fetchFn: mockFetch as unknown as typeof fetch,
        log: silentTestLogger,
      });

      const target = new ReadOnlyJiraCustomerTarget({
        cloudId: 'csm-cloud-gateway-888',
        siteUrl: 'https://mysite.atlassian.net',
        httpClient,
        identityResolver: { resolveCustomerIdentity: vi.fn() },
        log: silentTestLogger,
      });

      await target.discoverFields();
      await target.getCustomerProfile('acc-123', 'user@test.com');

      expect(requestedUrls[0]).toBe(
        'https://api.atlassian.com/jsm/csm/cloudid/csm-cloud-gateway-888/api/v1/customer/details',
      );
      expect(requestedUrls[1]).toBe(
        'https://api.atlassian.com/jsm/csm/cloudid/csm-cloud-gateway-888/api/v1/customer/profile/acc-123',
      );
    });

    it('no production log contains the Cloud ID', async () => {
      const logEntries: Array<{ message: string; context?: unknown }> = [];
      const capturingLogger = {
        debug: (message: string, context?: unknown) => logEntries.push({ message, context }),
        info: (message: string, context?: unknown) => logEntries.push({ message, context }),
        warn: (message: string, context?: unknown) => logEntries.push({ message, context }),
        error: (message: string, context?: unknown) => logEntries.push({ message, context }),
      } as unknown as Logger;

      const secretCloudId = 'secret-cloud-identifier-xyz-999';

      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/api/v1/customer/details')) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ results: [] }),
            headers: new Headers(),
          };
        }
        if (url.includes('/rest/api/3/user/search')) {
          return {
            ok: true,
            status: 200,
            text: async () =>
              JSON.stringify([
                {
                  accountId: 'acc-1',
                  emailAddress: 'test@domain.com',
                  active: true,
                },
              ]),
            headers: new Headers(),
          };
        }
        if (url.includes('/api/v1/customer/profile')) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ customerId: 'acc-1', details: [] }),
            headers: new Headers(),
          };
        }
        throw new Error(`Unexpected url: ${url}`);
      });

      const httpClient = new GetOnlyJiraHttpClient(authProvider, {
        fetchFn: mockFetch as unknown as typeof fetch,
        log: capturingLogger,
      });

      const resolver = new JiraUserSearchResolver({
        cloudId: secretCloudId,
        httpClient,
        log: capturingLogger,
      });

      const target = new ReadOnlyJiraCustomerTarget({
        cloudId: secretCloudId,
        siteUrl: 'https://placeholder.atlassian.net',
        httpClient,
        identityResolver: resolver,
        log: capturingLogger,
      });

      const validator = new SingleCustomerValidator(target, resolver, capturingLogger);

      await validator.validateCustomer('test@domain.com');

      const serializedLogs = JSON.stringify(logEntries);
      expect(serializedLogs).not.toContain(secretCloudId);
    });

    it('validation mode never constructs or invokes the real Entra adapter', async () => {
      const originalValidate = process.env.JIRA_VALIDATE_EXISTING_CUSTOMER;
      const originalTarget = process.env.CUSTOMER_TARGET;
      const originalDryRun = process.env.SYNC_DRY_RUN;
      const originalDiscovery = process.env.DISCOVERY_ONLY;
      const originalEmail = process.env.JIRA_TEST_CUSTOMER_EMAIL;
      const originalCloudId = process.env.ATLASSIAN_CLOUD_ID;
      const originalSource = process.env.DIRECTORY_SOURCE;
      const originalAuthMode = process.env.JSM_API_AUTH_MODE;
      const originalFetch = global.fetch;

      const entraSpy = vi.spyOn(EntraDirectorySource.prototype, 'getPeople');

      try {
        process.env.JIRA_VALIDATE_EXISTING_CUSTOMER = 'true';
        process.env.CUSTOMER_TARGET = 'jira-readonly';
        process.env.SYNC_DRY_RUN = 'true';
        process.env.DISCOVERY_ONLY = 'false';
        process.env.JIRA_TEST_CUSTOMER_EMAIL = 'valid.user@example.com';
        process.env.ATLASSIAN_CLOUD_ID = 'cloud-id-test';
        process.env.DIRECTORY_SOURCE = 'entra'; // Even if DIRECTORY_SOURCE=entra
        process.env.JSM_API_AUTH_MODE = 'scoped-api-token';

        global.fetch = vi.fn().mockImplementation(async (url: string) => {
          expect(url).not.toContain('graph.microsoft.com');
          if (url.includes('/api/v1/customer/details')) {
            return {
              ok: true,
              status: 200,
              text: async () => JSON.stringify({ results: [] }),
              headers: new Headers(),
            };
          }
          if (
            url.includes('/rest/api/3/user/search') ||
            url.includes('/rest/servicedeskapi/servicedesk/')
          ) {
            return {
              ok: true,
              status: 200,
              text: async () => JSON.stringify({ size: 0, values: [] }),
              headers: new Headers(),
            };
          }
          throw new Error(`Unexpected url: ${url}`);
        }) as unknown as typeof fetch;

        const result = await runStartup();

        expect(result.success).toBe(false);
        expect(result.singleCustomerReport).toBeDefined();
        expect(result.singleCustomerReport?.resolutionStatus).toBe('NOT_FOUND');
        expect(entraSpy).not.toHaveBeenCalled();
      } finally {
        entraSpy.mockRestore();
        process.env.JIRA_VALIDATE_EXISTING_CUSTOMER = originalValidate;
        process.env.CUSTOMER_TARGET = originalTarget;
        process.env.SYNC_DRY_RUN = originalDryRun;
        process.env.DISCOVERY_ONLY = originalDiscovery;
        process.env.JIRA_TEST_CUSTOMER_EMAIL = originalEmail;
        process.env.ATLASSIAN_CLOUD_ID = originalCloudId;
        process.env.DIRECTORY_SOURCE = originalSource;
        if (originalAuthMode !== undefined) {
          process.env.JSM_API_AUTH_MODE = originalAuthMode;
        } else {
          delete process.env.JSM_API_AUTH_MODE;
        }
        global.fetch = originalFetch;
      }
    });
  });
});
