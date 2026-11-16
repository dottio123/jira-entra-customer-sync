import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { SessionRecord } from '../store';
import {
  OAuthError,
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  generateOAuthState,
} from '../../connectors/jira';
import { logger } from '../../utils/logger';
import { WebContext, query } from '../http/context';

export function registerConnectionRoutes(
  app: FastifyInstance,
  ctx: WebContext,
  oauthFetchFn?: typeof fetch,
): void {
  const { store, services, config } = ctx;

  app.get('/connections', async (request, reply) => {
    const current = await ctx.requireSession(request, reply, true);
    if (!current) return;
    reply.header('Content-Security-Policy', ctx.contentSecurityPolicy(true));
    await ctx.render(request, reply, 'connections', 'Connections', current.principal, {
      csrfToken: current.csrfToken,
      oauth: services.oauthStatus(),
      writePermission: services.jiraWritePermission(),
      callbackUrl: config.callbackUrl,
      redirectUriMismatch: config.redirectUriMismatch,
      message: query(request).message,
      graphConfigured: config.graphConfigured,
      serviceDeskIds: config.serviceDeskIds,
    });
  });

  /**
   * Starts Atlassian authorization. The Connections page uses a plain link (GET) because
   * browsers apply the CSP form-action directive to every redirect after a form submission,
   * which blocks Atlassian's single sign-on hand-offs (for example to Microsoft Entra).
   * Cross-site requests are refused, so another site cannot start an authorization.
   */
  app.get('/auth/atlassian/start', async (request, reply) => {
    const current = await ctx.requireSession(request, reply, true);
    if (!current) return;
    if (!isSameOriginNavigation(request)) {
      return ctx.renderError(request, reply, 403, {
        tone: 'warning',
        title: 'Start the Jira connection from Connections',
        text: 'Open Connections in this service and choose Connect Jira.',
      });
    }
    return beginAuthorization(request, reply, current);
  });

  // Form-based start, kept for compatibility with older pages and scripts.
  app.post('/auth/atlassian/start', async (request, reply) => {
    const current = await ctx.requireFormSession(request, reply, true);
    if (!current) return;
    return beginAuthorization(request, reply, current);
  });

  function isSameOriginNavigation(request: FastifyRequest): boolean {
    const fetchSite = request.headers['sec-fetch-site'];
    if (typeof fetchSite === 'string') return fetchSite === 'same-origin';
    // Older browsers without Fetch Metadata: require a same-origin Referer.
    return ctx.origin.safeRedirectPath(request.headers.referer) !== undefined;
  }

  async function beginAuthorization(
    request: FastifyRequest,
    reply: FastifyReply,
    current: SessionRecord,
  ) {
    if (config.redirectUriMismatch || !services.oauthStatus().configurationAvailable) {
      return ctx.renderError(request, reply, 409, {
        tone: 'warning',
        title: 'Jira cannot be connected yet',
        text: 'The Atlassian app details are incomplete, or the callback URL in the configuration does not match this service’s address. See Connections for details.',
      });
    }
    const state = generateOAuthState();
    store.createOAuthState(state, current.tokenHash);
    const url = buildAuthorizationUrl({
      clientId: config.oauthClientId!,
      redirectUri: config.callbackUrl,
      scopes: config.oauthScopes,
      state,
      allowCustomerDetailWrite: config.oauthWriteScopeAllowed,
    });
    store.audit(current.principal.id, 'JIRA_OAUTH_START', 'SUCCESS');
    reply.header('Content-Security-Policy', ctx.contentSecurityPolicy(true));
    return reply.code(303).redirect(url);
  }

  app.get('/auth/atlassian/callback', async (request, reply) => {
    const current = ctx.session(request);
    const params = query(request);
    if (!current || current.principal.role !== 'admin' || current.principal.mustChangePassword) {
      return ctx.renderError(request, reply, 403, {
        tone: 'warning',
        title: 'Sign in to finish connecting Jira',
        text: 'The Jira sign-in returned to a browser without an administrator session. Sign in, then choose Connect Jira again.',
      });
    }
    if (!params.state || !store.consumeOAuthState(params.state, current.tokenHash)) {
      store.audit(current.principal.id, 'JIRA_OAUTH_CALLBACK', 'INVALID_STATE');
      return ctx.renderError(request, reply, 400, {
        tone: 'warning',
        title: 'This Jira sign-in link has expired',
        text: 'Open Connections and choose Connect Jira again.',
      });
    }
    if (params.error || !params.code || config.redirectUriMismatch) {
      store.audit(current.principal.id, 'JIRA_OAUTH_CALLBACK', 'DENIED');
      return reply.redirect('/connections?message=denied');
    }
    try {
      const record = await exchangeAuthorizationCode({
        clientId: config.oauthClientId!,
        clientSecret: config.oauthClientSecret!,
        code: params.code,
        redirectUri: config.callbackUrl,
        expectedScopes: config.oauthScopes,
        fetchFn: oauthFetchFn,
      });
      if (!config.oauthScopes.every((scope) => record.scopes.includes(scope))) {
        throw new OAuthError('OAUTH_GRANT_INVALID', 'Required OAuth scopes were not granted.');
      }
      services.tokenStore.writeTokenRecord(record);
      store.audit(current.principal.id, 'JIRA_OAUTH_CALLBACK', 'SUCCESS');
      return reply.redirect('/connections?message=connected');
    } catch (err) {
      logger.warn('Jira OAuth authorization could not be completed', {
        category: err instanceof OAuthError ? err.category : 'UNCLASSIFIED',
      });
      store.audit(current.principal.id, 'JIRA_OAUTH_CALLBACK', 'FAILED');
      return reply.redirect('/connections?message=failed');
    }
  });
}
