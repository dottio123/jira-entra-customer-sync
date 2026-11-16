/**
 * Single Existing-Customer Identity and Profile Validation Service.
 *
 * ARCHITECTURAL PRINCIPLE:
 * This CLI diagnostic performs a controlled, read-only validation of identity resolution
 * and profile retrieval for a single designated customer.
 *
 * Safety Constraints:
 * - Does NOT query Microsoft Graph or instantiate Entra directory sources.
 * - Does NOT write, create, invite, or enroll customers (strictly prohibited).
 * - Enforces request budget guards (max 1 search, max 1 profile retrieval).
 * - Logs and returns strictly sanitized metadata (never exposes PII or credentials).
 */

import {
  CustomerIdentityResolverPort,
  IdentityResolutionOutcome,
  CustomerDetails,
} from '../domain';
import { ReadOnlyJiraCustomerTarget, DiscoveredFieldReport } from '../connectors/jira';
import { Logger, logger } from '../utils/logger';
import { hashIdentifier } from '../utils/privacy';

export interface SingleCustomerValidationReport {
  correlationReference: string;
  success: boolean;
  resolutionStatus: IdentityResolutionOutcome;
  profileRetrievalStatus: 'RETRIEVED' | 'SKIPPED' | 'FAILED';
  resolutionReason?: string;
  detailFieldNamesPresent: string[];
  detailFieldNamesMissing: string[];
  mappedDomainFieldNames: string[];
  populatedMappedFieldCount: number;
  emptyMappedFieldCount: number;
  atlassianRequestId?: string;
}

export class SingleCustomerValidator {
  constructor(
    private readonly target: ReadOnlyJiraCustomerTarget,
    private readonly identityResolver: CustomerIdentityResolverPort,
    private readonly log: Logger = logger,
  ) {}

  /**
   * Executes the single-customer identity and profile validation flow.
   */
  async validateCustomer(email: string): Promise<SingleCustomerValidationReport> {
    const normalizedEmail = (email || '').trim().toLowerCase();
    const correlationReference = hashIdentifier(normalizedEmail);

    this.log.info('Starting single-customer validation flow', {
      correlationReference,
    });

    // Step 1: Retrieve customer detail-field metadata
    let fieldReport: DiscoveredFieldReport;
    try {
      fieldReport = await this.target.discoverFields();
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.log.error('Failed detail-field discovery during validation', {
        correlationReference,
        error: errorMsg,
      });
      throw err;
    }

    const detailFieldNamesPresent = fieldReport.fields.map((f) => f.name);
    const detailFieldNamesMissing = fieldReport.missingDomainFields;
    const mappedDomainFieldNames = Object.keys(fieldReport.matchedDomainFields);

    // Step 2: Search for the designated customer
    this.log.info('Resolving customer identity in Jira', {
      correlationReference,
    });

    const resolution = await this.identityResolver.resolveCustomerIdentity(normalizedEmail);

    if (resolution.outcome !== 'RESOLVED') {
      this.log.info('Customer identity not resolved; skipping profile retrieval', {
        correlationReference,
        resolutionStatus: resolution.outcome,
        reason: resolution.reason,
      });

      return {
        correlationReference,
        success: false,
        resolutionStatus: resolution.outcome,
        profileRetrievalStatus: 'SKIPPED',
        resolutionReason: resolution.reason,
        detailFieldNamesPresent,
        detailFieldNamesMissing,
        mappedDomainFieldNames,
        populatedMappedFieldCount: 0,
        emptyMappedFieldCount: mappedDomainFieldNames.length,
      };
    }

    // Step 3: Retrieve customer profile for resolved customer
    const accountId = resolution.accountId;
    if (!accountId || accountId.trim().length === 0) {
      this.log.warn('Resolved record is missing a usable account identifier', {
        correlationReference,
      });

      return {
        correlationReference,
        success: false,
        resolutionStatus: 'NOT_FOUND',
        profileRetrievalStatus: 'SKIPPED',
        resolutionReason: 'Resolved record missing accountId',
        detailFieldNamesPresent,
        detailFieldNamesMissing,
        mappedDomainFieldNames,
        populatedMappedFieldCount: 0,
        emptyMappedFieldCount: mappedDomainFieldNames.length,
      };
    }

    this.log.info('Retrieving customer profile from Jira CSM', {
      correlationReference,
    });

    try {
      const result = await this.target.getCustomerProfile(accountId, normalizedEmail);

      const customerDetails: CustomerDetails = result.customerDetails;
      const atlassianRequestId = result.requestId;

      // Calculate populated vs empty fields among domain fields
      const domainKeys: Array<keyof Omit<CustomerDetails, 'email'>> = [
        'title',
        'officePhoneNumber',
        'supervisor',
        'officeClassroom',
      ];

      let populatedMappedFieldCount = 0;
      let emptyMappedFieldCount = 0;

      for (const key of domainKeys) {
        const val = customerDetails[key];
        if (typeof val === 'string' && val.trim().length > 0) {
          populatedMappedFieldCount++;
        } else {
          emptyMappedFieldCount++;
        }
      }

      const requiredFields = ['title', 'officePhoneNumber', 'supervisor', 'officeClassroom'];
      const hasAllRequiredFields = requiredFields.every((f) => mappedDomainFieldNames.includes(f));

      this.log.info('Customer profile retrieved and mapped successfully', {
        correlationReference,
        resolutionStatus: 'RESOLVED',
        profileRetrievalStatus: 'RETRIEVED',
        populatedMappedFieldCount,
        emptyMappedFieldCount,
        atlassianRequestId,
        success: hasAllRequiredFields,
      });

      return {
        correlationReference,
        success: hasAllRequiredFields,
        resolutionStatus: 'RESOLVED',
        profileRetrievalStatus: 'RETRIEVED',
        detailFieldNamesPresent,
        detailFieldNamesMissing,
        mappedDomainFieldNames,
        populatedMappedFieldCount,
        emptyMappedFieldCount,
        atlassianRequestId,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.log.error('Failed to retrieve customer profile', {
        correlationReference,
        error: errorMsg,
      });

      return {
        correlationReference,
        success: false,
        resolutionStatus: 'RESOLVED',
        profileRetrievalStatus: 'FAILED',
        resolutionReason: errorMsg,
        detailFieldNamesPresent,
        detailFieldNamesMissing,
        mappedDomainFieldNames,
        populatedMappedFieldCount: 0,
        emptyMappedFieldCount: mappedDomainFieldNames.length,
      };
    }
  }
}
