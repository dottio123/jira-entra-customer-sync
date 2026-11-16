/**
 * Authentication Investigation Service.
 *
 * ARCHITECTURAL PRINCIPLE:
 * Bounded, strictly GET-only diagnostic service to investigate Atlassian JSM authentication routing.
 * Tests the project-scoped customer endpoint:
 * GET /rest/servicedeskapi/servicedesk/{id}/customer?start=0&limit=1
 *
 * PRIVACY AND TELEMETRY RESTRICTIONS (Requirements 25-26):
 * Capture ONLY:
 * - HTTP status
 * - Sanitized Atlassian request ID
 * - Sanitized Atlassian error code
 * - Authentication mode
 * - Endpoint category
 * - Whether pagination metadata was returned
 *
 * NEVER capture:
 * - Response bodies containing customer data
 * - Email addresses
 * - Display names
 * - Account IDs
 * - Service desk IDs
 * - Cloud ID
 * - Site URL
 * - Credentials
 *
 * Live validation rule:
 * - Do NOT claim support for an authentication mode until a live GET-only validation succeeds.
 */

import {
  GetOnlyJiraHttpClient,
  JiraHttpError,
  HttpResponse,
} from '../connectors/jira/readonly-http-client';
import {
  JsmApiAuthMode,
  ScopeReaderFailureReason,
} from '../connectors/jira/jira-servicedesk-customer-scope-reader';
import { Logger, logger } from '../utils/logger';

export interface AuthenticationInvestigationReport {
  mode: 'AUTHENTICATION_INVESTIGATION';
  investigatedAt: string;
  authMode: JsmApiAuthMode;
  endpointCategory: 'jsm-servicedesk-customer';
  httpStatus: number | null;
  sanitizedRequestId: string | null;
  sanitizedErrorCode: string | null;
  paginationMetadataReturned: boolean;
  supported: boolean;
  prerequisiteRequired?: string;
  failureReason?: ScopeReaderFailureReason;
}

export interface AuthenticationInvestigationServiceOptions {
  authMode: JsmApiAuthMode;
  serviceDeskId: string;
  siteUrl?: string;
  cloudId?: string | (() => Promise<string>);
  httpClient: GetOnlyJiraHttpClient;
  log?: Logger;
}

export class AuthenticationInvestigationService {
  private readonly authMode: JsmApiAuthMode;
  private readonly serviceDeskId: string;
  private readonly siteUrl?: string;
  private readonly cloudId?: string | (() => Promise<string>);
  private readonly httpClient: GetOnlyJiraHttpClient;
  private readonly log: Logger;

  constructor(options: AuthenticationInvestigationServiceOptions) {
    if (!options.httpClient) {
      throw new Error('GetOnlyJiraHttpClient is required for AuthenticationInvestigationService.');
    }
    if (!options.serviceDeskId || options.serviceDeskId.trim().length === 0) {
      throw new Error('serviceDeskId is required for AuthenticationInvestigationService.');
    }
    this.authMode = options.authMode;
    this.serviceDeskId = options.serviceDeskId.trim();
    this.siteUrl = options.siteUrl?.trim().replace(/\/+$/, '');
    this.cloudId = options.cloudId;
    this.httpClient = options.httpClient;
    this.log = options.log ?? logger;
  }

  private async resolveCloudId(): Promise<string> {
    if (!this.cloudId) {
      throw new Error('Cloud ID is required for scoped-api-token authentication investigation.');
    }
    const id = typeof this.cloudId === 'function' ? await this.cloudId() : this.cloudId;
    if (!id || id.trim().length === 0 || id.startsWith('placeholder')) {
      throw new Error(
        'Valid Cloud ID is required for scoped-api-token authentication investigation.',
      );
    }
    return id.trim();
  }

  private sanitizeErrorCode(responseBody: unknown): string | null {
    if (!responseBody || typeof responseBody !== 'object') {
      return null;
    }
    const body = responseBody as Record<string, unknown>;
    if (typeof body.code === 'string' && /^[A-Z0-9_-]+$/i.test(body.code)) {
      return body.code;
    }
    if (typeof body.error === 'string' && /^[A-Z0-9_-]+$/i.test(body.error)) {
      return body.error;
    }
    if (typeof body.message === 'string') {
      if (body.message.toLowerCase().includes('scope does not match')) {
        return 'SCOPE_CHECK_FAILED';
      }
      if (body.message.toLowerCase().includes('unauthorized')) {
        return 'UNAUTHORIZED';
      }
    }
    if (Array.isArray(body.errorMessages) && body.errorMessages.length > 0) {
      const msg = String(body.errorMessages[0]);
      if (msg.toLowerCase().includes('scope')) {
        return 'SCOPE_CHECK_FAILED';
      }
      if (msg.toLowerCase().includes('unauthorized')) {
        return 'UNAUTHORIZED';
      }
    }
    return null;
  }

  private sanitizeRequestId(raw?: string | null): string | null {
    if (!raw || typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (/^[A-Za-z0-9_-]+$/.test(trimmed)) {
      return trimmed;
    }
    return null;
  }

  async investigate(): Promise<AuthenticationInvestigationReport> {
    const investigatedAt = new Date().toISOString();

    this.log.info('Starting bounded authentication investigation', {
      authMode: this.authMode,
      endpointCategory: 'jsm-servicedesk-customer',
    });

    if (this.authMode === 'oauth-3lo') {
      this.log.warn(
        'OAuth 3LO investigated: prerequisite required, token acquisition not configured',
      );
      return {
        mode: 'AUTHENTICATION_INVESTIGATION',
        investigatedAt,
        authMode: 'oauth-3lo',
        endpointCategory: 'jsm-servicedesk-customer',
        httpStatus: null,
        sanitizedRequestId: null,
        sanitizedErrorCode: null,
        paginationMetadataReturned: false,
        supported: false,
        prerequisiteRequired:
          'OAuth 2.0 (3LO) token acquisition is required to access JSM customer endpoints.',
        failureReason: 'ENUMERATION_AUTHENTICATION_UNSUPPORTED',
      };
    }

    let url: string;
    try {
      if (this.authMode === 'scoped-api-token') {
        const cloudId = await this.resolveCloudId();
        url = `https://api.atlassian.com/ex/jira/${encodeURIComponent(cloudId)}/rest/servicedeskapi/servicedesk/${encodeURIComponent(
          this.serviceDeskId,
        )}/customer?start=0&limit=1`;
      } else if (this.authMode === 'basic-api-token') {
        if (!this.siteUrl) {
          return {
            mode: 'AUTHENTICATION_INVESTIGATION',
            investigatedAt,
            authMode: 'basic-api-token',
            endpointCategory: 'jsm-servicedesk-customer',
            httpStatus: null,
            sanitizedRequestId: null,
            sanitizedErrorCode: null,
            paginationMetadataReturned: false,
            supported: false,
            prerequisiteRequired: 'Site URL must be configured for basic-api-token authentication.',
            failureReason: 'ENUMERATION_ROUTING_FAILED',
          };
        }
        url = `${this.siteUrl}/rest/servicedeskapi/servicedesk/${encodeURIComponent(
          this.serviceDeskId,
        )}/customer?start=0&limit=1`;
      } else {
        return {
          mode: 'AUTHENTICATION_INVESTIGATION',
          investigatedAt,
          authMode: this.authMode,
          endpointCategory: 'jsm-servicedesk-customer',
          httpStatus: null,
          sanitizedRequestId: null,
          sanitizedErrorCode: null,
          paginationMetadataReturned: false,
          supported: false,
          failureReason: 'ENUMERATION_AUTHENTICATION_UNSUPPORTED',
        };
      }
    } catch {
      return {
        mode: 'AUTHENTICATION_INVESTIGATION',
        investigatedAt,
        authMode: this.authMode,
        endpointCategory: 'jsm-servicedesk-customer',
        httpStatus: null,
        sanitizedRequestId: null,
        sanitizedErrorCode: null,
        paginationMetadataReturned: false,
        supported: false,
        failureReason: 'ENUMERATION_ROUTING_FAILED',
      };
    }

    try {
      const response: HttpResponse<Record<string, unknown>> = await this.httpClient.get<
        Record<string, unknown>
      >(url, { 'X-ExperimentalApi': 'opt-in' });

      const data = response.data;
      const paginationMetadataReturned = Boolean(
        data &&
        (typeof data.isLastPage === 'boolean' ||
          Array.isArray(data.values) ||
          typeof data.size === 'number' ||
          typeof data.limit === 'number'),
      );

      const sanitizedRequestId = this.sanitizeRequestId(
        response.headers?.get ? response.headers.get('x-atlassian-request-id') : null,
      );

      this.log.info('Authentication investigation completed: endpoint accessible', {
        authMode: this.authMode,
        httpStatus: 200,
        paginationMetadataReturned,
        sanitizedRequestId,
      });

      return {
        mode: 'AUTHENTICATION_INVESTIGATION',
        investigatedAt,
        authMode: this.authMode,
        endpointCategory: 'jsm-servicedesk-customer',
        httpStatus: 200,
        sanitizedRequestId,
        sanitizedErrorCode: null,
        paginationMetadataReturned,
        supported: true,
      };
    } catch (err) {
      if (err instanceof JiraHttpError) {
        const sanitizedRequestId = this.sanitizeRequestId(err.requestId);
        const sanitizedErrorCode = this.sanitizeErrorCode(err.responseBody);
        const httpStatus = err.statusCode;

        let failureReason: ScopeReaderFailureReason = 'ENUMERATION_ROUTING_FAILED';
        let prerequisiteRequired: string | undefined;

        if (httpStatus === 401) {
          failureReason = 'ENUMERATION_UNAUTHORIZED';
          if (this.authMode === 'scoped-api-token') {
            prerequisiteRequired =
              'OAuth 2.0 (3LO) token acquisition is required to access JSM customer endpoints via Atlassian Cloud Gateway.';
          } else {
            prerequisiteRequired =
              'Valid HTTP Basic authentication credentials are required for direct site API.';
          }
        } else if (httpStatus === 403) {
          failureReason = 'ENUMERATION_FORBIDDEN';
        } else if (httpStatus === 404) {
          failureReason = 'ENUMERATION_ENDPOINT_OR_SCOPE_INVALID';
        }

        this.log.warn(
          'Authentication investigation completed: endpoint rejected credentials or route',
          {
            authMode: this.authMode,
            httpStatus,
            sanitizedErrorCode,
            sanitizedRequestId,
            failureReason,
          },
        );

        return {
          mode: 'AUTHENTICATION_INVESTIGATION',
          investigatedAt,
          authMode: this.authMode,
          endpointCategory: 'jsm-servicedesk-customer',
          httpStatus,
          sanitizedRequestId,
          sanitizedErrorCode,
          paginationMetadataReturned: false,
          supported: false,
          prerequisiteRequired,
          failureReason,
        };
      }

      return {
        mode: 'AUTHENTICATION_INVESTIGATION',
        investigatedAt,
        authMode: this.authMode,
        endpointCategory: 'jsm-servicedesk-customer',
        httpStatus: null,
        sanitizedRequestId: null,
        sanitizedErrorCode: null,
        paginationMetadataReturned: false,
        supported: false,
        failureReason: 'ENUMERATION_ROUTING_FAILED',
      };
    }
  }
}
