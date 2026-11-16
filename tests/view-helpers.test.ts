import { describe, expect, it } from 'vitest';
import {
  badge,
  fieldLabel,
  formatDuration,
  icon,
  operatingMode,
  plural,
  runStatus,
  scheduleFormValues,
  skipReason,
  updatesState,
} from '../src/web/view-helpers';

describe('view helpers', () => {
  it('maps known codes to plain language and keeps the original code', () => {
    expect(runStatus('FAILED')).toMatchObject({
      label: 'Stopped safely',
      tone: 'danger',
      code: 'FAILED',
    });
    expect(skipReason('ENTRA_NOT_FOUND').label).toBe('Not found in directory');
    expect(operatingMode('COMMISSIONED_MANUAL_ONLY').label).toBe('Manual approval');
    expect(fieldLabel('officePhoneNumber')).toBe('Office phone');
    expect(fieldLabel('Office/Classroom')).toBe('Office / room');
    expect(fieldLabel('emailAddress')).toBe('Email address');
    expect(fieldLabel('Email Address')).toBe('Email address');
  });

  it('falls back to a readable version of unknown codes', () => {
    expect(runStatus('SOMETHING_NEW')).toMatchObject({ label: 'Something new', tone: 'neutral' });
    expect(fieldLabel('customField')).toBe('customField');
  });

  it('summarizes whether updates to Jira are possible', () => {
    const base = {
      paused: false,
      writes_enabled: false,
      automation_enabled: false,
      commissioning_status: 'COMMISSIONED_MANUAL_ONLY' as const,
    };
    expect(updatesState(base).label).toBe('Off');
    expect(updatesState({ ...base, writes_enabled: true }).label).toBe('On — needs approval');
    expect(updatesState({ ...base, writes_enabled: true, paused: true }).label).toBe('Paused');
    expect(
      updatesState({
        ...base,
        writes_enabled: true,
        automation_enabled: true,
        commissioning_status: 'COMMISSIONED_AUTOMATED',
      }).label,
    ).toBe('Automatic');
    expect(
      updatesState({ ...base, writes_enabled: true, commissioning_status: 'UNCOMMISSIONED' }).label,
    ).toBe('Off');
  });

  it('pre-fills the schedule picker and leaves unusual schedules to the advanced field', () => {
    expect(scheduleFormValues('0 2 * * *')).toMatchObject({ frequency: 'DAILY', time: '02:00' });
    expect(scheduleFormValues('30 14 * * 1-5')).toMatchObject({
      frequency: 'WEEKDAYS',
      time: '14:30',
    });
    expect(scheduleFormValues('0 2 * * 5')).toMatchObject({ frequency: 'WEEKLY', dayOfWeek: 5 });
    expect(scheduleFormValues('0 2 15 * *')).toMatchObject({
      frequency: 'MONTHLY',
      dayOfMonth: 15,
    });
    expect(scheduleFormValues('0 2 31 * *').frequency).toBe('CUSTOM');
    expect(scheduleFormValues('0 2 1 6 *').frequency).toBe('CUSTOM');
    expect(scheduleFormValues('*/15 * * * *').frequency).toBe('CUSTOM');
  });

  it('formats durations and counts', () => {
    expect(formatDuration(0, 42_000)).toBe('42 s');
    expect(formatDuration(1, 1 + 72_000)).toBe('1 min 12 s');
    expect(formatDuration(1, null)).toBe('—');
    expect(plural(1, 'customer')).toBe('1 customer');
    expect(plural(1200, 'customer')).toBe('1,200 customers');
    expect(plural(undefined, 'detail')).toBe('0 details');
  });

  it('escapes markup produced for badges and icons', () => {
    expect(badge('neutral', '<b>x</b>', '"t"')).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(badge('neutral', 'x', '"t"')).toContain('title="&quot;t&quot;"');
    expect(icon('not-an-icon" onload="x')).toContain('#i-info');
  });
});
