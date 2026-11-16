import { randomBytes } from 'crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { logger } from '../../utils/logger';
import { LOGIN_CSRF_TTL_SECONDS, SESSION_ABSOLUTE_TTL_MS } from '../defaults';
import { WebContext, form, query } from '../http/context';
import { constantEqual } from '../http/security';
import { hashPassword, passwordNeedsRehash, verifyPassword } from '../password';

const SESSION_COOKIE_MAX_AGE_SECONDS = SESSION_ABSOLUTE_TTL_MS / 1000;

/** Renders the sign-in page with a fresh login CSRF cookie. */
export async function renderLoginPage(
  ctx: WebContext,
  request: FastifyRequest,
  reply: FastifyReply,
  options: { statusCode?: number; error?: string | null } = {},
): Promise<void> {
  const csrf = randomBytes(32).toString('hex');
  reply.setCookie(ctx.cookies.loginCsrf, csrf, {
    ...ctx.cookies.options,
    maxAge: LOGIN_CSRF_TTL_SECONDS,
  });
  if (options.statusCode) reply.code(options.statusCode);
  await ctx.render(request, reply, 'login', 'Sign in', null, {
    loginCsrf: csrf,
    error: options.error ?? null,
  });
}

export function registerAuthRoutes(app: FastifyInstance, ctx: WebContext): void {
  const { store, cookies } = ctx;
  // Pays the hashing cost for unknown usernames too, so timing does not reveal valid names.
  const dummyPasswordHash = hashPassword('nonexistent-local-user-password');

  app.get('/login', async (request, reply) => {
    if (!ctx.origin.isAllowedHost(request)) {
      return reply.redirect(`${ctx.config.publicBaseUrl}/login`);
    }
    if (ctx.session(request)) return reply.redirect('/overview');
    await renderLoginPage(ctx, request, reply, {
      error:
        query(request).error === 'invalid' ? 'The username or password was not accepted.' : null,
    });
  });

  app.post(
    '/login',
    { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const fields = form(request);
      if (!constantEqual(fields._csrf, request.cookies[cookies.loginCsrf])) {
        logger.warn('Web login request rejected', { reason: 'CSRF_CHECK_FAILED' });
        return reply.redirect('/login?notice=login_expired');
      }
      if (!ctx.origin.isAllowedOrigin(request.headers.origin)) {
        logger.warn('Web login request rejected', { reason: 'ORIGIN_MISMATCH' });
        return reply.code(303).redirect(`${ctx.config.publicBaseUrl}/login`);
      }
      const username = fields.username?.trim() ?? '';
      const password = fields.password ?? '';
      const user = username.length <= 64 ? store.getUserByUsername(username) : undefined;
      const passwordValid = verifyPassword(password, user?.passwordHash ?? dummyPasswordHash);
      if (!user || !passwordValid) {
        store.audit(null, 'LOCAL_LOGIN', 'DENIED');
        return reply.redirect('/login?error=invalid');
      }
      if (passwordNeedsRehash(user.passwordHash)) {
        store.rehashPassword(user.id, password);
      }
      const newSession = store.createSession(user.id);
      store.audit(user.id, 'LOCAL_LOGIN', 'SUCCESS');
      reply.clearCookie(cookies.loginCsrf, cookies.options);
      reply.setCookie(cookies.session, newSession.token, {
        ...cookies.options,
        maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
      });
      return reply.redirect(user.mustChangePassword ? '/password' : '/overview');
    },
  );

  app.get('/password', async (request, reply) => {
    const current = ctx.session(request);
    if (!current) return reply.redirect('/login');
    await ctx.render(request, reply, 'password', 'Change password', current.principal, {
      csrfToken: current.csrfToken,
      error:
        query(request).error === 'invalid'
          ? 'Check the current password and choose a new password of at least 12 characters.'
          : null,
    });
  });

  app.post(
    '/password',
    { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const current = ctx.session(request);
      if (!current) return reply.redirect('/login');
      if (
        !ctx.origin.isAllowedOrigin(request.headers.origin) ||
        !constantEqual(form(request)._csrf, current.csrfToken)
      ) {
        return ctx.renderError(request, reply, 403, {
          tone: 'warning',
          title: 'This form has expired',
          text: 'Reload the page and try again.',
        });
      }
      const fields = form(request);
      const user = store.getUserById(current.principal.id);
      const oldPassword = fields.currentPassword ?? '';
      const newPassword = fields.newPassword ?? '';
      if (
        !user ||
        !verifyPassword(oldPassword, user.passwordHash) ||
        newPassword !== fields.confirmPassword ||
        newPassword === oldPassword ||
        newPassword.length < 12 ||
        newPassword.length > 1024
      ) {
        return reply.redirect('/password?error=invalid');
      }
      store.changePassword(user.id, newPassword);
      const newSession = store.createSession(user.id);
      store.audit(user.id, 'PASSWORD_CHANGE', 'SUCCESS');
      reply.setCookie(cookies.session, newSession.token, {
        ...cookies.options,
        maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
      });
      return reply.redirect('/overview');
    },
  );

  app.post('/logout', async (request, reply) => {
    const current = ctx.session(request);
    if (!current) return reply.redirect('/login');
    if (
      !ctx.origin.isAllowedOrigin(request.headers.origin) ||
      !constantEqual(form(request)._csrf, current.csrfToken)
    ) {
      return ctx.renderError(request, reply, 403, {
        tone: 'warning',
        title: 'This form has expired',
        text: 'Reload the page and try again.',
      });
    }
    store.deleteSession(request.cookies[cookies.session]);
    reply.clearCookie(cookies.session, cookies.options);
    return reply.redirect('/login');
  });
}
