/**
 * Atlassian OAuth 2.0 (3LO) Types and Token Record Schema.
 *
 * ARCHITECTURAL PRINCIPLE:
 * Strictly defined, versioned token-record format containing only operational credentials.
 * NEVER stores customer PII, directory records, Cloud IDs, site URLs, or OAuth client secrets.
 */

import { z } from 'zod';

export type OAuthErrorCategory =
  | 'OAUTH_CONFIGURATION_INVALID'
  | 'OAUTH_TOKEN_RECORD_MISSING'
  | 'OAUTH_TOKEN_RECORD_INVALID'
  | 'OAUTH_ACCESS_TOKEN_EXPIRED'
  | 'OAUTH_REFRESH_FAILED'
  | 'OAUTH_GRANT_INVALID'
  | 'OAUTH_REAUTHORIZATION_REQUIRED'
  | 'OAUTH_STORAGE_FAILED';

export class OAuthError extends Error {
  public readonly category: OAuthErrorCategory;
  public readonly statusCode?: number;
  public readonly sanitizedErrorCode?: string;

  constructor(
    category: OAuthErrorCategory,
    message: string,
    options?: { statusCode?: number; sanitizedErrorCode?: string },
  ) {
    super(message);
    this.name = 'OAuthError';
    this.category = category;
    this.statusCode = options?.statusCode;
    this.sanitizedErrorCode = options?.sanitizedErrorCode;
  }
}

/**
 * Strict schema for the versioned Atlassian OAuth 2.0 token record.
 * Uses .strict() to reject any extraneous fields (e.g. client secrets, codes, state, customer data).
 */
export const AtlassianOAuthTokenRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    tokenType: z.string().refine((t) => t.toLowerCase() === 'bearer', {
      message: "tokenType must be compatible with 'Bearer'",
    }),
    accessToken: z.string().min(1, 'accessToken is required'),
    refreshToken: z.string().min(1, 'refreshToken is required'),
    accessTokenExpiresAt: z.string().datetime({
      message: 'accessTokenExpiresAt must be a valid ISO 8601 timestamp string',
    }),
    scopes: z
      .array(z.string())
      .refine(
        (scopes) =>
          scopes.includes('read:servicedesk.customer:jira-service-management') &&
          scopes.includes('offline_access'),
        {
          message:
            "scopes must contain 'read:servicedesk.customer:jira-service-management' and 'offline_access'",
        },
      ),
    createdAt: z.string().datetime({
      message: 'createdAt must be a valid ISO 8601 timestamp string',
    }),
    updatedAt: z.string().datetime({
      message: 'updatedAt must be a valid ISO 8601 timestamp string',
    }),
  })
  .strict();

export type AtlassianOAuthTokenRecord = z.infer<typeof AtlassianOAuthTokenRecordSchema>;

/**
 * Validates that an object contains zero forbidden credential or customer fields.
 */
export function assertNoForbiddenTokenRecordFields(record: Record<string, unknown>): void {
  const forbiddenKeys = [
    'clientSecret',
    'client_secret',
    'code',
    'authorizationCode',
    'authorization_code',
    'state',
    'oauthState',
    'apiToken',
    'jiraApiToken',
    'userEmail',
    'email',
    'displayName',
    'accountId',
    'customerId',
    'entraObjectId',
    'cloudId',
    'siteUrl',
    'serviceDeskId',
    'rawResponse',
    'rawCustomerData',
  ];

  for (const key of forbiddenKeys) {
    if (key in record && record[key] !== undefined) {
      throw new OAuthError(
        'OAUTH_TOKEN_RECORD_INVALID',
        `Token record contains forbidden field '${key}'.`,
      );
    }
  }
}
