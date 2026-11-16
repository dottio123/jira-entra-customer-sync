import type { FastifyInstance } from 'fastify';
import type { WebContext } from '../http/context';

export function registerOverviewRoutes(app: FastifyInstance, ctx: WebContext): void {
  const { store, services, config } = ctx;

  app.get('/overview', async (request, reply) => {
    const current = await ctx.requireSession(request, reply);
    if (!current) return;
    await ctx.render(request, reply, 'overview', 'Overview', current.principal, {
      csrfToken: current.csrfToken,
      oauth: services.oauthStatus(),
      settings: store.getSettings(),
      recentRuns: store.listRuns(5),
      activeLock: store.getActiveLock(),
      alerts: store.listAlerts(5, true),
      latestPreview: store.getLatestCompletedPreview(),
      redirectUriMismatch: config.redirectUriMismatch,
      serviceDeskConfigured: config.serviceDeskIds.length > 0,
    });
  });

  app.post('/alerts/:id/ack', async (request, reply) => {
    const current = await ctx.requireFormSession(request, reply, true);
    if (!current) return;
    const alertId = parseInt((request.params as { id?: string }).id ?? '', 10);
    if (!isNaN(alertId)) {
      store.acknowledgeAlert(alertId);
      store.audit(current.principal.id, 'ALERT_DISMISSED', `alert=${alertId}`);
    }
    return reply.redirect(ctx.origin.safeRedirectPath(request.headers.referer) ?? '/overview');
  });
}
