export type DryRunResultCategory =
  | 'UPDATE_PLANNED'
  | 'UNCHANGED'
  | 'NOT_FOUND'
  | 'AMBIGUOUS'
  | 'EMAIL_UNAVAILABLE'
  | 'INACTIVE'
  | 'JIRA_INACTIVE'
  | 'ERROR';

export interface DryRunReportRecordComparison {
  customerRef: string;
  categoryInA?: DryRunResultCategory;
  categoryInB?: DryRunResultCategory;
  fieldsInA?: string[];
  fieldsInB?: string[];
  categoryChanged: boolean;
  fieldSetChanged: boolean;
}

export interface DryRunReportConsistencyMetrics {
  recordsInRunA: number;
  recordsInRunB: number;
  recordsInBoth: number;
  recordsAdded: number;
  recordsRemoved: number;
  recordsWithCategoryChanges: number;
  recordsWithFieldSetChanges: number;
  isConsistent: boolean;
  differences: DryRunReportRecordComparison[];
}

export interface MinimalDryRunReport {
  records: Array<{
    customerRef: string;
    resultCategory: DryRunResultCategory;
    changedFieldNames: string[];
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

/**
 * Performs a stable comparison between two consecutive dry-run reports.
 *
 * Requirements:
 * 1. Compare reports using: correlation reference, result category, and changed field names.
 * 2. Ignore timestamps, run identifiers, request IDs, operation order, and aggregate ordering.
 * 3. Produce aggregate consistency metrics.
 * 4. Zero exposure of underlying employee identity.
 */
export function compareDryRunReports(
  reportA: MinimalDryRunReport,
  reportB: MinimalDryRunReport,
): DryRunReportConsistencyMetrics {
  const mapA = new Map<
    string,
    { resultCategory: DryRunResultCategory; changedFieldNames: Set<string> }
  >();
  const mapB = new Map<
    string,
    { resultCategory: DryRunResultCategory; changedFieldNames: Set<string> }
  >();

  for (const r of reportA.records || []) {
    mapA.set(r.customerRef, {
      resultCategory: r.resultCategory,
      changedFieldNames: new Set(r.changedFieldNames || []),
    });
  }

  for (const r of reportB.records || []) {
    mapB.set(r.customerRef, {
      resultCategory: r.resultCategory,
      changedFieldNames: new Set(r.changedFieldNames || []),
    });
  }

  let recordsInBoth = 0;
  let recordsAdded = 0;
  let recordsRemoved = 0;
  let recordsWithCategoryChanges = 0;
  let recordsWithFieldSetChanges = 0;
  const differences: DryRunReportRecordComparison[] = [];

  const allRefs = new Set([...mapA.keys(), ...mapB.keys()]);

  for (const ref of allRefs) {
    const a = mapA.get(ref);
    const b = mapB.get(ref);

    if (a && b) {
      recordsInBoth++;
      const categoryChanged = a.resultCategory !== b.resultCategory;

      // Compare field sets regardless of ordering
      let fieldSetChanged = a.changedFieldNames.size !== b.changedFieldNames.size;
      if (!fieldSetChanged) {
        for (const f of a.changedFieldNames) {
          if (!b.changedFieldNames.has(f)) {
            fieldSetChanged = true;
            break;
          }
        }
      }

      if (categoryChanged) recordsWithCategoryChanges++;
      if (fieldSetChanged) recordsWithFieldSetChanges++;

      if (categoryChanged || fieldSetChanged) {
        differences.push({
          customerRef: ref,
          categoryInA: a.resultCategory,
          categoryInB: b.resultCategory,
          fieldsInA: Array.from(a.changedFieldNames).sort(),
          fieldsInB: Array.from(b.changedFieldNames).sort(),
          categoryChanged,
          fieldSetChanged,
        });
      }
    } else if (a && !b) {
      recordsRemoved++;
      differences.push({
        customerRef: ref,
        categoryInA: a.resultCategory,
        fieldsInA: Array.from(a.changedFieldNames).sort(),
        categoryChanged: true,
        fieldSetChanged: true,
      });
    } else if (!a && b) {
      recordsAdded++;
      differences.push({
        customerRef: ref,
        categoryInB: b.resultCategory,
        fieldsInB: Array.from(b.changedFieldNames).sort(),
        categoryChanged: true,
        fieldSetChanged: true,
      });
    }
  }

  const isConsistent =
    recordsAdded === 0 &&
    recordsRemoved === 0 &&
    recordsWithCategoryChanges === 0 &&
    recordsWithFieldSetChanges === 0;

  return {
    recordsInRunA: mapA.size,
    recordsInRunB: mapB.size,
    recordsInBoth,
    recordsAdded,
    recordsRemoved,
    recordsWithCategoryChanges,
    recordsWithFieldSetChanges,
    isConsistent,
    differences,
  };
}
