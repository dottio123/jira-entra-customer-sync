import { CustomerDetails } from '../../domain';

/** Canonical keys of the Jira customer detail fields this service synchronizes. */
export type SyncedFieldKey = keyof Omit<CustomerDetails, 'email'>;

export interface SyncedFieldDefinition {
  key: SyncedFieldKey;
  /** Default Jira CSM field name, used when discovery has not supplied the site's actual name. */
  jiraName: string;
  /** Lower-case Jira field names accepted as this field during discovery and profile mapping. */
  aliases: readonly string[];
  /** Human-readable label for configuration errors. */
  label: string;
}

export const SYNCED_FIELDS: readonly SyncedFieldDefinition[] = [
  { key: 'title', jiraName: 'Title', aliases: ['title', 'job title'], label: 'Job title' },
  {
    key: 'officePhoneNumber',
    jiraName: 'Office Phone Number',
    aliases: ['office phone number', 'office phone', 'phone number', 'business phone'],
    label: 'Office phone',
  },
  {
    key: 'supervisor',
    jiraName: 'Supervisor',
    aliases: ['supervisor', 'manager'],
    label: 'Supervisor',
  },
  {
    key: 'officeClassroom',
    jiraName: 'Office/Classroom',
    aliases: ['office/classroom', 'office classroom', 'office location', 'office'],
    label: 'Office / room',
  },
  {
    key: 'emailAddress',
    jiraName: 'Email Address',
    aliases: ['email address', 'email'],
    label: 'Email address',
  },
];

export const SYNCED_FIELD_KEYS: readonly SyncedFieldKey[] = SYNCED_FIELDS.map((f) => f.key);

export function getSyncedField(key: string): SyncedFieldDefinition | undefined {
  return SYNCED_FIELDS.find((f) => f.key === key.trim());
}

export interface FieldConfigurationReport {
  missingDomainFields: string[];
  ambiguousDomainFields?: Record<string, string[]>;
}

/**
 * Fails closed with a sanitized configuration error when any synchronized field is missing
 * from, or ambiguously matched in, the discovered Jira customer detail fields.
 */
export function assertSyncedFieldsConfigured(report: FieldConfigurationReport): void {
  const labels = (keys: SyncedFieldKey[]) =>
    keys.map((k) => getSyncedField(k)?.label ?? k).join(', ');

  const missing = SYNCED_FIELD_KEYS.filter((k) => report.missingDomainFields.includes(k));
  if (missing.length > 0) {
    throw new Error(
      `Configuration error: Required Jira customer detail field(s) missing: ${labels(missing)}.`,
    );
  }

  const ambiguous = SYNCED_FIELD_KEYS.filter(
    (k) => (report.ambiguousDomainFields?.[k]?.length ?? 0) > 0,
  );
  if (ambiguous.length > 0) {
    throw new Error(
      `Configuration error: Required Jira customer detail field(s) ambiguously resolved: ${labels(ambiguous)}.`,
    );
  }
}
