import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import {
  BasicJiraAuthProvider,
  JiraCustomerDetailWriteClient,
  ReadOnlyJiraCustomerTarget,
  RequestBudgetGuard,
  resolveJiraCsmFieldName,
  normalizeJiraCustomerDetailWriteValue,
} from '../src/connectors/jira';
import { PilotCustomerWriteService } from '../src/services';
import {
  CustomerDetails,
  CustomerIdentityResolverPort,
  DirectoryPerson,
  DirectorySourcePort,
} from '../src/domain';
import { Logger } from '../src/utils/logger';

const silentLogger = new Logger('pilot-write-test', 'error');
const reportPaths: string[] = [];

afterEach(() => {
  for (const reportPath of reportPaths.splice(0)) {
    if (fs.existsSync(reportPath)) fs.unlinkSync(reportPath);
  }
});

describe('JiraCustomerDetailWriteClient', () => {
  it('issues exactly one narrowly scoped PUT with a single value', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'x-atlassian-request-id': 'write-req-1' }),
      text: async () => JSON.stringify({ name: 'Office/Classroom', values: ['Room 12'] }),
    });
    const budget = new RequestBudgetGuard({ customerDetailWrite: 1, global: 1 });
    const client = new JiraCustomerDetailWriteClient({
      authProvider: new BasicJiraAuthProvider('user@example.com', 'token'),
      cloudId: 'cloud-id',
      budgetGuard: budget,
      fetchFn: fetchFn as unknown as typeof fetch,
      log: silentLogger,
    });

    const result = await client.setCustomerDetail('customer-id', 'Office/Classroom', 'Room 12');

    expect(result).toEqual({ statusCode: 200, requestId: 'write-req-1' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toContain('/api/v1/customer/customer-id/details?fieldName=Office%2FClassroom');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ values: ['Room 12'] });
    expect(budget.getCounts().customerDetailWrite).toBe(1);
  });

  it('rejects empty values before a network request', async () => {
    const fetchFn = vi.fn();
    const client = new JiraCustomerDetailWriteClient({
      authProvider: new BasicJiraAuthProvider('user@example.com', 'token'),
      cloudId: 'cloud-id',
      budgetGuard: new RequestBudgetGuard({ customerDetailWrite: 1 }),
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    await expect(client.setCustomerDetail('customer-id', 'Title', '  ')).rejects.toThrow(
      /non-empty value/,
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('normalizes formatted phone values to Jira digit-only form', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
    });
    const client = new JiraCustomerDetailWriteClient({
      authProvider: new BasicJiraAuthProvider('user@example.com', 'token'),
      cloudId: 'cloud-id',
      budgetGuard: new RequestBudgetGuard({ customerDetailWrite: 1 }),
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    await client.setCustomerDetail('customer-id', 'Office Phone Number', '+1 (757) 965-6133');

    const [, init] = fetchFn.mock.calls[0]!;
    expect(JSON.parse(init.body)).toEqual({ values: ['17579656133'] });
  });

  it('resolves canonical field name to Jira CSM Email Address and lowercases write value', async () => {
    expect(resolveJiraCsmFieldName('emailAddress')).toBe('Email Address');
    expect(normalizeJiraCustomerDetailWriteValue('emailAddress', '  Jane.Doe@EXAMPLE.COM  ')).toBe(
      'jane.doe@example.com',
    );

    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
    });
    const client = new JiraCustomerDetailWriteClient({
      authProvider: new BasicJiraAuthProvider('user@example.com', 'token'),
      cloudId: 'cloud-id',
      budgetGuard: new RequestBudgetGuard({ customerDetailWrite: 1 }),
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    await client.setCustomerDetail('customer-id', 'Email Address', '  Jane.Doe@EXAMPLE.COM  ');

    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toContain('fieldName=Email%20Address');
    expect(JSON.parse(init.body)).toEqual({ values: ['jane.doe@example.com'] });
  });

  it('does not retry a failed write', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      headers: new Headers({ 'x-atlassian-request-id': 'write-denied' }),
      text: async () => JSON.stringify({ error: 'FORBIDDEN' }),
    });
    const client = new JiraCustomerDetailWriteClient({
      authProvider: new BasicJiraAuthProvider('user@example.com', 'token'),
      cloudId: 'cloud-id',
      budgetGuard: new RequestBudgetGuard({ customerDetailWrite: 1 }),
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    await expect(client.setCustomerDetail('customer-id', 'Title', 'Engineer')).rejects.toThrow(
      /status 403/,
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe('PilotCustomerWriteService', () => {
  const pilotEmail = 'pilot@example.com';
  const person: DirectoryPerson = {
    sourceId: 'entra-1',
    displayName: 'Pilot User',
    email: pilotEmail,
    jobTitle: 'Engineer',
    officePhone: '+1 555 1000',
    supervisorName: 'Manager Name',
    officeLocation: 'Room 12',
    managerLookupStatus: 'RESOLVED',
  };
  const fields = {
    fields: [
      { id: 'title-id', name: 'Title', typeName: 'STRING', required: false },
      {
        id: 'phone-id',
        name: 'Office Phone Number',
        typeName: 'STRING',
        required: false,
      },
      { id: 'manager-id', name: 'Supervisor', typeName: 'STRING', required: false },
      {
        id: 'office-id',
        name: 'Office/Classroom',
        typeName: 'STRING',
        required: false,
      },
      {
        id: 'email-id',
        name: 'Email Address',
        typeName: 'STRING',
        required: false,
      },
    ],
    fieldCount: 5,
    matchedDomainFields: {
      title: 'title-id',
      officePhoneNumber: 'phone-id',
      supervisor: 'manager-id',
      officeClassroom: 'office-id',
      emailAddress: 'email-id',
    },
    missingDomainFields: [],
    unmappedFields: [],
    unknownTypes: [],
  };

  function createService(
    before: CustomerDetails,
    after: CustomerDetails,
    overrides: {
      people?: DirectoryPerson[];
      resolution?: Awaited<ReturnType<CustomerIdentityResolverPort['resolveCustomerIdentity']>>;
      verificationError?: Error;
      writeError?: Error;
    } = {},
  ) {
    const directory: DirectorySourcePort = {
      getPeople: vi.fn().mockResolvedValue(overrides.people ?? [person]),
    };
    const getCustomerProfile = vi.fn().mockResolvedValueOnce({
      customerDetails: before,
      profile: { customerId: 'jira-1', details: [] },
    });
    if (overrides.verificationError) {
      getCustomerProfile.mockRejectedValueOnce(overrides.verificationError);
    } else {
      getCustomerProfile.mockResolvedValueOnce({
        customerDetails: after,
        profile: { customerId: 'jira-1', details: [] },
      });
    }
    const reader = {
      discoverFields: vi.fn().mockResolvedValue(fields),
      getCustomerProfile,
    } as unknown as ReadOnlyJiraCustomerTarget;
    const resolver: CustomerIdentityResolverPort = {
      resolveCustomerIdentity: vi.fn().mockResolvedValue(
        overrides.resolution ?? {
          outcome: 'RESOLVED',
          accountId: 'jira-1',
          emailAddress: pilotEmail,
          verifiedServiceDeskIds: ['1'],
        },
      ),
    };
    const setCustomerDetail = vi
      .fn()
      .mockResolvedValue({ statusCode: 200, requestId: 'write-request' });
    if (overrides.writeError) {
      setCustomerDetail.mockRejectedValueOnce(overrides.writeError);
    }
    const writer = { setCustomerDetail } as unknown as JiraCustomerDetailWriteClient;
    const configuredReportPath = `reports/test-pilot-write-${Date.now()}-${Math.random()}.json`;
    const service = new PilotCustomerWriteService(
      directory,
      reader,
      resolver,
      writer,
      { pilotCustomerEmail: pilotEmail, maxFields: 1, reportPath: configuredReportPath },
      undefined,
      undefined,
      silentLogger,
    );
    return { service, setCustomerDetail, getCustomerProfile };
  }

  const matching: CustomerDetails = {
    email: pilotEmail,
    title: 'Engineer',
    officePhoneNumber: '+1 555 1000',
    supervisor: 'Manager Name',
    officeClassroom: 'Room 12',
    emailAddress: pilotEmail,
  };

  it('applies one planned field and verifies the fresh Jira profile', async () => {
    const { service, setCustomerDetail, getCustomerProfile } = createService(
      { ...matching, officeClassroom: 'Room 11' },
      matching,
    );

    const report = await service.execute();
    if (report.reportPath) reportPaths.push(report.reportPath);

    expect(report.success).toBe(true);
    expect(report.appliedFieldNames).toEqual(['officeClassroom']);
    expect(report.verificationComplete).toBe(true);
    expect(setCustomerDetail).toHaveBeenCalledWith('jira-1', 'Office/Classroom', 'Room 12');
    expect(setCustomerDetail).toHaveBeenCalledTimes(1);
    expect(getCustomerProfile).toHaveBeenCalledTimes(2);
  });

  it('stops before writing when more than one field changed', async () => {
    const { service, setCustomerDetail } = createService(
      { ...matching, title: 'Old Title', officeClassroom: 'Room 11' },
      matching,
    );

    await expect(service.execute()).rejects.toThrow(/2 fields changed/);
    expect(setCustomerDetail).not.toHaveBeenCalled();
  });

  it('returns a successful no-op when Jira already matches', async () => {
    const { service, setCustomerDetail, getCustomerProfile } = createService(matching, matching);
    const report = await service.execute();
    if (report.reportPath) reportPaths.push(report.reportPath);

    expect(report.success).toBe(true);
    expect(report.appliedFieldCount).toBe(0);
    expect(setCustomerDetail).not.toHaveBeenCalled();
    expect(getCustomerProfile).toHaveBeenCalledTimes(1);
  });

  it('fails closed when manager comparison is unavailable', async () => {
    const unavailable = { ...person, managerLookupStatus: 'LOOKUP_FAILED' as const };
    const { service, setCustomerDetail } = createService(matching, matching, {
      people: [unavailable],
    });

    await expect(service.execute()).rejects.toThrow(/manager lookup was unavailable/);
    expect(setCustomerDetail).not.toHaveBeenCalled();
  });

  it('fails closed when service-desk membership has no verified provenance', async () => {
    const { service, setCustomerDetail } = createService(matching, matching, {
      resolution: {
        outcome: 'RESOLVED',
        accountId: 'jira-1',
        emailAddress: pilotEmail,
        verifiedServiceDeskIds: [],
      },
    });

    await expect(service.execute()).rejects.toThrow(/membership was not verified/);
    expect(setCustomerDetail).not.toHaveBeenCalled();
  });

  it('returns failure when the post-write profile does not verify', async () => {
    const before = { ...matching, officeClassroom: 'Room 11' };
    const { service, setCustomerDetail } = createService(before, before);
    const report = await service.execute();
    if (report.reportPath) reportPaths.push(report.reportPath);

    expect(setCustomerDetail).toHaveBeenCalledTimes(1);
    expect(report.success).toBe(false);
    expect(report.failureReason).toBe('POST_WRITE_VERIFICATION_FAILED');
    expect(report.manualReviewRequired).toBe(true);
  });

  it('persists a review-required failure when post-write verification is unavailable', async () => {
    const before = { ...matching, officeClassroom: 'Room 11' };
    const { service, setCustomerDetail } = createService(before, matching, {
      verificationError: new Error('synthetic read failure'),
    });
    const report = await service.execute();
    if (report.reportPath) reportPaths.push(report.reportPath);

    expect(setCustomerDetail).toHaveBeenCalledTimes(1);
    expect(report.success).toBe(false);
    expect(report.failureReason).toBe('POST_WRITE_VERIFICATION_UNAVAILABLE');
    expect(report.writeAccepted).toBe(true);
    expect(report.manualReviewRequired).toBe(true);
  });

  it('does not retry an ambiguous write outcome and requires manual review', async () => {
    const before = { ...matching, officeClassroom: 'Room 11' };
    const { service, setCustomerDetail, getCustomerProfile } = createService(before, matching, {
      writeError: new TypeError('synthetic network interruption'),
    });
    const report = await service.execute();
    if (report.reportPath) reportPaths.push(report.reportPath);

    expect(setCustomerDetail).toHaveBeenCalledTimes(1);
    expect(getCustomerProfile).toHaveBeenCalledTimes(1);
    expect(report.success).toBe(false);
    expect(report.failureReason).toBe('JIRA_WRITE_OUTCOME_UNKNOWN');
    expect(report.writeAccepted).toBeNull();
    expect(report.manualReviewRequired).toBe(true);
  });
});
