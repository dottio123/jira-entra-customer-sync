/**
 * Internal Microsoft Graph DTO definitions.
 *
 * ARCHITECTURAL PRINCIPLE:
 * These types reflect raw Microsoft Graph wire response formats.
 * They must NEVER be exported outside the Entra connector module or leak into domain models.
 */

export interface GraphUserDto {
  id: string;
  displayName: string;
  mail?: string | null;
  userPrincipalName: string;
  jobTitle?: string | null;
  businessPhones?: string[] | null;
  officeLocation?: string | null;
  accountEnabled: boolean;
  userType?: string | null;
}

export interface GraphManagerDto {
  id: string;
  displayName?: string | null;
}

export interface GraphPagedResponse<T> {
  value: T[];
  '@odata.nextLink'?: string;
}

export interface GraphErrorResponse {
  code?: string;
  message?: string;
  innerError?: {
    'request-id'?: string;
    'client-request-id'?: string;
    date?: string;
  };
}
