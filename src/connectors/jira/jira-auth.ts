/**
 * Jira Authentication Provider Interface and Implementations.
 *
 * Provides authentication headers for Atlassian Jira and JSM API requests.
 */

export interface IJiraAuthProvider {
  getAuthHeader(): Promise<string>;
}

/**
 * Basic Authentication Provider using Atlassian Account Email and API Token.
 * Encodes credentials into standard HTTP Basic auth header format: Basic base64(email:token)
 */
export class BasicJiraAuthProvider implements IJiraAuthProvider {
  private readonly authHeader: string;

  constructor(userEmail: string, apiToken: string) {
    if (!userEmail || userEmail.trim().length === 0) {
      throw new Error('User email is required for BasicJiraAuthProvider.');
    }
    if (!apiToken || apiToken.trim().length === 0) {
      throw new Error('API token is required for BasicJiraAuthProvider.');
    }

    const credentials = `${userEmail.trim()}:${apiToken.trim()}`;
    const base64 = Buffer.from(credentials).toString('base64');
    this.authHeader = `Basic ${base64}`;
  }

  async getAuthHeader(): Promise<string> {
    return this.authHeader;
  }
}
