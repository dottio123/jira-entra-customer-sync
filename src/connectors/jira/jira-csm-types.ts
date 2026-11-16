/**
 * Atlassian Customer Service Management (CSM) and Jira Platform REST API DTOs.
 *
 * ARCHITECTURAL PRINCIPLE:
 * These types model raw vendor schemas strictly within the Jira connector boundary.
 * They must NOT leak into the domain or service layers.
 */

/**
 * Field configuration from GET /api/v1/customer/details
 */
export interface DetailFieldAllowedValue {
  id: string;
  value: string;
  [key: string]: unknown;
}

export interface DetailFieldType {
  name: string;
  allowedValues?: DetailFieldAllowedValue[];
  [key: string]: unknown;
}

export interface DetailFieldWithConfiguration {
  id?: string;
  fieldId?: string;
  key?: string;
  name: string;
  type: DetailFieldType;
  required?: boolean;
  description?: string;
  [key: string]: unknown;
}

export interface DetailFieldsResponse {
  results: DetailFieldWithConfiguration[];
  [key: string]: unknown;
}

/**
 * Customer profile details from GET /api/v1/customer/profile/{customerId}
 */
export interface ProfileDetailField {
  id: string;
  name: string;
  value: unknown;
  [key: string]: unknown;
}

export interface CustomerAccountProfile {
  customerId: string;
  displayName?: string;
  email?: string;
  details: ProfileDetailField[];
  [key: string]: unknown;
}

/**
 * Jira Platform user search result from GET /rest/api/3/user/search?query={email}
 */
export interface JiraUserSearchResult {
  accountId: string;
  accountType?: string;
  emailAddress?: string;
  displayName: string;
  active: boolean;
  [key: string]: unknown;
}

/**
 * JSM Service Desk Customer user from GET /rest/servicedeskapi/servicedesk/{serviceDeskId}/customer
 */
export interface JsmCustomerUser {
  accountId: string;
  name?: string;
  key?: string;
  emailAddress?: string;
  displayName?: string;
  active?: boolean;
  timeZone?: string;
  [key: string]: unknown;
}

/**
 * Paginated response from GET /rest/servicedeskapi/servicedesk/{serviceDeskId}/customer
 */
export interface JsmPagedCustomerResponse {
  size: number;
  start: number;
  limit: number;
  isLastPage: boolean;
  _links?: {
    base?: string;
    context?: string;
    next?: string;
    prev?: string;
    self?: string;
    [key: string]: unknown;
  };
  values: JsmCustomerUser[];
  [key: string]: unknown;
}

/**
 * JSM Service Desk item from GET /rest/servicedeskapi/servicedesk
 */
export interface JsmServiceDeskItem {
  id: string;
  projectId?: string;
  projectName?: string;
  projectKey?: string;
  [key: string]: unknown;
}

/**
 * Paginated response from GET /rest/servicedeskapi/servicedesk
 */
export interface JsmPagedServiceDeskResponse {
  size: number;
  start: number;
  limit: number;
  isLastPage: boolean;
  _links?: {
    base?: string;
    context?: string;
    next?: string;
    prev?: string;
    self?: string;
    [key: string]: unknown;
  };
  values: JsmServiceDeskItem[];
  [key: string]: unknown;
}
