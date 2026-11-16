import { USER_AGENT } from '../src/version';
import { describe, it, expect, vi } from 'vitest';
import {
  BasicJiraAuthProvider,
  GetOnlyJiraHttpClient,
  JiraUserSearchResolver,
  ReadOnlyJiraCustomerTarget,
  JiraUserSearchResult,
  DetailFieldsResponse,
  CustomerAccountProfile,
} from '../src/connectors/jira';
import { CustomerIdentityResolverPort } from '../src/domain';
import { Logger } from '../src/utils/logger';

describe('Jira Customer Service Management Connector', () => {
  const silentLogger = new Logger('test-jira', 'error');

  describe('BasicJiraAuthProvider', () => {
    it('generates correct Basic auth header from user email and api token', async () => {
      const authProvider = new BasicJiraAuthProvider(
        'sync-user@example.com',
        'api-token-secret-123',
      );
      const header = await authProvider.getAuthHeader();

      const expectedCredentials = Buffer.from(
        'sync-user@example.com:api-token-secret-123',
      ).toString('base64');
      expect(header).toBe(`Basic ${expectedCredentials}`);
    });

    it('throws if email or token is empty or whitespace', () => {
      expect(() => new BasicJiraAuthProvider('', 'token')).toThrow(/user email is required/i);
      expect(() => new BasicJiraAuthProvider('user@example.com', '   ')).toThrow(
        /api token is required/i,
      );
    });

    it('does not leak secret token in error message', () => {
      try {
        new BasicJiraAuthProvider('', 'super-secret-api-token');
      } catch (err: unknown) {
        expect(String(err)).not.toContain('super-secret-api-token');
      }
    });
  });

  describe('GetOnlyJiraHttpClient', () => {
    const authProvider = new BasicJiraAuthProvider('user@test.com', 'secret');

    it('strictly rejects non-GET HTTP requests', async () => {
      const client = new GetOnlyJiraHttpClient(authProvider, {
        log: silentLogger,
      });

      await expect(client.request('POST', 'https://api.atlassian.com/test')).rejects.toThrow(
        /strictly enforces GET-only requests.*POST/i,
      );

      await expect(client.request('PUT', 'https://api.atlassian.com/test')).rejects.toThrow(
        /strictly enforces GET-only requests.*PUT/i,
      );

      await expect(client.request('DELETE', 'https://api.atlassian.com/test')).rejects.toThrow(
        /strictly enforces GET-only requests.*DELETE/i,
      );
    });

    it('executes successful GET request and attaches required headers and parses JSON', async () => {
      let capturedUrl = '';
      let capturedHeaders: Record<string, string> = {};

      const mockFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        capturedUrl = url;
        capturedHeaders = (init?.headers as Record<string, string>) || {};
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ hello: 'world' }),
          headers: new Headers({
            'content-type': 'application/json',
            'x-atlassian-request-id': 'req-12345',
          }),
        };
      });

      const client = new GetOnlyJiraHttpClient(authProvider, {
        fetchFn: mockFetch as unknown as typeof fetch,
        log: silentLogger,
      });

      const response = await client.get<{ hello: string }>('https://api.atlassian.com/hello');

      expect(response.status).toBe(200);
      expect(response.data).toEqual({ hello: 'world' });
      expect(response.requestId).toBe('req-12345');
      expect(capturedUrl).toBe('https://api.atlassian.com/hello');
      expect(capturedHeaders['Accept']).toBe('application/json');
      expect(capturedHeaders['User-Agent']).toBe(USER_AGENT);
      expect(capturedHeaders['Authorization']).toMatch(/^Basic /);
    });

    it('retries on 429 throttling and honors Retry-After header', async () => {
      let callCount = 0;
      const sleepDelays: number[] = [];

      const mockFetch = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            ok: false,
            status: 429,
            json: async () => ({ message: 'Rate limit exceeded' }),
            headers: new Headers({
              'retry-after': '2',
              'x-atlassian-request-id': 'req-throttle',
            }),
          };
        }
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ success: true }),
          headers: new Headers({ 'x-atlassian-request-id': 'req-success' }),
        };
      });

      const mockSleep = vi.fn().mockImplementation(async (ms: number) => {
        sleepDelays.push(ms);
      });

      const client = new GetOnlyJiraHttpClient(authProvider, {
        fetchFn: mockFetch as unknown as typeof fetch,
        sleepFn: mockSleep,
        log: silentLogger,
      });

      const res = await client.get<{ success: boolean }>('https://api.atlassian.com/throttle');

      expect(res.status).toBe(200);
      expect(res.data).toEqual({ success: true });
      expect(callCount).toBe(2);
      expect(sleepDelays).toHaveLength(1);
      expect(sleepDelays[0]).toBe(2000); // 2 seconds from Retry-After
    });

    it('retries on 503 transient error and respects maxRetries', async () => {
      let callCount = 0;
      const mockFetch = vi.fn().mockImplementation(async () => {
        callCount++;
        return {
          ok: false,
          status: 503,
          json: async () => ({ error: 'Service Unavailable' }),
          headers: new Headers(),
        };
      });

      const mockSleep = vi.fn().mockResolvedValue(undefined);

      const client = new GetOnlyJiraHttpClient(authProvider, {
        fetchFn: mockFetch as unknown as typeof fetch,
        sleepFn: mockSleep,
        maxRetries: 2,
        retryDelayMs: 10,
        log: silentLogger,
      });

      await expect(client.get('https://api.atlassian.com/503')).rejects.toThrow(
        /Jira API request failed with status 503/,
      );

      // Initial call + 2 retries = 3 calls total
      expect(callCount).toBe(3);
    });

    it('does NOT retry permanent errors (400, 401, 403, 404)', async () => {
      const permanentCodes = [400, 401, 403, 404];

      for (const code of permanentCodes) {
        let callCount = 0;
        const mockFetch = vi.fn().mockImplementation(async () => {
          callCount++;
          return {
            ok: false,
            status: code,
            json: async () => ({ error: 'Permanent error' }),
            headers: new Headers(),
          };
        });

        const client = new GetOnlyJiraHttpClient(authProvider, {
          fetchFn: mockFetch as unknown as typeof fetch,
          maxRetries: 3,
          log: silentLogger,
        });

        await expect(client.get('https://api.atlassian.com/error')).rejects.toThrow(
          new RegExp(`Jira API request failed with status ${code}`),
        );

        // Permanent error must NOT be retried
        expect(callCount).toBe(1);
      }
    });
  });

  describe('JiraUserSearchResolver', () => {
    const authProvider = new BasicJiraAuthProvider('user@test.com', 'secret');

    it('rejects fuzzy results and returns NOT_FOUND', async () => {
      const fuzzyUser: JiraUserSearchResult = {
        accountId: 'acc-fuzzy',
        displayName: 'Bob Jones',
        emailAddress: 'bobby.jones@otherdomain.com', // Fuzzy match, different email
        active: true,
      };

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify([fuzzyUser]),
        headers: new Headers(),
      });

      const httpClient = new GetOnlyJiraHttpClient(authProvider, {
        fetchFn: mockFetch as unknown as typeof fetch,
        log: silentLogger,
      });

      const resolver = new JiraUserSearchResolver({
        cloudId: 'cloud-uuid-999',
        httpClient,
        log: silentLogger,
      });

      const result = await resolver.resolveCustomerIdentity('bob.jones@exactdomain.com');

      expect(result.outcome).toBe('NOT_FOUND');
      expect((result as { reason: string }).reason).toMatch(/fuzzy results rejected/i);
    });

    it('accepts exact normalized email match for active user', async () => {
      const matchedUser: JiraUserSearchResult = {
        accountId: 'acc-exact-123',
        displayName: 'Carol Danvers',
        emailAddress: 'carol.danvers@example.com',
        active: true,
      };

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify([matchedUser]),
        headers: new Headers(),
      });

      const httpClient = new GetOnlyJiraHttpClient(authProvider, {
        fetchFn: mockFetch as unknown as typeof fetch,
        log: silentLogger,
      });

      const resolver = new JiraUserSearchResolver({
        siteUrl: 'https://mysite.atlassian.net',
        httpClient,
        log: silentLogger,
      });

      // Whitespace and uppercase in query normalized
      const result = await resolver.resolveCustomerIdentity('  CAROL.DANVERS@EXAMPLE.COM  ');

      expect(result.outcome).toBe('RESOLVED');
      if (result.outcome === 'RESOLVED') {
        expect(result.accountId).toBe('acc-exact-123');
        expect(result.emailAddress).toBe('carol.danvers@example.com');
        expect(result.displayName).toBe('Carol Danvers');
      }
    });

    it('returns EMAIL_UNAVAILABLE if candidate email is missing or hidden', async () => {
      const hiddenEmailUser: JiraUserSearchResult = {
        accountId: 'acc-hidden',
        displayName: 'Private User',
        emailAddress: undefined, // Hidden by Atlassian privacy settings
        active: true,
      };

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify([hiddenEmailUser]),
        headers: new Headers(),
      });

      const httpClient = new GetOnlyJiraHttpClient(authProvider, {
        fetchFn: mockFetch as unknown as typeof fetch,
        log: silentLogger,
      });

      const resolver = new JiraUserSearchResolver({
        siteUrl: 'https://mysite.atlassian.net',
        httpClient,
        log: silentLogger,
      });

      const result = await resolver.resolveCustomerIdentity('private.user@example.com');

      expect(result.outcome).toBe('EMAIL_UNAVAILABLE');
      expect((result as { reason: string }).reason).toMatch(/emailAddress is missing or hidden/i);
    });

    it('rejects inactive accounts and returns NOT_FOUND', async () => {
      const inactiveUser: JiraUserSearchResult = {
        accountId: 'acc-inactive',
        displayName: 'Former Employee',
        emailAddress: 'former@example.com',
        active: false, // Inactive
      };

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify([inactiveUser]),
        headers: new Headers(),
      });

      const httpClient = new GetOnlyJiraHttpClient(authProvider, {
        fetchFn: mockFetch as unknown as typeof fetch,
        log: silentLogger,
      });

      const resolver = new JiraUserSearchResolver({
        siteUrl: 'https://mysite.atlassian.net',
        httpClient,
        log: silentLogger,
      });

      const result = await resolver.resolveCustomerIdentity('former@example.com');

      expect(result.outcome).toBe('NOT_FOUND');
      expect((result as { reason: string }).reason).toMatch(/account is inactive/i);
    });

    it('returns AMBIGUOUS outcome when multiple active accounts match exact email', async () => {
      const duplicates: JiraUserSearchResult[] = [
        {
          accountId: 'acc-dup-1',
          displayName: 'Duplicate User 1',
          emailAddress: 'shared@example.com',
          active: true,
        },
        {
          accountId: 'acc-dup-2',
          displayName: 'Duplicate User 2',
          emailAddress: 'shared@example.com',
          active: true,
        },
      ];

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(duplicates),
        headers: new Headers(),
      });

      const httpClient = new GetOnlyJiraHttpClient(authProvider, {
        fetchFn: mockFetch as unknown as typeof fetch,
        log: silentLogger,
      });

      const resolver = new JiraUserSearchResolver({
        siteUrl: 'https://mysite.atlassian.net',
        httpClient,
        log: silentLogger,
      });

      const result = await resolver.resolveCustomerIdentity('shared@example.com');

      expect(result.outcome).toBe('AMBIGUOUS');
      expect((result as { candidateCount?: number }).candidateCount).toBe(2);
      expect((result as { reason: string }).reason).toMatch(/multiple active accounts/i);
    });
  });

  describe('ReadOnlyJiraCustomerTarget', () => {
    const authProvider = new BasicJiraAuthProvider('user@test.com', 'secret');

    it('field discovery succeeds, maps domain fields, and accepts unknown field types', async () => {
      const mockFieldsResponse: DetailFieldsResponse = {
        results: [
          {
            id: 'f-title',
            name: 'Title',
            type: { name: 'STRING' },
            required: false,
          },
          {
            id: 'f-phone',
            name: 'Office Phone Number',
            type: { name: 'PHONE_UNKNOWN_CUSTOM' }, // Unknown type
            required: false,
          },
          {
            id: 'f-super',
            name: 'Supervisor',
            type: { name: 'USER_CUSTOM_TYPE' }, // Unknown type
            required: false,
          },
          {
            id: 'f-office',
            name: 'Office/Classroom',
            type: { name: 'ROOM_PICKER_SPECIAL' }, // Unknown type
            required: false,
          },
          {
            id: 'f-email',
            name: 'Email Address',
            type: { name: 'STRING' },
            required: false,
          },
        ],
      };

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(mockFieldsResponse),
        headers: new Headers(),
      });

      const httpClient = new GetOnlyJiraHttpClient(authProvider, {
        fetchFn: mockFetch as unknown as typeof fetch,
        log: silentLogger,
      });

      const dummyResolver: CustomerIdentityResolverPort = {
        resolveCustomerIdentity: vi.fn(),
      };

      const target = new ReadOnlyJiraCustomerTarget({
        cloudId: 'cloud-uuid-999',
        siteUrl: 'https://mysite.atlassian.net',
        httpClient,
        identityResolver: dummyResolver,
        log: silentLogger,
      });

      const report = await target.discoverFields();

      expect(report.fieldCount).toBe(5);
      expect(report.matchedDomainFields).toEqual({
        title: 'f-title',
        officePhoneNumber: 'f-phone',
        supervisor: 'f-super',
        officeClassroom: 'f-office',
        emailAddress: 'f-email',
      });
      expect(report.missingDomainFields).toHaveLength(0);
      // Unknown types are recorded and accepted without error
      expect(report.unknownTypes).toContain('PHONE_UNKNOWN_CUSTOM');
      expect(report.unknownTypes).toContain('USER_CUSTOM_TYPE');
      expect(report.unknownTypes).toContain('ROOM_PICKER_SPECIAL');
    });

    it('findByEmail retrieves profile and correctly maps to CustomerDetails', async () => {
      const mockFieldsResponse: DetailFieldsResponse = {
        results: [
          { id: 'f-title', name: 'Title', type: { name: 'STRING' } },
          { id: 'f-phone', name: 'Office Phone Number', type: { name: 'STRING' } },
          { id: 'f-super', name: 'Supervisor', type: { name: 'STRING' } },
          { id: 'f-office', name: 'Office/Classroom', type: { name: 'STRING' } },
          { id: 'f-email', name: 'Email Address', type: { name: 'STRING' } },
        ],
      };

      const mockProfile: CustomerAccountProfile = {
        customerId: 'acc-customer-777',
        displayName: 'Diana Prince',
        email: 'diana.prince@themyscira.gov',
        details: [
          { id: 'f-title', name: 'Title', value: 'Chief Ambassador' },
          { id: 'f-phone', name: 'Office Phone Number', value: '+1-555-8888' },
          { id: 'f-super', name: 'Supervisor', value: 'Queen Hippolyta' },
          { id: 'f-office', name: 'Office/Classroom', value: 'Embassy Suite 1' },
          { id: 'f-email', name: 'Email Address', value: 'diana.prince@themyscira.gov' },
        ],
      };

      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/api/v1/customer/details')) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify(mockFieldsResponse),
            headers: new Headers(),
          };
        }
        if (url.includes('/api/v1/customer/profile/acc-customer-777')) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify(mockProfile),
            headers: new Headers(),
          };
        }
        throw new Error(`Unexpected URL: ${url}`);
      });

      const httpClient = new GetOnlyJiraHttpClient(authProvider, {
        fetchFn: mockFetch as unknown as typeof fetch,
        log: silentLogger,
      });

      const mockResolver: CustomerIdentityResolverPort = {
        resolveCustomerIdentity: vi.fn().mockResolvedValue({
          outcome: 'RESOLVED',
          accountId: 'acc-customer-777',
          emailAddress: 'diana.prince@themyscira.gov',
          displayName: 'Diana Prince',
        }),
      };

      const target = new ReadOnlyJiraCustomerTarget({
        cloudId: 'cloud-uuid-999',
        siteUrl: 'https://mysite.atlassian.net',
        httpClient,
        identityResolver: mockResolver,
        log: silentLogger,
      });

      const customer = await target.findByEmail('diana.prince@themyscira.gov');

      expect(customer).toBeDefined();
      expect(customer).toEqual({
        email: 'diana.prince@themyscira.gov',
        title: 'Chief Ambassador',
        officePhoneNumber: '+1-555-8888',
        supervisor: 'Queen Hippolyta',
        officeClassroom: 'Embassy Suite 1',
        emailAddress: 'diana.prince@themyscira.gov',
      });
    });

    it('mapProfileToCustomerDetails sets emailAddress to null when detail is blank, never substituting account email', () => {
      const httpClient = new GetOnlyJiraHttpClient(authProvider, {
        log: silentLogger,
      });
      const dummyResolver: CustomerIdentityResolverPort = {
        resolveCustomerIdentity: vi.fn(),
      };
      const target = new ReadOnlyJiraCustomerTarget({
        siteUrl: 'https://mysite.atlassian.net',
        cloudId: 'cloud-uuid-999',
        httpClient,
        identityResolver: dummyResolver,
        log: silentLogger,
      });

      const profileWithoutEmailDetail: CustomerAccountProfile = {
        customerId: 'acc-customer-888',
        displayName: 'Bruce Wayne',
        email: 'bruce.wayne@example.com',
        details: [{ id: 'f-title', name: 'Title', value: 'Philanthropist' }],
      };

      const mapped = target.mapProfileToCustomerDetails(
        'bruce.wayne@example.com',
        profileWithoutEmailDetail,
      );
      expect(mapped.email).toBe('bruce.wayne@example.com');
      expect(mapped.emailAddress).toBeNull();
      expect(mapped.title).toBe('Philanthropist');
    });

    it('assertTargetFieldsConfigured throws when required target fields are missing', () => {
      const httpClient = new GetOnlyJiraHttpClient(authProvider, {
        log: silentLogger,
      });
      const target = new ReadOnlyJiraCustomerTarget({
        siteUrl: 'https://mysite.atlassian.net',
        cloudId: 'cloud-uuid-999',
        httpClient,
        identityResolver: { resolveCustomerIdentity: vi.fn() },
        log: silentLogger,
      });

      expect(() => {
        target.assertTargetFieldsConfigured({
          fields: [],
          unmappedFields: [],
          fieldCount: 4,
          matchedDomainFields: {
            title: 'f-title',
            officePhoneNumber: 'f-phone',
            supervisor: 'f-super',
            officeClassroom: 'f-office',
          },
          missingDomainFields: ['emailAddress'],
          ambiguousDomainFields: {},
          unknownTypes: [],
        });
      }).toThrowError(/Required Jira customer detail field\(s\) missing: Email address/);
    });

    it('assertTargetFieldsConfigured throws when target fields are ambiguous', () => {
      const httpClient = new GetOnlyJiraHttpClient(authProvider, {
        log: silentLogger,
      });
      const target = new ReadOnlyJiraCustomerTarget({
        siteUrl: 'https://mysite.atlassian.net',
        cloudId: 'cloud-uuid-999',
        httpClient,
        identityResolver: { resolveCustomerIdentity: vi.fn() },
        log: silentLogger,
      });

      expect(() => {
        target.assertTargetFieldsConfigured({
          fields: [],
          unmappedFields: [],
          fieldCount: 6,
          matchedDomainFields: {
            title: 'f-title',
            officePhoneNumber: 'f-phone',
            supervisor: 'f-super',
            officeClassroom: 'f-office',
          },
          missingDomainFields: [],
          ambiguousDomainFields: {
            emailAddress: ['Email Address', 'Email'],
          },
          unknownTypes: [],
        });
      }).toThrowError(
        /Required Jira customer detail field\(s\) ambiguously resolved: Email address/,
      );
    });

    it('returns null when customer identity resolution fails', async () => {
      const httpClient = new GetOnlyJiraHttpClient(authProvider, {
        log: silentLogger,
      });

      const mockResolver: CustomerIdentityResolverPort = {
        resolveCustomerIdentity: vi.fn().mockResolvedValue({
          outcome: 'NOT_FOUND',
          reason: 'User not found',
        }),
      };

      const target = new ReadOnlyJiraCustomerTarget({
        cloudId: 'cloud-uuid-999',
        siteUrl: 'https://mysite.atlassian.net',
        httpClient,
        identityResolver: mockResolver,
        log: silentLogger,
      });

      const customer = await target.findByEmail('ghost@example.com');
      expect(customer).toBeNull();
    });

    it('auto-resolves Cloud ID from tenant info when cloudId is placeholder', async () => {
      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/_edge/tenant_info')) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ cloudId: 'auto-resolved-cloud-id' }),
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
        log: silentLogger,
      });

      const dummyResolver: CustomerIdentityResolverPort = {
        resolveCustomerIdentity: vi.fn(),
      };

      const target = new ReadOnlyJiraCustomerTarget({
        siteUrl: 'https://mysite.atlassian.net',
        httpClient,
        identityResolver: dummyResolver,
        log: silentLogger,
      });

      const report = await target.discoverFields();
      expect(report.fieldCount).toBe(0);
      expect(await target.ensureCloudId()).toBe('auto-resolved-cloud-id');
    });

    describe('Atlassian CSM Customer Profile Parsing & Diff Safety', () => {
      const dummyResolver: CustomerIdentityResolverPort = {
        resolveCustomerIdentity: vi.fn(),
      };

      it('maps documented Atlassian value.text array to string and never produces [object Object]', () => {
        const httpClient = new GetOnlyJiraHttpClient(authProvider, {
          log: silentLogger,
        });
        const target = new ReadOnlyJiraCustomerTarget({
          siteUrl: 'https://mysite.atlassian.net',
          cloudId: 'mock-cloud-id',
          httpClient,
          identityResolver: dummyResolver,
          log: silentLogger,
        });

        // 1. Single text item in array
        expect(
          target.coerceToString({
            type: 'TEXT',
            text: ['Engineer'],
            assetsObjects: null,
          }),
        ).toBe('Engineer');

        // 2. Empty text array
        expect(
          target.coerceToString({
            type: 'TEXT',
            text: [],
            assetsObjects: null,
          }),
        ).toBeNull();

        // 3. Array with only empty/whitespace strings
        expect(
          target.coerceToString({
            type: 'TEXT',
            text: ['', '   '],
            assetsObjects: null,
          }),
        ).toBeNull();

        // 4. Null value
        expect(target.coerceToString(null)).toBeNull();
        expect(target.coerceToString(undefined)).toBeNull();

        // 5. Multiline text
        expect(
          target.coerceToString({
            type: 'TEXT',
            text: ['Lead', 'Architect'],
            assetsObjects: null,
          }),
        ).toBe('Lead\nArchitect');

        // 6. Unknown object shape must NEVER return "[object Object]"
        const result = target.coerceToString({ unknownKey: 123, otherProp: true });
        expect(result).toBeNull();
        expect(result).not.toBe('[object Object]');

        // 7. Full profile mapping with value.text
        const profile: CustomerAccountProfile = {
          customerId: 'acc-123',
          accountId: 'acc-123',
          emailAddress: 'dev@example.com',
          displayName: 'Test Dev',
          details: [
            {
              id: 'f-title',
              name: 'Title',
              value: { type: 'TEXT', text: ['Senior Software Engineer'], assetsObjects: null },
            },
            {
              id: 'f-phone',
              name: 'Office Phone Number',
              value: { type: 'PHONE_NUMBER', text: ['555-0199'], assetsObjects: null },
            },
            {
              id: 'f-supervisor',
              name: 'Supervisor',
              value: { type: 'TEXT', text: ['Jane Manager'], assetsObjects: null },
            },
            {
              id: 'f-office',
              name: 'Office/Classroom',
              value: { type: 'TEXT', text: ['Building C, Room 404'], assetsObjects: null },
            },
          ],
        };

        const mapped = target.mapProfileToCustomerDetails('dev@example.com', profile);
        expect(mapped.title).toBe('Senior Software Engineer');
        expect(mapped.officePhoneNumber).toBe('555-0199');
        expect(mapped.supervisor).toBe('Jane Manager');
        expect(mapped.officeClassroom).toBe('Building C, Room 404');
        expect(JSON.stringify(mapped)).not.toContain('[object Object]');
      });

      it('preserves the rule that empty Entra fields do not erase existing Jira data in DiffPlanner', async () => {
        const { DiffPlanner } = await import('../src/services/diff-planner');
        const diffPlanner = new DiffPlanner();

        const candidateEntraWithEmptyFields = {
          email: 'user@example.com',
          title: null, // Empty in Entra
          officePhoneNumber: null, // Empty in Entra
          supervisor: '   ', // Whitespace-only in Entra
          officeClassroom: null, // Empty in Entra
        };

        const existingPopulatedJiraCustomer = {
          email: 'user@example.com',
          title: 'Existing Principal Engineer',
          officePhoneNumber: '555-4321',
          supervisor: 'Existing Director',
          officeClassroom: 'Tower 1, Floor 12',
        };

        const plan = diffPlanner.planDiff(
          candidateEntraWithEmptyFields,
          existingPopulatedJiraCustomer,
        );

        // Crucial invariant: Empty source fields must NEVER overwrite or erase existing target fields
        expect(plan.hasChanges).toBe(false);
        expect(plan.fieldDiffs).toHaveLength(0);
        expect(plan.updates).toEqual({});
      });
    });
  });
});
