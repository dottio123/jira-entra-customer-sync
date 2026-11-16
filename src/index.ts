import { APP_VERSION } from './version';
import { loadConfig, PILOT_WRITE_OAUTH_SCOPE } from './config';
import { logger, extractSanitizedErrorCode } from './utils';
import { DirectoryPerson, CustomerDetails, SyncSummary, DirectorySourcePort } from './domain';
import { InMemoryDirectorySource, InMemoryCustomerTarget } from './connectors/memory';
import { EntraDirectorySource, AzureMicrosoftGraphClient } from './connectors/entra';
import * as fs from 'fs';
import {
  IJiraAuthProvider,
  BasicJiraAuthProvider,
  OAuth3LoJiraAuthProvider,
  OAuthTokenStore,
  GetOnlyJiraHttpClient,
  JiraCustomerDetailWriteClient,
  JiraHttpError,
  JiraUserSearchResolver,
  JsmServiceDeskCustomerResolver,
  ReadOnlyJiraCustomerTarget,
  JiraServiceDeskCustomerScopeReader,
  RequestBudgetGuard,
  DiscoveredFieldReport,
} from './connectors/jira';
import {
  SyncService,
  SingleCustomerValidator,
  SingleCustomerValidationReport,
  CustomerEnumerationValidator,
  CustomerEnumerationValidationReport,
  EndToEndDryRunService,
  EndToEndDryRunReport,
  JiraFirstDryRunService,
  JiraFirstDryRunReport,
  DiffPlanner,
  MappingService,
  AuthenticationInvestigationService,
  AuthenticationInvestigationReport,
  PilotCustomerWriteService,
  PilotCustomerWriteReport,
  BoundedRolloutWriteService,
  BoundedRolloutWriteReport,
} from './services';

export interface StartupResult {
  success: boolean;
  message: string;
  environment: string;
  dryRun: boolean;
  directorySourceType: string;
  summary?: SyncSummary;
  discoveryReport?: DiscoveredFieldReport;
  singleCustomerReport?: SingleCustomerValidationReport;
  enumerationValidationReport?: CustomerEnumerationValidationReport;
  authInvestigationReport?: AuthenticationInvestigationReport;
  endToEndDryRunReport?: EndToEndDryRunReport | JiraFirstDryRunReport;
  pilotCustomerWriteReport?: PilotCustomerWriteReport;
  boundedRolloutWriteReport?: BoundedRolloutWriteReport;
}

/**
 * Creates the appropriate Jira authentication provider based strictly on configured authMode.
 * When oauth-3lo is selected, uses Bearer authentication with OAuth3LoJiraAuthProvider.
 * When other modes are selected, uses BasicJiraAuthProvider and never touches OAuth token records.
 */
function createJiraAuthProvider(config: ReturnType<typeof loadConfig>): IJiraAuthProvider {
  if (config.jira.authMode === 'oauth-3lo') {
    const tokenStore = new OAuthTokenStore({
      tokenPath: config.jira.oauth.tokenPath,
      allowCustomPath: config.environment === 'test',
    });
    return new OAuth3LoJiraAuthProvider({
      clientId: config.jira.oauth.clientId,
      clientSecret: config.jira.oauth.clientSecret,
      tokenStore,
      log: logger,
    });
  }

  return new BasicJiraAuthProvider(config.jira.userEmail, config.jira.apiToken);
}

/**
 * Executes application initialization and either:
 * 1. Customer enumeration validation (when JIRA_VALIDATE_CUSTOMER_ENUMERATION=true)
 * 2. Single customer identity and profile validation (when JIRA_VALIDATE_EXISTING_CUSTOMER=true)
 * 3. End-to-end dry-run planning (when END_TO_END_DRY_RUN=true, scope controlled by SYNC_SCOPE_SOURCE)
 * 4. Jira customer detail field discovery (when DISCOVERY_ONLY=true)
 * 5. Synchronization demonstration (using Entra or in-memory directory, with in-memory target)
 */
export async function runStartup(): Promise<StartupResult> {
  try {
    const config = loadConfig();
    logger.setLevel(config.logging.level);

    const jiraConfigured = Boolean(config.jira.siteUrl && config.jira.siteUrl.trim().length > 0);
    const cloudIdConfigured = Boolean(
      config.jira.cloudId &&
      config.jira.cloudId.trim().length > 0 &&
      !config.jira.cloudId.startsWith('placeholder'),
    );

    const isOAuthMode = config.jira.authMode === 'oauth-3lo';
    const oauthConfigured = Boolean(
      config.jira.oauth &&
      config.jira.oauth.clientId &&
      config.jira.oauth.clientId.trim().length > 0 &&
      !config.jira.oauth.clientId.startsWith('placeholder') &&
      config.jira.oauth.clientSecret &&
      config.jira.oauth.clientSecret.trim().length > 0 &&
      !config.jira.oauth.clientSecret.startsWith('placeholder') &&
      config.jira.oauth.tokenPath &&
      fs.existsSync(config.jira.oauth.tokenPath),
    );

    const authenticationConfigured = isOAuthMode
      ? oauthConfigured
      : Boolean(
          config.jira.userEmail &&
          config.jira.userEmail.trim().length > 0 &&
          !config.jira.userEmail.startsWith('service-account@placeholder') &&
          config.jira.apiToken &&
          config.jira.apiToken.trim().length > 0 &&
          !config.jira.apiToken.startsWith('placeholder'),
        );
    const entraConfigured = Boolean(
      config.entra.tenantId &&
      config.entra.tenantId.trim().length > 0 &&
      !config.entra.tenantId.startsWith('placeholder') &&
      config.entra.clientId &&
      config.entra.clientId.trim().length > 0 &&
      !config.entra.clientId.startsWith('placeholder') &&
      config.entra.clientSecret &&
      config.entra.clientSecret.trim().length > 0 &&
      !config.entra.clientSecret.startsWith('placeholder'),
    );

    logger.info('Application started successfully', {
      service: 'entra-jsm-customer-sync',
      version: APP_VERSION,
      status: 'ready',
      environment: config.environment,
      jiraConfigured,
      cloudIdConfigured,
      authenticationConfigured,
      authMode: config.jira.authMode,
      ...(isOAuthMode ? { oauthConfigured } : {}),
      entraConfigured,
      dryRun: config.sync.dryRun,
      directorySource: config.sync.directorySource,
      customerTarget: config.sync.customerTarget,
      discoveryOnly: config.sync.discoveryOnly,
      validateExistingCustomer: config.sync.validateExistingCustomer,
      validateCustomerEnumeration: config.sync.validateCustomerEnumeration,
      syncScopeSource: config.sync.syncScopeSource,
      serviceDeskIdsConfigured: config.sync.jsmServiceDeskIds.length > 0,
      endToEndDryRun: config.sync.endToEndDryRun,
      pilotWriteEnabled: config.sync.pilotWriteEnabled,
      rolloutWriteEnabled: config.sync.rolloutWriteEnabled,
      rolloutPreflightOnly: config.sync.rolloutPreflightOnly,
      notice: config.sync.rolloutPreflightOnly
        ? 'Validating bounded rollout approval in read-only preflight mode.'
        : config.sync.rolloutWriteEnabled
          ? 'Executing explicitly approved bounded Jira customer-detail rollout.'
          : config.sync.pilotWriteEnabled
            ? 'Executing explicitly enabled single-customer, single-field Jira pilot write.'
            : config.sync.investigateAuth
              ? 'Executing Jira authentication investigation probe against configured service desk.'
              : config.sync.validateCustomerEnumeration
                ? 'Executing Jira customer enumeration validation against configured service desk.'
                : config.sync.endToEndDryRun
                  ? config.sync.syncScopeSource === 'jira'
                    ? 'Executing Jira-first end-to-end dry-run planning.'
                    : 'Executing Entra-first end-to-end dry-run planning.'
                  : config.sync.validateExistingCustomer
                    ? 'Executing single existing-customer validation against Jira CSM.'
                    : config.sync.discoveryOnly
                      ? 'Executing Jira customer detail field discovery only.'
                      : config.sync.directorySource === 'entra'
                        ? 'Executing with real Microsoft Graph directory source and in-memory customer target.'
                        : 'Executing with in-memory directory demonstration dataset and in-memory customer target.',
    });

    if (config.sync.rolloutWriteEnabled || config.sync.rolloutPreflightOnly) {
      const graphClient = new AzureMicrosoftGraphClient({
        tenantId: config.entra.tenantId,
        clientId: config.entra.clientId,
        clientSecret: config.entra.clientSecret,
      });
      const directorySource = new EntraDirectorySource(graphClient, {
        includeGuestUsers: config.entra.includeGuestUsers,
        managerLookupConcurrency: config.entra.managerLookupConcurrency,
        maxRetries: config.entra.maxRetries,
        retryDelayMs: config.entra.retryDelayMs,
        log: logger,
      });
      const maxWrites =
        config.sync.rolloutWriteMaxCustomers * config.sync.rolloutWriteMaxFieldsPerCustomer;
      const budgetGuard = new RequestBudgetGuard({
        cloudIdDiscovery: 1,
        fieldDiscovery: 1,
        customerEnumerationPage: Math.max(config.sync.jsmServiceDeskIds.length * 2, 4),
        customerProfile: config.sync.endToEndMaxRecords + maxWrites,
        customerDetailWrite: maxWrites,
        retry: 10,
        global: config.sync.endToEndMaxRecords + maxWrites * 2 + 20,
      });
      const authProvider = createJiraAuthProvider(config);
      const tokenStore = new OAuthTokenStore({ tokenPath: config.jira.oauth.tokenPath });
      if (!tokenStore.readTokenRecord().scopes.includes(PILOT_WRITE_OAUTH_SCOPE)) {
        throw new Error(
          `Bounded rollout write requires a consented OAuth token containing '${PILOT_WRITE_OAUTH_SCOPE}'.`,
        );
      }
      const readClient = new GetOnlyJiraHttpClient(authProvider, {
        maxRetries: config.jira.maxRetries,
        retryDelayMs: config.jira.retryDelayMs,
        budgetGuard,
        log: logger,
      });
      const jiraReader = new ReadOnlyJiraCustomerTarget({
        cloudId: config.jira.cloudId,
        siteUrl: config.jira.siteUrl,
        httpClient: readClient,
        budgetGuard,
        log: logger,
      });
      const scopeReader = new JiraServiceDeskCustomerScopeReader({
        cloudId: () => jiraReader.ensureCloudId(),
        siteUrl: config.jira.siteUrl,
        httpClient: readClient,
        serviceDeskIds: config.sync.jsmServiceDeskIds,
        authMode: config.jira.authMode,
        budgetGuard,
        log: logger,
      });
      const jiraWriter = new JiraCustomerDetailWriteClient({
        authProvider,
        cloudId: () => jiraReader.ensureCloudId(),
        budgetGuard,
        log: logger,
      });
      const rolloutService = new BoundedRolloutWriteService(
        directorySource,
        scopeReader,
        jiraReader,
        jiraWriter,
        {
          maxRecords: config.sync.endToEndMaxRecords,
          maxCustomers: config.sync.rolloutWriteMaxCustomers,
          maxFieldsPerCustomer: config.sync.rolloutWriteMaxFieldsPerCustomer,
          writeMinIntervalMs: config.sync.rolloutWriteMinIntervalMs,
          approvedReportPath: config.sync.rolloutApprovedReportPath!,
          approvedReportSha256: config.sync.rolloutApprovedReportSha256!,
          reportPath: config.sync.rolloutWriteReportPath,
          preflightOnly: config.sync.rolloutPreflightOnly,
        },
        new DiffPlanner(),
        new MappingService(),
        logger,
      );
      const boundedRolloutWriteReport = await rolloutService.execute();
      return {
        success: boundedRolloutWriteReport.success,
        message: boundedRolloutWriteReport.success
          ? 'Bounded Jira customer-detail rollout completed and verified.'
          : `Bounded rollout stopped: ${boundedRolloutWriteReport.failureReason ?? 'unsuccessful'}.`,
        environment: config.environment,
        dryRun: config.sync.rolloutPreflightOnly,
        directorySourceType: config.sync.directorySource,
        boundedRolloutWriteReport,
      };
    }

    if (config.sync.pilotWriteEnabled) {
      const graphClient = new AzureMicrosoftGraphClient({
        tenantId: config.entra.tenantId,
        clientId: config.entra.clientId,
        clientSecret: config.entra.clientSecret,
      });
      const directorySource = new EntraDirectorySource(graphClient, {
        includeGuestUsers: config.entra.includeGuestUsers,
        managerLookupConcurrency: config.entra.managerLookupConcurrency,
        maxRetries: config.entra.maxRetries,
        retryDelayMs: config.entra.retryDelayMs,
        log: logger,
      });
      const budgetGuard = new RequestBudgetGuard({
        cloudIdDiscovery: 1,
        fieldDiscovery: 1,
        userSearch: Math.max(config.sync.jsmServiceDeskIds.length * 10, 25),
        customerProfile: 2,
        customerDetailWrite: 1,
        retry: 10,
        global: 50,
      });
      const authProvider = createJiraAuthProvider(config);
      const tokenStore = new OAuthTokenStore({ tokenPath: config.jira.oauth.tokenPath });
      const tokenRecord = tokenStore.readTokenRecord();
      const requiredWriteScope = PILOT_WRITE_OAUTH_SCOPE;
      if (!tokenRecord.scopes.includes(requiredWriteScope)) {
        throw new Error(
          `Pilot write requires a newly consented OAuth token containing '${requiredWriteScope}'.`,
        );
      }

      const readClient = new GetOnlyJiraHttpClient(authProvider, {
        maxRetries: config.jira.maxRetries,
        retryDelayMs: config.jira.retryDelayMs,
        budgetGuard,
        log: logger,
      });
      const jiraReader = new ReadOnlyJiraCustomerTarget({
        cloudId: config.jira.cloudId,
        siteUrl: config.jira.siteUrl,
        httpClient: readClient,
        budgetGuard,
        log: logger,
      });
      const identityResolver = new JsmServiceDeskCustomerResolver({
        cloudId: () => jiraReader.ensureCloudId(),
        siteUrl: config.jira.siteUrl,
        httpClient: readClient,
        serviceDeskIds: config.sync.jsmServiceDeskIds,
        authMode: config.jira.authMode,
        budgetGuard,
        log: logger,
      });
      jiraReader.setIdentityResolver(identityResolver);
      const jiraWriter = new JiraCustomerDetailWriteClient({
        authProvider,
        cloudId: () => jiraReader.ensureCloudId(),
        budgetGuard,
        log: logger,
      });
      const writeService = new PilotCustomerWriteService(
        directorySource,
        jiraReader,
        identityResolver,
        jiraWriter,
        {
          pilotCustomerEmail: config.sync.pilotCustomerEmail!,
          maxFields: config.sync.pilotWriteMaxFields,
          reportPath: config.sync.pilotWriteReportPath,
        },
        new DiffPlanner(),
        new MappingService(),
        logger,
      );
      const pilotCustomerWriteReport = await writeService.execute();
      return {
        success: pilotCustomerWriteReport.success,
        message: pilotCustomerWriteReport.success
          ? 'Single-customer pilot write completed and verified.'
          : `Single-customer pilot write verification failed: ${pilotCustomerWriteReport.failureReason ?? 'unsuccessful'}.`,
        environment: config.environment,
        dryRun: false,
        directorySourceType: config.sync.directorySource,
        pilotCustomerWriteReport,
      };
    }

    // Mode 0: Authentication Investigation Mode
    if (config.sync.investigateAuth) {
      logger.info('Initiating Authentication Investigation Mode', {
        authMode: config.jira.authMode,
        dryRun: config.sync.dryRun,
      });

      const budgetGuard = new RequestBudgetGuard({
        customerEnumerationPage: 2,
        retry: 2,
      });

      const authProvider = createJiraAuthProvider(config);

      const httpClient = new GetOnlyJiraHttpClient(authProvider, {
        maxRetries: config.jira.maxRetries,
        retryDelayMs: config.jira.retryDelayMs,
        budgetGuard,
        log: logger,
      });

      let cachedCloudId: string | undefined;
      const investigationService = new AuthenticationInvestigationService({
        authMode: config.jira.authMode,
        serviceDeskId: config.sync.jsmServiceDeskIds[0] ?? '1',
        siteUrl: config.jira.siteUrl,
        cloudId: async () => {
          if (cachedCloudId) return cachedCloudId;
          if (config.jira.cloudId && !config.jira.cloudId.startsWith('placeholder')) {
            cachedCloudId = config.jira.cloudId;
            return cachedCloudId;
          }
          const target = new ReadOnlyJiraCustomerTarget({
            cloudId: config.jira.cloudId,
            siteUrl: config.jira.siteUrl,
            httpClient,
            budgetGuard,
            log: logger,
          });
          cachedCloudId = await target.ensureCloudId();
          return cachedCloudId;
        },
        httpClient,
        log: logger,
      });

      const authInvestigationReport = await investigationService.investigate();

      return {
        success: authInvestigationReport.supported,
        message: authInvestigationReport.supported
          ? 'Authentication investigation completed successfully: endpoint accessible.'
          : `Authentication investigation completed: endpoint rejected (${authInvestigationReport.failureReason ?? 'unsupported'}).`,
        environment: config.environment,
        dryRun: config.sync.dryRun,
        directorySourceType: config.sync.directorySource,
        authInvestigationReport,
      };
    }

    // Mode 1: Customer enumeration validation
    if (config.sync.validateCustomerEnumeration) {
      logger.info('Initiating Customer Enumeration Validation Mode', {
        target: config.sync.customerTarget,
        dryRun: config.sync.dryRun,
        authMode: config.jira.authMode,
      });

      if (config.jira.authMode !== 'oauth-3lo') {
        const errorMsg = `Customer enumeration requires JSM_API_AUTH_MODE=oauth-3lo. Received: '${config.jira.authMode}'.`;
        logger.error(errorMsg);
        return {
          success: false,
          message: errorMsg,
          environment: config.environment,
          dryRun: config.sync.dryRun,
          directorySourceType: config.sync.directorySource,
          enumerationValidationReport: {
            mode: 'CUSTOMER_ENUMERATION_VALIDATION',
            validatedAt: new Date().toISOString(),
            authenticationMode: config.jira.authMode,
            customerEnumerationSupported: false,
            jiraFirstDryRunAvailable: false,
            fallbackUsed: false,
            failureReason: 'ENUMERATION_AUTHENTICATION_UNSUPPORTED',
            errorMessage: errorMsg,
            pagesRetrieved: 0,
            customersEnumerated: 0,
            recordsWithUsableIdentifier: 0,
            recordsWithVisibleEmail: 0,
            recordsWithoutVisibleEmail: 0,
            duplicateIdentifierCount: 0,
            paginationCompleted: false,
            sanitizedAtlassianRequestId: null,
            sanitizedErrorCategory: 'AUTHENTICATION_MODE_MISMATCH',
            requestBudgetUsed: 0,
            retryCount: 0,
          },
        };
      }

      const budgetGuard = new RequestBudgetGuard({
        customerEnumerationPage: 5,
        retry: 5,
      });

      const authProvider = createJiraAuthProvider(config);

      const httpClient = new GetOnlyJiraHttpClient(authProvider, {
        maxRetries: config.jira.maxRetries,
        retryDelayMs: config.jira.retryDelayMs,
        budgetGuard,
        log: logger,
      });

      let cachedCloudId: string | undefined;
      const scopeReader = new JiraServiceDeskCustomerScopeReader({
        cloudId: async () => {
          if (cachedCloudId) return cachedCloudId;
          if (config.jira.cloudId && !config.jira.cloudId.startsWith('placeholder')) {
            cachedCloudId = config.jira.cloudId;
            return cachedCloudId;
          }
          const target = new ReadOnlyJiraCustomerTarget({
            cloudId: config.jira.cloudId,
            siteUrl: config.jira.siteUrl,
            httpClient,
            budgetGuard,
            log: logger,
          });
          cachedCloudId = await target.ensureCloudId();
          return cachedCloudId;
        },
        siteUrl: config.jira.siteUrl,
        httpClient,
        authMode: config.jira.authMode,
        serviceDeskIds: config.sync.jsmServiceDeskIds,
        budgetGuard,
        pageSize: 25,
        log: logger,
      });

      const validator = new CustomerEnumerationValidator(scopeReader, {
        maxRecords: 25,
        authMode: config.jira.authMode,
        budgetGuard,
        log: logger,
      });

      const enumerationValidationReport = await validator.validate();

      const success = enumerationValidationReport.customerEnumerationSupported;
      return {
        success,
        message: success
          ? 'Customer enumeration validation completed successfully.'
          : `Customer enumeration validation failed closed: ${enumerationValidationReport.failureReason}.`,
        environment: config.environment,
        dryRun: config.sync.dryRun,
        directorySourceType: config.sync.directorySource,
        enumerationValidationReport,
      };
    }

    // Mode 2: Single existing-customer validation
    if (config.sync.validateExistingCustomer) {
      logger.info('Initiating Single Customer Validation Mode', {
        target: config.sync.customerTarget,
        dryRun: config.sync.dryRun,
      });

      // Enforce strict request budget for validation
      const budgetGuard = new RequestBudgetGuard({
        cloudIdDiscovery: 1,
        fieldDiscovery: 1,
        userSearch: 1,
        customerProfile: 1,
      });

      const authProvider = createJiraAuthProvider(config);

      const httpClient = new GetOnlyJiraHttpClient(authProvider, {
        maxRetries: config.jira.maxRetries,
        retryDelayMs: config.jira.retryDelayMs,
        log: logger,
      });

      const jiraTarget = new ReadOnlyJiraCustomerTarget({
        cloudId: config.jira.cloudId,
        siteUrl: config.jira.siteUrl,
        httpClient,
        budgetGuard,
        log: logger,
      });

      const identityResolver =
        config.jira.authMode === 'oauth-3lo' && config.sync.jsmServiceDeskIds.length > 0
          ? new JsmServiceDeskCustomerResolver({
              cloudId: () => jiraTarget.ensureCloudId(),
              siteUrl: config.jira.siteUrl,
              httpClient,
              serviceDeskIds: config.sync.jsmServiceDeskIds,
              authMode: config.jira.authMode,
              budgetGuard,
              log: logger,
            })
          : new JiraUserSearchResolver({
              cloudId: () => jiraTarget.ensureCloudId(),
              siteUrl: config.jira.siteUrl,
              httpClient,
              budgetGuard,
              log: logger,
            });

      jiraTarget.setIdentityResolver(identityResolver);

      const validator = new SingleCustomerValidator(jiraTarget, identityResolver, logger);

      const singleCustomerReport = await validator.validateCustomer(config.sync.testCustomerEmail!);

      logger.info('Single customer validation completed', {
        correlationReference: singleCustomerReport.correlationReference,
        resolutionStatus: singleCustomerReport.resolutionStatus,
        profileRetrievalStatus: singleCustomerReport.profileRetrievalStatus,
        populatedMappedFieldCount: singleCustomerReport.populatedMappedFieldCount,
        emptyMappedFieldCount: singleCustomerReport.emptyMappedFieldCount,
        atlassianRequestId: singleCustomerReport.atlassianRequestId,
      });

      return {
        success: singleCustomerReport.success,
        message: singleCustomerReport.success
          ? 'Single customer validation completed successfully.'
          : 'Single customer validation failed.',
        environment: config.environment,
        dryRun: config.sync.dryRun,
        directorySourceType: config.sync.directorySource,
        singleCustomerReport,
      };
    }

    // Mode 3: End-to-end dry-run planning
    if (config.sync.endToEndDryRun) {
      logger.info(
        config.sync.syncScopeSource === 'jira'
          ? 'Initiating Jira-First End-to-End Dry Run'
          : 'Initiating Entra-First End-to-End Dry Run',
        {
          scopeSource: config.sync.syncScopeSource,
          maxRecords: config.sync.endToEndMaxRecords,
          concurrency: config.sync.jiraLookupConcurrency,
        },
      );

      let dirSource: DirectorySourcePort;
      if (config.sync.directorySource === 'entra') {
        const graphClient = new AzureMicrosoftGraphClient({
          tenantId: config.entra.tenantId,
          clientId: config.entra.clientId,
          clientSecret: config.entra.clientSecret,
        });
        dirSource = new EntraDirectorySource(graphClient, {
          includeGuestUsers: config.entra.includeGuestUsers,
          managerLookupConcurrency: config.entra.managerLookupConcurrency,
          maxRetries: config.entra.maxRetries,
          retryDelayMs: config.entra.retryDelayMs,
          log: logger,
        });
      } else {
        dirSource = new InMemoryDirectorySource();
      }

      const budgetGuard = new RequestBudgetGuard({
        cloudIdDiscovery: 1,
        fieldDiscovery: 1,
        userSearch: Math.max(
          config.sync.endToEndMaxRecords * 10,
          config.sync.jsmServiceDeskIds.length * 10,
          25,
        ),
        customerProfile: config.sync.endToEndMaxRecords,
        customerEnumerationPage: Math.ceil(config.sync.endToEndMaxRecords / 25) + 5,
        retry: 20,
        global: Math.max(
          config.sync.endToEndMaxRecords * 4 + 25,
          config.sync.jsmServiceDeskIds.length * 10 + 25,
          50,
        ),
      });

      const authProvider = createJiraAuthProvider(config);

      const httpClient = new GetOnlyJiraHttpClient(authProvider, {
        maxRetries: config.jira.maxRetries,
        retryDelayMs: config.jira.retryDelayMs,
        budgetGuard,
        log: logger,
      });

      const jiraTarget = new ReadOnlyJiraCustomerTarget({
        cloudId: config.jira.cloudId,
        siteUrl: config.jira.siteUrl,
        httpClient,
        budgetGuard,
        log: logger,
      });

      if (config.sync.syncScopeSource === 'jira') {
        // Jira-First Dry Run Gate:
        if (config.jira.authMode !== 'oauth-3lo') {
          throw new Error(
            "Safety violation: Jira-first end-to-end dry run requires JSM_API_AUTH_MODE='oauth-3lo'.",
          );
        }
        if (!config.jira.oauth.clientId || config.jira.oauth.clientId.startsWith('placeholder')) {
          throw new Error(
            'Safety violation: ATLASSIAN_OAUTH_CLIENT_ID is required for Jira-first dry run.',
          );
        }
        if (
          !config.jira.oauth.clientSecret ||
          config.jira.oauth.clientSecret.startsWith('placeholder')
        ) {
          throw new Error(
            'Safety violation: ATLASSIAN_OAUTH_CLIENT_SECRET is required for Jira-first dry run.',
          );
        }
        const tokenStore = new OAuthTokenStore({ tokenPath: config.jira.oauth.tokenPath });
        if (!tokenStore.hasTokenRecord()) {
          throw new Error(
            'Safety violation: Valid OAuth token record is required for Jira-first dry run (run npm run oauth:login).',
          );
        }
        tokenStore.readTokenRecord(); // strictly validates token record schema

        if (config.sync.jsmServiceDeskIds.length === 0) {
          throw new Error(
            'Safety violation: At least one service desk ID is required in JSM_SERVICE_DESK_IDS for Jira-first dry run.',
          );
        }
        if (!config.sync.customerEnumerationValidated) {
          throw new Error(
            'Safety violation: Jira-first dry-run execution requires prior customer-enumeration validation or explicit acknowledgment (CUSTOMER_ENUMERATION_VALIDATED=true).',
          );
        }
        if (!config.sync.dryRun) {
          throw new Error('Safety violation: SYNC_DRY_RUN must be true for dry run.');
        }
        if (config.sync.customerTarget !== 'jira-readonly') {
          throw new Error("Safety violation: CUSTOMER_TARGET must be 'jira-readonly' for dry run.");
        }
        if (config.sync.syncScopeSource !== 'jira') {
          throw new Error("Safety violation: SYNC_SCOPE_SOURCE must be 'jira'.");
        }
        const scopeReader = new JiraServiceDeskCustomerScopeReader({
          cloudId: () => jiraTarget.ensureCloudId(),
          siteUrl: config.jira.siteUrl,
          httpClient,
          authMode: config.jira.authMode,
          serviceDeskIds: config.sync.jsmServiceDeskIds,
          budgetGuard,
          pageSize: 50,
          log: logger,
        });

        const identityResolver = new JsmServiceDeskCustomerResolver({
          cloudId: () => jiraTarget.ensureCloudId(),
          siteUrl: config.jira.siteUrl,
          httpClient,
          serviceDeskIds: config.sync.jsmServiceDeskIds,
          authMode: config.jira.authMode,
          budgetGuard,
          log: logger,
        });

        jiraTarget.setIdentityResolver(identityResolver);

        const dryRunService = new JiraFirstDryRunService(
          dirSource,
          scopeReader,
          jiraTarget,
          {
            maxRecords: config.sync.endToEndMaxRecords,
            concurrency: config.sync.jiraLookupConcurrency,
            reportPath: config.sync.dryRunReportPath,
            environment: config.environment,
            directorySource: config.sync.directorySource,
            customerTarget: config.sync.customerTarget,
            dryRun: config.sync.dryRun,
            pilotMode: config.sync.pilotMode,
            pilotCustomerEmail: config.sync.pilotCustomerEmail,
          },
          budgetGuard,
          new DiffPlanner(),
          new MappingService(),
          logger,
          identityResolver,
        );

        const endToEndDryRunReport = await dryRunService.executeDryRun();

        const success = endToEndDryRunReport.success;
        return {
          success,
          message: success
            ? 'Jira-first end-to-end dry run completed successfully.'
            : `Jira-first end-to-end dry run stopped or failed: (${endToEndDryRunReport.failureReason ?? 'unsuccessful'}).`,
          environment: config.environment,
          dryRun: config.sync.dryRun,
          directorySourceType: config.sync.directorySource,
          endToEndDryRunReport,
        };
      } else {
        // Entra-first diagnostic fallback
        const identityResolver =
          config.jira.authMode === 'oauth-3lo' && config.sync.jsmServiceDeskIds.length > 0
            ? new JsmServiceDeskCustomerResolver({
                cloudId: () => jiraTarget.ensureCloudId(),
                siteUrl: config.jira.siteUrl,
                httpClient,
                serviceDeskIds: config.sync.jsmServiceDeskIds,
                authMode: config.jira.authMode,
                budgetGuard,
                log: logger,
              })
            : new JiraUserSearchResolver({
                cloudId: () => jiraTarget.ensureCloudId(),
                siteUrl: config.jira.siteUrl,
                httpClient,
                budgetGuard,
                log: logger,
              });

        jiraTarget.setIdentityResolver(identityResolver);

        const dryRunService = new EndToEndDryRunService(
          dirSource,
          jiraTarget,
          identityResolver,
          {
            maxRecords: config.sync.endToEndMaxRecords,
            concurrency: config.sync.jiraLookupConcurrency,
            reportPath: config.sync.dryRunReportPath,
            environment: config.environment,
            directorySource: config.sync.directorySource,
            customerTarget: config.sync.customerTarget,
            dryRun: config.sync.dryRun,
            fullDirectoryDryRunAcknowledged: config.sync.fullDirectoryDryRunAcknowledged,
          },
          budgetGuard,
          new DiffPlanner(),
          new MappingService(),
          logger,
        );

        const endToEndDryRunReport = await dryRunService.executeDryRun();

        return {
          success: true,
          message: 'Entra-first end-to-end dry run completed successfully.',
          environment: config.environment,
          dryRun: config.sync.dryRun,
          directorySourceType: config.sync.directorySource,
          endToEndDryRunReport,
        };
      }
    }

    // Mode 4: Field discovery only
    if (config.sync.discoveryOnly) {
      logger.info('Executing Jira customer detail field discovery only');

      const authProvider = createJiraAuthProvider(config);

      const httpClient = new GetOnlyJiraHttpClient(authProvider, {
        maxRetries: config.jira.maxRetries,
        retryDelayMs: config.jira.retryDelayMs,
        log: logger,
      });

      const jiraTarget = new ReadOnlyJiraCustomerTarget({
        cloudId: config.jira.cloudId,
        siteUrl: config.jira.siteUrl,
        httpClient,
        log: logger,
      });

      const dummyResolver = new JiraUserSearchResolver({
        cloudId: () => jiraTarget.ensureCloudId(),
        httpClient,
        log: logger,
      });

      jiraTarget.setIdentityResolver(dummyResolver);

      const discoveryReport = await jiraTarget.discoverFields();

      logger.info('Jira customer detail field discovery completed', {
        totalFields: discoveryReport.fieldCount,
        matchedFields: Object.keys(discoveryReport.matchedDomainFields),
        missingFields: discoveryReport.missingDomainFields,
        unknownTypes: discoveryReport.unknownTypes,
      });

      return {
        success: true,
        message: 'Metadata discovery completed successfully.',
        environment: config.environment,
        dryRun: config.sync.dryRun,
        directorySourceType: config.sync.directorySource,
        discoveryReport,
      };
    }

    // Mode 5: In-memory synchronization demonstration
    let directorySource: DirectorySourcePort;

    if (config.sync.directorySource === 'entra') {
      logger.info('Initializing Microsoft Graph directory source', {
        includeGuestUsers: config.entra.includeGuestUsers,
        managerLookupConcurrency: config.entra.managerLookupConcurrency,
      });

      const graphClient = new AzureMicrosoftGraphClient({
        tenantId: config.entra.tenantId,
        clientId: config.entra.clientId,
        clientSecret: config.entra.clientSecret,
      });

      directorySource = new EntraDirectorySource(graphClient, {
        includeGuestUsers: config.entra.includeGuestUsers,
        managerLookupConcurrency: config.entra.managerLookupConcurrency,
        maxRetries: config.entra.maxRetries,
        retryDelayMs: config.entra.retryDelayMs,
        log: logger,
      });
    } else {
      // Default: Seed deterministic demonstration dataset
      const mockDirectoryPeople: DirectoryPerson[] = [
        {
          sourceId: 'demo-entra-001',
          displayName: 'Alice Smith',
          email: 'alice.smith@example.com',
          jobTitle: 'Senior DevOps Engineer',
          officePhone: '+1-555-0101',
          supervisorName: 'Sarah Connor',
          officeLocation: 'Building A, Room 302',
        },
        {
          sourceId: 'demo-entra-002',
          displayName: 'Bob Jones',
          email: 'bob.jones@example.com',
          jobTitle: 'IT Support Specialist',
          officePhone: '+1-555-0102',
          supervisorName: 'Alice Smith',
          officeLocation: 'Desk 12',
        },
        {
          sourceId: 'demo-entra-003',
          displayName: 'Charlie Brown',
          email: '  CHARLIE.BROWN@EXAMPLE.COM  ',
          jobTitle: 'Principal Architect',
          officePhone: '+1-555-0103',
          supervisorName: 'Dana Scully',
          officeLocation: null, // Empty source: must not erase Jira's existing officeClassroom
        },
        {
          sourceId: 'demo-entra-004',
          displayName: 'Dana White',
          email: null, // Missing email: will be skipped
          jobTitle: 'External Consultant',
        },
        {
          sourceId: 'demo-entra-005',
          displayName: 'Eve Davis',
          email: 'eve.davis@example.com',
          jobTitle: 'Data Analyst', // Not found in Jira: will be skipped
        },
      ];
      directorySource = new InMemoryDirectorySource(mockDirectoryPeople);
    }

    const mockExistingCustomers: CustomerDetails[] = [
      {
        email: 'alice.smith@example.com',
        title: null, // Empty: will be populated
        officePhoneNumber: null,
        supervisor: null,
        officeClassroom: null,
      },
      {
        email: 'bob.jones@example.com',
        title: 'IT Support Specialist', // Identical: will be no-op
        officePhoneNumber: '+1-555-0102',
        supervisor: 'Alice Smith',
        officeClassroom: 'Desk 12',
      },
      {
        email: 'charlie.brown@example.com',
        title: 'Architect', // Different: will be updated to Principal Architect
        officePhoneNumber: '+1-555-0103',
        supervisor: 'Dana Scully',
        officeClassroom: 'Building B, Room 101', // Populated: must NOT be erased
      },
    ];

    const customerTarget = new InMemoryCustomerTarget(mockExistingCustomers);
    const syncService = new SyncService(directorySource, customerTarget);

    const summary = await syncService.executeSync({
      dryRun: config.sync.dryRun,
    });

    logger.info('Demonstration run completed successfully', {
      isDryRun: summary.isDryRun,
      totalProcessed: summary.totalProcessed,
      updatedCount: summary.updatedCount,
      unchangedCount: summary.unchangedCount,
      skippedCount: summary.skippedCount,
      errorCount: summary.errorCount,
    });

    return {
      success: true,
      message: 'Application started successfully with valid configuration.',
      environment: config.environment,
      dryRun: config.sync.dryRun,
      directorySourceType: config.sync.directorySource,
      summary,
    };
  } catch (error) {
    if (error instanceof JiraHttpError) {
      const sanitizedErrorCode = extractSanitizedErrorCode(error.responseBody);
      logger.error('Failed to initialize application: Jira HTTP error', {
        statusCode: error.statusCode,
        requestId: error.requestId,
        loginReason: error.loginReason,
        endpoint: error.endpoint,
        sanitizedErrorCode,
        reason: 'JIRA_HTTP_INITIALIZATION_ERROR',
      });
    } else {
      logger.error('Failed to initialize application', {
        reason: 'APPLICATION_INITIALIZATION_FAILED',
      });
    }
    throw error;
  }
}

// When executed directly as a script (e.g. `node dist/index.js` or `npm start`)
if (require.main === module) {
  runStartup()
    .then((result) => {
      if (!result.success) {
        process.exit(1);
      }
      process.exit(0);
    })
    .catch(() => {
      process.exit(1);
    });
}
