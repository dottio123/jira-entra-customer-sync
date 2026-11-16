import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { logger } from '../../utils/logger';
import { WebContext, form } from '../http/context';

/** Redirects back to the submitting page (or a fallback) with a standard notice code. */
export function redirectWithNotice(
  ctx: WebContext,
  request: FastifyRequest,
  reply: FastifyReply,
  fallback: string,
  notice: string,
): FastifyReply {
  const target = ctx.origin.safeRedirectPath(request.headers.referer) ?? fallback;
  const url = new URL(target, 'http://local');
  url.searchParams.set('notice', notice);
  return reply.redirect(`${url.pathname}${url.search}`);
}

export function registerRunRoutes(app: FastifyInstance, ctx: WebContext): void {
  const { store, services, config, runs } = ctx;

  /** Returns a notice code when no new run may start right now. */
  const runBlocker = (): string | undefined => {
    if (runs.isStopping) return 'shutting_down';
    if (store.getSettings().paused) return 'paused';
    if (store.getActiveLock()) return 'run_active';
    if (config.serviceDeskIds.length === 0) return 'scope_missing';
    return undefined;
  };

  app.get('/runs', async (request, reply) => {
    const current = await ctx.requireSession(request, reply);
    if (!current) return;
    await ctx.render(request, reply, 'runs', 'Sync history', current.principal, {
      csrfToken: current.csrfToken,
      runs: store.listRuns(50),
      activeLock: store.getActiveLock(),
      settings: store.getSettings(),
    });
  });

  app.post('/runs/preview', async (request, reply) => {
    const current = await ctx.requireFormSession(request, reply, true);
    if (!current) return;
    const blocker = runBlocker();
    if (blocker) return redirectWithNotice(ctx, request, reply, '/runs', blocker);

    const runId = store.createRun({
      runType: 'PREVIEW',
      triggerSource: 'MANUAL',
      scopeServiceDeskIds: config.serviceDeskIds,
      createdByUserId: current.principal.id,
    });
    runs.track(
      services.previewService
        .executePreview({ runId, scopeServiceDeskIds: config.serviceDeskIds })
        .catch((err) => {
          logger.error('Background preview execution failed', {
            runId,
            error: err instanceof Error ? err.name : 'UNKNOWN',
          });
        }),
    );
    return reply.redirect(`/runs/${runId}`);
  });

  app.get('/runs/:id', async (request, reply) => {
    const current = await ctx.requireSession(request, reply, true);
    if (!current) return;
    const id = parseInt((request.params as { id?: string }).id ?? '', 10);
    const run = Number.isNaN(id) ? undefined : store.getRun(id, true);
    if (!run) {
      return ctx.renderError(request, reply, 404, {
        tone: 'neutral',
        title: 'Run not found',
        text: 'It may have been entered incorrectly. Open Sync history to see all runs.',
      });
    }
    await ctx.render(request, reply, 'run-detail', `Run #${run.id}`, current.principal, {
      csrfToken: current.csrfToken,
      run,
      settings: store.getSettings(),
      writePermission: services.jiraWritePermission(),
    });
  });

  app.post('/runs/approve', async (request, reply) => {
    const current = await ctx.requireFormSession(request, reply, true);
    if (!current) return;

    const fields = form(request);
    const previewRunId = parseInt(fields.previewRunId ?? '', 10);
    const approvalDigest = fields.approvalDigest?.trim().toLowerCase() ?? '';
    const back = Number.isNaN(previewRunId) ? '/runs' : `/runs/${previewRunId}`;

    const settings = store.getSettings();
    if (settings.commissioning_status === 'UNCOMMISSIONED' || !settings.writes_enabled) {
      return redirectWithNotice(ctx, request, reply, back, 'writes_off');
    }
    if (Number.isNaN(previewRunId) || !/^[a-f0-9]{64}$/.test(approvalDigest)) {
      return redirectWithNotice(ctx, request, reply, back, 'invalid_approval');
    }
    const blocker = runBlocker();
    if (blocker) return redirectWithNotice(ctx, request, reply, back, blocker);
    const permission = services.jiraWritePermission();
    if (!permission.allowedByConfig || !permission.granted) {
      return redirectWithNotice(ctx, request, reply, back, 'write_permission_missing');
    }
    const preview = store.getRun(previewRunId);
    if (preview && preview.runType === 'PREVIEW' && preview.proposedCustomerChanges === 0) {
      return redirectWithNotice(ctx, request, reply, back, 'nothing_to_apply');
    }

    const writeRunId = store.createRun({
      runType: 'LIVE_ROLLOUT',
      triggerSource: 'MANUAL',
      scopeServiceDeskIds: config.serviceDeskIds,
      approvalDigest,
      previewRunId,
      createdByUserId: current.principal.id,
    });
    runs.track(
      services.writerService
        .executeLiveRollout({
          runId: writeRunId,
          previewRunId,
          approvalDigest,
          configuredScopeServiceDeskIds: config.serviceDeskIds,
          actorUserId: current.principal.id,
        })
        .catch((err) => {
          logger.error('Background rollout execution failed', {
            runId: writeRunId,
            error: err instanceof Error ? err.name : 'UNKNOWN',
          });
        }),
    );
    return reply.redirect(`/runs/${writeRunId}`);
  });

  app.post('/settings/pause', async (request, reply) => {
    const current = await ctx.requireFormSession(request, reply, true);
    if (!current) return;
    // The form states the intended result, so a stale tab or double submit cannot reverse it.
    const requested = form(request).paused;
    const paused =
      requested === 'true' ? true : requested === 'false' ? false : !store.getSettings().paused;
    store.updateSetting('paused', String(paused), current.principal.id);
    return redirectWithNotice(ctx, request, reply, '/runs', paused ? 'paused_saved' : 'resumed');
  });
}
