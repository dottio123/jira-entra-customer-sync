import { WebStore } from '../web/store';
import { ProductionSyncPreviewService } from './production-sync-preview-service';
import { ProductionSyncWriterService } from './production-sync-writer-service';
import { NotificationService } from './notification-service';
import { Logger, logger } from '../utils/logger';
import { isValidTimeZone, parseSupportedSchedule } from '../utils/cron-interpreter';
import { DEFAULT_SCHEDULE_CRON, DEFAULT_SCHEDULE_TIMEZONE } from '../web/defaults';
import { errorMessage, notifySafely, sanitizeFailureReason } from './run-support';

export interface SchedulerServiceOptions {
  checkIntervalMs?: number;
  scopeServiceDeskIds: string[];
  now?: () => Date;
  log?: Logger;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

interface LocalTime {
  dateKey: string;
  month: number;
  day: number;
  weekday: number | undefined;
  hour: number;
  minute: number;
}

function toLocalTime(date: Date, timeZone: string): LocalTime {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const part = new Map(parts.map((p) => [p.type, p.value]));
  const year = part.get('year') ?? '';
  const month = part.get('month') ?? '';
  const day = part.get('day') ?? '';
  return {
    dateKey: `${year}-${month}-${day}`,
    month: parseInt(month, 10),
    day: parseInt(day, 10),
    weekday: WEEKDAY_INDEX[part.get('weekday') ?? ''],
    // Some runtimes render midnight as hour "24" with hour12: false.
    hour: parseInt(part.get('hour') ?? '0', 10) % 24,
    minute: parseInt(part.get('minute') ?? '0', 10),
  };
}

/**
 * Runs one scheduled preview per configured window (and, only when fully commissioned for
 * automatic operation, applies it). Ticks never throw: every failure is logged and the next
 * tick tries again.
 */
export class SchedulerService {
  private timer?: NodeJS.Timeout;
  private currentTick?: Promise<void>;
  private lastRunDateKey?: string;
  private lastPruneDateKey?: string;
  private lastConfigWarning?: string;
  private readonly checkIntervalMs: number;
  private readonly scopeServiceDeskIds: string[];
  private readonly now: () => Date;
  private readonly log: Logger;

  constructor(
    private readonly store: WebStore,
    private readonly previewService: ProductionSyncPreviewService,
    private readonly writerService: ProductionSyncWriterService,
    private readonly notificationService: NotificationService,
    options: SchedulerServiceOptions,
  ) {
    this.checkIntervalMs = options.checkIntervalMs ?? 60000;
    this.scopeServiceDeskIds = options.scopeServiceDeskIds;
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? logger;
  }

  start(): void {
    if (this.timer) return;
    this.log.info('Scheduler service started');
    this.timer = setInterval(() => {
      void this.tick();
    }, this.checkIntervalMs);
  }

  /** Stops future ticks and resolves once any tick in progress has finished. */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
      this.log.info('Scheduler service stopped');
    }
    await this.currentTick;
  }

  async tick(): Promise<void> {
    if (this.currentTick) return;
    this.currentTick = this.runTick()
      .catch((err) => {
        this.log.error('Scheduler tick failed', {
          error: sanitizeFailureReason(errorMessage(err)),
        });
      })
      .finally(() => {
        this.currentTick = undefined;
      });
    await this.currentTick;
  }

  private warnOnce(message: string, context: Record<string, unknown>): void {
    const key = `${message}|${JSON.stringify(context)}`;
    if (this.lastConfigWarning === key) return;
    this.lastConfigWarning = key;
    this.log.warn(message, context);
  }

  private async runTick(): Promise<void> {
    const settings = this.store.getSettings();
    if (settings.paused) return;

    const timeZone = settings.schedule_timezone || DEFAULT_SCHEDULE_TIMEZONE;
    if (!isValidTimeZone(timeZone)) {
      this.warnOnce('Scheduled synchronization skipped: unrecognized time zone', { timeZone });
      return;
    }
    const local = toLocalTime(this.now(), timeZone);

    // 1. Daily retention pruning, once per calendar day.
    if (this.lastPruneDateKey !== local.dateKey) {
      try {
        this.store.pruneRetention();
        this.lastPruneDateKey = local.dateKey;
      } catch (err) {
        this.log.warn('Daily scheduled retention prune failed', { error: errorMessage(err) });
      }
    }

    // 2. Is today a scheduled day, and has the window been reached?
    const schedule = parseSupportedSchedule(
      settings.schedule_cron || DEFAULT_SCHEDULE_CRON,
      timeZone,
    );
    if (!schedule) {
      this.warnOnce('Scheduled synchronization skipped: invalid or unsupported cron expression', {
        schedule_cron: settings.schedule_cron,
      });
      return;
    }

    if (schedule.frequency === 'WEEKDAYS') {
      if (local.weekday === undefined || local.weekday === 0 || local.weekday === 6) return;
    } else if (schedule.frequency === 'WEEKLY') {
      if (local.weekday !== schedule.dayOfWeek) return;
    } else if (schedule.frequency === 'MONTHLY') {
      if (local.day !== schedule.dayOfMonth) return;
      if (schedule.month !== undefined && local.month !== schedule.month) return;
    }

    const targetScheduleKey = `${local.dateKey}@${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')}`;
    if (this.lastRunDateKey === targetScheduleKey) return;
    if (this.alreadyRanForWindow(local.dateKey, schedule.hour, schedule.minute, timeZone)) {
      // DST fall-back and restart duplicate protection.
      this.lastRunDateKey = targetScheduleKey;
      return;
    }

    const isDue =
      local.hour > schedule.hour ||
      (local.hour === schedule.hour && local.minute >= schedule.minute);
    if (!isDue) return;

    // Another run holds the lock: try again on the next tick instead of skipping the window.
    if (this.store.getActiveLock()) {
      this.log.info('Scheduled synchronization deferred: another run is in progress');
      return;
    }

    if (this.scopeServiceDeskIds.length === 0) {
      this.warnOnce('Scheduled synchronization skipped: no Jira service desk scope configured', {});
      return;
    }

    this.lastRunDateKey = targetScheduleKey;
    await this.runScheduledSync(local.dateKey, schedule.hour, schedule.minute, timeZone);
  }

  /** A scheduled run started today at or after the target time already satisfies this window. */
  private alreadyRanForWindow(
    dateKey: string,
    targetHour: number,
    targetMinute: number,
    timeZone: string,
  ): boolean {
    const latest = this.store.getLatestScheduledRun();
    if (!latest) return false;
    const run = toLocalTime(new Date(latest.startedAt), timeZone);
    if (run.dateKey !== dateKey) return false;
    return run.hour > targetHour || (run.hour === targetHour && run.minute >= targetMinute);
  }

  private async runScheduledSync(
    dateKey: string,
    targetHour: number,
    targetMinute: number,
    timeZone: string,
  ): Promise<void> {
    // The preview and writer services record failures and send their own alerts.
    // Only failures before either service starts are reported here.
    let serviceStarted = false;
    try {
      this.log.info('Scheduled synchronization triggered', {
        dateKey,
        targetHour,
        targetMinute,
        timeZone,
      });

      const settings = this.store.getSettings();
      // Writes are gated by commissioning AND automation AND the writes switch.
      const automatedWritesAllowed =
        settings.commissioning_status === 'COMMISSIONED_AUTOMATED' &&
        settings.automation_enabled &&
        settings.writes_enabled;

      const previewRunId = this.store.createRun({
        runType: 'PREVIEW',
        triggerSource: 'SCHEDULED',
        scopeServiceDeskIds: this.scopeServiceDeskIds,
      });
      serviceStarted = true;
      const previewResult = await this.previewService.executePreview({
        runId: previewRunId,
        scopeServiceDeskIds: this.scopeServiceDeskIds,
      });

      if (automatedWritesAllowed && previewResult.proposedCustomerChangesCount > 0) {
        const writeRunId = this.store.createRun({
          runType: 'LIVE_ROLLOUT',
          triggerSource: 'SCHEDULED',
          scopeServiceDeskIds: this.scopeServiceDeskIds,
          approvalDigest: previewResult.previewDigest,
          previewRunId,
        });
        await this.writerService.executeLiveRollout({
          runId: writeRunId,
          previewRunId,
          approvalDigest: previewResult.previewDigest,
          configuredScopeServiceDeskIds: this.scopeServiceDeskIds,
        });
      }
    } catch (err) {
      const message = sanitizeFailureReason(errorMessage(err));
      this.log.error('Scheduled synchronization failed', { error: message });
      if (!serviceStarted) {
        await notifySafely(
          this.notificationService,
          {
            severity: 'ERROR',
            title: 'Scheduled run could not start',
            message: `The scheduled run could not start: ${message}`,
          },
          this.log,
        );
      }
    }
  }
}
