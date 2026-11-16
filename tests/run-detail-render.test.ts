import { describe, expect, it } from 'vitest';
import * as ejs from 'ejs';
import * as path from 'path';
import { DiffPlanner } from '../src/services/diff-planner';
import { viewHelpers } from '../src/web/view-helpers';

describe('preview diff inspector', () => {
  async function render(changedFields: unknown[]) {
    return ejs.renderFile(path.join(process.cwd(), 'src/web/views/pages/run-detail.ejs'), {
      ...viewHelpers,
      run: {
        id: 1,
        runType: 'PREVIEW',
        status: 'COMPLETED',
        triggerSource: 'MANUAL',
        scopeServiceDeskIds: ['1'],
        startedAt: 0,
        completedAt: 1000,
        proposedFieldChanges: changedFields.length,
        details: {
          proposedChanges: [
            { customerEmail: 'person@example.com', customerRef: 'ref-test', changedFields },
          ],
        },
      },
      settings: { commissioning_status: 'UNCOMMISSIONED', writes_enabled: false },
      csrfToken: 'test',
    });
  }

  it('renders actual planner values in the correct current and proposed columns, with escaping', async () => {
    const plan = new DiffPlanner().planDiff(
      {
        email: 'person@example.com',
        title: 'Senior <Engineer>',
        officePhoneNumber: '555-0100',
        supervisor: 'Team & Lead',
        officeClassroom: 'Room 12',
      },
      {
        email: 'person@example.com',
        title: 'Junior <Engineer>',
        officePhoneNumber: null,
        supervisor: 'Former Lead',
        officeClassroom: 'Room 10',
      },
    );
    const html = await render(plan.fieldDiffs);
    for (const diff of plan.fieldDiffs) {
      const escapedOld = ejs.escapeXML(diff.oldValue ?? '(empty)');
      const escapedNew = ejs.escapeXML(diff.newValue!);
      expect(html).toContain(`<span class="muted">${escapedOld}</span>`);
      expect(html).toContain(`<strong>${escapedNew}</strong>`);
      expect(html.indexOf(escapedOld)).toBeLessThan(html.indexOf(escapedNew));
    }
    expect(html).not.toContain('<Engineer>');
    expect(html.match(/\(empty\)/g)).toHaveLength(1);
  });

  it('labels missing proposed values explicitly instead of leaving a blank cell', async () => {
    const html = await render([{ fieldName: 'title', oldValue: 'Engineer' }]);
    expect(html).toContain('Unavailable — generate a fresh preview');
    expect(html).toContain('<span class="muted">Engineer</span>');
  });
});
