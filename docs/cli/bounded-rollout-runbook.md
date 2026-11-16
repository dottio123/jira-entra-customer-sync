# Bounded Jira Customer-Detail Rollout

## Current status

> This is a legacy CLI path, superseded by the web interface's approval-bound updates. It remains available for controlled diagnostics; its write gates are disabled by default.

The first live result, [bounded-rollout-write-2026-09-30T20-56-47.json](../reports/bounded-rollout-write-2026-09-30T20-56-47.json), applied and verified two fields for one customer before Jira rejected a formatted phone value for a second customer. The fail-fast guard left the other five fields unapplied.

The diagnostic response identified the cause: Jira's phone attribute requires a digit-only value. The Jira write connector now converts common Entra formatting while preserving country-code digits, and phone comparison treats the digit-only Jira representation as equivalent to formatted Entra input. The full automated suite passed before the rollout resumed.

The corrected approval artifact is [jira-first-rollout-2026-10-01T08-17-47.json](../reports/jira-first-rollout-2026-10-01T08-17-47.json), with SHA-256:

```text
320386f5cbe110269c0c662c1d267b16c3673ecdf9159fa06b39410056c8b0a9
```

The corresponding [read-only preflight](../reports/bounded-rollout-preflight-2026-10-01T08-18-35.json) reproduced the three remaining customer/field plans and attempted zero writes.

The successful completion report is [bounded-rollout-write-2026-10-01T08-19-26.json](../reports/bounded-rollout-write-2026-10-01T08-19-26.json). It records:

- Three customers attempted and verified.
- Five fields attempted, accepted, and verified.
- No early stop, failure, ambiguous outcome, or automatic retry.

Together with the first partial rollout, the completed set is seven verified fields across four customers: three titles, two office phone numbers, and two supervisors.

The independent [post-rollout read-only report](../reports/jira-first-post-rollout-2026-10-01T08-20-38.json) evaluated the same 10-customer scope. All four exact Entra matches are unchanged, with zero planned field changes, zero errors, zero retries, and no profile failures.

The first report's `attemptedCustomerCount` is `1` even though requests reached two customer references. The original implementation counted customers only after an accepted field. The counter now records a customer when its first write is attempted, and rejection records include only the Jira status code and request ID as sanitized diagnostic metadata. The saved evidence was not edited.

## Safeguards

- Maximum five customers and four fields per customer; operator limits may be lower.
- Jira service-project enumeration remains the scope authority.
- A successful read-only report and exact SHA-256 digest are mandatory.
- Fresh preflight must reproduce the exact approved customer references and field names.
- Updates execute sequentially with a fresh profile read after every field.
- Sequential write attempts are separated by a configurable five-second minimum interval.
- A rejected, ambiguous, or unverifiable write stops the rollout immediately.
- Mutation requests are never retried automatically.
- Reports exclude email addresses and field values.
- Rejected writes record only the Jira HTTP status and request ID; arbitrary response bodies remain excluded.
- Common Entra phone formatting is converted to Jira's digit-only customer-phone representation at the Jira write boundary.
- `ROLLOUT_PREFLIGHT_ONLY=true` exercises approval validation and fresh planning without invoking the writer.

## Generate a new approval artifact

Always generate and review a new artifact immediately before a rollout. Use a unique `DRY_RUN_REPORT_PATH` and set `JIRA_PILOT_MODE=false`.

```powershell
$stamp = Get-Date -Format "yyyy-MM-ddTHH-mm-ss"
$env:DIRECTORY_SOURCE = "entra"
$env:CUSTOMER_TARGET = "jira-readonly"
$env:JSM_API_AUTH_MODE = "oauth-3lo"
$env:SYNC_DRY_RUN = "true"
$env:SYNC_SCOPE_SOURCE = "jira"
$env:END_TO_END_DRY_RUN = "true"
$env:END_TO_END_MAX_RECORDS = "10"
$env:JIRA_PILOT_MODE = "false"
$env:CUSTOMER_ENUMERATION_VALIDATED = "true"
$env:JIRA_WRITE_SCOPE_ALLOWED = "true"
$env:PILOT_WRITE_ENABLED = "false"
$env:ROLLOUT_WRITE_ENABLED = "false"
$env:ROLLOUT_PREFLIGHT_ONLY = "false"
$env:DRY_RUN_REPORT_PATH = "reports/jira-first-rollout-$stamp.json"
npm.cmd run dev
```

Review every pseudonymous customer reference and changed field name. Calculate the digest without editing the report:

```powershell
(Get-FileHash -Algorithm SHA256 -LiteralPath $env:DRY_RUN_REPORT_PATH).Hash.ToLowerInvariant()
```

## Configure a proposed rollout

Keep execution disabled while preparing these values:

```powershell
$env:ROLLOUT_WRITE_ENABLED = "false"
$env:ROLLOUT_WRITE_MAX_CUSTOMERS = "4"
$env:ROLLOUT_WRITE_MAX_FIELDS_PER_CUSTOMER = "2"
$env:ROLLOUT_WRITE_MIN_INTERVAL_MS = "5000"
$env:ROLLOUT_APPROVED_REPORT_PATH = $env:DRY_RUN_REPORT_PATH
$env:ROLLOUT_APPROVED_REPORT_SHA256 = "<reviewed artifact SHA-256>"
```

Do not enable execution until the reviewed report, limits, and digest receive explicit approval.

Validate the bound artifact and fresh plan without writing:

```powershell
$env:SYNC_DRY_RUN = "true"
$env:END_TO_END_DRY_RUN = "false"
$env:JIRA_PILOT_MODE = "false"
$env:ROLLOUT_WRITE_ENABLED = "false"
$env:ROLLOUT_PREFLIGHT_ONLY = "true"
$env:ROLLOUT_WRITE_REPORT_PATH = "reports/bounded-rollout-preflight.json"
npm.cmd run dev
```

Continue only when the resulting report has `success: true`, `preflightOnly: true`, and `preflightMatchedApproval: true`.

## Approved execution template

After explicit approval, set a unique result path and all gates in the same PowerShell session:

```powershell
$stamp = Get-Date -Format "yyyy-MM-ddTHH-mm-ss"
$env:SYNC_DRY_RUN = "false"
$env:END_TO_END_DRY_RUN = "false"
$env:JIRA_PILOT_MODE = "false"
$env:PILOT_WRITE_ENABLED = "false"
$env:JIRA_WRITE_SCOPE_ALLOWED = "true"
$env:ROLLOUT_WRITE_ENABLED = "true"
$env:ROLLOUT_PREFLIGHT_ONLY = "false"
$env:ROLLOUT_WRITE_CONFIRMATION = "APPLY_BOUNDED_CUSTOMER_DETAIL_UPDATES"
$env:ROLLOUT_WRITE_REPORT_PATH = "reports/bounded-rollout-write-$stamp.json"
npm.cmd run dev
```

Disable execution immediately afterward:

```powershell
$env:ROLLOUT_WRITE_ENABLED = "false"
$env:ROLLOUT_WRITE_CONFIRMATION = ""
$env:SYNC_DRY_RUN = "true"
```
