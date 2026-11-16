import { CustomerDetails, CustomerFieldUpdates, FieldDiff } from '../domain';

export interface CustomerDiffPlan {
  email: string;
  hasChanges: boolean;
  fieldDiffs: FieldDiff[];
  updates: CustomerFieldUpdates;
}

export interface DiffPlannerOptions {
  caseInsensitiveFields?: Array<keyof CustomerFieldUpdates>;
}

export interface IDiffPlanner {
  planDiff(candidate: CustomerDetails, existing: CustomerDetails): CustomerDiffPlan;
}

/**
 * Normalizes text fields by trimming leading/trailing whitespace,
 * converting whitespace-only strings to null, and collapsing multiple internal whitespaces to a single space.
 * Preserves character case.
 */
export function normalizeText(val: string | null | undefined): string | null {
  if (val === null || val === undefined) return null;
  const trimmed = val.trim();
  if (trimmed.length === 0) return null;
  return trimmed.replace(/\s+/g, ' ');
}

/**
 * Creates a normalized comparison representation of an office phone number.
 *
 * Rules:
 * 1. Preserves the original Entra phone number for proposed updates.
 * 2. Normalizes common punctuation (dashes, dots, parentheses, spaces) for comparison.
 * 3. Preserves extensions (e.g. x123, ext. 123, #123, ,123 -> x123).
 * 4. Does not treat equivalent formatting as a change.
 * 5. Removes a leading plus sign because Jira stores phone attributes as digits only; country-code digits are preserved.
 */
export function normalizePhoneForComparison(phone: string | null | undefined): string | null {
  if (phone === null || phone === undefined) return null;
  const trimmed = phone.trim();
  if (trimmed.length === 0) return null;

  // Extract extension if present (e.g. ext, ext., x, #, or comma followed by digits)
  const extRegex = /^(.*?)(?:\s*(?:x|ext\.?|#|,)\s*(\d+))\s*$/i;
  const extMatch = trimmed.match(extRegex);

  let mainPart = trimmed;
  let extPart = '';

  if (extMatch && extMatch[1] && extMatch[2]) {
    mainPart = extMatch[1];
    extPart = 'x' + extMatch[2];
  }

  // Remove common punctuation: parenthesis, hyphens, periods, and spaces
  const normalizedMain = mainPart.replace(/[()\-.+\s]+/g, '');
  return extPart ? `${normalizedMain}${extPart}` : normalizedMain;
}

export class DiffPlanner implements IDiffPlanner {
  private static readonly SYNC_FIELDS: Array<keyof CustomerFieldUpdates> = [
    'title',
    'officePhoneNumber',
    'supervisor',
    'officeClassroom',
    'emailAddress',
  ];

  private readonly caseInsensitiveFields: Set<keyof CustomerFieldUpdates>;

  constructor(options?: DiffPlannerOptions) {
    this.caseInsensitiveFields = new Set(options?.caseInsensitiveFields ?? []);
  }

  /**
   * Compares candidate customer details (from directory) with existing customer details (from target).
   *
   * Enforces matching rules:
   * 1. Do not overwrite a populated target value with an empty source value.
   * 2. Normalize text and phone representations before comparison.
   * 3. Preserve the original source representation in the update plan.
   * 4. Include ONLY changed values in the update plan.
   * 5. Treat unchanged/semantically equivalent values as no-op.
   */
  planDiff(candidate: CustomerDetails, existing: CustomerDetails): CustomerDiffPlan {
    const fieldDiffs: FieldDiff[] = [];
    const updates: CustomerFieldUpdates = {};

    for (const field of DiffPlanner.SYNC_FIELDS) {
      const sourceRaw = candidate[field];
      const targetRaw = existing[field];

      if (field === 'officePhoneNumber') {
        const sourcePhoneComp = normalizePhoneForComparison(sourceRaw);
        const targetPhoneComp = normalizePhoneForComparison(targetRaw);

        const isSourceEmpty = sourcePhoneComp === null;
        const isTargetEmpty = targetPhoneComp === null;

        // Rule: Do not overwrite populated Jira value with empty source value
        if (isSourceEmpty) {
          continue;
        }

        // Rule: If target is empty and source has a value -> populate target with the source value
        if (isTargetEmpty) {
          const proposedValue = sourceRaw?.trim() ?? null;
          fieldDiffs.push({
            fieldName: field,
            oldValue: targetRaw,
            newValue: proposedValue,
          });
          updates[field] = proposedValue;
          continue;
        }

        // Both populated: compare normalized comparison representations
        if (sourcePhoneComp !== targetPhoneComp) {
          const proposedValue = sourceRaw?.trim() ?? null;
          fieldDiffs.push({
            fieldName: field,
            oldValue: targetRaw,
            newValue: proposedValue,
          });
          updates[field] = proposedValue;
        }
      } else if (field === 'emailAddress') {
        const sourceNormalized = sourceRaw ? sourceRaw.trim().toLowerCase() : null;
        const targetTrimmed = targetRaw ? targetRaw.trim() : null;

        const isSourceEmpty = !sourceNormalized || sourceNormalized.length === 0;
        const isTargetEmpty = !targetTrimmed || targetTrimmed.length === 0;

        // Rule: Do not overwrite populated Jira value with empty source value
        if (isSourceEmpty) {
          continue;
        }

        // Rule: If target is empty and source has a value -> populate target (trimmed and lowercase)
        if (isTargetEmpty) {
          fieldDiffs.push({
            fieldName: field,
            oldValue: targetRaw,
            newValue: sourceNormalized,
          });
          updates[field] = sourceNormalized;
          continue;
        }

        // Both populated: compare case-insensitively after trimming
        if (sourceNormalized !== targetTrimmed.toLowerCase()) {
          fieldDiffs.push({
            fieldName: field,
            oldValue: targetRaw,
            newValue: sourceNormalized,
          });
          updates[field] = sourceNormalized;
        }
      } else {
        // Text fields: title, supervisor, officeClassroom
        const sourceNormalized = normalizeText(sourceRaw);
        const targetNormalized = normalizeText(targetRaw);

        const isSourceEmpty = sourceNormalized === null;
        const isTargetEmpty = targetNormalized === null;

        // Rule: Do not overwrite populated Jira value with empty source value
        if (isSourceEmpty) {
          continue;
        }

        // Rule: If target is empty and source has a value -> populate target (preserves meaningful character case)
        if (isTargetEmpty) {
          fieldDiffs.push({
            fieldName: field,
            oldValue: targetRaw,
            newValue: sourceNormalized,
          });
          updates[field] = sourceNormalized;
          continue;
        }

        // Both populated: compare values
        const isCaseInsensitive = this.caseInsensitiveFields.has(field);
        const sourceForComp = isCaseInsensitive ? sourceNormalized.toLowerCase() : sourceNormalized;
        const targetForComp = isCaseInsensitive ? targetNormalized.toLowerCase() : targetNormalized;

        if (sourceForComp !== targetForComp) {
          fieldDiffs.push({
            fieldName: field,
            oldValue: targetRaw,
            newValue: sourceNormalized,
          });
          updates[field] = sourceNormalized;
        }
      }
    }

    return {
      email: candidate.email,
      hasChanges: fieldDiffs.length > 0,
      fieldDiffs,
      updates,
    };
  }
}
