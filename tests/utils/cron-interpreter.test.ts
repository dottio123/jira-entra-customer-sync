import { describe, it, expect } from 'vitest';
import {
  describeCron,
  parseCronParts,
  parseSupportedSchedule,
  validateScheduleCron,
} from '../../src/utils/cron-interpreter';

describe('cron-interpreter', () => {
  describe('parseCronParts', () => {
    it('returns null for empty or invalid strings', () => {
      expect(parseCronParts('')).toBeNull();
      expect(parseCronParts('invalid')).toBeNull();
      expect(parseCronParts('* * * *')).toBeNull();
      expect(parseCronParts('* * * * * *')).toBeNull();
    });

    it('correctly splits valid 5-token cron expressions', () => {
      expect(parseCronParts('0 2 * * *')).toEqual({
        minute: '0',
        hour: '2',
        dayOfMonth: '*',
        month: '*',
        dayOfWeek: '*',
      });
      expect(parseCronParts('15   23 * *   *')).toEqual({
        minute: '15',
        hour: '23',
        dayOfMonth: '*',
        month: '*',
        dayOfWeek: '*',
      });
    });
  });

  describe('parseSupportedSchedule & validateScheduleCron', () => {
    it('accepts daily schedules with exact time', () => {
      const res = validateScheduleCron('0 2 * * *');
      expect(res.valid).toBe(true);
      if (res.valid) {
        expect(res.schedule.frequency).toBe('DAILY');
        expect(res.schedule.hour).toBe(2);
        expect(res.schedule.minute).toBe(0);
      }
      expect(parseSupportedSchedule('0 2 * * *')?.frequency).toBe('DAILY');
    });

    it('accepts weekday schedules', () => {
      const numRes = validateScheduleCron('30 8 * * 1-5');
      expect(numRes.valid).toBe(true);
      if (numRes.valid) {
        expect(numRes.schedule.frequency).toBe('WEEKDAYS');
        expect(numRes.schedule.hour).toBe(8);
        expect(numRes.schedule.minute).toBe(30);
      }

      const aliasRes = validateScheduleCron('0 9 * * MON-FRI');
      expect(aliasRes.valid).toBe(true);
      if (aliasRes.valid) {
        expect(aliasRes.schedule.frequency).toBe('WEEKDAYS');
      }
    });

    it('accepts weekly schedules with specific day of week', () => {
      const sunRes = validateScheduleCron('0 3 * * 0');
      expect(sunRes.valid).toBe(true);
      if (sunRes.valid) {
        expect(sunRes.schedule.frequency).toBe('WEEKLY');
        expect(sunRes.schedule.dayOfWeek).toBe(0);
      }

      const sun7Res = validateScheduleCron('0 3 * * 7');
      expect(sun7Res.valid).toBe(true);
      if (sun7Res.valid) {
        expect(sun7Res.schedule.frequency).toBe('WEEKLY');
        expect(sun7Res.schedule.dayOfWeek).toBe(0);
      }

      const friRes = validateScheduleCron('45 14 * * FRI');
      expect(friRes.valid).toBe(true);
      if (friRes.valid) {
        expect(friRes.schedule.frequency).toBe('WEEKLY');
        expect(friRes.schedule.dayOfWeek).toBe(5);
      }

      const wedRes = validateScheduleCron('0 2 * * WEDNESDAY');
      expect(wedRes.valid).toBe(true);
      if (wedRes.valid) {
        expect(wedRes.schedule.frequency).toBe('WEEKLY');
        expect(wedRes.schedule.dayOfWeek).toBe(3);
      }
    });

    it('accepts monthly schedules with specific day of month', () => {
      const monthRes = validateScheduleCron('0 0 1 * *');
      expect(monthRes.valid).toBe(true);
      if (monthRes.valid) {
        expect(monthRes.schedule.frequency).toBe('MONTHLY');
        expect(monthRes.schedule.dayOfMonth).toBe(1);
      }

      const midMonthRes = validateScheduleCron('30 22 15 * *');
      expect(midMonthRes.valid).toBe(true);
      if (midMonthRes.valid) {
        expect(midMonthRes.schedule.frequency).toBe('MONTHLY');
        expect(midMonthRes.schedule.dayOfMonth).toBe(15);
      }
    });

    it('rejects multi-run interval cron expressions with descriptive message', () => {
      const every15 = validateScheduleCron('*/15 * * * *');
      expect(every15.valid).toBe(false);
      if (!every15.valid) {
        expect(every15.error).toContain('Interval or multi-execution schedules');
      }

      const everyMin = validateScheduleCron('* * * * *');
      expect(everyMin.valid).toBe(false);

      const every2h = validateScheduleCron('0 */2 * * *');
      expect(every2h.valid).toBe(false);
    });

    it('rejects malformed or empty expressions with descriptive error', () => {
      const empty = validateScheduleCron('');
      expect(empty.valid).toBe(false);
      if (!empty.valid) {
        expect(empty.error).toBe('Cron expression cannot be empty.');
      }

      const badFieldCount = validateScheduleCron('0 2 * *');
      expect(badFieldCount.valid).toBe(false);
      if (!badFieldCount.valid) {
        expect(badFieldCount.error).toContain('exactly 5 space-separated fields');
      }

      const outOfRange = validateScheduleCron('99 99 * * *');
      expect(outOfRange.valid).toBe(false);
      if (!outOfRange.valid) {
        expect(outOfRange.error).toContain('Unsupported cron schedule');
      }
    });
  });

  describe('describeCron', () => {
    it('interprets daily schedules with time and timezone', () => {
      expect(describeCron('0 2 * * *', 'America/New_York')).toBe(
        'Every day at 2:00 AM (America/New_York)',
      );
      expect(describeCron('15 23 * * *', 'America/New_York')).toBe(
        'Every day at 11:15 PM (America/New_York)',
      );
      expect(describeCron('0 0 * * *')).toBe('Every day at 12:00 AM');
      expect(describeCron('30 12 * * *')).toBe('Every day at 12:30 PM');
    });

    it('interprets weekday schedules', () => {
      expect(describeCron('0 9 * * 1-5', 'America/New_York')).toBe(
        'Every weekday (Monday through Friday) at 9:00 AM (America/New_York)',
      );
      expect(describeCron('0 9 * * MON-FRI')).toBe(
        'Every weekday (Monday through Friday) at 9:00 AM',
      );
    });

    it('interprets weekly specific day schedules', () => {
      expect(describeCron('0 3 * * 0')).toBe('Every Sunday at 3:00 AM');
      expect(describeCron('0 3 * * 7')).toBe('Every Sunday at 3:00 AM');
      expect(describeCron('45 14 * * 5', 'UTC')).toBe('Every Friday at 2:45 PM (UTC)');
      expect(describeCron('0 2 * * TUESDAY')).toBe('Every Tuesday at 2:00 AM');
    });

    it('interprets monthly specific day schedules', () => {
      expect(describeCron('0 0 1 * *')).toBe('On the 1st of every month at 12:00 AM');
      expect(describeCron('0 4 15 * *')).toBe('On the 15th of every month at 4:00 AM');
      expect(describeCron('30 22 22 * *')).toBe('On the 22nd of every month at 10:30 PM');
    });

    it('returns informative fallback for unsupported interval or malformed expressions', () => {
      expect(describeCron('')).toBe('No schedule set');
      expect(describeCron('*/15 * * * *')).toBe('Unsupported schedule expression (*/15 * * * *)');
      expect(describeCron('* * * * *')).toBe('Unsupported schedule expression (* * * * *)');
      expect(describeCron('invalid syntax')).toBe(
        'Unsupported schedule expression (invalid syntax)',
      );
    });
  });
});
