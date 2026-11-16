import { describe, it, expect } from 'vitest';
import { parseConfig, getSanitizedConfig, DEFAULT_ATLASSIAN_OAUTH_SCOPES } from '../src/config';

describe('Configuration Module', () => {
  it('parses valid environment variables correctly', () => {
    const mockEnv = {
      NODE_ENV: 'production',
      ENTRA_TENANT_ID: 'tenant-uuid-1111-2222',
      ENTRA_CLIENT_ID: 'client-uuid-3333-4444',
      ENTRA_CLIENT_SECRET: 'secret-key-xyz-987',
      JIRA_SITE_URL: 'https://testcorp.atlassian.net',
      JIRA_USER_EMAIL: 'jira-sync-user@testcorp.com',
      JIRA_API_TOKEN: 'jira-api-token-abc-123',
      SYNC_DRY_RUN: 'false',
      LOG_LEVEL: 'warn',
    };

    const config = parseConfig(mockEnv);

    expect(config.environment).toBe('production');
    expect(config.entra.tenantId).toBe('tenant-uuid-1111-2222');
    expect(config.entra.clientId).toBe('client-uuid-3333-4444');
    expect(config.entra.clientSecret).toBe('secret-key-xyz-987');
    expect(config.jira.siteUrl).toBe('https://testcorp.atlassian.net');
    expect(config.jira.userEmail).toBe('jira-sync-user@testcorp.com');
    expect(config.jira.apiToken).toBe('jira-api-token-abc-123');
    expect(config.sync.dryRun).toBe(false);
    expect(config.logging.level).toBe('warn');
  });

  it('applies safe defaults when optional variables are omitted', () => {
    const config = parseConfig({});

    // Safety-first default: dryRun must default to true
    expect(config.sync.dryRun).toBe(true);
    expect(config.logging.level).toBe('info');
    expect(config.environment).toBe('development');
    expect(config.entra.tenantId).toBe('placeholder-entra-tenant-id');
    expect(config.jira.siteUrl).toBe('https://placeholder.atlassian.net');
  });

  it('rejects invalid Atlassian site URL', () => {
    expect(() =>
      parseConfig({
        JIRA_SITE_URL: 'not-a-valid-url',
      }),
    ).toThrow();
  });

  it('rejects invalid Jira user email', () => {
    expect(() =>
      parseConfig({
        JIRA_USER_EMAIL: 'not-an-email',
      }),
    ).toThrow();
  });

  it('rejects invalid log level', () => {
    expect(() =>
      parseConfig({
        LOG_LEVEL: 'ultra-verbose',
      }),
    ).toThrow();
  });

  it('rejects invalid boolean value for SYNC_DRY_RUN', () => {
    expect(() =>
      parseConfig({
        SYNC_DRY_RUN: 'not-a-boolean',
      }),
    ).toThrow(/Invalid boolean value/);
  });

  it('masks credentials when getSanitizedConfig is invoked', () => {
    const rawSecret = 'super-confidential-secret-key';
    const rawToken = 'confidential-jira-token-value';

    const config = parseConfig({
      ENTRA_CLIENT_SECRET: rawSecret,
      JIRA_API_TOKEN: rawToken,
    });

    const sanitized = getSanitizedConfig(config);
    const serialized = JSON.stringify(sanitized);

    expect(serialized).not.toContain(rawSecret);
    expect(serialized).not.toContain(rawToken);
    expect((sanitized.entra as Record<string, unknown>).clientSecret).toBe('********');
    expect((sanitized.jira as Record<string, unknown>).apiToken).toBe('********');
  });

  it('rejects token-like value in JSM_API_AUTH_MODE without leaking the token in the error message', () => {
    const rawToken = 'ATATT3xFfGF0jE5mVJLS1FvuRj9bkBBL5Z6SYBrgXSm5b8zN0qcUZz8EcVUrOBSa4qPw6yN6uTs';
    try {
      parseConfig({
        JSM_API_AUTH_MODE: rawToken,
      });
      expect.unreachable('Should have thrown an error');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toContain(
        'received a token-like string instead of an authentication routing mode',
      );
      expect(msg).not.toContain(rawToken);
    }
  });

  describe('Atlassian OAuth 2.0 Configuration & Scope Validation', () => {
    it('defaults to required read-only scopes when ATLASSIAN_OAUTH_SCOPES is omitted', () => {
      const config = parseConfig({
        JSM_API_AUTH_MODE: 'oauth-3lo',
      });

      expect(config.jira.oauth.scopes).toEqual([
        'offline_access',
        'read:servicedesk.customer:jira-service-management',
        'read:user:jira',
        'read:customer.detail-field:jira-service-management',
        'read:customer.profile:jira-service-management',
      ]);
    });

    it('rejects deprecated hyphenated scope read:servicedesk-customer:jira-service-management', () => {
      expect(() =>
        parseConfig({
          JSM_API_AUTH_MODE: 'oauth-3lo',
          ATLASSIAN_OAUTH_SCOPES:
            'read:servicedesk-customer:jira-service-management offline_access',
        }),
      ).toThrow(
        /must use 'read:servicedesk\.customer:jira-service-management' \(with dot\), not 'read:servicedesk-customer:jira-service-management'/,
      );
    });

    it('rejects missing read:servicedesk.customer:jira-service-management or offline_access', () => {
      expect(() =>
        parseConfig({
          JSM_API_AUTH_MODE: 'oauth-3lo',
          ATLASSIAN_OAUTH_SCOPES: 'read:user:jira offline_access',
        }),
      ).toThrow(/must include required scope 'read:servicedesk\.customer:jira-service-management'/);

      expect(() =>
        parseConfig({
          JSM_API_AUTH_MODE: 'oauth-3lo',
          ATLASSIAN_OAUTH_SCOPES: 'read:servicedesk.customer:jira-service-management',
        }),
      ).toThrow(/must include required scope 'offline_access'/);
    });

    it('rejects write, delete, and customer management scopes', () => {
      expect(() =>
        parseConfig({
          JSM_API_AUTH_MODE: 'oauth-3lo',
          ATLASSIAN_OAUTH_SCOPES:
            'read:servicedesk.customer:jira-service-management offline_access manage:servicedesk-customer',
        }),
      ).toThrow(/must not include customer management scope/);

      expect(() =>
        parseConfig({
          JSM_API_AUTH_MODE: 'oauth-3lo',
          ATLASSIAN_OAUTH_SCOPES:
            'read:servicedesk.customer:jira-service-management offline_access write:servicedesk-customer',
        }),
      ).toThrow(
        /Safety violation: ATLASSIAN_OAUTH_SCOPES must not include write, delete, or management scopes/,
      );
    });

    it('preserves distinct loopback redirect URIs without normalizing localhost to 127.0.0.1 or vice versa', () => {
      const config1 = parseConfig({
        ATLASSIAN_OAUTH_REDIRECT_URI: 'http://127.0.0.1:8080/callback',
      });
      expect(config1.jira.oauth.redirectUri).toBe('http://127.0.0.1:8080/callback');

      const config2 = parseConfig({
        ATLASSIAN_OAUTH_REDIRECT_URI: 'http://localhost:8080/callback',
      });
      expect(config2.jira.oauth.redirectUri).toBe('http://localhost:8080/callback');
    });

    it('rejects parent-path traversal in ATLASSIAN_OAUTH_TOKEN_PATH', () => {
      expect(() =>
        parseConfig({
          ATLASSIAN_OAUTH_TOKEN_PATH: 'secrets/../../escaped-token.json',
        }),
      ).toThrow(/Parent-path traversal is prohibited/);
    });
  });

  describe('Pilot Configuration & Mode Resolution', () => {
    it('rejects startup when pilot mode is explicitly true but no pilot or test email is provided', () => {
      expect(() =>
        parseConfig({
          JIRA_PILOT_MODE: 'true',
        }),
      ).toThrow(/Missing configuration: A valid pilot customer email is required/);
    });

    it('rejects startup when pilot email is whitespace', () => {
      expect(() =>
        parseConfig({
          JIRA_PILOT_MODE: 'true',
          JIRA_PILOT_CUSTOMER_EMAIL: '   ',
        }),
      ).toThrow(/Missing configuration: A valid pilot customer email is required/);
    });

    it('rejects startup when pilot email contains placeholder angle brackets', () => {
      expect(() =>
        parseConfig({
          JIRA_PILOT_MODE: 'true',
          JIRA_PILOT_CUSTOMER_EMAIL: '<customer@your-domain.com>',
        }),
      ).toThrow(/contains a placeholder/);
    });

    it('rejects startup when pilot email contains placeholder keyword', () => {
      expect(() =>
        parseConfig({
          JIRA_PILOT_MODE: 'true',
          JIRA_PILOT_CUSTOMER_EMAIL: 'placeholder-customer@example.com',
        }),
      ).toThrow(/contains a placeholder/);
    });

    it('rejects startup when pilot email is syntactically invalid', () => {
      expect(() =>
        parseConfig({
          JIRA_PILOT_MODE: 'true',
          JIRA_PILOT_CUSTOMER_EMAIL: 'not-an-email',
        }),
      ).toThrow(/must be a syntactically valid email address/);
    });

    it('falls back to JIRA_TEST_CUSTOMER_EMAIL when JIRA_PILOT_CUSTOMER_EMAIL is omitted and pilotMode is true', () => {
      const config = parseConfig({
        JIRA_PILOT_MODE: 'true',
        JIRA_TEST_CUSTOMER_EMAIL: 'fallback@example.com',
      });
      expect(config.sync.pilotMode).toBe(true);
      expect(config.sync.pilotCustomerEmail).toBe('fallback@example.com');
    });

    it('prefers JIRA_PILOT_CUSTOMER_EMAIL over JIRA_TEST_CUSTOMER_EMAIL', () => {
      const config = parseConfig({
        JIRA_PILOT_MODE: 'true',
        JIRA_PILOT_CUSTOMER_EMAIL: 'preferred@example.com',
        JIRA_TEST_CUSTOMER_EMAIL: 'fallback@example.com',
      });
      expect(config.sync.pilotMode).toBe(true);
      expect(config.sync.pilotCustomerEmail).toBe('preferred@example.com');
    });

    it('implicitly enables pilotMode when JIRA_PILOT_CUSTOMER_EMAIL is provided and JIRA_PILOT_MODE is unset', () => {
      const config = parseConfig({
        JIRA_PILOT_CUSTOMER_EMAIL: 'implicit@example.com',
      });
      expect(config.sync.pilotMode).toBe(true);
      expect(config.sync.pilotCustomerEmail).toBe('implicit@example.com');
    });

    it('respects explicit JIRA_PILOT_MODE=false even if JIRA_PILOT_CUSTOMER_EMAIL is provided', () => {
      const config = parseConfig({
        JIRA_PILOT_MODE: 'false',
        JIRA_PILOT_CUSTOMER_EMAIL: 'notused@example.com',
      });
      expect(config.sync.pilotMode).toBe(false);
      expect(config.sync.pilotCustomerEmail).toBeUndefined();
    });
  });

  describe('Pilot Write Safety Gates', () => {
    const writeBase = {
      PILOT_WRITE_SCOPE_ALLOWED: 'true',
      PILOT_WRITE_ENABLED: 'true',
      PILOT_WRITE_CONFIRMATION: 'APPLY_SINGLE_CUSTOMER_DETAIL_UPDATE',
      PILOT_WRITE_MAX_FIELDS: '1',
      SYNC_DRY_RUN: 'false',
      DIRECTORY_SOURCE: 'entra',
      CUSTOMER_TARGET: 'jira-readonly',
      SYNC_SCOPE_SOURCE: 'jira',
      JSM_API_AUTH_MODE: 'oauth-3lo',
      JSM_SERVICE_DESK_IDS: '1',
      CUSTOMER_ENUMERATION_VALIDATED: 'true',
      JIRA_PILOT_MODE: 'true',
      JIRA_PILOT_CUSTOMER_EMAIL: 'pilot@example.com',
      END_TO_END_DRY_RUN: 'false',
      ATLASSIAN_OAUTH_SCOPES: `${DEFAULT_ATLASSIAN_OAUTH_SCOPES.join(' ')} write:customer.detail:jira-service-management`,
    };

    it('accepts the complete single-customer write gate', () => {
      const config = parseConfig(writeBase);
      expect(config.sync.pilotWriteEnabled).toBe(true);
      expect(config.sync.pilotWriteMaxFields).toBe(1);
    });

    it('rejects write scope unless the dedicated scope gate is enabled', () => {
      expect(() =>
        parseConfig({
          ATLASSIAN_OAUTH_SCOPES: writeBase.ATLASSIAN_OAUTH_SCOPES,
        }),
      ).toThrow(/must not include write/);
    });

    it('allows OAuth consent while pilot write execution remains disabled', () => {
      const config = parseConfig({
        PILOT_WRITE_SCOPE_ALLOWED: 'true',
        PILOT_WRITE_ENABLED: 'false',
        ATLASSIAN_OAUTH_SCOPES: writeBase.ATLASSIAN_OAUTH_SCOPES,
      });
      expect(config.sync.pilotWriteScopeAllowed).toBe(true);
      expect(config.sync.pilotWriteEnabled).toBe(false);
    });

    it('rejects pilot write execution unless the scope gate is enabled', () => {
      expect(() => parseConfig({ ...writeBase, PILOT_WRITE_SCOPE_ALLOWED: 'false' })).toThrow(
        /PILOT_WRITE_SCOPE_ALLOWED=true/,
      );
    });

    it('rejects pilot write unless dry-run is explicitly disabled', () => {
      expect(() => parseConfig({ ...writeBase, SYNC_DRY_RUN: 'true' })).toThrow(
        /requires SYNC_DRY_RUN=false/,
      );
    });

    it('rejects pilot write without the exact confirmation phrase', () => {
      expect(() => parseConfig({ ...writeBase, PILOT_WRITE_CONFIRMATION: 'yes' })).toThrow(
        /APPLY_SINGLE_CUSTOMER_DETAIL_UPDATE/,
      );
    });

    it('rejects a write maximum greater than one', () => {
      expect(() => parseConfig({ ...writeBase, PILOT_WRITE_MAX_FIELDS: '2' })).toThrow(
        /between 1 and 1/,
      );
    });
  });

  describe('Bounded Rollout Write Safety Gates', () => {
    const rolloutBase = {
      PILOT_WRITE_SCOPE_ALLOWED: 'true',
      ROLLOUT_WRITE_ENABLED: 'true',
      ROLLOUT_WRITE_CONFIRMATION: 'APPLY_BOUNDED_CUSTOMER_DETAIL_UPDATES',
      ROLLOUT_WRITE_MAX_CUSTOMERS: '4',
      ROLLOUT_WRITE_MAX_FIELDS_PER_CUSTOMER: '2',
      ROLLOUT_WRITE_MIN_INTERVAL_MS: '5000',
      ROLLOUT_APPROVED_REPORT_PATH: 'reports/approved.json',
      ROLLOUT_APPROVED_REPORT_SHA256: 'a'.repeat(64),
      SYNC_DRY_RUN: 'false',
      END_TO_END_DRY_RUN: 'false',
      END_TO_END_MAX_RECORDS: '10',
      DIRECTORY_SOURCE: 'entra',
      CUSTOMER_TARGET: 'jira-readonly',
      SYNC_SCOPE_SOURCE: 'jira',
      JSM_API_AUTH_MODE: 'oauth-3lo',
      JSM_SERVICE_DESK_IDS: '1',
      CUSTOMER_ENUMERATION_VALIDATED: 'true',
      JIRA_PILOT_MODE: 'false',
      ATLASSIAN_OAUTH_SCOPES: `${DEFAULT_ATLASSIAN_OAUTH_SCOPES.join(' ')} write:customer.detail:jira-service-management`,
    };

    it('accepts a completely bounded rollout configuration', () => {
      const config = parseConfig(rolloutBase);
      expect(config.sync.rolloutWriteEnabled).toBe(true);
      expect(config.sync.rolloutWriteMaxCustomers).toBe(4);
      expect(config.sync.rolloutWriteMinIntervalMs).toBe(5000);
    });

    it('requires an approval report digest', () => {
      expect(() => parseConfig({ ...rolloutBase, ROLLOUT_APPROVED_REPORT_SHA256: '' })).toThrow(
        /approved report path and SHA-256/,
      );
    });

    it('rejects simultaneous pilot and rollout write modes', () => {
      expect(() =>
        parseConfig({
          ...rolloutBase,
          PILOT_WRITE_ENABLED: 'true',
          PILOT_WRITE_CONFIRMATION: 'APPLY_SINGLE_CUSTOMER_DETAIL_UPDATE',
          JIRA_PILOT_MODE: 'true',
        }),
      ).toThrow(/mutually exclusive/);
    });

    it('rejects rollout limits above five customers', () => {
      expect(() => parseConfig({ ...rolloutBase, ROLLOUT_WRITE_MAX_CUSTOMERS: '6' })).toThrow(
        /between 1 and 5/,
      );
    });

    it('rejects a rollout write interval above sixty seconds', () => {
      expect(() => parseConfig({ ...rolloutBase, ROLLOUT_WRITE_MIN_INTERVAL_MS: '60001' })).toThrow(
        /between 0 and 60000/,
      );
    });

    it('accepts a read-only rollout preflight without write confirmation', () => {
      const config = parseConfig({
        ...rolloutBase,
        ROLLOUT_WRITE_ENABLED: 'false',
        ROLLOUT_PREFLIGHT_ONLY: 'true',
        ROLLOUT_WRITE_CONFIRMATION: '',
        SYNC_DRY_RUN: 'true',
      });
      expect(config.sync.rolloutPreflightOnly).toBe(true);
      expect(config.sync.rolloutWriteEnabled).toBe(false);
    });
  });
});
