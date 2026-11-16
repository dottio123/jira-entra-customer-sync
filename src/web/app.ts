import * as fs from 'fs';
import * as path from 'path';
import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import ejs from 'ejs';
import { JiraCustomerDetailWriteClient, ReadOnlyJiraCustomerTarget } from '../connectors/jira';
import { DirectorySourcePort, ExistingCustomerScopeReaderPort } from '../domain';
import { logger } from '../utils/logger';
import { describeCron } from '../utils/cron-interpreter';
import { loadWebConfig, WebConfig } from './config';
import { SHUTDOWN_RUN_WAIT_MS } from './defaults';
import { CookieSettings, WebContext, form, query } from './http/context';
import { constantEqual, createOriginPolicy } from './http/security';
import { RunTracker } from './run-tracker';
import { registerAuthRoutes, renderLoginPage } from './routes/auth';
import { registerConnectionRoutes } from './routes/connections';
import { registerOverviewRoutes } from './routes/overview';
import { registerRunRoutes } from './routes/runs';
import { registerScheduleRoutes } from './routes/schedule';
import { registerSettingsRoutes } from './routes/settings';
import { registerSystemRoutes } from './routes/system';
import { WebStore } from './store';
import { Notice, noticeFor, viewHelpers } from './view-helpers';
import { createWebServices } from './wiring';

export interface WebAppOptions {
  config?: WebConfig;
  now?: () => number;
  oauthFetchFn?: typeof fetch;
  assetRoot?: string;
  directorySource?: DirectorySourcePort;
  scopeReader?: ExistingCustomerScopeReaderPort;
  jiraTarget?: ReadOnlyJiraCustomerTarget;
  jiraWriter?: JiraCustomerDetailWriteClient;
  notificationFetchFn?: typeof fetch;
  startScheduler?: boolean;
}

export async function createWebApp(options: WebAppOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadWebConfig();
  const store = new WebStore(
    path.join(config.dataDir, 'web.sqlite'),
    options.now,
    undefined,
    config.secretsDir,
  );
  try {
    store.bootstrapAdmin(config.adminUsername, config.bootstrapPassword);
  } catch (error) {
    store.close();
    throw error;
  }

  const runs = new RunTracker();
  const services = createWebServices(config, store, runs, options);
  const assetRoot = options.assetRoot ?? path.resolve(process.cwd(), 'src/web');
  const viewsDir = path.join(assetRoot, 'views');
  const logoAvailable = Boolean(config.logoFile && fs.existsSync(config.logoFile));
  const app = Fastify({ logger: false, trustProxy: config.trustProxy });

  const cookies: CookieSettings = {
    session: config.secureCookies ? '__Host-sync_session' : 'sync_session',
    loginCsrf: config.secureCookies ? '__Host-sync_login_csrf' : 'sync_login_csrf',
    options: { path: '/', httpOnly: true, secure: config.secureCookies, sameSite: 'lax' },
  };
  const contentSecurityPolicy = (allowAtlassianAuthorization = false): string =>
    `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; form-action 'self'${allowAtlassianAuthorization ? ' https://auth.atlassian.com https://id.atlassian.com' : ''}; base-uri 'none'; frame-ancestors 'none'`;
  const origin = createOriginPolicy(config);

  await app.register(cookie);
  await app.register(formbody);
  await app.register(rateLimit, { global: false });
  await app.register(staticFiles, {
    root: path.join(assetRoot, 'assets'),
    prefix: '/assets/',
    decorateReply: false,
  });

  app.addHook('onRequest', async (_request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    reply.header('X-Frame-Options', 'DENY');
    if (config.secureCookies) {
      reply.header('Strict-Transport-Security', 'max-age=31536000');
    }
  });
  app.addHook('onSend', async (_request, reply) => {
    if (!reply.hasHeader('content-security-policy')) {
      reply.header('Content-Security-Policy', contentSecurityPolicy(false));
    }
  });

  const render: WebContext['render'] = async (
    request,
    reply,
    page,
    title,
    principal,
    locals = {},
  ) => {
    const html = await ejs.renderFile(path.join(viewsDir, 'layout.ejs'), {
      page,
      title,
      principal,
      displayName: config.displayName,
      logoAvailable,
      describeCron,
      ...viewHelpers,
      systemState: principal ? store.getSettings() : null,
      csrfToken: undefined,
      notice: noticeFor(query(request).notice),
      ...locals,
    });
    reply.header('Cache-Control', 'no-store').type('text/html; charset=utf-8').send(html);
  };

  const session: WebContext['session'] = (request) =>
    store.getSession(request.cookies[cookies.session]);

  const renderError: WebContext['renderError'] = async (request, reply, statusCode, notice) => {
    reply.code(statusCode);
    const current = session(request);
    const principal = current && !current.principal.mustChangePassword ? current.principal : null;
    await render(request, reply, 'error', notice.title, principal, {
      csrfToken: current?.csrfToken,
      errorNotice: notice,
      statusCode,
    });
  };

  const requireSession: WebContext['requireSession'] = async (
    request,
    reply,
    adminOnly = false,
  ) => {
    const current = session(request);
    if (!current) {
      reply.redirect('/login');
      return undefined;
    }
    if (current.principal.mustChangePassword) {
      reply.redirect('/password');
      return undefined;
    }
    if (adminOnly && current.principal.role !== 'admin') {
      await renderError(request, reply, 403, {
        tone: 'danger',
        title: 'Administrator access required',
        text: 'Ask an administrator to make this change.',
      });
      return undefined;
    }
    return current;
  };

  const requireFormSession: WebContext['requireFormSession'] = async (
    request,
    reply,
    adminOnly = false,
  ) => {
    const current = await requireSession(request, reply, adminOnly);
    if (!current) return undefined;
    if (
      !origin.isAllowedOrigin(request.headers.origin) ||
      !constantEqual(form(request)._csrf, current.csrfToken)
    ) {
      await renderError(request, reply, 403, {
        tone: 'warning',
        title: 'This form has expired',
        text: 'Reload the page and try again.',
      });
      return undefined;
    }
    return current;
  };

  const ctx: WebContext = {
    config,
    store,
    services,
    runs,
    origin,
    cookies,
    contentSecurityPolicy,
    render,
    renderError,
    session,
    requireSession,
    requireFormSession,
  };

  if (options.startScheduler) services.schedulerService.start();
  if (config.allowInsecureRemoteHttp) {
    logger.warn('Insecure HTTP test mode enabled for non-loopback host', {
      publicBaseUrl: config.publicBaseUrl,
      reason: 'ALLOW_INSECURE_REMOTE_HTTP',
    });
  }
  if (config.legacyWriteScopeName) {
    logger.warn('PILOT_WRITE_SCOPE_ALLOWED is deprecated; use JIRA_WRITE_SCOPE_ALLOWED instead');
  }

  // Graceful shutdown: refuse new runs, let in-flight runs stop at their next safe point,
  // wait a bounded time, then close storage. Anything still running is marked INTERRUPTED
  // on the next start and is never replayed.
  app.addHook('onClose', async () => {
    runs.beginShutdown();
    const stopped = Promise.allSettled([
      services.schedulerService.stop(),
      runs.drain(SHUTDOWN_RUN_WAIT_MS),
    ]);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(resolve, SHUTDOWN_RUN_WAIT_MS);
    });
    await Promise.race([stopped, timeout]);
    if (timer) clearTimeout(timer);
    store.close();
  });

  app.setNotFoundHandler(async (request, reply) => {
    await renderError(request, reply, 404, {
      tone: 'neutral',
      title: 'Page not found',
      text: 'The page you were looking for does not exist.',
    });
  });

  app.setErrorHandler(async (error, request: FastifyRequest, reply: FastifyReply) => {
    const failure = error as { statusCode?: number; code?: string };
    if (failure.statusCode === 429) {
      logger.warn('Web request rate limited', { route: request.routeOptions.url ?? 'unknown' });
      if (request.routeOptions.url === '/login') {
        await renderLoginPage(ctx, request, reply, {
          statusCode: 429,
          error:
            'Too many sign-in attempts. Wait several minutes, then reload this page and try again.',
        });
        return;
      }
      await renderError(request, reply, 429, {
        tone: 'warning',
        title: 'Too many requests',
        text: 'Please wait a few minutes and try again.',
      });
      return;
    }
    if (failure.statusCode && failure.statusCode >= 400 && failure.statusCode < 500) {
      await renderError(request, reply, failure.statusCode, {
        tone: 'warning',
        title: 'The request could not be processed',
        text: 'Go back, reload the page, and try again.',
      });
      return;
    }
    const errorCode =
      typeof failure.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(failure.code)
        ? failure.code
        : 'UNCLASSIFIED';
    logger.error('Web request failed', { route: request.routeOptions.url ?? 'unknown', errorCode });
    try {
      await renderError(request, reply, 500, {
        tone: 'danger',
        title: 'Something went wrong',
        text: 'An internal error occurred. The details were recorded in the service log.',
      });
    } catch {
      reply.code(500).type('text/plain').send('An internal error occurred.');
    }
  });

  registerSystemRoutes(app, ctx, logoAvailable);
  registerAuthRoutes(app, ctx);
  registerOverviewRoutes(app, ctx);
  registerRunRoutes(app, ctx);
  registerScheduleRoutes(app, ctx);
  registerSettingsRoutes(app, ctx);
  registerConnectionRoutes(app, ctx, options.oauthFetchFn);

  return app;
}

export type { Notice };
