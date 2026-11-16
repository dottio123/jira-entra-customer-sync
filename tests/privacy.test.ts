import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import { hashIdentifier, maskEmail, extractSanitizedErrorCode } from '../src/utils/privacy';
import { Logger } from '../src/utils/logger';
import {
  JsmServiceDeskCustomerResolver,
  JiraHttpError,
  BasicJiraAuthProvider,
  GetOnlyJiraHttpClient,
  RequestBudgetGuard,
  ReadOnlyJiraCustomerTarget,
  DiscoveredFieldReport,
} from '../src/connectors/jira';
import { JiraFirstDryRunService, DiffPlanner, MappingService } from '../src/services';
import { InMemoryDirectorySource, InMemoryCustomerScopeReader } from '../src/connectors/memory';
import { EntraDirectorySource, IGraphClient } from '../src/connectors/entra';
import { CustomerIdentityResolverPort } from '../src/domain';
import { runStartup } from '../src';

describe('Privacy, Pseudonymity, and Sensitive Marker Sanitization (Requirement 1, 4, 6)', () => {
  const SYNTHETIC_BEARER_TOKEN = 'Bearer ATATT3xFfGF0jE5mVJLS1FvuRj9bkBBL5Z6SY_SECRET';
  const SYNTHETIC_CLIENT_SECRET = 'SUPER_SECRET_CLIENT_KEY_987654321';
  const SYNTHETIC_CUSTOMER_EMAIL = 'sensitive.pilot.user@classified-domain.org';
  const SYNTHETIC_RAW_NAME = 'Classified Director Name';
  const SYNTHETIC_PASSWORD = 'super-secret-password-1234';
  const SYNTHETIC_GRAPH_MESSAGE = 'Graph Internal Access Token: secret-graph-token-xyz';
  const SYNTHETIC_EXCEPTION_MSG = 'Fatal DB connection leaked token: db-token-9999';

  let logMessages: string[] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;

  beforeEach(() => {
    logMessages = [];
    console.log = (msg: string) => {
      logMessages.push(msg);
    };
    console.warn = (msg: string) => {
      logMessages.push(msg);
    };
    console.error = (msg: string) => {
      logMessages.push(msg);
    };
  });

  afterEach(() => {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  });

  describe('Identifier Pseudonymization & Email Masking', () => {
    it('produces deterministic 10-hex truncated SHA-256 pseudonymous references', () => {
      const ref1 = hashIdentifier(SYNTHETIC_CUSTOMER_EMAIL);
      const ref2 = hashIdentifier(SYNTHETIC_CUSTOMER_EMAIL);
      const ref3 = hashIdentifier(SYNTHETIC_CUSTOMER_EMAIL.toUpperCase());

      expect(ref1).toBe(ref2);
      expect(ref1).toBe(ref3);
      expect(ref1).toMatch(/^ref-[a-f0-9]{10}$/);
      expect(ref1).not.toContain('sensitive');
      expect(ref1).not.toContain('classified-domain');
    });

    it('returns anon-00000000 for empty or whitespace identifiers', () => {
      expect(hashIdentifier(null)).toBe('anon-00000000');
      expect(hashIdentifier(undefined)).toBe('anon-00000000');
      expect(hashIdentifier('')).toBe('anon-00000000');
      expect(hashIdentifier('   ')).toBe('anon-00000000');
    });

    it('safely masks email addresses preserving only domain and up to 2 leading chars', () => {
      expect(maskEmail('alex.smith@example.com')).toBe('al***@example.com');
      expect(maskEmail('a@example.com')).toBe('*@example.com');
      expect(maskEmail('')).toBe('(empty)');
    });

    it('extractSanitizedErrorCode allows only safe tokens and maps recognized categories', () => {
      expect(extractSanitizedErrorCode({ code: 'INVALID_REQUEST' })).toBe('INVALID_REQUEST');
      expect(extractSanitizedErrorCode({ error: 'UNAUTHORIZED_CLIENT' })).toBe(
        'UNAUTHORIZED_CLIENT',
      );
      expect(extractSanitizedErrorCode({ errorMessages: ['OAuth scope check failed'] })).toBe(
        'SCOPE_CHECK_FAILED',
      );
      expect(extractSanitizedErrorCode({ message: 'User unauthorized' })).toBe('UNAUTHORIZED');
      // Rejects arbitrary text or sensitive tokens
      expect(extractSanitizedErrorCode({ code: 'Arbitrary message with spaces' })).toBeUndefined();
      expect(extractSanitizedErrorCode({ error: SYNTHETIC_BEARER_TOKEN })).toBeUndefined();
    });
  });

  describe('Synthetic Markers in Jira HTTP Response Bodies & Customer Resolver', () => {
    it('omits response body tokens, passwords, and raw emails from logs and resolution result', async () => {
      const testLogger = new Logger('test-resolver-privacy', 'debug');

      const mockFetch = vi.fn().mockImplementation(async () => {
        return {
          ok: false,
          status: 401,
          headers: new Headers({ 'x-atlassian-request-id': 'req-safe-401' }),
          text: async () =>
            JSON.stringify({
              error: 'AUTHENTICATION_DENIED',
              message: `Failed for ${SYNTHETIC_CUSTOMER_EMAIL} using token ${SYNTHETIC_BEARER_TOKEN}`,
              details: {
                secret: SYNTHETIC_CLIENT_SECRET,
                password: SYNTHETIC_PASSWORD,
                name: SYNTHETIC_RAW_NAME,
              },
            }),
        };
      });

      const authProvider = new BasicJiraAuthProvider('user@example.com', 'tok');
      const httpClient = new GetOnlyJiraHttpClient(authProvider, {
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      const resolver = new JsmServiceDeskCustomerResolver({
        authMode: 'oauth-3lo',
        cloudId: 'cloud-privacy-123',
        serviceDeskIds: ['sd-1'],
        httpClient,
        log: testLogger,
      });

      const result = await resolver.resolveCustomerIdentity(SYNTHETIC_CUSTOMER_EMAIL);
      expect(result.outcome).toBe('ERROR');

      const resultStr = JSON.stringify(result);
      expect(resultStr).not.toContain(SYNTHETIC_BEARER_TOKEN);
      expect(resultStr).not.toContain(SYNTHETIC_CLIENT_SECRET);
      expect(resultStr).not.toContain(SYNTHETIC_CUSTOMER_EMAIL);
      expect(resultStr).not.toContain(SYNTHETIC_PASSWORD);
      expect(resultStr).not.toContain(SYNTHETIC_RAW_NAME);

      const allLogs = logMessages.join('\n');
      expect(allLogs).not.toContain(SYNTHETIC_BEARER_TOKEN);
      expect(allLogs).not.toContain(SYNTHETIC_CLIENT_SECRET);
      expect(allLogs).not.toContain(SYNTHETIC_CUSTOMER_EMAIL);
      expect(allLogs).not.toContain(SYNTHETIC_PASSWORD);
      expect(allLogs).not.toContain(SYNTHETIC_RAW_NAME);

      // Verify sanitized structured metadata is present
      expect(allLogs).toContain('req-safe-401');
      expect(allLogs).toContain('401');
      expect(allLogs).toContain('AUTHENTICATION_DENIED');
    });

    it('omits ordinary exception messages from resolver logs and resolution reason', async () => {
      const testLogger = new Logger('test-resolver-exception-privacy', 'debug');

      const authProvider = new BasicJiraAuthProvider('user@example.com', 'tok');
      const httpClient = new GetOnlyJiraHttpClient(authProvider);
      vi.spyOn(httpClient, 'get').mockRejectedValue(new Error(SYNTHETIC_EXCEPTION_MSG));

      const resolver = new JsmServiceDeskCustomerResolver({
        authMode: 'oauth-3lo',
        cloudId: 'cloud-privacy-123',
        serviceDeskIds: ['sd-1'],
        httpClient,
        log: testLogger,
      });

      const result = await resolver.resolveCustomerIdentity(SYNTHETIC_CUSTOMER_EMAIL);
      expect(result.outcome).toBe('ERROR');

      const resultStr = JSON.stringify(result);
      expect(resultStr).not.toContain(SYNTHETIC_EXCEPTION_MSG);

      const allLogs = logMessages.join('\n');
      expect(allLogs).not.toContain(SYNTHETIC_EXCEPTION_MSG);
      expect(allLogs).toContain('CUSTOMER_QUERY_FAILED');
    });
  });

  describe('Synthetic Markers in Microsoft Graph Error Messages', () => {
    it('omits raw Graph error messages from logs and DirectoryPerson model', async () => {
      const testLogger = new Logger('test-graph-privacy', 'debug');

      const mockGraphClient = {
        getUsers: vi.fn().mockResolvedValue({
          value: [
            {
              id: 'user-graph-1',
              displayName: SYNTHETIC_RAW_NAME,
              mail: SYNTHETIC_CUSTOMER_EMAIL,
              accountEnabled: true,
            },
          ],
        }),
        getManager: vi.fn().mockRejectedValue({
          statusCode: 500,
          code: 'InternalServerError',
          message: SYNTHETIC_GRAPH_MESSAGE,
          innerError: { 'request-id': 'graph-req-safe-999' },
        }),
      };

      const source = new EntraDirectorySource(mockGraphClient as unknown as IGraphClient, {
        log: testLogger,
        maxRetries: 0,
      });

      const people = await source.getPeople();
      expect(people).toHaveLength(1);
      const person = people[0]!;

      expect(person.managerLookupStatus).toBe('LOOKUP_FAILED');
      expect(person.managerLookupError).not.toContain(SYNTHETIC_GRAPH_MESSAGE);

      const allLogs = logMessages.join('\n');
      expect(allLogs).not.toContain(SYNTHETIC_GRAPH_MESSAGE);
      expect(allLogs).toContain('GRAPH_MANAGER_LOOKUP_FAILED');
      expect(allLogs).toContain('graph-req-safe-999');
    });
  });

  describe('Synthetic Markers in Profile-Retrieval Errors & Persisted Reports', () => {
    it('omits sensitive tokens and emails from dry-run summary, records, and persisted report file', async () => {
      const testLogger = new Logger('test-pilot-privacy', 'debug');

      const mockDiscoveryReport: DiscoveredFieldReport = {
        fields: [
          { id: 'field-title', name: 'Title', typeName: 'STRING', required: false },
          { id: 'field-phone', name: 'Office Phone Number', typeName: 'STRING', required: false },
          { id: 'field-supervisor', name: 'Supervisor', typeName: 'STRING', required: false },
          { id: 'field-office', name: 'Office/Classroom', typeName: 'STRING', required: false },
        ],
        fieldCount: 4,
        matchedDomainFields: {
          title: 'field-title',
          officePhoneNumber: 'field-phone',
          supervisor: 'field-supervisor',
          officeClassroom: 'field-office',
        },
        missingDomainFields: [],
        ambiguousDomainFields: {},
        unmappedFields: [],
        unknownTypes: [],
      };

      const testReportPath = 'reports/test-privacy-leak-check.json';
      if (fs.existsSync(testReportPath)) {
        fs.unlinkSync(testReportPath);
      }

      const dirSource = new InMemoryDirectorySource([
        {
          sourceId: 'src-1',
          displayName: SYNTHETIC_RAW_NAME,
          email: SYNTHETIC_CUSTOMER_EMAIL,
          jobTitle: 'Engineer',
          officePhone: '+1-555-0100',
          supervisorName: 'Super Visor',
          officeLocation: 'HQ Room 10',
          managerLookupStatus: 'RESOLVED',
        },
      ]);

      const scopeReader = new InMemoryCustomerScopeReader([]);

      const mockTarget = {
        discoverFields: vi.fn().mockResolvedValue(mockDiscoveryReport),
        getCustomerProfile: vi.fn().mockImplementation(async () => {
          throw new JiraHttpError(
            `Internal Error communicating with database for token ${SYNTHETIC_CLIENT_SECRET}`,
            500,
            'req-err-500',
            { secret: SYNTHETIC_CLIENT_SECRET, rawUser: SYNTHETIC_CUSTOMER_EMAIL },
          );
        }),
        ensureCloudId: vi.fn().mockResolvedValue('cloud-safe-123'),
      } as unknown as ReadOnlyJiraCustomerTarget;

      const mockResolver = {
        resolveCustomerIdentity: vi.fn().mockResolvedValue({
          outcome: 'RESOLVED',
          accountId: 'acc-safe-1',
          emailAddress: SYNTHETIC_CUSTOMER_EMAIL,
          displayName: SYNTHETIC_RAW_NAME,
          verifiedServiceDeskIds: ['1'],
        }),
      };

      const service = new JiraFirstDryRunService(
        dirSource,
        scopeReader,
        mockTarget,
        {
          maxRecords: 1,
          concurrency: 1,
          pilotMode: true,
          pilotCustomerEmail: SYNTHETIC_CUSTOMER_EMAIL,
          reportPath: testReportPath,
        },
        new RequestBudgetGuard({ global: 50, userSearch: 10, customerProfile: 10 }),
        new DiffPlanner(),
        new MappingService(),
        testLogger,
        mockResolver as unknown as CustomerIdentityResolverPort,
      );

      const report = await service.executeDryRun();

      let persistedContent = '';
      if (report.reportPath && fs.existsSync(report.reportPath)) {
        persistedContent = fs.readFileSync(report.reportPath, 'utf-8');
        fs.unlinkSync(report.reportPath);
      }

      const reportJson = JSON.stringify(report);

      // Verify report object omits raw sensitive markers
      expect(reportJson).not.toContain(SYNTHETIC_CUSTOMER_EMAIL);
      expect(reportJson).not.toContain(SYNTHETIC_CLIENT_SECRET);
      expect(reportJson).not.toContain(SYNTHETIC_RAW_NAME);

      // Verify persisted file omits raw sensitive markers
      if (persistedContent) {
        expect(persistedContent).not.toContain(SYNTHETIC_CUSTOMER_EMAIL);
        expect(persistedContent).not.toContain(SYNTHETIC_CLIENT_SECRET);
        expect(persistedContent).not.toContain(SYNTHETIC_RAW_NAME);
      }

      // Verify logs omit raw sensitive markers
      const allLogs = logMessages.join('\n');
      expect(allLogs).not.toContain(SYNTHETIC_CUSTOMER_EMAIL);
      expect(allLogs).not.toContain(SYNTHETIC_CLIENT_SECRET);
      expect(allLogs).not.toContain(SYNTHETIC_RAW_NAME);

      // Verify correlation reference is used
      const expectedHash = hashIdentifier(SYNTHETIC_CUSTOMER_EMAIL);
      expect(reportJson).toContain(expectedHash);
      expect(allLogs).toContain(expectedHash);
    });
  });

  describe('Synthetic Markers in Top-Level Startup Error Handler', () => {
    it('omits raw error response bodies and tokens from startup error logs', async () => {
      // Simulate startup throwing a JiraHttpError containing sensitive tokens in responseBody
      const originalEnv = { ...process.env };
      process.env.JSM_API_AUTH_MODE = 'scoped-api-token';
      process.env.JSM_API_TOKEN = 'test-token';
      process.env.JSM_USER_EMAIL = 'test@example.com';
      process.env.JIRA_SITE_URL = 'https://test.atlassian.net';
      process.env.ATLASSIAN_CLOUD_ID = 'cloud-startup-123';
      process.env.JSM_SERVICE_DESK_IDS = '1';
      process.env.DIRECTORY_SOURCE = 'memory';
      process.env.CUSTOMER_TARGET = 'jira-readonly';
      process.env.DISCOVERY_ONLY = 'true';
      delete process.env.JIRA_INVESTIGATE_AUTH;

      const mockFetch = vi.fn().mockImplementation(async () => {
        return {
          ok: false,
          status: 403,
          headers: new Headers({ 'x-atlassian-request-id': 'req-startup-403' }),
          text: async () =>
            JSON.stringify({
              error: 'FORBIDDEN_SCOPE',
              token: SYNTHETIC_BEARER_TOKEN,
              secret: SYNTHETIC_CLIENT_SECRET,
            }),
        };
      });

      // Temporarily mock global fetch
      const originalGlobalFetch = global.fetch;
      global.fetch = mockFetch as unknown as typeof fetch;

      try {
        await expect(runStartup()).rejects.toThrow();

        const allLogs = logMessages.join('\n');
        expect(allLogs).not.toContain(SYNTHETIC_BEARER_TOKEN);
        expect(allLogs).not.toContain(SYNTHETIC_CLIENT_SECRET);
        expect(allLogs).toContain('req-startup-403');
        expect(allLogs).toContain('403');
        expect(allLogs).toContain('FORBIDDEN_SCOPE');
      } finally {
        global.fetch = originalGlobalFetch;
        process.env = originalEnv;
      }
    });
  });
});
