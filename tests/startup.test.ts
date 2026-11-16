import { describe, it, expect, vi } from 'vitest';
import { runStartup } from '../src/index';

describe('Application Startup Routine', () => {
  it('starts cleanly with default configuration and executes demonstration without external calls', async () => {
    const originalSource = process.env.DIRECTORY_SOURCE;
    try {
      process.env.DIRECTORY_SOURCE = 'memory';
      const startup = await runStartup();

      expect(startup).toBeDefined();
      expect(startup.success).toBe(true);
      expect(startup.dryRun).toBe(true);
      expect(startup.message).toMatch(/Application started successfully/i);
      expect(startup.summary).toBeDefined();
      expect(startup.summary?.totalProcessed).toBe(5);
      expect(startup.summary?.isDryRun).toBe(true);
    } finally {
      process.env.DIRECTORY_SOURCE = originalSource;
    }
  });

  it('executes metadata discovery only when DISCOVERY_ONLY=true without sync or profile calls', async () => {
    const originalDiscovery = process.env.DISCOVERY_ONLY;
    const originalAuthMode = process.env.JSM_API_AUTH_MODE;
    const originalCloudId = process.env.ATLASSIAN_CLOUD_ID;
    const originalFetch = global.fetch;

    try {
      process.env.DISCOVERY_ONLY = 'true';
      process.env.JSM_API_AUTH_MODE = 'scoped-api-token';
      process.env.ATLASSIAN_CLOUD_ID = 'disc-cloud-id';

      const mockFields = {
        results: [
          { id: 'df-1', name: 'Title', type: { name: 'STRING' } },
          { id: 'df-2', name: 'Office Phone Number', type: { name: 'STRING' } },
        ],
      };

      global.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/_edge/tenant_info')) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ cloudId: 'disc-cloud-id' }),
            headers: new Headers(),
          };
        }

        expect(url).toContain('/api/v1/customer/details');
        // Ensure no profile or user search URLs are called
        expect(url).not.toContain('/customer/profile');
        expect(url).not.toContain('/user/search');

        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify(mockFields),
          headers: new Headers({ 'x-atlassian-request-id': 'req-disc-test' }),
        };
      }) as unknown as typeof fetch;

      const result = await runStartup();

      expect(result.success).toBe(true);
      expect(result.discoveryReport).toBeDefined();
      expect(result.discoveryReport?.fieldCount).toBe(2);
      expect(result.discoveryReport?.fields[0]?.name).toBe('Title');
      // Must not have run sync summary
      expect(result.summary).toBeUndefined();
    } finally {
      if (originalDiscovery !== undefined) {
        process.env.DISCOVERY_ONLY = originalDiscovery;
      } else {
        delete process.env.DISCOVERY_ONLY;
      }
      if (originalAuthMode !== undefined) {
        process.env.JSM_API_AUTH_MODE = originalAuthMode;
      } else {
        delete process.env.JSM_API_AUTH_MODE;
      }
      if (originalCloudId !== undefined) {
        process.env.ATLASSIAN_CLOUD_ID = originalCloudId;
      } else {
        delete process.env.ATLASSIAN_CLOUD_ID;
      }
      global.fetch = originalFetch;
    }
  });

  it('proves startup logs boolean readiness indicators and never logs full config object', async () => {
    const originalSource = process.env.DIRECTORY_SOURCE;
    const { logger } = await import('../src/utils/logger');

    let startupLogContext: Record<string, unknown> | undefined;
    const originalInfo = logger.info.bind(logger);
    logger.info = vi.fn((msg: string, ctx?: Record<string, unknown>) => {
      if (msg === 'Application started successfully' && ctx) {
        startupLogContext = ctx;
      }
      originalInfo(msg, ctx);
    });

    try {
      process.env.DIRECTORY_SOURCE = 'memory';
      await runStartup();

      expect(startupLogContext).toBeDefined();
      // Requirement 2: Stop logging the entire sanitized configuration object at startup
      expect(startupLogContext?.config).toBeUndefined();

      // Requirement 3: Boolean readiness indicators
      expect(typeof startupLogContext?.jiraConfigured).toBe('boolean');
      expect(typeof startupLogContext?.cloudIdConfigured).toBe('boolean');
      expect(typeof startupLogContext?.authenticationConfigured).toBe('boolean');
      expect(typeof startupLogContext?.entraConfigured).toBe('boolean');
      expect(typeof startupLogContext?.dryRun).toBe('boolean');
      expect(typeof startupLogContext?.directorySource).toBe('string');
      expect(typeof startupLogContext?.customerTarget).toBe('string');
      expect(typeof startupLogContext?.discoveryOnly).toBe('boolean');
      expect(typeof startupLogContext?.validateExistingCustomer).toBe('boolean');
    } finally {
      if (originalSource !== undefined) {
        process.env.DIRECTORY_SOURCE = originalSource;
      } else {
        delete process.env.DIRECTORY_SOURCE;
      }
      logger.info = originalInfo;
    }
  });

  it('proves Jira site URL never appears in any production log event at startup', async () => {
    const originalSource = process.env.DIRECTORY_SOURCE;
    const originalSiteUrl = process.env.ATLASSIAN_SITE_URL;
    const syntheticSiteUrl = 'https://example-tenant-7f3a.atlassian.net';
    const { logger } = await import('../src/utils/logger');

    const loggedEvents: Array<{ msg: string; ctx?: Record<string, unknown> }> = [];
    const originalInfo = logger.info.bind(logger);
    const originalWarn = logger.warn.bind(logger);
    const originalError = logger.error.bind(logger);
    const originalDebug = logger.debug.bind(logger);

    const interceptor = (msg: string, ctx?: Record<string, unknown>) => {
      loggedEvents.push({ msg, ctx });
    };

    logger.info = vi.fn(interceptor);
    logger.warn = vi.fn(interceptor);
    logger.error = vi.fn(interceptor);
    logger.debug = vi.fn(interceptor);

    try {
      process.env.DIRECTORY_SOURCE = 'memory';
      process.env.ATLASSIAN_SITE_URL = syntheticSiteUrl;
      await runStartup();

      expect(loggedEvents.length).toBeGreaterThan(0);
      for (const event of loggedEvents) {
        const fullString = JSON.stringify(event);
        expect(fullString).not.toContain(syntheticSiteUrl);
        expect(fullString).not.toContain('example-tenant-7f3a');
      }
    } finally {
      if (originalSiteUrl !== undefined) {
        process.env.ATLASSIAN_SITE_URL = originalSiteUrl;
      } else {
        delete process.env.ATLASSIAN_SITE_URL;
      }
      logger.info = originalInfo;
      logger.warn = originalWarn;
      logger.error = originalError;
      logger.debug = originalDebug;
      if (originalSource !== undefined) {
        process.env.DIRECTORY_SOURCE = originalSource;
      } else {
        delete process.env.DIRECTORY_SOURCE;
      }
    }
  });
});
