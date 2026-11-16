import { describe, it, expect } from 'vitest';
import { DiffPlanner } from '../src/services/diff-planner';
import { CustomerDetails } from '../src/domain';

describe('DiffPlanner', () => {
  const planner = new DiffPlanner();

  it('populates empty Jira fields from directory data', () => {
    const candidate: CustomerDetails = {
      email: 'alex@example.com',
      title: 'Senior Systems Analyst',
      officePhoneNumber: '+1-555-0199',
      supervisor: 'Jordan Lee',
      officeClassroom: 'Hall B, Room 204',
    };

    const existing: CustomerDetails = {
      email: 'alex@example.com',
      title: null,
      officePhoneNumber: null,
      supervisor: null,
      officeClassroom: null,
    };

    const plan = planner.planDiff(candidate, existing);

    expect(plan.hasChanges).toBe(true);
    expect(plan.updates).toEqual({
      title: 'Senior Systems Analyst',
      officePhoneNumber: '+1-555-0199',
      supervisor: 'Jordan Lee',
      officeClassroom: 'Hall B, Room 204',
    });
    expect(plan.fieldDiffs).toHaveLength(4);
  });

  it('treats unchanged values as no-op and produces no update', () => {
    const candidate: CustomerDetails = {
      email: 'alex@example.com',
      title: 'Senior Systems Analyst',
      officePhoneNumber: '+1-555-0199',
      supervisor: 'Jordan Lee',
      officeClassroom: 'Hall B, Room 204',
    };

    const existing: CustomerDetails = {
      email: 'alex@example.com',
      title: 'Senior Systems Analyst',
      officePhoneNumber: '+1-555-0199',
      supervisor: 'Jordan Lee',
      officeClassroom: 'Hall B, Room 204',
    };

    const plan = planner.planDiff(candidate, existing);

    expect(plan.hasChanges).toBe(false);
    expect(plan.updates).toEqual({});
    expect(plan.fieldDiffs).toHaveLength(0);
  });

  it('treats formatted Entra and digit-only Jira phone values as equal', () => {
    const candidate: CustomerDetails = {
      email: 'alex@example.com',
      title: null,
      officePhoneNumber: '+1 (757) 965-6133',
      supervisor: null,
      officeClassroom: null,
    };
    const existing: CustomerDetails = {
      ...candidate,
      officePhoneNumber: '17579656133',
    };

    expect(planner.planDiff(candidate, existing).hasChanges).toBe(false);
  });

  it('does not overwrite a non-empty target value with an empty source value', () => {
    const candidate: CustomerDetails = {
      email: 'alex@example.com',
      title: null, // empty source
      officePhoneNumber: '', // empty string source
      supervisor: '   ', // whitespace only source
      officeClassroom: 'New Building C', // populated source
    };

    const existing: CustomerDetails = {
      email: 'alex@example.com',
      title: 'Existing Manager', // populated target
      officePhoneNumber: '+1-555-1234', // populated target
      supervisor: 'Existing Director', // populated target
      officeClassroom: 'Old Building A', // populated target
    };

    const plan = planner.planDiff(candidate, existing);

    expect(plan.hasChanges).toBe(true);
    // Only officeClassroom should be in updates; existing non-empty values must NOT be erased
    expect(plan.updates).toEqual({
      officeClassroom: 'New Building C',
    });
    expect(plan.fieldDiffs).toHaveLength(1);
    expect(plan.fieldDiffs[0]?.fieldName).toBe('officeClassroom');
  });

  it('includes only changed values in an update plan', () => {
    const candidate: CustomerDetails = {
      email: 'alex@example.com',
      title: 'Lead Architect', // changed
      officePhoneNumber: '+1-555-9999', // same
      supervisor: 'Taylor Swift', // same
      officeClassroom: 'Room 500', // same
    };

    const existing: CustomerDetails = {
      email: 'alex@example.com',
      title: 'Senior Architect',
      officePhoneNumber: '+1-555-9999',
      supervisor: 'Taylor Swift',
      officeClassroom: 'Room 500',
    };

    const plan = planner.planDiff(candidate, existing);

    expect(plan.hasChanges).toBe(true);
    expect(plan.updates).toEqual({
      title: 'Lead Architect',
    });
    expect(plan.fieldDiffs).toHaveLength(1);
    expect(plan.fieldDiffs[0]?.fieldName).toBe('title');
  });
});
