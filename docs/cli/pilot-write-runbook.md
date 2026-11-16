# Single-Customer Jira Detail Write Pilot

> This is a legacy CLI path, superseded by the web interface's approval-bound updates. It remains available for controlled diagnostics; its write gates are disabled by default.

## Purpose

This runbook controls the first Jira customer-detail update. The implementation can update at most one populated field for one configured pilot customer. It cannot create, invite, delete, or update multiple customers.

The last confirmed dry-run report must show exactly one planned field change for the intended customer before proceeding.

## Implemented safeguards

- Read-only operation remains the default.
- The one supported write scope is rejected unless `JIRA_WRITE_SCOPE_ALLOWED=true`.
- Scope consent and write execution use separate gates. OAuth reauthorization can therefore occur with `PILOT_WRITE_ENABLED=false`.
- Write execution requires the exact confirmation phrase `APPLY_SINGLE_CUSTOMER_DETAIL_UPDATE`.
- Execution requires `SYNC_DRY_RUN=false`, `END_TO_END_DRY_RUN=false`, Jira-first scope, OAuth 3LO, validated customer enumeration, and one pilot email.
- The selected customer must have one exact Entra match and verified membership in a configured Jira service desk.
- The current diff must contain zero or one field. A larger diff stops before mutation.
- Empty Entra values are never written.
- The writer has a one-request budget and does not retry a mutation automatically.
- Jira is read again after an accepted update. Failed or unavailable verification returns a nonzero result and marks the report for manual review.
- The report excludes email addresses and field values.

## 1. Add the narrow Atlassian permission

In the Atlassian Developer Console, add only this Customer Service Management scope to the existing OAuth 2.0 (3LO) app:

```text
write:customer.detail:jira-service-management
```

Do not add customer creation, deletion, administration, or management permissions.

## 2. Reauthorize without enabling writes

In `.env`, append the write scope to the existing space-separated scope list and enable only the scope gate:

```dotenv
ATLASSIAN_OAUTH_SCOPES=offline_access read:servicedesk.customer:jira-service-management read:user:jira read:customer.detail-field:jira-service-management read:customer.profile:jira-service-management write:customer.detail:jira-service-management
JIRA_WRITE_SCOPE_ALLOWED=true
PILOT_WRITE_ENABLED=false
SYNC_DRY_RUN=true
```

Then obtain a new grant and verify its scopes:

```powershell
npm.cmd run oauth:login
npm.cmd run oauth:status
```

Do not continue unless `grantedScopeNames` includes `write:customer.detail:jira-service-management`, `requiredScopesGranted` is `true`, and the granted list contains no unexpected write, delete, manage, or admin scopes.

## 3. Repeat the read-only pilot

Run a fresh Jira-first dry run after reauthorization:

```powershell
$env:DIRECTORY_SOURCE = "entra"
$env:CUSTOMER_TARGET = "jira-readonly"
$env:JSM_API_AUTH_MODE = "oauth-3lo"
$env:SYNC_DRY_RUN = "true"
$env:SYNC_SCOPE_SOURCE = "jira"
$env:END_TO_END_DRY_RUN = "true"
$env:DISCOVERY_ONLY = "false"
$env:JIRA_VALIDATE_EXISTING_CUSTOMER = "false"
$env:JIRA_VALIDATE_CUSTOMER_ENUMERATION = "false"
$env:JIRA_INVESTIGATE_AUTH = "false"
$env:CUSTOMER_ENUMERATION_VALIDATED = "true"
$env:JIRA_PILOT_MODE = "true"
$env:JIRA_WRITE_SCOPE_ALLOWED = "true"
$env:PILOT_WRITE_ENABLED = "false"
$env:PILOT_WRITE_CONFIRMATION = ""
npm.cmd run dev
```

Review the newly generated report. Continue only when all of these are true:

- `success` is `true`.
- `readOnly` is `true`.
- `customersEvaluated` is `1`.
- `exactEntraMatches` is `1`.
- `plannedFieldChanges` is `1`.
- The sole planned field is the expected field.
- `errorCount` and `retryCount` are `0`.
- The verified service desk ID is expected.

## 4. Execute once

Use the same PowerShell session only after reviewing the fresh report:

```powershell
$stamp = Get-Date -Format "yyyy-MM-ddTHH-mm-ss"
$env:SYNC_DRY_RUN = "false"
$env:END_TO_END_DRY_RUN = "false"
$env:JIRA_WRITE_SCOPE_ALLOWED = "true"
$env:PILOT_WRITE_ENABLED = "true"
$env:PILOT_WRITE_CONFIRMATION = "APPLY_SINGLE_CUSTOMER_DETAIL_UPDATE"
$env:PILOT_WRITE_MAX_FIELDS = "1"
$env:PILOT_WRITE_REPORT_PATH = "reports/pilot-write-report-$stamp.json"
npm.cmd run dev
```

The command exits successfully only when Jira accepts the update and the fresh profile read matches Entra. A no-op also succeeds and records that no write was attempted.

## 5. Inspect and disable

Open the report named by `PILOT_WRITE_REPORT_PATH`. A verified update must contain:

- `success: true`
- `writeAttempted: true`
- `writeAccepted: true`
- `appliedFieldCount: 1`
- `verificationComplete: true`
- `manualReviewRequired: false`
- `failureReason: null`

If `manualReviewRequired` is `true`, inspect the customer directly in Jira before any retry. A `writeAccepted` value of `null` means the request outcome is unknown because no authoritative response was received. The application deliberately does not retry or roll back an ambiguous write.

Disable execution immediately after the run:

```powershell
$env:PILOT_WRITE_ENABLED = "false"
$env:PILOT_WRITE_CONFIRMATION = ""
$env:SYNC_DRY_RUN = "true"
```

Remove the write permission and reauthorize with the read-only scope set when no further pilot writes are planned.
