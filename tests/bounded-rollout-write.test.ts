import * as crypto from 'crypto';
import * as fs from 'fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BoundedRolloutWriteService,
  BoundedRolloutWriteReport,
} from '../src/services/bounded-rollout-write-service';
import {
  DirectoryPerson,
  DirectorySourcePort,
  ExistingCustomerScopeReaderPort,
} from '../src/domain';
import {
  JiraCustomerDetailWriteClient,
  JiraHttpError,
  ReadOnlyJiraCustomerTarget,
} from '../src/connectors/jira';
import { Logger } from '../src/utils/logger';
import { hashIdentifier } from '../src/utils/privacy';

const silentLogger = new Logger('bounded-rollout-test', 'error');
const createdPaths: string[] = [];

afterEach(() => {
  for (const filePath of createdPaths.splice(0)) {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
  vi.restoreAllMocks();
});

function writeApproval(records: Array<{ customerRef: string; changedFieldNames: string[] }>) {
  const path = `reports/test-rollout-2026-10-01T00-00-00Z-${Date.now()}-${Math.random()}.json`;
  const body = JSON.stringify({
    mode: 'JIRA_FIRST_DRY_RUN',
    readOnly: true,
    success: true,
    records: records.map((record) => ({ ...record, resultCategory: 'UPDATE_PLANNED' })),
  });
  fs.writeFileSync(path, body, 'utf8');
  createdPaths.push(path);
  return {
    path,
    digest: crypto.createHash('sha256').update(body).digest('hex'),
  };
}

function createService(options: {
  approvedFields?: string[];
  freshTitle?: string;
  writeError?: Error;
  digestOverride?: string;
  preflightOnly?: boolean;
  writeMinIntervalMs?: number;
  sleepFn?: (milliseconds: number) => Promise<void>;
}) {
  const email = 'rollout@example.com';
  const customerRef = hashIdentifier(email);
  const approvedFields = options.approvedFields ?? ['title', 'officePhoneNumber'];
  const approval = writeApproval([{ customerRef, changedFieldNames: approvedFields }]);
  const person: DirectoryPerson = {
    sourceId: 'entra-1',
    displayName: 'Rollout Person',
    email,
    jobTitle: options.freshTitle ?? 'New Title',
    officePhone: '555-0100',
    supervisorName: null,
    officeLocation: null,
    managerLookupStatus: 'NO_MANAGER',
  };
  const directory: DirectorySourcePort = { getPeople: vi.fn().mockResolvedValue([person]) };
  const scopeReader: ExistingCustomerScopeReaderPort = {
    async *listExistingCustomers() {
      yield {
        sourceCustomerId: 'jira-1',
        normalizedEmail: email,
        isActive: true,
        sourceScopeReferences: ['1'],
      };
    },
  };
  const initial = {
    email,
    title: 'Old Title',
    officePhoneNumber: '555-0000',
    supervisor: null,
    officeClassroom: null,
    emailAddress: email,
  };
  const afterTitle = { ...initial, title: person.jobTitle };
  const afterBoth = { ...afterTitle, officePhoneNumber: person.officePhone };
  const getCustomerProfile = vi
    .fn()
    .mockResolvedValueOnce({
      customerDetails: initial,
      profile: { customerId: 'jira-1', details: [] },
    })
    .mockResolvedValueOnce({
      customerDetails: afterTitle,
      profile: { customerId: 'jira-1', details: [] },
    })
    .mockResolvedValueOnce({
      customerDetails: afterBoth,
      profile: { customerId: 'jira-1', details: [] },
    });
  const reader = {
    discoverFields: vi.fn().mockResolvedValue({
      fields: [
        { id: 'title-id', name: 'Title', typeName: 'STRING', required: false },
        { id: 'phone-id', name: 'Office Phone Number', typeName: 'STRING', required: false },
      ],
      matchedDomainFields: { title: 'title-id', officePhoneNumber: 'phone-id' },
    }),
    getCustomerProfile,
  } as unknown as ReadOnlyJiraCustomerTarget;
  const setCustomerDetail = vi.fn().mockResolvedValue({ statusCode: 200 });
  if (options.writeError) setCustomerDetail.mockRejectedValueOnce(options.writeError);
  const writer = { setCustomerDetail } as unknown as JiraCustomerDetailWriteClient;
  const reportPath = `reports/test-rollout-result-${Date.now()}-${Math.random()}.json`;
  const service = new BoundedRolloutWriteService(
    directory,
    scopeReader,
    reader,
    writer,
    {
      maxRecords: 10,
      maxCustomers: 1,
      maxFieldsPerCustomer: 2,
      approvedReportPath: approval.path,
      approvedReportSha256: options.digestOverride ?? approval.digest,
      reportPath,
      preflightOnly: options.preflightOnly,
      writeMinIntervalMs: options.writeMinIntervalMs,
      sleepFn: options.sleepFn,
    },
    undefined,
    undefined,
    silentLogger,
  );
  return { service, setCustomerDetail, getCustomerProfile };
}

describe('BoundedRolloutWriteService', () => {
  it('applies approved fields sequentially and verifies each fresh profile', async () => {
    const { service, setCustomerDetail, getCustomerProfile } = createService({});
    const report: BoundedRolloutWriteReport = await service.execute();
    if (report.reportPath) createdPaths.push(report.reportPath);

    expect(report.success).toBe(true);
    expect(report.preflightMatchedApproval).toBe(true);
    expect(report.verifiedFieldCount).toBe(2);
    expect(setCustomerDetail).toHaveBeenCalledTimes(2);
    expect(getCustomerProfile).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(report)).not.toContain('New Title');
    expect(JSON.stringify(report)).not.toContain('555-0100');
  });

  it('paces sequential write attempts without retrying either write', async () => {
    const sleepFn = vi.fn().mockResolvedValue(undefined);
    const { service, setCustomerDetail } = createService({
      writeMinIntervalMs: 5000,
      sleepFn,
    });

    const report = await service.execute();
    if (report.reportPath) createdPaths.push(report.reportPath);

    expect(report.success).toBe(true);
    expect(setCustomerDetail).toHaveBeenCalledTimes(2);
    expect(sleepFn).toHaveBeenCalledOnce();
    expect(sleepFn).toHaveBeenCalledWith(5000);
  });

  it('validates the approval and fresh plan without invoking the writer in preflight mode', async () => {
    const { service, setCustomerDetail, getCustomerProfile } = createService({
      preflightOnly: true,
    });
    const report = await service.execute();
    if (report.reportPath) createdPaths.push(report.reportPath);

    expect(report.success).toBe(true);
    expect(report.preflightOnly).toBe(true);
    expect(report.preflightMatchedApproval).toBe(true);
    expect(setCustomerDetail).not.toHaveBeenCalled();
    expect(getCustomerProfile).toHaveBeenCalledTimes(1);
  });

  it('rejects an approval artifact whose digest changed before any API work', async () => {
    const { service, setCustomerDetail, getCustomerProfile } = createService({
      digestOverride: '0'.repeat(64),
    });

    await expect(service.execute()).rejects.toThrow(/SHA-256/);
    expect(setCustomerDetail).not.toHaveBeenCalled();
    expect(getCustomerProfile).not.toHaveBeenCalled();
  });

  it('stops before writing when the fresh field plan differs from approval', async () => {
    const { service, setCustomerDetail } = createService({ approvedFields: ['title'] });
    const report = await service.execute();
    if (report.reportPath) createdPaths.push(report.reportPath);

    expect(report.success).toBe(false);
    expect(report.failureReason).toBe('APPROVED_PLAN_DRIFTED');
    expect(setCustomerDetail).not.toHaveBeenCalled();
  });

  it('stops after one ambiguous write outcome without retrying', async () => {
    const { service, setCustomerDetail, getCustomerProfile } = createService({
      writeError: new TypeError('synthetic interruption'),
    });
    const report = await service.execute();
    if (report.reportPath) createdPaths.push(report.reportPath);

    expect(report.success).toBe(false);
    expect(report.failureReason).toBe('JIRA_WRITE_OUTCOME_UNKNOWN');
    expect(report.stoppedEarly).toBe(true);
    expect(report.records[0]?.manualReviewRequired).toBe(true);
    expect(setCustomerDetail).toHaveBeenCalledTimes(1);
    expect(getCustomerProfile).toHaveBeenCalledTimes(1);
  });

  it('counts a rejected customer attempt and records only sanitized Jira rejection metadata', async () => {
    const { service, setCustomerDetail, getCustomerProfile } = createService({
      writeError: new JiraHttpError('synthetic rejection', 400, 'request-123', {
        message: 'sensitive response text',
      }),
    });
    const report = await service.execute();
    if (report.reportPath) createdPaths.push(report.reportPath);

    expect(report.success).toBe(false);
    expect(report.failureReason).toBe('JIRA_WRITE_REJECTED');
    expect(report.attemptedCustomerCount).toBe(1);
    expect(report.attemptedFieldCount).toBe(1);
    expect(report.records[0]?.rejectionStatusCode).toBe(400);
    expect(report.records[0]?.rejectionRequestId).toBe('request-123');
    expect(report.records[0]?.manualReviewRequired).toBe(false);
    expect(JSON.stringify(report)).not.toContain('sensitive response text');
    expect(setCustomerDetail).toHaveBeenCalledTimes(1);
    expect(getCustomerProfile).toHaveBeenCalledTimes(1);
  });
});
