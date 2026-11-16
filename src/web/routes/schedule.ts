import type { FastifyInstance } from 'fastify';
import { isValidTimeZone, validateScheduleCron } from '../../utils/cron-interpreter';
import { DEFAULT_SCHEDULE_CRON, MAX_SAFETY_THRESHOLD } from '../defaults';
import { WebContext, form, query } from '../http/context';

/** Parses a whole number within [1, MAX_SAFETY_THRESHOLD]; undefined when invalid. */
function parseThreshold(value: string | undefined, fallback: number): number | undefined {
  if (value === undefined || value.trim() === '') return fallback;
  if (!/^\d+$/.test(value.trim())) return undefined;
  const n = Number(value.trim());
  return n >= 1 && n <= MAX_SAFETY_THRESHOLD ? n : undefined;
}

export function registerScheduleRoutes(app: FastifyInstance, ctx: WebContext): void {
  const { store } = ctx;

  app.get('/schedule', async (request, reply) => {
    const current = await ctx.requireSession(request, reply, true);
    if (!current) return;
    await ctx.render(request, reply, 'schedule', 'Schedule', current.principal, {
      csrfToken: current.csrfToken,
      settings: store.getSettings(),
      activeLock: store.getActiveLock(),
      message: query(request).message,
      error: query(request).error,
      maxThreshold: MAX_SAFETY_THRESHOLD,
    });
  });

  app.post('/schedule', async (request, reply) => {
    const current = await ctx.requireFormSession(request, reply, true);
    if (!current) return;

    const fields = form(request);
    const fail = (message: string) =>
      reply.redirect(`/schedule?error=${encodeURIComponent(message)}`);
    const currentSettings = store.getSettings();

    const scheduleCron = fields.schedule_cron?.trim() || DEFAULT_SCHEDULE_CRON;
    const validation = validateScheduleCron(scheduleCron);
    if (!validation.valid) return fail(validation.error);

    // A form without a time zone keeps the saved one rather than resetting it.
    const scheduleTimezone = fields.schedule_timezone?.trim() || currentSettings.schedule_timezone;
    if (!isValidTimeZone(scheduleTimezone)) {
      return fail(
        'Time zone not recognized. Use a name from the list, for example Europe/London or America/Chicago.',
      );
    }

    const maxCustomers = parseThreshold(
      fields.max_customers_threshold,
      currentSettings.max_customers_threshold,
    );
    const maxFields = parseThreshold(
      fields.max_fields_threshold,
      currentSettings.max_fields_threshold,
    );
    if (maxCustomers === undefined || maxFields === undefined) {
      return fail(
        `Safety limits must be whole numbers between 1 and ${MAX_SAFETY_THRESHOLD.toLocaleString('en-US')}.`,
      );
    }

    // Automation can only be on when the service is commissioned for automatic operation.
    const automationEnabled =
      fields.automation_enabled === 'true' &&
      currentSettings.commissioning_status === 'COMMISSIONED_AUTOMATED';

    store.updateSettings(
      {
        schedule_cron: scheduleCron,
        schedule_timezone: scheduleTimezone,
        max_customers_threshold: maxCustomers,
        max_fields_threshold: maxFields,
        automation_enabled: automationEnabled,
      },
      current.principal.id,
    );
    return reply.redirect('/schedule?message=saved');
  });
}
