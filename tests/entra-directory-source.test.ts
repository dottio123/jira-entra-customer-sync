import { describe, it, expect, beforeEach } from 'vitest';
import {
  EntraDirectorySource,
  IGraphClient,
  GetUsersQueryOptions,
  GraphUserDto,
  GraphManagerDto,
  GraphPagedResponse,
} from '../src/connectors/entra';
import { Logger } from '../src/utils/logger';

class FakeGraphClient implements IGraphClient {
  public getUsersHandler: (
    options: GetUsersQueryOptions,
  ) => Promise<GraphPagedResponse<GraphUserDto>> = async () => ({ value: [] });
  public getManagerHandler: (userId: string) => Promise<GraphManagerDto | null> = async () => null;

  public getUsersCalls: GetUsersQueryOptions[] = [];
  public getManagerCalls: string[] = [];

  async getUsers(options: GetUsersQueryOptions): Promise<GraphPagedResponse<GraphUserDto>> {
    this.getUsersCalls.push(options);
    return this.getUsersHandler(options);
  }

  async getManager(userId: string): Promise<GraphManagerDto | null> {
    this.getManagerCalls.push(userId);
    return this.getManagerHandler(userId);
  }
}

describe('EntraDirectorySource Adapter', () => {
  let fakeClient: FakeGraphClient;
  let logMessages: string[] = [];
  let testLogger: Logger;

  beforeEach(() => {
    fakeClient = new FakeGraphClient();
    logMessages = [];

    testLogger = new Logger('test-entra', 'debug');
    // Capture log output for privacy and sanitization assertions
    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;

    console.log = (msg: string) => {
      logMessages.push(msg);
      originalLog(msg);
    };
    console.warn = (msg: string) => {
      logMessages.push(msg);
      originalWarn(msg);
    };
    console.error = (msg: string) => {
      logMessages.push(msg);
      originalError(msg);
    };
  });

  it('mail is preferred over userPrincipalName', async () => {
    fakeClient.getUsersHandler = async () => ({
      value: [
        {
          id: 'user-001',
          displayName: 'John Doe',
          mail: 'john.primary@company.com',
          userPrincipalName: 'jdoe@company.onmicrosoft.com',
          accountEnabled: true,
        },
      ],
    });

    const source = new EntraDirectorySource(fakeClient, { log: testLogger });
    const people = await source.getPeople();

    expect(people).toHaveLength(1);
    expect(people[0]?.email).toBe('john.primary@company.com');
  });

  it('userPrincipalName is used when mail is empty', async () => {
    fakeClient.getUsersHandler = async () => ({
      value: [
        {
          id: 'user-002',
          displayName: 'Jane Doe',
          mail: null,
          userPrincipalName: 'jane.doe@company.com',
          accountEnabled: true,
        },
      ],
    });

    const source = new EntraDirectorySource(fakeClient, { log: testLogger });
    const people = await source.getPeople();

    expect(people).toHaveLength(1);
    expect(people[0]?.email).toBe('jane.doe@company.com');
  });

  it('disabled users are excluded', async () => {
    fakeClient.getUsersHandler = async () => ({
      value: [
        {
          id: 'user-active',
          displayName: 'Active User',
          mail: 'active@company.com',
          userPrincipalName: 'active@company.com',
          accountEnabled: true,
        },
        {
          id: 'user-disabled',
          displayName: 'Disabled User',
          mail: 'disabled@company.com',
          userPrincipalName: 'disabled@company.com',
          accountEnabled: false,
        },
      ],
    });

    const source = new EntraDirectorySource(fakeClient, { log: testLogger });
    const people = await source.getPeople();

    expect(people).toHaveLength(1);
    expect(people[0]?.sourceId).toBe('user-active');
  });

  it('guests are excluded by default', async () => {
    fakeClient.getUsersHandler = async () => ({
      value: [
        {
          id: 'user-member',
          displayName: 'Internal Member',
          mail: 'member@company.com',
          userPrincipalName: 'member@company.com',
          userType: 'Member',
          accountEnabled: true,
        },
        {
          id: 'user-guest-type',
          displayName: 'External Partner',
          mail: 'partner@external.com',
          userPrincipalName: 'partner@external.com',
          userType: 'Guest',
          accountEnabled: true,
        },
        {
          id: 'user-guest-ext',
          displayName: 'External Vendor',
          mail: 'vendor@external.com',
          userPrincipalName: 'vendor_external.com#EXT#@company.onmicrosoft.com',
          accountEnabled: true,
        },
      ],
    });

    const source = new EntraDirectorySource(fakeClient, {
      includeGuestUsers: false,
      log: testLogger,
    });
    const people = await source.getPeople();

    expect(people).toHaveLength(1);
    expect(people[0]?.sourceId).toBe('user-member');
  });

  it('guests can be included through configuration', async () => {
    fakeClient.getUsersHandler = async () => ({
      value: [
        {
          id: 'user-member',
          displayName: 'Internal Member',
          mail: 'member@company.com',
          userPrincipalName: 'member@company.com',
          userType: 'Member',
          accountEnabled: true,
        },
        {
          id: 'user-guest',
          displayName: 'External Partner',
          mail: 'partner@external.com',
          userPrincipalName: 'partner_external.com#EXT#@company.onmicrosoft.com',
          userType: 'Guest',
          accountEnabled: true,
        },
      ],
    });

    const source = new EntraDirectorySource(fakeClient, {
      includeGuestUsers: true,
      log: testLogger,
    });
    const people = await source.getPeople();

    expect(people).toHaveLength(2);
    expect(people.map((p) => p.sourceId)).toEqual(['user-member', 'user-guest']);
  });

  it('first business phone is selected', async () => {
    fakeClient.getUsersHandler = async () => ({
      value: [
        {
          id: 'user-phone',
          displayName: 'Phone User',
          mail: 'phone@company.com',
          userPrincipalName: 'phone@company.com',
          accountEnabled: true,
          businessPhones: ['', '   ', '+1-555-8888', '+1-555-9999'],
        },
      ],
    });

    const source = new EntraDirectorySource(fakeClient, { log: testLogger });
    const people = await source.getPeople();

    expect(people[0]?.officePhone).toBe('+1-555-8888');
  });

  it('immediate manager display name is mapped', async () => {
    fakeClient.getUsersHandler = async () => ({
      value: [
        {
          id: 'user-emp',
          displayName: 'Employee Person',
          mail: 'emp@company.com',
          userPrincipalName: 'emp@company.com',
          accountEnabled: true,
        },
      ],
    });

    fakeClient.getManagerHandler = async (userId: string) => {
      if (userId === 'user-emp') {
        return {
          id: 'mgr-001',
          displayName: 'Director Dan',
        };
      }
      return null;
    };

    const source = new EntraDirectorySource(fakeClient, { log: testLogger });
    const people = await source.getPeople();

    expect(people[0]?.supervisorName).toBe('Director Dan');
  });

  it('missing manager is tolerated', async () => {
    fakeClient.getUsersHandler = async () => ({
      value: [
        {
          id: 'user-no-mgr',
          displayName: 'Independent Contributor',
          mail: 'solo@company.com',
          userPrincipalName: 'solo@company.com',
          accountEnabled: true,
        },
      ],
    });

    // 404 or null returns null from getManager
    fakeClient.getManagerHandler = async () => null;

    const source = new EntraDirectorySource(fakeClient, { log: testLogger });
    const people = await source.getPeople();

    expect(people).toHaveLength(1);
    expect(people[0]?.supervisorName).toBeNull();
  });

  it('manager lookup failure handling', async () => {
    fakeClient.getUsersHandler = async () => ({
      value: [
        {
          id: 'user-fail-mgr',
          displayName: 'Worker Person',
          mail: 'worker@company.com',
          userPrincipalName: 'worker@company.com',
          accountEnabled: true,
        },
      ],
    });

    fakeClient.getManagerHandler = async () => {
      const err = new Error('Forbidden directory access') as Error & {
        statusCode: number;
        innerError: { 'request-id': string };
      };
      err.statusCode = 403;
      err.innerError = { 'request-id': 'req-abc-999' };
      throw err;
    };

    const source = new EntraDirectorySource(fakeClient, {
      maxRetries: 0,
      log: testLogger,
    });
    // Should NOT throw; manager is set to null and failure logged
    const people = await source.getPeople();

    expect(people).toHaveLength(1);
    expect(people[0]?.supervisorName).toBeNull();
  });

  it('multiple Graph pages are processed', async () => {
    fakeClient.getUsersHandler = async (options) => {
      if (!options.nextLink) {
        return {
          value: [
            {
              id: 'p1-user1',
              displayName: 'Page1 User1',
              mail: 'p1u1@company.com',
              userPrincipalName: 'p1u1@company.com',
              accountEnabled: true,
            },
            {
              id: 'p1-user2',
              displayName: 'Page1 User2',
              mail: 'p1u2@company.com',
              userPrincipalName: 'p1u2@company.com',
              accountEnabled: true,
            },
          ],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/users?$skiptoken=page2token',
        };
      }

      if (options.nextLink.includes('page2token')) {
        return {
          value: [
            {
              id: 'p2-user1',
              displayName: 'Page2 User1',
              mail: 'p2u1@company.com',
              userPrincipalName: 'p2u1@company.com',
              accountEnabled: true,
            },
          ],
        };
      }

      return { value: [] };
    };

    const source = new EntraDirectorySource(fakeClient, { log: testLogger });
    const people = await source.getPeople();

    expect(people).toHaveLength(3);
    expect(people.map((p) => p.sourceId)).toEqual(['p1-user1', 'p1-user2', 'p2-user1']);
  });

  it('throttled requests are retried within the configured limit', async () => {
    let callCount = 0;

    fakeClient.getUsersHandler = async () => {
      callCount++;
      if (callCount === 1) {
        const err = new Error('Too Many Requests') as Error & {
          statusCode: number;
          headers: Record<string, string>;
        };
        err.statusCode = 429;
        err.headers = { 'retry-after': '0' };
        throw err;
      }

      return {
        value: [
          {
            id: 'retried-user',
            displayName: 'Retried User',
            mail: 'retried@company.com',
            userPrincipalName: 'retried@company.com',
            accountEnabled: true,
          },
        ],
      };
    };

    const source = new EntraDirectorySource(fakeClient, {
      maxRetries: 2,
      retryDelayMs: 10,
      log: testLogger,
    });
    const people = await source.getPeople();

    expect(callCount).toBe(2);
    expect(people).toHaveLength(1);
    expect(people[0]?.sourceId).toBe('retried-user');
  });

  it('retry limit is enforced', async () => {
    let callCount = 0;

    fakeClient.getUsersHandler = async () => {
      callCount++;
      const err = new Error('Service Unavailable') as Error & { statusCode: number };
      err.statusCode = 503;
      throw err;
    };

    const source = new EntraDirectorySource(fakeClient, {
      maxRetries: 2,
      retryDelayMs: 10,
      log: testLogger,
    });

    await expect(source.getPeople()).rejects.toThrow(/Service Unavailable/);
    // Initial call + 2 retries = 3 calls total
    expect(callCount).toBe(3);
  });

  it('logs contain no client secret, access token, or full email address', async () => {
    fakeClient.getUsersHandler = async () => ({
      value: [
        {
          id: 'user-secret-test',
          displayName: 'Secret Test User',
          mail: 'confidential.employee@supersecretcorp.com',
          userPrincipalName: 'confidential.employee@supersecretcorp.com',
          accountEnabled: true,
        },
      ],
    });

    const source = new EntraDirectorySource(fakeClient, { log: testLogger });
    await source.getPeople();

    const allLoggedText = logMessages.join('\n');

    // Verify raw email PII is never logged in full
    expect(allLoggedText).not.toContain('confidential.employee@supersecretcorp.com');
    // Verify no secret tokens
    expect(allLoggedText).not.toContain('clientSecret');
    expect(allLoggedText).not.toContain('access_token');
    expect(allLoggedText).not.toContain('Bearer');
  });

  it('Graph DTOs do not leak into domain or service contracts', async () => {
    fakeClient.getUsersHandler = async () => ({
      value: [
        {
          id: 'user-clean',
          displayName: 'Clean Model',
          mail: 'clean@company.com',
          userPrincipalName: 'clean@company.com',
          jobTitle: 'Clean Engineer',
          officeLocation: 'Room 1',
          businessPhones: ['+1-555-0001'],
          accountEnabled: true,
          userType: 'Member',
        },
      ],
    });

    const source = new EntraDirectorySource(fakeClient, { log: testLogger });
    const [person] = await source.getPeople();

    expect(person).toBeDefined();
    // Verify person only contains DirectoryPerson properties
    const keys = Object.keys(person!);
    expect(keys.sort()).toEqual(
      [
        'sourceId',
        'displayName',
        'email',
        'jobTitle',
        'officePhone',
        'supervisorName',
        'officeLocation',
        'managerLookupStatus',
        'managerLookupError',
      ].sort(),
    );

    // Verify Graph wire properties do not exist
    expect(person).not.toHaveProperty('userType');
    expect(person).not.toHaveProperty('accountEnabled');
    expect(person).not.toHaveProperty('businessPhones');
    expect(person).not.toHaveProperty('userPrincipalName');
    expect(person).not.toHaveProperty('@odata.context');
  });
});
