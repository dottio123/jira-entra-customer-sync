import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JsmServiceDeskCustomerResolver } from '../src/connectors/jira/jsm-servicedesk-customer-resolver';
import { GetOnlyJiraHttpClient, JiraHttpError } from '../src/connectors/jira/readonly-http-client';
import { IJiraAuthProvider } from '../src/connectors/jira/jira-auth';
import { RequestBudgetGuard } from '../src/connectors/jira/request-budget-guard';

describe('JsmServiceDeskCustomerResolver Suite', () => {
  let mockAuthProvider: IJiraAuthProvider;
  let mockHttpClient: GetOnlyJiraHttpClient;
  let budgetGuard: RequestBudgetGuard;

  beforeEach(() => {
    mockAuthProvider = {
      getAuthHeader: vi.fn().mockResolvedValue('Bearer test-token'),
    };
    mockHttpClient = new GetOnlyJiraHttpClient(mockAuthProvider);
    budgetGuard = new RequestBudgetGuard({ userSearch: 5 });
  });

  it('validates required options on construction', () => {
    expect(
      () =>
        new JsmServiceDeskCustomerResolver({
          httpClient: null as unknown as GetOnlyJiraHttpClient,
          serviceDeskIds: ['1'],
          cloudId: 'cloud-123',
        }),
    ).toThrow('GetOnlyJiraHttpClient is required');

    expect(
      () =>
        new JsmServiceDeskCustomerResolver({
          httpClient: mockHttpClient,
          serviceDeskIds: [],
          cloudId: 'cloud-123',
        }),
    ).toThrow('At least one serviceDeskId is required');

    expect(
      () =>
        new JsmServiceDeskCustomerResolver({
          httpClient: mockHttpClient,
          serviceDeskIds: ['1'],
        }),
    ).toThrow('Either Cloud ID or Site URL is required');
  });

  it('returns NOT_FOUND for empty or whitespace email without network calls', async () => {
    const getSpy = vi.spyOn(mockHttpClient, 'get');
    const resolver = new JsmServiceDeskCustomerResolver({
      httpClient: mockHttpClient,
      serviceDeskIds: ['1'],
      cloudId: 'cloud-123',
    });

    const res = await resolver.resolveCustomerIdentity('   ');
    expect(res.outcome).toBe('NOT_FOUND');
    expect(getSpy).not.toHaveBeenCalled();
  });

  it('constructs correct API URL and headers for oauth-3lo', async () => {
    const getSpy = vi.spyOn(mockHttpClient, 'get').mockResolvedValue({
      status: 200,
      headers: new Headers(),
      data: {
        size: 1,
        start: 0,
        limit: 50,
        isLastPage: true,
        values: [
          {
            accountId: 'acc-1',
            emailAddress: 'alice@example.com',
            displayName: 'Alice Smith',
            active: true,
          },
        ],
      },
    });

    const resolver = new JsmServiceDeskCustomerResolver({
      httpClient: mockHttpClient,
      serviceDeskIds: ['SD-1'],
      cloudId: 'cloud-999',
      authMode: 'oauth-3lo',
      budgetGuard,
    });

    const result = await resolver.resolveCustomerIdentity('Alice@Example.COM');

    expect(result.outcome).toBe('RESOLVED');
    if (result.outcome === 'RESOLVED') {
      expect(result.accountId).toBe('acc-1');
      expect(result.emailAddress).toBe('alice@example.com');
      expect(result.displayName).toBe('Alice Smith');
    }

    expect(getSpy).toHaveBeenCalledTimes(1);
    const [callUrl, callHeaders] = getSpy.mock.calls[0]!;
    expect(callUrl).toBe(
      'https://api.atlassian.com/ex/jira/cloud-999/rest/servicedeskapi/servicedesk/SD-1/customer?query=alice%40example.com&start=0&limit=50',
    );
    expect(callHeaders).toEqual({ 'X-ExperimentalApi': 'opt-in' });
  });

  it('returns NOT_FOUND when API returns no values', async () => {
    vi.spyOn(mockHttpClient, 'get').mockResolvedValue({
      status: 200,
      headers: new Headers(),
      data: {
        size: 0,
        start: 0,
        limit: 50,
        isLastPage: true,
        values: [],
      },
    });

    const resolver = new JsmServiceDeskCustomerResolver({
      httpClient: mockHttpClient,
      serviceDeskIds: ['1'],
      cloudId: 'cloud-999',
    });

    const result = await resolver.resolveCustomerIdentity('bob@example.com');
    expect(result.outcome).toBe('NOT_FOUND');
  });

  it('returns EMAIL_UNAVAILABLE when candidate returned has no visible email', async () => {
    vi.spyOn(mockHttpClient, 'get').mockResolvedValue({
      status: 200,
      headers: new Headers(),
      data: {
        size: 1,
        start: 0,
        limit: 50,
        isLastPage: true,
        values: [
          {
            accountId: 'acc-hidden',
            displayName: 'Hidden User',
            active: true,
          },
        ],
      },
    });

    const resolver = new JsmServiceDeskCustomerResolver({
      httpClient: mockHttpClient,
      serviceDeskIds: ['1'],
      cloudId: 'cloud-999',
    });

    const result = await resolver.resolveCustomerIdentity('bob@example.com');
    expect(result.outcome).toBe('EMAIL_UNAVAILABLE');
  });

  it('rejects fuzzy matches and returns NOT_FOUND if none exactly match email', async () => {
    vi.spyOn(mockHttpClient, 'get').mockResolvedValue({
      status: 200,
      headers: new Headers(),
      data: {
        size: 1,
        start: 0,
        limit: 50,
        isLastPage: true,
        values: [
          {
            accountId: 'acc-fuzzy',
            emailAddress: 'bob.different@example.com',
            displayName: 'Bob Different',
            active: true,
          },
        ],
      },
    });

    const resolver = new JsmServiceDeskCustomerResolver({
      httpClient: mockHttpClient,
      serviceDeskIds: ['1'],
      cloudId: 'cloud-999',
    });

    const result = await resolver.resolveCustomerIdentity('bob@example.com');
    expect(result.outcome).toBe('NOT_FOUND');
  });

  it('returns INACTIVE when matching customer account is inactive', async () => {
    vi.spyOn(mockHttpClient, 'get').mockResolvedValue({
      status: 200,
      headers: new Headers(),
      data: {
        size: 1,
        start: 0,
        limit: 50,
        isLastPage: true,
        values: [
          {
            accountId: 'acc-inactive',
            emailAddress: 'inactive@example.com',
            displayName: 'Inactive User',
            active: false,
          },
        ],
      },
    });

    const resolver = new JsmServiceDeskCustomerResolver({
      httpClient: mockHttpClient,
      serviceDeskIds: ['1'],
      cloudId: 'cloud-999',
    });

    const result = await resolver.resolveCustomerIdentity('inactive@example.com');
    expect(result.outcome).toBe('INACTIVE');
  });

  it('returns AMBIGUOUS when multiple distinct accounts match the same email', async () => {
    vi.spyOn(mockHttpClient, 'get').mockResolvedValue({
      status: 200,
      headers: new Headers(),
      data: {
        size: 2,
        start: 0,
        limit: 50,
        isLastPage: true,
        values: [
          {
            accountId: 'acc-1',
            emailAddress: 'shared@example.com',
            displayName: 'User One',
            active: true,
          },
          {
            accountId: 'acc-2',
            emailAddress: 'shared@example.com',
            displayName: 'User Two',
            active: true,
          },
        ],
      },
    });

    const resolver = new JsmServiceDeskCustomerResolver({
      httpClient: mockHttpClient,
      serviceDeskIds: ['1'],
      cloudId: 'cloud-999',
    });

    const result = await resolver.resolveCustomerIdentity('shared@example.com');
    expect(result.outcome).toBe('AMBIGUOUS');
    if (result.outcome === 'AMBIGUOUS') {
      expect(result.candidateCount).toBe(2);
    }
  });

  it('queries multiple service desks and deduplicates identical account IDs', async () => {
    const getSpy = vi
      .spyOn(mockHttpClient, 'get')
      .mockResolvedValueOnce({
        status: 200,
        headers: new Headers(),
        data: {
          size: 1,
          start: 0,
          limit: 50,
          isLastPage: true,
          values: [
            {
              accountId: 'acc-same',
              emailAddress: 'user@example.com',
              displayName: 'Same User',
              active: true,
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: new Headers(),
        data: {
          size: 1,
          start: 0,
          limit: 50,
          isLastPage: true,
          values: [
            {
              accountId: 'acc-same',
              emailAddress: 'user@example.com',
              displayName: 'Same User',
              active: true,
            },
          ],
        },
      });

    const resolver = new JsmServiceDeskCustomerResolver({
      httpClient: mockHttpClient,
      serviceDeskIds: ['1', '2'],
      cloudId: 'cloud-999',
    });

    const result = await resolver.resolveCustomerIdentity('user@example.com');
    expect(getSpy).toHaveBeenCalledTimes(2);
    expect(result.outcome).toBe('RESOLVED');
    if (result.outcome === 'RESOLVED') {
      expect(result.accountId).toBe('acc-same');
    }
  });

  it('fails closed and returns ERROR on HTTP 401 unauthorized', async () => {
    vi.spyOn(mockHttpClient, 'get').mockRejectedValue(
      new JiraHttpError('Unauthorized', 401, 'req-401', { error: 'Unauthorized' }),
    );

    const resolver = new JsmServiceDeskCustomerResolver({
      httpClient: mockHttpClient,
      serviceDeskIds: ['1'],
      cloudId: 'cloud-999',
    });

    const result = await resolver.resolveCustomerIdentity('user@example.com');
    expect(result.outcome).toBe('ERROR');
    if (result.outcome === 'ERROR') {
      expect(result.statusCode).toBe(401);
      expect(result.sanitizedRequestId).toBe('req-401');
      expect(result.reason).toContain('HTTP 401');
    }
  });

  it('fails closed and returns ERROR on HTTP 403 forbidden', async () => {
    vi.spyOn(mockHttpClient, 'get').mockRejectedValue(
      new JiraHttpError('Forbidden', 403, 'req-403', { error: 'Forbidden' }),
    );

    const resolver = new JsmServiceDeskCustomerResolver({
      httpClient: mockHttpClient,
      serviceDeskIds: ['1'],
      cloudId: 'cloud-999',
    });

    const result = await resolver.resolveCustomerIdentity('user@example.com');
    expect(result.outcome).toBe('ERROR');
    if (result.outcome === 'ERROR') {
      expect(result.statusCode).toBe(403);
      expect(result.sanitizedRequestId).toBe('req-403');
      expect(result.reason).toContain('HTTP 403');
    }
  });

  it('fails closed and returns ERROR if any service desk query fails even if another succeeded', async () => {
    vi.spyOn(mockHttpClient, 'get')
      .mockResolvedValueOnce({
        status: 200,
        headers: new Headers(),
        data: {
          size: 1,
          start: 0,
          limit: 50,
          isLastPage: true,
          values: [
            {
              accountId: 'acc-1',
              emailAddress: 'user@example.com',
              displayName: 'User One',
              active: true,
            },
          ],
        },
      })
      .mockRejectedValueOnce(
        new JiraHttpError('Internal Server Error', 500, 'req-500', { error: 'ServerError' }),
      );

    const resolver = new JsmServiceDeskCustomerResolver({
      httpClient: mockHttpClient,
      serviceDeskIds: ['1', '2'],
      cloudId: 'cloud-999',
    });

    const result = await resolver.resolveCustomerIdentity('user@example.com');
    // Must NOT return RESOLVED from partial results
    expect(result.outcome).toBe('ERROR');
    if (result.outcome === 'ERROR') {
      expect(result.statusCode).toBe(500);
      expect(result.sanitizedRequestId).toBe('req-500');
    }
  });

  it('paginates over multiple pages and resolves customer found on later page', async () => {
    const getSpy = vi
      .spyOn(mockHttpClient, 'get')
      .mockResolvedValueOnce({
        status: 200,
        headers: new Headers(),
        data: {
          size: 50,
          start: 0,
          limit: 50,
          isLastPage: false,
          values: Array.from({ length: 50 }, (_, i) => ({
            accountId: `acc-other-${i}`,
            emailAddress: `other${i}@example.com`,
            displayName: `Other ${i}`,
            active: true,
          })),
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: new Headers(),
        data: {
          size: 1,
          start: 50,
          limit: 50,
          isLastPage: true,
          values: [
            {
              accountId: 'acc-target',
              emailAddress: 'target@example.com',
              displayName: 'Target User',
              active: true,
            },
          ],
        },
      });

    const resolver = new JsmServiceDeskCustomerResolver({
      httpClient: mockHttpClient,
      serviceDeskIds: ['1'],
      cloudId: 'cloud-999',
    });

    const result = await resolver.resolveCustomerIdentity('target@example.com');
    expect(getSpy).toHaveBeenCalledTimes(2);
    expect(getSpy.mock.calls[0]![0]).toContain('start=0&limit=50');
    expect(getSpy.mock.calls[1]![0]).toContain('start=50&limit=50');
    expect(result.outcome).toBe('RESOLVED');
    if (result.outcome === 'RESOLVED') {
      expect(result.accountId).toBe('acc-target');
      expect(result.emailAddress).toBe('target@example.com');
    }
  });

  it('treats empty non-final page as incomplete pagination and returns ERROR', async () => {
    vi.spyOn(mockHttpClient, 'get').mockResolvedValueOnce({
      status: 200,
      headers: new Headers({ 'x-atlassian-request-id': 'req-nonfinal-empty' }),
      data: {
        size: 0,
        start: 0,
        limit: 50,
        isLastPage: false,
        values: [],
      },
    });

    const resolver = new JsmServiceDeskCustomerResolver({
      httpClient: mockHttpClient,
      serviceDeskIds: ['1'],
      cloudId: 'cloud-999',
    });

    const result = await resolver.resolveCustomerIdentity('user@example.com');
    expect(result.outcome).toBe('ERROR');
    if (result.outcome === 'ERROR') {
      expect(result.reason).toContain(
        'Incomplete customer search pagination: received 0 results on non-final page',
      );
    }
  });

  it('validates pagination metadata and returns ERROR when isLastPage is non-boolean', async () => {
    vi.spyOn(mockHttpClient, 'get').mockResolvedValueOnce({
      status: 200,
      headers: new Headers({ 'x-atlassian-request-id': 'req-malformed-meta' }),
      data: {
        size: 1,
        start: 0,
        limit: 50,
        isLastPage: 'false' as unknown as boolean, // string instead of boolean
        values: [
          {
            accountId: 'acc-1',
            emailAddress: 'user@example.com',
            active: true,
          },
        ],
      },
    });

    const resolver = new JsmServiceDeskCustomerResolver({
      httpClient: mockHttpClient,
      serviceDeskIds: ['1'],
      cloudId: 'cloud-999',
    });

    const result = await resolver.resolveCustomerIdentity('user@example.com');
    expect(result.outcome).toBe('ERROR');
    if (result.outcome === 'ERROR') {
      expect(result.reason).toContain('non-boolean isLastPage');
    }
  });

  it('fails closed with ERROR when request budget is exceeded during resolution', async () => {
    const budgetGuard = new RequestBudgetGuard({
      userSearch: 1,
    });
    // Consume the single allowed userSearch operation
    budgetGuard.recordOperation('userSearch');

    const resolver = new JsmServiceDeskCustomerResolver({
      httpClient: mockHttpClient,
      serviceDeskIds: ['1'],
      cloudId: 'cloud-999',
      budgetGuard,
    });

    const result = await resolver.resolveCustomerIdentity('user@example.com');
    expect(result.outcome).toBe('ERROR');
    if (result.outcome === 'ERROR') {
      expect(result.reason).toContain('Request budget exceeded');
    }
  });

  it('records verifiedServiceDeskIds across multiple configured service desks', async () => {
    vi.spyOn(mockHttpClient, 'get')
      .mockResolvedValueOnce({
        status: 200,
        headers: new Headers(),
        data: {
          size: 1,
          start: 0,
          limit: 50,
          isLastPage: true,
          values: [
            {
              accountId: 'acc-multi-desk',
              emailAddress: 'member@example.com',
              displayName: 'Multi Member',
              active: true,
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: new Headers(),
        data: {
          size: 1,
          start: 0,
          limit: 50,
          isLastPage: true,
          values: [
            {
              accountId: 'acc-multi-desk',
              emailAddress: 'member@example.com',
              displayName: 'Multi Member',
              active: true,
            },
          ],
        },
      });

    const resolver = new JsmServiceDeskCustomerResolver({
      httpClient: mockHttpClient,
      serviceDeskIds: ['sd-desk-1', 'sd-desk-2'],
      cloudId: 'cloud-999',
    });

    const result = await resolver.resolveCustomerIdentity('member@example.com');
    expect(result.outcome).toBe('RESOLVED');
    if (result.outcome === 'RESOLVED') {
      expect(result.verifiedServiceDeskIds).toEqual(['sd-desk-1', 'sd-desk-2']);
    }
  });

  it('returns verifiedServiceDeskIds when customer is INACTIVE or AMBIGUOUS', async () => {
    // Inactive test
    vi.spyOn(mockHttpClient, 'get').mockResolvedValueOnce({
      status: 200,
      headers: new Headers(),
      data: {
        size: 1,
        start: 0,
        limit: 50,
        isLastPage: true,
        values: [
          {
            accountId: 'acc-inactive',
            emailAddress: 'inactive@example.com',
            active: false,
          },
        ],
      },
    });

    const resolver = new JsmServiceDeskCustomerResolver({
      httpClient: mockHttpClient,
      serviceDeskIds: ['sd-inactive-desk'],
      cloudId: 'cloud-999',
    });

    const result = await resolver.resolveCustomerIdentity('inactive@example.com');
    expect(result.outcome).toBe('INACTIVE');
    if (result.outcome === 'INACTIVE') {
      expect(result.verifiedServiceDeskIds).toEqual(['sd-inactive-desk']);
    }
  });
});
