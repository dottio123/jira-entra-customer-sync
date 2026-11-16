/**
 * Presentation helpers shared by the EJS views.
 * Translate internal status codes into plain-language labels while keeping the
 * original code available for administrators (tooltips and technical details).
 */
import { parseSupportedSchedule } from '../utils/cron-interpreter';
import type { SystemSettings } from './store';
import { SYNCED_FIELDS } from '../connectors/jira/field-catalog';

/** Labels of the synchronized fields, in display order. */
export const syncedFieldLabels: readonly string[] = SYNCED_FIELDS.map((f) => f.label);

export type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

export interface Label {
  label: string;
  tone: Tone;
  help: string;
  code: string;
}

function label(code: string, value: string, tone: Tone, help = ''): Label {
  return { label: value, tone, help, code };
}

const RUN_STATUS: Record<string, [string, Tone, string]> = {
  PENDING: ['Queued', 'neutral', 'Waiting to start.'],
  RUNNING: ['In progress', 'info', 'This run is working now.'],
  COMPLETED: ['Completed', 'success', 'Finished without problems.'],
  FAILED: ['Stopped safely', 'danger', 'Stopped before finishing. Nothing uncertain was retried.'],
  PAUSED: ['Paused', 'warning', 'Held because syncing is paused or a safety limit was reached.'],
  INTERRUPTED: [
    'Interrupted',
    'warning',
    'The service restarted while this run was active. It was not replayed.',
  ],
};

const RUN_TYPE: Record<string, [string, string]> = {
  PREVIEW: ['Preview', 'Checks for differences. Nothing is changed in Jira.'],
  LIVE_ROLLOUT: ['Update', 'Applies approved changes to Jira customers.'],
  COMMISSIONING_TEST: ['Setup test', 'Simulated run recorded during commissioning.'],
};

const TRIGGER: Record<string, string> = {
  MANUAL: 'Started manually',
  SCHEDULED: 'Scheduled',
};

const SKIP_REASON: Record<string, [string, Tone, string]> = {
  DOMAIN_NOT_APPROVED: [
    'Email domain not included',
    'neutral',
    'The customer’s email domain is not on the approved domain list in Settings.',
  ],
  EMAIL_UNAVAILABLE: [
    'No email in Jira',
    'warning',
    'Jira did not return an email address for this customer, so it cannot be matched.',
  ],
  ENTRA_NOT_FOUND: [
    'Not found in directory',
    'warning',
    'No active directory user has this exact email address.',
  ],
  ENTRA_AMBIGUOUS: [
    'Multiple directory matches',
    'warning',
    'More than one directory user has this email, so no update is made.',
  ],
  INACTIVE: ['Inactive in Jira', 'neutral', 'The customer account is inactive in Jira.'],
};

const FIELD: Record<string, string> = {
  title: 'Job title',
  officephonenumber: 'Office phone',
  'office phone number': 'Office phone',
  supervisor: 'Supervisor',
  officeclassroom: 'Office / room',
  'office/classroom': 'Office / room',
  emailaddress: 'Email address',
  'email address': 'Email address',
};

const WRITE_RESULT: Record<string, [string, Tone, string]> = {
  VERIFIED: ['Confirmed', 'success', 'Written and confirmed by reading it back from Jira.'],
  FAILED: ['Failed', 'danger', 'Jira rejected the update, or the value read back did not match.'],
  PARTIAL: ['Partly updated', 'warning', 'Some details were confirmed before the update stopped.'],
  OUTCOME_UNKNOWN: [
    'Outcome unknown',
    'danger',
    'The request was sent but Jira did not answer. Check this customer in Jira before retrying.',
  ],
  VERIFICATION_UNAVAILABLE: [
    'Not confirmed',
    'warning',
    'Jira accepted the update, but it could not be read back to confirm it.',
  ],
  SKIPPED: ['Not attempted', 'neutral', 'Stopped before this detail was written.'],
  NOT_ATTEMPTED: ['Not attempted', 'neutral', 'Stopped before this customer was updated.'],
};

/** A message box shown at the top of a page. */
export interface Notice {
  tone: Tone;
  title: string;
  text?: string;
}

/** Standard notices addressed by ?notice=<code> after a redirect. */
const NOTICES: Record<string, Notice> = {
  run_active: {
    tone: 'warning',
    title: 'Another run is in progress',
    text: 'Wait for it to finish, then try again.',
  },
  paused: {
    tone: 'warning',
    title: 'Syncing is paused',
    text: 'Resume syncing before starting a preview or an update.',
  },
  shutting_down: {
    tone: 'warning',
    title: 'The service is restarting',
    text: 'New runs can start once it is back.',
  },
  scope_missing: {
    tone: 'danger',
    title: 'No Jira service desk is configured',
    text: 'Set JSM_SERVICE_DESK_IDS in the service configuration and restart the service.',
  },
  writes_off: {
    tone: 'neutral',
    title: 'Updates to Jira are turned off',
    text: 'Choose Manual approval and turn on Allow updates to Jira in Settings first.',
  },
  write_permission_missing: {
    tone: 'warning',
    title: 'Jira has not granted permission to update customer details',
    text: 'Open Connections, choose Reconnect Jira, and accept all permissions, then try again.',
  },
  invalid_approval: {
    tone: 'danger',
    title: 'The approval code was not accepted',
    text: 'Use the 64-character approval code shown on the preview.',
  },
  nothing_to_apply: {
    tone: 'info',
    title: 'Nothing to apply',
    text: 'This preview found no changes.',
  },
  mode_invalid: { tone: 'danger', title: 'Choose an operating mode' },
  mode_needs_manual: {
    tone: 'warning',
    title: 'Use Manual approval first',
    text: 'The service must run in Manual approval before it can switch to Automatic.',
  },
  mode_needs_update: {
    tone: 'warning',
    title: 'Complete a manual update first',
    text: 'Automatic mode is available after at least one approved update has been confirmed in Jira.',
  },
  domains_locked: {
    tone: 'warning',
    title: 'Approved domains were not changed',
    text: 'Wait for the active run to finish before changing approved domains.',
  },
  paused_saved: {
    tone: 'warning',
    title: 'Syncing paused',
    text: 'No new previews or updates will start.',
  },
  resumed: { tone: 'success', title: 'Syncing resumed' },
  login_expired: {
    tone: 'warning',
    title: 'The sign-in page expired',
    text: 'Enter your details again.',
  },
};

export function noticeFor(code: string | undefined): Notice | undefined {
  return code ? NOTICES[code] : undefined;
}

const MODE: Record<string, [string, Tone, string]> = {
  UNCOMMISSIONED: [
    'Setup — previews only',
    'neutral',
    'The service only checks for differences. Nothing can be changed in Jira.',
  ],
  COMMISSIONED_MANUAL_ONLY: [
    'Manual approval',
    'info',
    'Changes are applied only after an administrator reviews and approves a preview.',
  ],
  COMMISSIONED_AUTOMATED: [
    'Automatic',
    'success',
    'Changes may also be applied automatically at the scheduled time.',
  ],
};

const ALERT_SEVERITY: Record<string, [string, Tone]> = {
  ERROR: ['Error', 'danger'],
  WARN: ['Warning', 'warning'],
  INFO: ['Info', 'info'],
};

export function runStatus(code: string): Label {
  const entry = RUN_STATUS[code];
  return entry ? label(code, ...entry) : label(code, humanize(code), 'neutral');
}

export function runType(code: string): Label {
  const entry = RUN_TYPE[code];
  return entry
    ? label(code, entry[0], 'neutral', entry[1])
    : label(code, humanize(code), 'neutral');
}

export function triggerLabel(code: string): string {
  return TRIGGER[code] ?? humanize(code);
}

export function skipReason(code: string): Label {
  const entry = SKIP_REASON[code];
  return entry ? label(code, ...entry) : label(code, humanize(code), 'neutral');
}

export function fieldLabel(name: string): string {
  return FIELD[String(name).toLowerCase()] ?? String(name);
}

export function writeResult(code: string): Label {
  const entry = WRITE_RESULT[code];
  return entry ? label(code, ...entry) : label(code, humanize(code), 'neutral');
}

export function operatingMode(code: string): Label {
  const entry = MODE[code];
  return entry ? label(code, ...entry) : label(code, humanize(code), 'neutral');
}

export function alertSeverity(code: string): Label {
  const entry = ALERT_SEVERITY[code];
  return entry ? label(code, entry[0], entry[1]) : label(code, humanize(code), 'neutral');
}

export function roleLabel(role: string): string {
  return role === 'admin' ? 'Administrator' : role === 'viewer' ? 'Viewer' : humanize(role);
}

/** Overall state of Jira updates, used by the sidebar and overview. */
export function updatesState(
  settings: Pick<
    SystemSettings,
    'paused' | 'writes_enabled' | 'automation_enabled' | 'commissioning_status'
  >,
): Label {
  if (settings.paused) {
    return label('PAUSED', 'Paused', 'warning', 'All syncing is on hold.');
  }
  if (!settings.writes_enabled || settings.commissioning_status === 'UNCOMMISSIONED') {
    return label('WRITES_DISABLED', 'Off', 'neutral', 'Previews only. Nothing is changed in Jira.');
  }
  if (settings.automation_enabled && settings.commissioning_status === 'COMMISSIONED_AUTOMATED') {
    return label('AUTOMATED', 'Automatic', 'success', 'Changes apply on schedule.');
  }
  return label('MANUAL', 'On — needs approval', 'info', 'Changes apply after you approve them.');
}

export function formatDateTime(ms: number | null | undefined, timeZone?: string): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  const options: Intl.DateTimeFormatOptions = {
    dateStyle: 'medium',
    timeStyle: 'short',
  };
  try {
    return new Intl.DateTimeFormat('en-US', { ...options, timeZone }).format(new Date(ms));
  } catch {
    return new Intl.DateTimeFormat('en-US', options).format(new Date(ms));
  }
}

export function formatDuration(
  startedAt: number | null | undefined,
  completedAt: number | null | undefined,
): string {
  if (startedAt == null || completedAt == null || completedAt < startedAt) return '—';
  const seconds = Math.round((completedAt - startedAt) / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min`;
}

export function formatNumber(value: unknown): string {
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString('en-US') : '0';
}

export function plural(count: unknown, singular: string, pluralForm = `${singular}s`): string {
  const n = Number(count);
  return `${formatNumber(n)} ${n === 1 ? singular : pluralForm}`;
}

export interface ScheduleFormValues {
  frequency: 'DAILY' | 'WEEKDAYS' | 'WEEKLY' | 'MONTHLY' | 'CUSTOM';
  time: string;
  dayOfWeek: number;
  dayOfMonth: number;
}

/** Pre-fill values for the friendly schedule picker. */
export function scheduleFormValues(expression: string): ScheduleFormValues {
  const parsed = parseSupportedSchedule(expression);
  // The picker offers "every month on day 1-28"; anything else stays in the advanced field.
  const monthlyIsCustom =
    parsed?.frequency === 'MONTHLY' &&
    (parsed.raw.split(/\s+/)[3] !== '*' || (parsed.dayOfMonth ?? 1) > 28);
  if (!parsed || monthlyIsCustom) {
    return { frequency: 'CUSTOM', time: '02:00', dayOfWeek: 1, dayOfMonth: 1 };
  }
  const pad = (n: number) => n.toString().padStart(2, '0');
  return {
    frequency: parsed.frequency,
    time: `${pad(parsed.hour)}:${pad(parsed.minute)}`,
    dayOfWeek: parsed.dayOfWeek ?? 1,
    dayOfMonth: parsed.dayOfMonth ?? 1,
  };
}

export function timeZoneOptions(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  try {
    return intl.supportedValuesOf ? intl.supportedValuesOf('timeZone') : [];
  } catch {
    return [];
  }
}

const ICONS = new Set([
  'overview',
  'history',
  'calendar',
  'settings',
  'link',
  'check',
  'check-circle',
  'alert',
  'x-circle',
  'info',
  'pause',
  'play',
  'copy',
  'refresh',
  'arrow-right',
  'arrow-left',
  'moon',
  'sun',
  'monitor',
  'logout',
  'shield',
  'users',
  'directory',
  'bell',
  'clock',
  'lock',
]);

/** Inline SVG reference to the sprite in partials/icons.ejs. Output with `<%-`. */
export function icon(name: string, className = ''): string {
  const safeName = ICONS.has(name) ? name : 'info';
  const cls = `icon${className ? ` ${escapeHtml(className)}` : ''}`;
  return `<svg class="${cls}" aria-hidden="true" focusable="false"><use href="#i-${safeName}"></use></svg>`;
}

/** Status pill. Output with `<%-`; all text is escaped here. */
export function badge(tone: Tone, text: string, title = ''): string {
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
  return `<span class="badge badge-${tone}"${titleAttr}><span class="badge-dot" aria-hidden="true"></span>${escapeHtml(text)}</span>`;
}

function humanize(code: string): string {
  const text = String(code ?? '')
    .replace(/_/g, ' ')
    .toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export const viewHelpers = {
  syncedFieldLabels,
  runStatus,
  runType,
  triggerLabel,
  skipReason,
  fieldLabel,
  operatingMode,
  writeResult,
  alertSeverity,
  roleLabel,
  updatesState,
  formatDateTime,
  formatDuration,
  formatNumber,
  plural,
  scheduleFormValues,
  timeZoneOptions,
  icon,
  badge,
};
