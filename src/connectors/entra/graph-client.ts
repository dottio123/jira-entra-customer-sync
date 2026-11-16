import { Client } from '@microsoft/microsoft-graph-client';
import { TokenCredentialAuthenticationProvider } from '@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials';
import { ClientSecretCredential } from '@azure/identity';
import { GraphUserDto, GraphManagerDto, GraphPagedResponse } from './graph-types';
import { extractGraphErrorInfo } from './retry-policy';

export interface GetUsersQueryOptions {
  select: string[];
  filter?: string;
  nextLink?: string;
}

/**
 * Port/abstraction for interacting with Microsoft Graph API.
 * Allows decoupling EntraDirectorySource from concrete network calls for deterministic unit testing.
 */
export interface IGraphClient {
  getUsers(options: GetUsersQueryOptions): Promise<GraphPagedResponse<GraphUserDto>>;
  getManager(userId: string): Promise<GraphManagerDto | null>;
}

export interface AzureGraphClientOptions {
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

/**
 * Concrete Microsoft Graph client utilizing Azure Identity ClientSecretCredential
 * and Microsoft Graph SDK TokenCredentialAuthenticationProvider with app-only scope.
 */
export class AzureMicrosoftGraphClient implements IGraphClient {
  private client: Client;

  constructor(options: AzureGraphClientOptions) {
    const credential = new ClientSecretCredential(
      options.tenantId,
      options.clientId,
      options.clientSecret,
    );

    const authProvider = new TokenCredentialAuthenticationProvider(credential, {
      scopes: ['https://graph.microsoft.com/.default'],
    });

    this.client = Client.initWithMiddleware({
      authProvider,
    });
  }

  async getUsers(options: GetUsersQueryOptions): Promise<GraphPagedResponse<GraphUserDto>> {
    let request;
    if (options.nextLink) {
      // For paging, nextLink contains the complete URL
      request = this.client.api(options.nextLink);
    } else {
      request = this.client.api('/users').select(options.select);
      if (options.filter) {
        request = request.filter(options.filter);
      }
    }

    return (await request.get()) as GraphPagedResponse<GraphUserDto>;
  }

  async getManager(userId: string): Promise<GraphManagerDto | null> {
    try {
      const response = await this.client
        .api(`/users/${encodeURIComponent(userId)}/manager`)
        .select(['id', 'displayName'])
        .get();

      return response as GraphManagerDto;
    } catch (error) {
      const errorInfo = extractGraphErrorInfo(error);
      // Microsoft Graph returns 404 if the user does not have an assigned manager
      if (errorInfo.statusCode === 404) {
        return null;
      }
      throw error;
    }
  }
}
