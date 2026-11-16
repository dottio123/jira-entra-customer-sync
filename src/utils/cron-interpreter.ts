/**
 * Plain-language cron expression interpreter & validator.
 * Validates and interprets scheduled sync expressions supported by SchedulerService.
 */

export interface CronParts {
  minute: string;
  hour: string;
  dayOfMonth: string;
  month: string;
  dayOfWeek: string;
}

export type SupportedFrequency = 'DAILY' | 'WEEKDAYS' | 'WEEKLY' | 'MONTHLY';

export interface SupportedSchedule {
  raw: string;
  frequency: SupportedFrequency;
  minute: number;
  hour: number;
  dayOfWeek?: number; // 0 for Sunday .. 6 for Saturday (normalized)
  dayOfMonth?: number; // 1 .. 31
  month?: number; // 1 .. 12; set only for a once-a-year date ("M H D <month> *")
  description: string;
}

const MONTH_NAMES = [
  '',
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const DAY_NAMES: Record<number, string> = {
  0: 'Sunday',
  1: 'Monday',
  2: 'Tuesday',
  3: 'Wednesday',
  4: 'Thursday',
  5: 'Friday',
  6: 'Saturday',
};

const DAY_NAME_ALIASES: Record<string, number> = {
  SUN: 0,
  SUNDAY: 0,
  MON: 1,
  MONDAY: 1,
  TUE: 2,
  TUES: 2,
  TUESDAY: 2,
  WED: 3,
  WEDNESDAY: 3,
  THU: 4,
  THUR: 4,
  THURS: 4,
  THURSDAY: 4,
  FRI: 5,
  FRIDAY: 5,
  SAT: 6,
  SATURDAY: 6,
};

function formatTime(hour: number, minute: number): string {
  const period = hour >= 12 ? 'PM' : 'AM';
  const displayHour = hour % 12 === 0 ? 12 : hour % 12;
  const displayMinute = minute.toString().padStart(2, '0');
  return `${displayHour}:${displayMinute} ${period}`;
}

function getOrdinalSuffix(n: number): string {
  if (n === 1 || n === 21 || n === 31) return 'st';
  if (n === 2 || n === 22) return 'nd';
  if (n === 3 || n === 23) return 'rd';
  return 'th';
}

export function parseCronParts(expression: string): CronParts | null {
  if (!expression || typeof expression !== 'string') return null;
  const tokens = expression.trim().split(/\s+/);
  if (tokens.length !== 5) return null;
  return {
    minute: tokens[0]!,
    hour: tokens[1]!,
    dayOfMonth: tokens[2]!,
    month: tokens[3]!,
    dayOfWeek: tokens[4]!,
  };
}

/**
 * Parses and validates an expression against the exact schedule patterns supported by SchedulerService.
 * Returns null if the expression is invalid or unsupported.
 */
export function parseSupportedSchedule(
  expression: string,
  timeZone?: string,
): SupportedSchedule | null {
  const parts = parseCronParts(expression);
  if (!parts) return null;

  const { minute, hour, dayOfMonth, month, dayOfWeek } = parts;

  // Minute and hour must be explicit integers within valid ranges (no * or steps)
  if (!/^\d+$/.test(minute) || !/^\d+$/.test(hour)) return null;
  const minuteNum = parseInt(minute, 10);
  const hourNum = parseInt(hour, 10);
  if (minuteNum < 0 || minuteNum > 59 || hourNum < 0 || hourNum > 23) return null;

  const timeStr = formatTime(hourNum, minuteNum);
  const tzSuffix = timeZone ? ` (${timeZone})` : '';

  // Pattern 1: DAILY ("M H * * *")
  if (dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return {
      raw: expression.trim(),
      frequency: 'DAILY',
      minute: minuteNum,
      hour: hourNum,
      description: `Every day at ${timeStr}${tzSuffix}`,
    };
  }

  // Pattern 2: WEEKDAYS ("M H * * 1-5" or "M H * * MON-FRI")
  const normDow = dayOfWeek.toUpperCase();
  if (dayOfMonth === '*' && month === '*' && (normDow === '1-5' || normDow === 'MON-FRI')) {
    return {
      raw: expression.trim(),
      frequency: 'WEEKDAYS',
      minute: minuteNum,
      hour: hourNum,
      description: `Every weekday (Monday through Friday) at ${timeStr}${tzSuffix}`,
    };
  }

  // Pattern 3: WEEKLY on a specific day ("M H * * 0", "M H * * 7", "M H * * SUN", etc.)
  if (dayOfMonth === '*' && month === '*') {
    let targetDow: number | undefined;
    if (/^[0-7]$/.test(dayOfWeek)) {
      const parsedDow = parseInt(dayOfWeek, 10);
      targetDow = parsedDow === 7 ? 0 : parsedDow;
    } else if (DAY_NAME_ALIASES[normDow] !== undefined) {
      targetDow = DAY_NAME_ALIASES[normDow];
    }

    if (targetDow !== undefined && targetDow >= 0 && targetDow <= 6) {
      const dayName = DAY_NAMES[targetDow] ?? 'Sunday';
      return {
        raw: expression.trim(),
        frequency: 'WEEKLY',
        minute: minuteNum,
        hour: hourNum,
        dayOfWeek: targetDow,
        description: `Every ${dayName} at ${timeStr}${tzSuffix}`,
      };
    }
  }

  // Pattern 4: MONTHLY on a specific day of the month ("M H D * *", or "M H D M *")
  if (/^\d+$/.test(dayOfMonth) && dayOfWeek === '*') {
    const dom = parseInt(dayOfMonth, 10);
    if (dom >= 1 && dom <= 31) {
      if (month === '*') {
        return {
          raw: expression.trim(),
          frequency: 'MONTHLY',
          minute: minuteNum,
          hour: hourNum,
          dayOfMonth: dom,
          description: `On the ${dom}${getOrdinalSuffix(dom)} of every month at ${timeStr}${tzSuffix}`,
        };
      }
      if (/^\d+$/.test(month)) {
        const monNum = parseInt(month, 10);
        if (monNum >= 1 && monNum <= 12) {
          const monName = MONTH_NAMES[monNum];
          return {
            raw: expression.trim(),
            frequency: 'MONTHLY',
            minute: minuteNum,
            hour: hourNum,
            dayOfMonth: dom,
            month: monNum,
            description: `On ${monName} ${dom}${getOrdinalSuffix(dom)} at ${timeStr}${tzSuffix}`,
          };
        }
      }
    }
  }

  return null;
}

/**
 * Validates a submitted schedule string. Returns descriptive error for unsupported syntax.
 */
export function validateScheduleCron(
  expression: string,
): { valid: true; schedule: SupportedSchedule } | { valid: false; error: string } {
  if (!expression || typeof expression !== 'string' || !expression.trim()) {
    return { valid: false, error: 'Cron expression cannot be empty.' };
  }

  const parts = parseCronParts(expression);
  if (!parts) {
    return {
      valid: false,
      error:
        'Cron expression must contain exactly 5 space-separated fields (minute, hour, day-of-month, month, day-of-week).',
    };
  }

  // Check for multi-run per day patterns (like */N or * for minute/hour)
  if (
    parts.minute.includes('/') ||
    parts.minute === '*' ||
    parts.hour.includes('/') ||
    parts.hour === '*'
  ) {
    return {
      valid: false,
      error:
        'Interval or multi-execution schedules (such as */15 or * for hour/minute) are not supported. Synchronization is designed to run once per scheduled window to protect Jira and Entra API rate limits.',
    };
  }

  const schedule = parseSupportedSchedule(expression);
  if (!schedule) {
    return {
      valid: false,
      error:
        "Unsupported cron schedule. Supported formats include: daily at a specific time (e.g. '0 2 * * *'), weekdays ('0 2 * * 1-5'), weekly on a specific day (e.g. '0 2 * * 0'), or monthly ('0 2 1 * *').",
    };
  }

  return { valid: true, schedule };
}

/** True when the value is an IANA time zone name the runtime recognizes (for example `Europe/London`). */
export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone || !timeZone.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timeZone.trim() });
    return true;
  } catch {
    return false;
  }
}

/**
 * Generates a human-readable plain language description for supported schedules.
 * Returns an explanatory fallback message for unsupported or invalid schedules.
 */
export function describeCron(expression: string, timeZone?: string): string {
  if (!expression || typeof expression !== 'string') {
    return 'No schedule set';
  }

  const schedule = parseSupportedSchedule(expression, timeZone);
  if (schedule) {
    return schedule.description;
  }

  return `Unsupported schedule expression (${expression.trim()})`;
}
