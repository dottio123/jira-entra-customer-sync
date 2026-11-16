import {
  GetOnlyJiraHttpClient,
  IJiraAuthProvider,
  JiraCustomerDetailWriteClient,
  JiraServiceDeskCustomerScopeReader,
  OAuth3LoJiraAuthProvider,
  OAuthStatusReport,
  OAuthTokenStore,
  ReadOnlyJiraCustomerTarget,
  RequestBudgetGuard,
  inspectOAuthStatus,
} from '../connectors/jira';
import { AzureMicrosoftGraphClient, EntraDirectorySource } from '../connectors/entra';
import { PILOT_WRITE_OAUTH_SCOPE } from '../config';
import { DirectorySourcePort, ExistingCustomerScopeReaderPort } from '../domain';
import { NotificationService } from '../services/notification-service';
import { ProductionSyncPreviewService } from '../services/production-sync-preview-service';
import { ProductionSyncWriterService } from '../services/production-sync-writer-service';
import { SchedulerService } from '../services/scheduler-service';
import { DiffPlanner } from '../services/diff-planner';
import { MappingService } from '../services/mapping-service';
import { logger } from '../utils/logger';
import { WebConfig } from './config';
import { RunTracker } from './run-tracker';
import { WebStore } from './store';

export interface WiringOptions {
  oauthFetchFn?: typeof fetch;
  notificationFetchFn?: typeof fetch;
  directorySource?: DirectorySourcePort;
  scopeReader?: ExistingCustomerScopeReaderPort;
  jiraTarget?: ReadOnlyJiraCustomerTarget;
  jiraWriter?: JiraCustomerDetailWriteClient;
}

export interface WebServices {
  tokenStore: OAuthTokenStore;
  notificationService: NotificationService;
  previewService: ProductionSyncPreviewService;
  writerService: ProductionSyncWriterService;
  schedulerService: SchedulerService;
  oauthStatus(): OAuthStatusReport;
  /** Whether updates are permitted by configuration and granted on the saved Jira connection. */
  jiraWritePermission(): { allowedByConfig: boolean; granted: boolean };
}

/**
 * Request ceilings for a single run. They bound runaway loops; they never truncate scope:
 * a run that reaches a ceiling fails closed rather than finishing with partial data.
 */
function createRunBudgetGuard(): RequestBudgetGuard {
  return new RequestBudgetGuard({
    global: 50_000,
    customerProfile: 20_000,
    userSearch: 100,
    customerEnumerationPage: 2_000,
    customerDetailWrite: 10_000,
    fieldDiscovery: 5,
    cloudIdDiscovery: 5,
  });
}

/** Directory used when Microsoft Graph credentials are missing: every read fails clearly. */
const unconfiguredDirectory: DirectorySourcePort = {
  async getPeople() {
    throw new Error(
      'Microsoft Entra ID is not configured. Set MICROSOFT_TENANT_ID, MICROSOFT_CLIENT_ID, and MICROSOFT_CLIENT_SECRET, then restart the service.',
    );
  },
};

export function createWebServices(
  config: WebConfig,
  store: WebStore,
  runs: RunTracker,
  options: WiringOptions = {},
): WebServices {
  const tokenStore = new OAuthTokenStore({
    tokenPath: config.tokenPath,
    allowedDir: config.secretsDir,
  });

  const authProvider: IJiraAuthProvider =
    config.oauthClientId && config.oauthClientSecret
      ? new OAuth3LoJiraAuthProvider({
          clientId: config.oauthClientId,
          clientSecret: config.oauthClientSecret,
          tokenStore,
          fetchFn: options.oauthFetchFn,
        })
      : {
          getAuthHeader: async () => {
            throw new Error('Atlassian OAuth credentials are not configured.');
          },
        };

  const siteUrl = config.atlassianSiteUrl ?? 'https://api.atlassian.com';
  const resolveCloudId = async (): Promise<string> => {
    if (config.atlassianCloudId) return config.atlassianCloudId;
    if (authProvider instanceof OAuth3LoJiraAuthProvider) {
      return authProvider.getCloudId(config.atlassianSiteUrl);
    }
    throw new Error('Atlassian OAuth credentials are not configured.');
  };

  const requireJiraConnection = (): void => {
    if (!tokenStore.hasTokenRecord()) {
      throw new Error(
        'Atlassian Jira is not connected. Connect Jira under Connections before running a preview or update.',
      );
    }
  };

  const newHttpClient = (budgetGuard: RequestBudgetGuard) =>
    new GetOnlyJiraHttpClient(authProvider, {
      budgetGuard,
      log: logger,
      fetchFn: options.oauthFetchFn,
    });

  // Factories are called once per run, so request budgets and field discovery are per run.
  const scopeReader = (): ExistingCustomerScopeReaderPort => {
    if (options.scopeReader) return options.scopeReader;
    requireJiraConnection();
    if (config.serviceDeskIds.length === 0) {
      throw new Error('No Jira service desk is configured. Set JSM_SERVICE_DESK_IDS.');
    }
    const budgetGuard = createRunBudgetGuard();
    return new JiraServiceDeskCustomerScopeReader({
      siteUrl,
      cloudId: resolveCloudId,
      authMode: 'oauth-3lo',
      httpClient: newHttpClient(budgetGuard),
      serviceDeskIds: config.serviceDeskIds,
      budgetGuard,
    });
  };

  const jiraTarget = (): ReadOnlyJiraCustomerTarget => {
    if (options.jiraTarget) return options.jiraTarget;
    requireJiraConnection();
    const budgetGuard = createRunBudgetGuard();
    return new ReadOnlyJiraCustomerTarget({
      siteUrl,
      cloudId: resolveCloudId,
      httpClient: newHttpClient(budgetGuard),
      budgetGuard,
    });
  };

  // Checked before an update starts, so a connection without write permission fails clearly
  // instead of every write being rejected by Jira with 401.
  const requireWritePermission = (): void => {
    if (!config.oauthWriteScopeAllowed) {
      throw new Error(
        'Updates to Jira are not permitted by the service configuration. Set JIRA_WRITE_SCOPE_ALLOWED=true, restart the service, then reconnect Jira under Connections.',
      );
    }
    if (!writeScopeGranted()) {
      throw new Error(
        'The Jira connection does not include permission to update customer details. Choose Reconnect Jira under Connections and accept all permissions.',
      );
    }
  };

  const writeScopeGranted = (): boolean => {
    try {
      return tokenStore.readTokenRecord().scopes.includes(PILOT_WRITE_OAUTH_SCOPE);
    } catch {
      return false;
    }
  };

  const jiraWriter = (): JiraCustomerDetailWriteClient => {
    if (options.jiraWriter) return options.jiraWriter;
    requireJiraConnection();
    requireWritePermission();
    return new JiraCustomerDetailWriteClient({
      authProvider,
      cloudId: resolveCloudId,
      budgetGuard: createRunBudgetGuard(),
      fetchFn: options.oauthFetchFn,
    });
  };

  const directorySource =
    options.directorySource ??
    (config.graph
      ? new EntraDirectorySource(new AzureMicrosoftGraphClient(config.graph))
      : unconfiguredDirectory);

  const notificationService = new NotificationService(store, {
    fetchFn: options.notificationFetchFn,
  });
  const shouldStop = () => runs.isStopping;

  const previewService = new ProductionSyncPreviewService(
    directorySource,
    scopeReader,
    jiraTarget,
    store,
    notificationService,
    new DiffPlanner(),
    new MappingService(),
    logger,
    { shouldStop },
  );

  const writerService = new ProductionSyncWriterService(
    directorySource,
    jiraTarget,
    jiraWriter,
    store,
    notificationService,
    { shouldStop },
  );

  const schedulerService = new SchedulerService(
    store,
    previewService,
    writerService,
    notificationService,
    { scopeServiceDeskIds: config.serviceDeskIds },
  );

  return {
    tokenStore,
    notificationService,
    previewService,
    writerService,
    schedulerService,
    oauthStatus: () =>
      inspectOAuthStatus({
        authenticationMode: 'oauth-3lo',
        clientId: config.oauthClientId,
        clientSecret: config.oauthClientSecret,
        scopes: config.oauthScopes,
        tokenStore,
      }),
    jiraWritePermission: () => ({
      allowedByConfig: config.oauthWriteScopeAllowed,
      granted: writeScopeGranted(),
    }),
  };
}
