import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { scryptSync, randomBytes } from 'crypto';
import { createWebServices } from '../src/web/wiring';
import { RunTracker } from '../src/web/run-tracker';
import { loadWebConfig, WebConfig } from '../src/web/config';
import { WebStore } from '../src/web/store';
import { createOriginPolicy } from '../src/web/http/security';
import { passwordNeedsRehash, verifyPassword } from '../src/web/password';
import { DirectoryPerson, DirectorySourcePort, CustomerDetails } from '../src/domain';
import {
  CustomerProfileFetchResult,
  GetOnlyJiraHttpClient,
  JiraCustomerDetailWriteClient,
  JiraHttpError,
  JiraServiceDeskCustomerScopeReader,
  JiraWriteOutcomeUnknownError,
  OAuth3LoJiraAuthProvider,
  OAuthTokenStore,
  ReadOnlyJiraCustomerTarget,
} from '../src/connectors/jira';
import { NotificationService } from '../src/services/notification-service';
import { ProductionSyncWriterService } from '../src/services/production-sync-writer-service';
import { ProductionSyncPreviewService } from '../src/services/production-sync-preview-service';
import { SchedulerService } from '../src/services/scheduler-service';
import { dotStuff, isSafeEmailAddress, sendSmtpMessage } from '../src/services/smtp-client';
import { parseSupportedSchedule } from '../src/utils/cron-interpreter';

const ALL_FIELDS = [
  { id: 'f-title', name: 'Job Title', type: { name: 'TEXT' } },
  { id: 'f-phone', name: 'Office Phone Number', type: { name: 'TEXT' } },
  { id: 'f-sup', name: 'Supervisor', type: { name: 'TEXT' } },
  { id: 'f-office', name: 'Office/Classroom', type: { name: 'TEXT' } },
  { id: 'f-email', name: 'Email Address', type: { name: 'TEXT' } },
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function person(email: string, jobTitle: string | null): DirectoryPerson {
  return {
    sourceId: `id-${email}`,
    displayName: email,
    email,
    jobTitle,
    officePhone: null,
    supervisorName: null,
    officeLocation: null,
    managerLookupStatus: 'NO_MANAGER',
  };
}

describe('production hardening regressions', () => {
  let tmp: string;
  let store: WebStore | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hardening-'));
  });

  afterEach(async () => {
    store?.close();
    store = undefined;
    await new Promise((resolve) => setTimeout(resolve, 30));
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  describe('web preview through the real Jira connectors', () => {
    let config: WebConfig;

    beforeEach(() => {
      config = loadWebConfig(
        {
          NODE_ENV: 'test',
          PUBLIC_BASE_URL: 'http://127.0.0.1:8080',
          WEB_DATA_DIR: path.join(tmp, 'data'),
          WEB_SECRETS_DIR: path.join(tmp, 'secrets'),
          ADMIN_INITIAL_PASSWORD: 'bootstrap-password-123',
          ATLASSIAN_OAUTH_CLIENT_ID: 'client',
          ATLASSIAN_OAUTH_CLIENT_SECRET: 'secret',
          JSM_SERVICE_DESK_IDS: '1',
        },
        tmp,
      );
      fs.mkdirSync(config.secretsDir, { recursive: true });
      const now = new Date().toISOString();
      new OAuthTokenStore({
        tokenPath: config.tokenPath,
        allowedDir: config.secretsDir,
      }).writeTokenRecord({
        schemaVersion: 1,
        tokenType: 'Bearer',
        accessToken: 'access',
        refreshToken: 'refresh',
        accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
        scopes: config.oauthScopes,
        createdAt: now,
        updatedAt: now,
      });
    });

    it('completes a preview of more than 50 matched customers without exhausting request budgets', async () => {
      const total = 75;
      const customers = Array.from({ length: total }, (_, i) => ({
        accountId: `acct-${i}`,
        emailAddress: `user${i}@example.com`,
        displayName: `User ${i}`,
        active: true,
      }));
      const people = customers.map((c) => person(c.emailAddress, 'Engineer'));
      const directorySource: DirectorySourcePort = { getPeople: async () => people };

      const fetchFn = (async (input: string | URL | Request) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.endsWith('/oauth/token/accessible-resources')) {
          return jsonResponse([
            { id: 'cloud-1', url: 'https://example-tenant.atlassian.net', name: 'x', scopes: [] },
          ]);
        }
        if (url.includes('/rest/servicedeskapi/servicedesk/1/customer')) {
          const start = Number(new URL(url).searchParams.get('start') ?? '0');
          const page = customers.slice(start, start + 50);
          return jsonResponse({
            values: page,
            size: page.length,
            isLastPage: start + page.length >= total,
          });
        }
        if (url.endsWith('/api/v1/customer/details')) return jsonResponse({ results: ALL_FIELDS });
        const profile = url.match(/customer\/profile\/(acct-\d+)/);
        if (profile) {
          return jsonResponse({
            customerId: profile[1],
            details: [
              {
                id: 'f-email',
                name: 'Email Address',
                value: `user${profile[1]!.slice(5)}@example.com`,
              },
            ],
          });
        }
        return jsonResponse({ message: 'unexpected' }, 404);
      }) as typeof fetch;

      store = new WebStore(
        path.join(config.dataDir, 'web.sqlite'),
        undefined,
        undefined,
        config.secretsDir,
      );
      store.updateSettings({ approved_email_domains: 'example.com' }, null);
      // The same wiring the web app uses, so the per-run Jira clients and budgets are exercised.
      const services = createWebServices(config, store, new RunTracker(), {
        oauthFetchFn: fetchFn,
        directorySource,
      });

      // Two consecutive runs: budgets must reset per run rather than accumulate.
      for (let run = 0; run < 2; run++) {
        const runId = store.createRun({
          runType: 'PREVIEW',
          triggerSource: 'MANUAL',
          scopeServiceDeskIds: ['1'],
        });
        const result = await services.previewService.executePreview({
          runId,
          scopeServiceDeskIds: ['1'],
        });
        expect(result.uniqueCustomers).toBe(total);
        expect(result.matchedEntraCustomers).toBe(total);
        expect(result.proposedCustomerChangesCount).toBe(total);
      }
    });
  });

  describe('writer', () => {
    function seedApprovedPreview(
      s: WebStore,
      changedFields: Array<{ fieldName: string; newValue: string }>,
    ) {
      s.bootstrapAdmin('admin', 'Password12345!');
      s.updateSettings(
        {
          approved_email_domains: 'example.com',
          writes_enabled: true,
          commissioning_status: 'COMMISSIONED_MANUAL_ONLY',
        },
        1,
      );
      const previewId = s.createRun({
        runType: 'PREVIEW',
        triggerSource: 'MANUAL',
        scopeServiceDeskIds: ['1'],
      });
      const digest = 'a'.repeat(64);
      s.updateRun(previewId, {
        status: 'COMPLETED',
        previewDigest: digest,
        proposedCustomerChanges: 1,
        details: {
          approvedEmailDomains: ['example.com'],
          proposedChanges: [
            {
              customerRef: 'ref-1',
              customerAccountId: 'acct-1',
              customerEmail: 'a@example.com',
              changedFields: changedFields.map((f) => ({ ...f, oldValue: null })),
            },
          ],
        },
      });
      const runId = s.createRun({
        runType: 'LIVE_ROLLOUT',
        triggerSource: 'MANUAL',
        scopeServiceDeskIds: ['1'],
        previewRunId: previewId,
      });
      return { previewId, runId, digest };
    }

    class Target {
      details: CustomerDetails = { email: 'a@example.com', emailAddress: 'a@example.com' };
      async discoverFields() {
        return {
          fields: [],
          fieldCount: 5,
          matchedDomainFields: {},
          matchedFieldNames: { title: 'Job Title', officeClassroom: 'Office Location' },
          missingDomainFields: [],
          ambiguousDomainFields: {},
          unmappedFields: [],
          unknownTypes: [],
        };
      }
      async getCustomerProfile(): Promise<CustomerProfileFetchResult> {
        return {
          profile: { customerId: 'acct-1', details: [] },
          customerDetails: { ...this.details },
        };
      }
    }

    it('writes using the field name discovered on the Jira site', async () => {
      store = new WebStore(path.join(tmp, 'web.sqlite'));
      const { previewId, runId, digest } = seedApprovedPreview(store, [
        { fieldName: 'title', newValue: 'Engineer' },
      ]);
      const target = new Target();
      const writes: Array<[string, string | undefined]> = [];
      const writer = {
        async setCustomerDetail(_id: string, field: string, value: string, jiraName?: string) {
          writes.push([field, jiraName]);
          target.details = { ...target.details, [field]: value };
          return { statusCode: 200 };
        },
      };
      const service = new ProductionSyncWriterService(
        { getPeople: async () => [person('a@example.com', 'Engineer')] },
        target as unknown as ReadOnlyJiraCustomerTarget,
        writer as unknown as JiraCustomerDetailWriteClient,
        store,
        new NotificationService(store),
        { writeMinIntervalMs: 0 },
      );
      const result = await service.executeLiveRollout({
        runId,
        previewRunId: previewId,
        approvalDigest: digest,
      });
      expect(result.status).toBe('COMPLETED');
      expect(writes).toEqual([['title', 'Job Title']]);
    });

    it('records a customer as PARTIAL when paused after some fields were written', async () => {
      store = new WebStore(path.join(tmp, 'web.sqlite'));
      const s = store;
      const { previewId, runId, digest } = seedApprovedPreview(s, [
        { fieldName: 'title', newValue: 'Engineer' },
        { fieldName: 'officeClassroom', newValue: 'Room 1' },
      ]);
      const target = new Target();
      const writer = {
        async setCustomerDetail(_id: string, field: string, value: string) {
          target.details = { ...target.details, [field]: value };
          s.updateSetting('paused', 'true', null); // admin presses pause after the first write
          return { statusCode: 200 };
        },
      };
      const directory = {
        getPeople: async () => [
          { ...person('a@example.com', 'Engineer'), officeLocation: 'Room 1' },
        ],
      };
      const service = new ProductionSyncWriterService(
        directory,
        target as unknown as ReadOnlyJiraCustomerTarget,
        writer as unknown as JiraCustomerDetailWriteClient,
        s,
        new NotificationService(s),
        { writeMinIntervalMs: 0 },
      );
      const result = await service.executeLiveRollout({
        runId,
        previewRunId: previewId,
        approvalDigest: digest,
      });
      expect(result.status).toBe('PAUSED');
      expect(result.records[0]?.status).toBe('PARTIAL');
      expect(result.totalVerifiedFields).toBe(1);
    });

    it('stops with OUTCOME_UNKNOWN when a write gets no answer, and keeps the record', async () => {
      store = new WebStore(path.join(tmp, 'web.sqlite'));
      const { previewId, runId, digest } = seedApprovedPreview(store, [
        { fieldName: 'title', newValue: 'Engineer' },
      ]);
      const writer = {
        async setCustomerDetail() {
          throw new JiraWriteOutcomeUnknownError('timed out');
        },
      };
      const service = new ProductionSyncWriterService(
        { getPeople: async () => [person('a@example.com', 'Engineer')] },
        new Target() as unknown as ReadOnlyJiraCustomerTarget,
        writer as unknown as JiraCustomerDetailWriteClient,
        store,
        new NotificationService(store),
        { writeMinIntervalMs: 0 },
      );
      const result = await service.executeLiveRollout({
        runId,
        previewRunId: previewId,
        approvalDigest: digest,
      });
      expect(result.status).toBe('FAILED');
      expect(result.records[0]?.appliedFields[0]?.status).toBe('OUTCOME_UNKNOWN');
      expect(store.getRun(runId, true)?.details).toBeTruthy();
    });

    it('explains a 401 write rejection as a missing Jira permission', async () => {
      store = new WebStore(path.join(tmp, 'web.sqlite'));
      const { previewId, runId, digest } = seedApprovedPreview(store, [
        { fieldName: 'emailAddress', newValue: 'a@example.com' },
      ]);
      const writer = {
        async setCustomerDetail() {
          throw new JiraHttpError('Jira customer detail update failed with status 401', 401);
        },
      };
      const target = new Target();
      target.details = { email: 'a@example.com' };
      const service = new ProductionSyncWriterService(
        { getPeople: async () => [person('a@example.com', null)] },
        target as unknown as ReadOnlyJiraCustomerTarget,
        writer as unknown as JiraCustomerDetailWriteClient,
        store,
        new NotificationService(store),
        { writeMinIntervalMs: 0 },
      );
      const result = await service.executeLiveRollout({
        runId,
        previewRunId: previewId,
        approvalDigest: digest,
      });
      expect(result.status).toBe('FAILED');
      expect(result.stopReason).toContain('Reconnect Jira');
      expect(result.records[0]?.appliedFields[0]?.errorMessage).toContain('not permitted');
    });

    it('refuses an update before any write when the Jira connection lacks the write permission', async () => {
      const config = loadWebConfig(
        {
          NODE_ENV: 'test',
          PUBLIC_BASE_URL: 'http://127.0.0.1:8080',
          WEB_DATA_DIR: path.join(tmp, 'data'),
          WEB_SECRETS_DIR: path.join(tmp, 'secrets'),
          ADMIN_INITIAL_PASSWORD: 'bootstrap-password-123',
          ATLASSIAN_OAUTH_CLIENT_ID: 'client',
          ATLASSIAN_OAUTH_CLIENT_SECRET: 'secret',
          JSM_SERVICE_DESK_IDS: '1',
          JIRA_WRITE_SCOPE_ALLOWED: 'true',
        },
        tmp,
      );
      // Allowing updates requests the write scope without listing it in ATLASSIAN_OAUTH_SCOPES.
      expect(config.oauthScopes).toContain('write:customer.detail:jira-service-management');

      fs.mkdirSync(config.secretsDir, { recursive: true });
      const now = new Date().toISOString();
      new OAuthTokenStore({
        tokenPath: config.tokenPath,
        allowedDir: config.secretsDir,
      }).writeTokenRecord({
        schemaVersion: 1,
        tokenType: 'Bearer',
        accessToken: 'access',
        refreshToken: 'refresh',
        accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
        // A connection made before updates were allowed: read scopes only.
        scopes: config.oauthScopes.filter((s) => !s.startsWith('write:')),
        createdAt: now,
        updatedAt: now,
      });

      store = new WebStore(path.join(tmp, 'web.sqlite'));
      const { previewId, runId, digest } = seedApprovedPreview(store, [
        { fieldName: 'title', newValue: 'Engineer' },
      ]);
      const methods: string[] = [];
      const fetchFn = (async (_input: string | URL | Request, init?: RequestInit) => {
        methods.push(init?.method ?? 'GET');
        return jsonResponse({ message: 'unexpected' }, 404);
      }) as typeof fetch;
      const services = createWebServices(config, store, new RunTracker(), {
        oauthFetchFn: fetchFn,
        directorySource: { getPeople: async () => [person('a@example.com', 'Engineer')] },
      });

      expect(services.jiraWritePermission()).toEqual({ allowedByConfig: true, granted: false });
      expect(services.oauthStatus().requiredScopesGranted).toBe(false);
      await expect(
        services.writerService.executeLiveRollout({
          runId,
          previewRunId: previewId,
          approvalDigest: digest,
        }),
      ).rejects.toThrow('Reconnect Jira');
      expect(methods).not.toContain('PUT');
      expect(store.getRun(runId)?.status).toBe('FAILED');
    });

    it('refuses a preview whose details are no longer available instead of completing with no writes', async () => {
      store = new WebStore(path.join(tmp, 'web.sqlite'));
      const { previewId, runId, digest } = seedApprovedPreview(store, [
        { fieldName: 'title', newValue: 'x' },
      ]);
      store.updateRun(previewId, { details: null });
      const service = new ProductionSyncWriterService(
        { getPeople: async () => [] },
        new Target() as unknown as ReadOnlyJiraCustomerTarget,
        {} as JiraCustomerDetailWriteClient,
        store,
        new NotificationService(store),
      );
      await expect(
        service.executeLiveRollout({ runId, previewRunId: previewId, approvalDigest: digest }),
      ).rejects.toThrow('no longer available');
      expect(store.getRun(runId)?.status).toBe('FAILED');
      expect(store.hasSuccessfulManualRollout()).toBe(false);
    });
  });

  describe('preview', () => {
    it('refuses to run while syncing is paused', async () => {
      store = new WebStore(path.join(tmp, 'web.sqlite'));
      store.updateSettings({ approved_email_domains: 'example.com', paused: true }, null);
      const runId = store.createRun({
        runType: 'PREVIEW',
        triggerSource: 'MANUAL',
        scopeServiceDeskIds: ['1'],
      });
      const service = new ProductionSyncPreviewService(
        { getPeople: async () => [] },
        { async *listExistingCustomers() {} },
        {} as ReadOnlyJiraCustomerTarget,
        store,
        new NotificationService(store),
      );
      await expect(service.executePreview({ runId, scopeServiceDeskIds: ['1'] })).rejects.toThrow(
        'paused',
      );
      expect(store.getRun(runId)?.status).toBe('FAILED');
    });
  });

  describe('scheduler', () => {
    const preview = {
      executed: 0,
      async executePreview(o: { runId: number }) {
        this.executed++;
        return {
          runId: o.runId,
          previewDigest: 'd',
          scopeServiceDeskIds: ['1'],
          totalEnumerated: 0,
          uniqueCustomers: 0,
          matchedEntraCustomers: 0,
          skippedCustomersCount: 0,
          proposedCustomerChangesCount: 1,
          proposedFieldChangesCount: 1,
          proposedChanges: [],
          skippedRecords: [],
        };
      },
    };

    function scheduler(s: WebStore, date: Date, writer: object = {}) {
      return new SchedulerService(
        s,
        preview as unknown as ProductionSyncPreviewService,
        writer as unknown as ProductionSyncWriterService,
        new NotificationService(s),
        { scopeServiceDeskIds: ['1'], now: () => date },
      );
    }

    it('survives an unrecognized time zone without throwing', async () => {
      store = new WebStore(path.join(tmp, 'web.sqlite'));
      store.updateSettings({ schedule_timezone: 'Eastern' }, null);
      preview.executed = 0;
      await expect(
        scheduler(store, new Date('2026-10-02T12:00:00Z')).tick(),
      ).resolves.toBeUndefined();
      expect(preview.executed).toBe(0);
    });

    it('honors the month in a once-a-year schedule', () => {
      expect(parseSupportedSchedule('0 2 1 6 *')?.month).toBe(6);
    });

    it('does not run a June-only schedule in October', async () => {
      store = new WebStore(path.join(tmp, 'web.sqlite'));
      store.updateSettings({ schedule_cron: '0 2 1 6 *', schedule_timezone: 'UTC' }, null);
      preview.executed = 0;
      await scheduler(store, new Date('2026-10-01T03:00:00Z')).tick();
      expect(preview.executed).toBe(0);
    });

    it('links a scheduled update to the preview it applies', async () => {
      store = new WebStore(path.join(tmp, 'web.sqlite'));
      store.updateSettings(
        {
          schedule_timezone: 'UTC',
          commissioning_status: 'COMMISSIONED_AUTOMATED',
          automation_enabled: true,
          writes_enabled: true,
        },
        null,
      );
      const seen: Array<{ runId: number; previewRunId: number }> = [];
      const writer = {
        async executeLiveRollout(o: { runId: number; previewRunId: number }) {
          seen.push(o);
          return {};
        },
      };
      await scheduler(store, new Date('2026-10-02T03:00:00Z'), writer).tick();
      expect(seen).toHaveLength(1);
      expect(store.getRun(seen[0]!.runId)?.previewRunId).toBe(seen[0]!.previewRunId);
    });

    it('defers instead of skipping the window when another run holds the lock', async () => {
      store = new WebStore(path.join(tmp, 'web.sqlite'));
      store.updateSettings({ schedule_timezone: 'UTC' }, null);
      const other = store.createRun({
        runType: 'PREVIEW',
        triggerSource: 'MANUAL',
        scopeServiceDeskIds: ['1'],
      });
      store.acquireRunLock(other, 'manual');
      preview.executed = 0;
      const s = scheduler(store, new Date('2026-10-02T03:00:00Z'));
      await s.tick();
      expect(preview.executed).toBe(0);
      store.releaseRunLock(other);
      await s.tick();
      expect(preview.executed).toBe(1);
    });
  });

  describe('store', () => {
    it('keeps a saved 23:15 schedule across restarts', () => {
      const file = path.join(tmp, 'web.sqlite');
      store = new WebStore(file);
      store.updateSettings({ schedule_cron: '15 23 * * *' }, null);
      store.close();
      store = new WebStore(file);
      expect(store.getSettings().schedule_cron).toBe('15 23 * * *');
    });

    it('defaults new installations to UTC', () => {
      store = new WebStore(path.join(tmp, 'web.sqlite'));
      expect(store.getSettings().schedule_timezone).toBe('UTC');
    });

    it('never writes webhook URLs or SMTP passwords to the audit log, and skips unchanged values', () => {
      store = new WebStore(path.join(tmp, 'web.sqlite'));
      store.updateSettings({ webhook_url: 'https://hooks.example.com/secret-token' }, null);
      store.setSmtpPassword('smtp-secret-value', null);
      store.updateSettings({ webhook_url: 'https://hooks.example.com/secret-token' }, null);
      const audit = store.db.prepare('SELECT outcome FROM audit_events').all() as Array<{
        outcome: string;
      }>;
      const text = JSON.stringify(audit);
      expect(text).not.toContain('secret-token');
      expect(text).not.toContain('smtp-secret-value');
      expect(audit.filter((a) => a.outcome.startsWith('webhook_url'))).toHaveLength(1);
      expect(store.getSmtpPassword()).toBe('smtp-secret-value');
      expect(store.getSettings().smtp_password_set).toBe(true);
    });

    it('records a schema version and upgrades databases created before versioning', () => {
      const file = path.join(tmp, 'legacy.sqlite');
      store = new WebStore(file);
      store.db.exec('DROP TABLE schema_version');
      store.close();
      store = new WebStore(file);
      const row = store.db.prepare('SELECT version FROM schema_version').get() as {
        version: number;
      };
      expect(row.version).toBeGreaterThanOrEqual(1);
    });
  });

  describe('password hashing', () => {
    it('verifies legacy hashes and flags them for an upgrade', () => {
      const salt = randomBytes(16).toString('hex');
      const legacy = `scrypt$${salt}$${scryptSync('correct horse battery', salt, 64, { cost: 1024 }).toString('hex')}`;
      expect(verifyPassword('correct horse battery', legacy)).toBe(true);
      expect(passwordNeedsRehash(legacy)).toBe(true);
    });
  });

  describe('redirects', () => {
    it('never redirects to another site from a crafted Referer', () => {
      const policy = createOriginPolicy(
        loadWebConfig({ PUBLIC_BASE_URL: 'http://127.0.0.1:8080' }),
      );
      expect(policy.safeRedirectPath('http://127.0.0.1:8080//evil.example.com/x')).toBeUndefined();
      expect(policy.safeRedirectPath('http://127.0.0.1:8080/runs?x=1')).toBe('/runs?x=1');
      expect(policy.safeRedirectPath('https://evil.example.com/runs')).toBeUndefined();
    });
  });

  describe('Jira site selection', () => {
    it('fails closed when the token reaches several sites and none is configured', async () => {
      const dir = path.join(tmp, 'secrets');
      fs.mkdirSync(dir);
      const tokenStore = new OAuthTokenStore({
        tokenPath: path.join(dir, 't.json'),
        allowedDir: dir,
      });
      const now = new Date().toISOString();
      tokenStore.writeTokenRecord({
        schemaVersion: 1,
        tokenType: 'Bearer',
        accessToken: 'a',
        refreshToken: 'r',
        accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
        scopes: ['offline_access', 'read:servicedesk.customer:jira-service-management'],
        createdAt: now,
        updatedAt: now,
      });
      const provider = new OAuth3LoJiraAuthProvider({
        clientId: 'c',
        clientSecret: 's',
        tokenStore,
        fetchFn: (async () =>
          jsonResponse([
            { id: '1', url: 'https://one.atlassian.net', name: 'one', scopes: [] },
            { id: '2', url: 'https://two.atlassian.net', name: 'two', scopes: [] },
          ])) as typeof fetch,
      });
      await expect(provider.getCloudId()).rejects.toThrow('more than one site');
      await expect(provider.getCloudId('https://two.atlassian.net')).resolves.toBe('2');
    });
  });

  describe('customer enumeration', () => {
    it('keeps paging when Jira says more pages remain even if a page is short', async () => {
      const pages = [
        { values: [{ accountId: 'a' }], isLastPage: false },
        { values: [{ accountId: 'b' }], isLastPage: true },
      ];
      let call = 0;
      const http = new GetOnlyJiraHttpClient(
        { getAuthHeader: async () => 'Bearer x' },
        { fetchFn: (async () => jsonResponse(pages[call++])) as typeof fetch },
      );
      const reader = new JiraServiceDeskCustomerScopeReader({
        cloudId: 'cloud',
        httpClient: http,
        serviceDeskIds: ['1'],
        authMode: 'oauth-3lo',
        pageSize: 50,
      });
      const ids: string[] = [];
      for await (const c of reader.listExistingCustomers()) ids.push(c.sourceCustomerId);
      expect(ids).toEqual(['a', 'b']);
    });
  });

  describe('SMTP', () => {
    function fakeServer(capabilities: string[], log: string[]): Promise<net.Server> {
      return new Promise((resolve) => {
        const server = net.createServer((socket) => {
          let data = false;
          socket.write('220 test ready\r\n');
          socket.on('data', (chunk) => {
            for (const line of chunk.toString().split('\r\n').filter(Boolean)) {
              log.push(line);
              if (data) {
                if (line === '.') {
                  data = false;
                  socket.write('250 queued\r\n');
                }
                continue;
              }
              if (line.startsWith('EHLO')) {
                socket.write(
                  ['250-test', ...capabilities.map((c) => `250-${c}`), '250 OK'].join('\r\n') +
                    '\r\n',
                );
              } else if (line.startsWith('AUTH PLAIN')) socket.write('235 ok\r\n');
              else if (line === 'DATA') {
                data = true;
                socket.write('354 go\r\n');
              } else if (line === 'QUIT') socket.end('221 bye\r\n');
              else socket.write('250 ok\r\n');
            }
          });
        });
        server.listen(0, '127.0.0.1', () => resolve(server));
      });
    }

    it('signs in and delivers to a loopback relay', async () => {
      const log: string[] = [];
      const server = await fakeServer(['AUTH PLAIN LOGIN'], log);
      const port = (server.address() as net.AddressInfo).port;
      try {
        await sendSmtpMessage({
          host: '127.0.0.1',
          port,
          from: 'alerts@example.com',
          to: ['ops@example.com'],
          subject: 'Hi\r\nBcc: injected@example.com',
          body: '.hidden line',
          username: 'user',
          password: 'pass',
          requireTls: false,
        });
      } finally {
        server.close();
      }
      expect(log.some((l) => l.startsWith('EHLO '))).toBe(true);
      expect(log.some((l) => l.startsWith('AUTH PLAIN '))).toBe(true);
      expect(log).toContain('..hidden line');
      expect(log.some((l) => l.startsWith('Bcc:'))).toBe(false);
    });

    it('refuses to send without encryption to a relay that requires it', async () => {
      const log: string[] = [];
      const server = await fakeServer([], log);
      const port = (server.address() as net.AddressInfo).port;
      try {
        await expect(
          sendSmtpMessage({
            host: '127.0.0.1',
            port,
            from: 'alerts@example.com',
            to: ['ops@example.com'],
            subject: 's',
            body: 'b',
            requireTls: true,
          }),
        ).rejects.toThrow('STARTTLS');
      } finally {
        server.close();
      }
      expect(log.some((l) => l.startsWith('MAIL FROM'))).toBe(false);
    });

    it('rejects addresses that could inject SMTP commands', () => {
      expect(isSafeEmailAddress('ops@example.com')).toBe(true);
      expect(isSafeEmailAddress('ops@example.com>\r\nRCPT TO:<x@y.z')).toBe(false);
      expect(dotStuff('a\n.b')).toBe('a\r\n..b');
    });
  });
});
