import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { parseApprovedEmailDomains } from '../../services/approved-email-domains';
import { parseRecipients } from '../../services/notification-service';
import { isSafeEmailAddress } from '../../services/smtp-client';
import { isLoopbackHost } from '../config';
import { DEFAULT_SMTP_PORT } from '../defaults';
import { Principal, SessionRecord, SystemSettings } from '../store';
import { WebContext, form, query } from '../http/context';
import type { Notice } from '../view-helpers';
import { redirectWithNotice } from './runs';

const MODES: ReadonlyArray<SystemSettings['commissioning_status']> = [
  'UNCOMMISSIONED',
  'COMMISSIONED_MANUAL_ONLY',
  'COMMISSIONED_AUTOMATED',
];

/** Webhook targets must be HTTPS; plain HTTP is accepted only for a loopback test receiver. */
export function isAcceptableWebhookUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && isLoopbackHost(url.hostname);
  } catch {
    return false;
  }
}

function validateAlertSettings(fields: Record<string, string | undefined>): string | undefined {
  const webhookUrl = fields.webhook_url?.trim() ?? '';
  if (fields.webhook_enabled === 'true' && !webhookUrl)
    return 'Enter a webhook URL, or turn the webhook off.';
  if (webhookUrl && !isAcceptableWebhookUrl(webhookUrl)) {
    return 'The webhook URL must start with https:// and must not contain a user name or password.';
  }

  const smtpEnabled = fields.smtp_enabled === 'true';
  const host = fields.smtp_host?.trim() ?? '';
  if (host && !/^[A-Za-z0-9.-]{1,253}$/.test(host)) return 'Enter a valid mail server host name.';
  const portText = fields.smtp_port?.trim() || String(DEFAULT_SMTP_PORT);
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || port < 1 || port > 65535) {
    return 'The mail server port must be a number between 1 and 65535.';
  }
  const from = fields.smtp_from?.trim() ?? '';
  if (from && !isSafeEmailAddress(from)) return 'Enter a valid From address.';
  const recipients = parseRecipients(fields.smtp_to);
  if (recipients.some((r) => !isSafeEmailAddress(r))) {
    return 'Enter valid recipient addresses, separated by commas.';
  }
  if (smtpEnabled && (!host || !from || recipients.length === 0)) {
    return 'Email alerts need a mail server, a From address, and at least one recipient.';
  }
  const username = fields.smtp_username?.trim() ?? '';
  if (username.length > 254 || /[\r\n]/.test(username))
    return 'Enter a valid mail server user name.';
  return undefined;
}

export function registerSettingsRoutes(app: FastifyInstance, ctx: WebContext): void {
  const { store, services, config } = ctx;

  const renderSettings = async (
    request: FastifyRequest,
    reply: FastifyReply,
    current: SessionRecord,
    extra: { notice?: Notice; draft?: Record<string, string | undefined> } = {},
  ) =>
    ctx.render(request, reply, 'settings', 'Settings', current.principal as Principal, {
      csrfToken: current.csrfToken,
      settings: store.getSettings(),
      callbackUrl: config.callbackUrl,
      oauth: services.oauthStatus(),
      message: query(request).message,
      ...extra,
    });

  app.get('/settings', async (request, reply) => {
    const current = await ctx.requireSession(request, reply, true);
    if (!current) return;
    await renderSettings(request, reply, current);
  });

  app.post('/settings/domains', async (request, reply) => {
    const current = await ctx.requireFormSession(request, reply, true);
    if (!current) return;
    if (store.getActiveLock()) {
      reply.code(409);
      return renderSettings(request, reply, current, {
        notice: {
          tone: 'warning',
          title: 'Approved domains were not changed',
          text: 'Wait for the active run to finish before changing approved domains.',
        },
      });
    }
    try {
      const domains = parseApprovedEmailDomains(form(request).approved_email_domains ?? '');
      store.updateSettings({ approved_email_domains: domains.join(',') }, current.principal.id);
    } catch {
      reply.code(400);
      return renderSettings(request, reply, current, {
        notice: {
          tone: 'danger',
          title: 'Approved domains were not saved',
          text: 'Enter valid email domains without @, wildcards, or URLs (maximum 100).',
        },
      });
    }
    return reply.redirect('/settings?message=domains_saved');
  });

  app.post('/settings/commission', async (request, reply) => {
    const current = await ctx.requireFormSession(request, reply, true);
    if (!current) return;

    const fields = form(request);
    const requested = fields.commissioning_status as SystemSettings['commissioning_status'];
    if (!MODES.includes(requested)) {
      return redirectWithNotice(ctx, request, reply, '/settings', 'mode_invalid');
    }
    const writesEnabled = fields.writes_enabled === 'true';
    const currentSettings = store.getSettings();

    if (requested === 'UNCOMMISSIONED') {
      // Setup mode always turns writing and automation off.
      store.updateSettings(
        { commissioning_status: requested, writes_enabled: false, automation_enabled: false },
        current.principal.id,
      );
      return reply.redirect('/settings?message=commissioned');
    }

    if (requested === 'COMMISSIONED_AUTOMATED') {
      if (currentSettings.commissioning_status === 'UNCOMMISSIONED') {
        return redirectWithNotice(ctx, request, reply, '/settings', 'mode_needs_manual');
      }
      if (!store.hasSuccessfulManualRollout()) {
        return redirectWithNotice(ctx, request, reply, '/settings', 'mode_needs_update');
      }
    }

    store.updateSettings(
      {
        commissioning_status: requested,
        writes_enabled: writesEnabled,
        // Leaving Automatic mode also turns scheduled automatic updates off.
        ...(requested === 'COMMISSIONED_MANUAL_ONLY' ? { automation_enabled: false } : {}),
      },
      current.principal.id,
    );
    return reply.redirect('/settings?message=commissioned');
  });

  app.post('/settings/alerts', async (request, reply) => {
    const current = await ctx.requireFormSession(request, reply, true);
    if (!current) return;

    const fields = form(request);
    const problem = validateAlertSettings(fields);
    if (problem) {
      reply.code(400);
      return renderSettings(request, reply, current, {
        notice: { tone: 'danger', title: 'Notification settings were not saved', text: problem },
        draft: fields,
      });
    }

    store.updateSettings(
      {
        webhook_enabled: fields.webhook_enabled === 'true',
        webhook_url: fields.webhook_url?.trim() || '',
        smtp_enabled: fields.smtp_enabled === 'true',
        smtp_host: fields.smtp_host?.trim() || '',
        smtp_port: Number(fields.smtp_port?.trim() || DEFAULT_SMTP_PORT),
        smtp_from: fields.smtp_from?.trim() || '',
        smtp_to: parseRecipients(fields.smtp_to).join(', '),
        smtp_username: fields.smtp_username?.trim() || '',
      },
      current.principal.id,
    );
    // The password field is write-only: blank keeps the stored password unless "clear" is ticked.
    if (fields.smtp_password_clear === 'true' || !fields.smtp_username?.trim()) {
      store.setSmtpPassword('', current.principal.id);
    } else if (fields.smtp_password) {
      store.setSmtpPassword(fields.smtp_password, current.principal.id);
    }
    return reply.redirect('/settings?message=alerts_saved');
  });
}
