/**
 * Read-Only Jira Service Management Customer Target.
 *
 * ARCHITECTURAL PRINCIPLES:
 * 1. Interface Segregation: Implements CustomerDetailsReaderPort ONLY.
 *    Does NOT implement CustomerDetailsWriterPort. Prevents any Jira write operations.
 * 2. Field Discovery: Discovers custom detail field definitions from Atlassian CSM API:
 *    GET https://api.atlassian.com/jsm/csm/cloudid/{cloudId}/api/v1/customer/details
 *    Accepts any field types reported by Jira without crashing on unknown types.
 * 3. Identity Resolution: Uses CustomerIdentityResolverPort to resolve email to accountId.
 * 4. Profile Retrieval: Retrieves customer profile and details from:
 *    GET https://api.atlassian.com/jsm/csm/cloudid/{cloudId}/api/v1/customer/profile/{customerId}
 * 5. GET-only: the non-mutating POST /api/v1/customer/search-by-detail-field endpoint is
 *    intentionally not used so this reader never issues anything but GET requests.
 * 6. Request Budget Guard: All operations honor request budgets to prevent runaway polling.
 * 7. Privacy: Never logs site URL, full email, or account ID.
 */

import {
  CustomerDetails,
  CustomerDetailsReaderPort,
  CustomerIdentityResolverPort,
} from '../../domain';
import { GetOnlyJiraHttpClient } from './readonly-http-client';
import {
  DetailFieldsResponse,
  CustomerAccountProfile,
  DetailFieldWithConfiguration,
} from './jira-csm-types';
import { RequestBudgetGuard } from './request-budget-guard';
import {
  SYNCED_FIELDS,
  SyncedFieldDefinition,
  assertSyncedFieldsConfigured,
} from './field-catalog';
import { Logger, logger } from '../../utils/logger';
import { hashIdentifier } from '../../utils/privacy';

export interface DiscoveredField {
  id: string;
  name: string;
  typeName: string;
  required: boolean;
}

export interface DiscoveredFieldReport {
  fields: DiscoveredField[];
  fieldCount: number;
  matchedDomainFields: Record<string, string>;
  /** Domain field key -> the field name as it appears on this Jira site. */
  matchedFieldNames?: Record<string, string>;
  missingDomainFields: string[];
  ambiguousDomainFields: Record<string, string[]>;
  unmappedFields: string[];
  unknownTypes: string[];
}

export interface ReadOnlyJiraCustomerTargetOptions {
  cloudId?: string | (() => Promise<string>);
  siteUrl?: string;
  httpClient: GetOnlyJiraHttpClient;
  identityResolver?: CustomerIdentityResolverPort;
  budgetGuard?: RequestBudgetGuard;
  log?: Logger;
}

export interface CustomerProfileFetchResult {
  profile: CustomerAccountProfile;
  customerDetails: CustomerDetails;
  requestId?: string;
}

export class ReadOnlyJiraCustomerTarget implements CustomerDetailsReaderPort {
  private cloudId?: string;
  private readonly cloudIdResolver?: () => Promise<string>;
  private readonly siteUrl?: string;
  private readonly httpClient: GetOnlyJiraHttpClient;
  private identityResolver?: CustomerIdentityResolverPort;
  private readonly budgetGuard?: RequestBudgetGuard;
  private readonly log: Logger;

  private cachedFieldReport: DiscoveredFieldReport | null = null;

  constructor(options: ReadOnlyJiraCustomerTargetOptions) {
    if (!options.siteUrl && !options.cloudId) {
      throw new Error('Either siteUrl or cloudId is required for ReadOnlyJiraCustomerTarget.');
    }

    if (typeof options.cloudId === 'function') {
      this.cloudIdResolver = options.cloudId;
    } else if (options.cloudId) {
      this.cloudId = options.cloudId.trim();
    }

    this.siteUrl = options.siteUrl?.trim().replace(/\/+$/, '');
    this.httpClient = options.httpClient;
    this.identityResolver = options.identityResolver;
    this.budgetGuard = options.budgetGuard;
    this.log = options.log ?? logger;
  }

  setIdentityResolver(identityResolver: CustomerIdentityResolverPort): void {
    this.identityResolver = identityResolver;
  }

  async getCloudId(): Promise<string> {
    return this.ensureCloudId();
  }

  /**
   * Resolves the Atlassian Cloud ID if not explicitly configured by querying /_edge/tenant_info.
   * Does NOT log the site URL or Cloud ID.
   */
  async ensureCloudId(): Promise<string> {
    if (
      this.cloudId &&
      this.cloudId !== 'placeholder-jira-cloud-id' &&
      this.cloudId !== 'placeholder_atlassian_cloud_id'
    ) {
      return this.cloudId;
    }

    if (this.cloudIdResolver) {
      const resolved = await this.cloudIdResolver();
      if (
        resolved &&
        resolved !== 'placeholder-jira-cloud-id' &&
        resolved !== 'placeholder_atlassian_cloud_id'
      ) {
        this.cloudId = resolved.trim();
        return this.cloudId;
      }
    }

    if (this.siteUrl) {
      this.log.info('Attempting automatic Cloud ID resolution from Atlassian tenant info');

      this.budgetGuard?.recordOperation('cloudIdDiscovery');

      try {
        const tenantInfoUrl = `${this.siteUrl}/_edge/tenant_info`;
        const tenantRes = await this.httpClient.get<{ cloudId: string }>(tenantInfoUrl);
        if (tenantRes.data?.cloudId) {
          this.cloudId = tenantRes.data.cloudId;
          this.log.info('Resolved Atlassian Cloud ID from tenant info', {
            resolved: true,
          });
          return this.cloudId;
        }
      } catch (err) {
        this.log.warn('Failed to auto-resolve Cloud ID from tenant info', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (!this.cloudId || this.cloudId.startsWith('placeholder')) {
      throw new Error(
        'Atlassian Cloud ID could not be determined. Please connect Jira via OAuth or set ATLASSIAN_CLOUD_ID in .env.',
      );
    }

    return this.cloudId;
  }

  /**
   * Retrieves detail-field definitions from Atlassian CSM and maps them against canonical domain fields.
   * Does NOT reject unknown field types. Never logs site URL.
   */
  async discoverFields(): Promise<DiscoveredFieldReport> {
    const cloudId = await this.ensureCloudId();
    const url = `https://api.atlassian.com/jsm/csm/cloudid/${cloudId}/api/v1/customer/details`;

    this.log.info('Discovering customer detail-field definitions from Jira CSM', {
      endpoint: 'GET /api/v1/customer/details',
    });

    this.budgetGuard?.recordOperation('fieldDiscovery');

    const response = await this.httpClient.get<DetailFieldsResponse>(url);
    const results = response.data?.results ?? [];

    const fields: DiscoveredField[] = results.map((f: DetailFieldWithConfiguration) => {
      const raw = f as Record<string, unknown>;
      const resolvedId =
        typeof raw.id === 'string' && raw.id.length > 0
          ? raw.id
          : typeof raw.fieldId === 'string' && raw.fieldId.length > 0
            ? raw.fieldId
            : typeof raw.key === 'string' && raw.key.length > 0
              ? raw.key
              : f.name;

      return {
        id: resolvedId,
        name: f.name,
        typeName: f.type?.name ?? 'UNKNOWN',
        required: f.required ?? false,
      };
    });

    // Map discovered Jira fields onto the synchronized domain fields by name alias.
    const matchedDomainFields: Record<string, string> = {};
    const matchedFieldNames: Record<string, string> = {};
    const missingDomainFields: string[] = [];
    const ambiguousDomainFields: Record<string, string[]> = {};
    const matchedFieldIds = new Set<string>();

    for (const target of SYNCED_FIELDS) {
      const matchingFields = fields.filter((f) =>
        target.aliases.includes(f.name.trim().toLowerCase()),
      );

      if (matchingFields.length === 1) {
        const field = matchingFields[0]!;
        matchedDomainFields[target.key] = field.id;
        matchedFieldNames[target.key] = field.name;
        matchedFieldIds.add(field.id);
      } else if (matchingFields.length > 1) {
        ambiguousDomainFields[target.key] = matchingFields.map((f) => f.name);
      } else {
        missingDomainFields.push(target.key);
      }
    }

    // Identify unmapped fields (fields present in Jira but not mapped to a domain target)
    const unmappedFields: string[] = fields
      .filter((f) => !matchedFieldIds.has(f.id))
      .map((f) => f.name);

    // Collect distinct unknown type names, excluding known standard types and known unmapped fields
    const knownStandardTypes = new Set([
      'STRING',
      'TEXT',
      'NUMBER',
      'DATE',
      'SELECT',
      'MULTI_SELECT',
      'USER',
      'PHONE_NUMBER',
      'PHONE',
      'EMAIL',
      'URL',
    ]);

    const knownUnmappedNames = new Set([
      'cell phone number',
      'cell phone',
      'mobile phone',
      'email address',
      'email',
    ]);

    const unknownTypes: string[] = [];
    for (const f of fields) {
      const normalizedName = f.name.trim().toLowerCase();
      // A known but unmapped field is never reported as an unknown field type.
      if (knownUnmappedNames.has(normalizedName)) {
        continue;
      }

      if (!knownStandardTypes.has(f.typeName.toUpperCase()) && !unknownTypes.includes(f.typeName)) {
        unknownTypes.push(f.typeName);
      }
    }

    const report: DiscoveredFieldReport = {
      fields,
      fieldCount: fields.length,
      matchedDomainFields,
      matchedFieldNames,
      missingDomainFields,
      ambiguousDomainFields,
      unmappedFields,
      unknownTypes,
    };

    this.cachedFieldReport = report;

    this.log.info('Discovered Jira customer detail fields', {
      totalFields: report.fieldCount,
      matchedFieldCount: Object.keys(report.matchedDomainFields).length,
      missingFieldCount: report.missingDomainFields.length,
      unmappedFieldCount: report.unmappedFields.length,
      unknownTypeCount: report.unknownTypes.length,
    });

    return report;
  }

  /**
   * Retrieves a single customer's profile by account ID and maps it to domain CustomerDetails.
   * Guarded by request budget.
   */
  async getCustomerProfile(
    accountId: string,
    normalizedEmail: string,
  ): Promise<CustomerProfileFetchResult> {
    if (!this.cachedFieldReport) {
      await this.discoverFields();
    }

    const cloudId = await this.ensureCloudId();
    const profileUrl = `https://api.atlassian.com/jsm/csm/cloudid/${cloudId}/api/v1/customer/profile/${encodeURIComponent(accountId)}`;

    this.budgetGuard?.recordOperation('customerProfile');

    const response = await this.httpClient.get<CustomerAccountProfile>(profileUrl);
    const profile = response.data;
    const customerDetails = this.mapProfileToCustomerDetails(normalizedEmail, profile);

    return {
      profile,
      customerDetails,
      requestId: response.requestId,
    };
  }

  /**
   * Finds an existing customer in Jira Service Management by normalized email.
   * Resolves email to accountId using CustomerIdentityResolverPort, then fetches customer profile.
   */
  async findByEmail(normalizedEmail: string): Promise<CustomerDetails | null> {
    const emailKey = normalizedEmail.trim().toLowerCase();
    const customerRef = hashIdentifier(emailKey);

    // Step 1: Resolve customer identity
    if (!this.identityResolver) {
      throw new Error(
        'Identity resolver is required for findByEmail in ReadOnlyJiraCustomerTarget.',
      );
    }
    const resolution = await this.identityResolver.resolveCustomerIdentity(emailKey);

    if (resolution.outcome !== 'RESOLVED') {
      this.log.debug('Customer identity could not be resolved in Jira', {
        customerRef,
        outcome: resolution.outcome,
        reason: resolution.reason,
      });
      return null;
    }

    const accountId = resolution.accountId;
    if (!accountId) {
      this.log.debug('Resolved customer identity is missing accountId', {
        customerRef,
      });
      return null;
    }

    try {
      const result = await this.getCustomerProfile(accountId, emailKey);
      return result.customerDetails;
    } catch (error) {
      this.log.warn('Failed to fetch Jira customer profile', {
        customerRef,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  public mapProfileToCustomerDetails(
    normalizedEmail: string,
    profile: CustomerAccountProfile,
  ): CustomerDetails {
    const detailsMapById = new Map<string, unknown>();
    const detailsMapByName = new Map<string, unknown>();

    if (Array.isArray(profile.details)) {
      for (const item of profile.details) {
        const val = item.value !== undefined ? item.value : item;
        if (item.id) {
          detailsMapById.set(item.id, val);
        }
        if (item.name) {
          detailsMapByName.set(item.name.trim().toLowerCase(), val);
        }
      }
    }

    const extractStringValue = (field: SyncedFieldDefinition): string | null => {
      const matchedId = this.cachedFieldReport?.matchedDomainFields[field.key];
      if (matchedId && detailsMapById.has(matchedId)) {
        return this.coerceToString(detailsMapById.get(matchedId));
      }

      for (const name of field.aliases) {
        if (detailsMapByName.has(name)) {
          return this.coerceToString(detailsMapByName.get(name));
        }
      }

      return null;
    };

    const details: CustomerDetails = {
      email: normalizedEmail,
      title: null,
      officePhoneNumber: null,
      supervisor: null,
      officeClassroom: null,
      emailAddress: null,
    };
    for (const field of SYNCED_FIELDS) {
      details[field.key] = extractStringValue(field);
    }
    return details;
  }

  /**
   * Verifies that every synchronized customer detail field is matched and unambiguous.
   * Fails closed with a sanitized configuration error if any field is missing or ambiguous.
   */
  public assertTargetFieldsConfigured(report?: DiscoveredFieldReport): void {
    const r = report ?? this.cachedFieldReport;
    if (!r) {
      throw new Error('Field discovery must be completed before verifying target fields.');
    }
    assertSyncedFieldsConfigured(r);
  }

  public coerceToString(value: unknown): string | null {
    if (value === null || value === undefined) {
      return null;
    }

    if (typeof value === 'string') {
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : null;
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }

    if (Array.isArray(value)) {
      const nonNulls = value
        .map((v) => this.coerceToString(v))
        .filter((v): v is string => v !== null && v.length > 0);
      return nonNulls.length > 0 ? nonNulls.join('\n') : null;
    }

    if (typeof value === 'object') {
      const obj = value as Record<string, unknown>;

      // 1. Atlassian documented CSM detail field format:
      // { "type": "TEXT", "text": ["Engineer"], "assetsObjects": null }
      if (Array.isArray(obj.text)) {
        const nonNulls = obj.text
          .map((v) => this.coerceToString(v))
          .filter((v): v is string => v !== null && v.length > 0);
        return nonNulls.length > 0 ? nonNulls.join('\n') : null;
      }

      if (typeof obj.text === 'string') {
        const trimmed = obj.text.trim();
        return trimmed.length > 0 ? trimmed : null;
      }

      // 2. Nested value property (e.g. obj.value)
      if (obj.value !== undefined && obj.value !== null) {
        return this.coerceToString(obj.value);
      }

      // 3. Common string representation properties
      if (typeof obj.displayName === 'string') {
        const trimmed = obj.displayName.trim();
        return trimmed.length > 0 ? trimmed : null;
      }

      if (typeof obj.name === 'string') {
        const trimmed = obj.name.trim();
        return trimmed.length > 0 ? trimmed : null;
      }

      if (typeof obj.label === 'string') {
        const trimmed = obj.label.trim();
        return trimmed.length > 0 ? trimmed : null;
      }

      // Guardrail: Never return "[object Object]" for unrecognized object shapes
      return null;
    }

    return null;
  }
}
