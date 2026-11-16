# Jira-First Pilot Validation and Live Write

> **Historical record.** This report describes one deployment of this service (version 0.x)
> and is kept for audit purposes. Figures, run numbers, and approval codes are specific to that
> deployment. Links to `reports/` point at runtime files that are not part of the repository.
> Corrections since it was written: email alerts now use STARTTLS/implicit TLS with optional
> sign-in; private-network HTTP is no longer exempt from HTTPS (it needs
> `ALLOW_INSECURE_REMOTE_HTTP=true`); and five Jira fields are synchronized.

## Status

The Jira-first read-only pilot path and guarded Milestone 3D write path have both completed live validation successfully.

The approved pilot changed one `officeClassroom` detail for one existing customer. The application verified the accepted update with a fresh Jira profile read, and an independent read-only follow-up found no remaining differences. Write execution is disabled after the run.

## Existing live evidence

The final pre-write artifact is [pilot-dry-run-report-2026-10-01T00-29-33Z.json](../reports/pilot-dry-run-report-2026-10-01T00-29-33Z.json).

That artifact records the following result for the configured pilot customer:

- One Jira customer evaluated and verified in service desk `1`.
- One exact Microsoft Entra match.
- One Jira customer profile retrieved.
- Four field decisions recorded without source or target values.
- One planned `officeClassroom` change.
- A complete manager comparison with status `RESOLVED`.
- `success: true`, `readOnly: true`, and `fallbackUsed: false`.

This artifact validates the selected customer and the source and target state observed during that run. It does not prove behavior for every tenant, customer, API failure, or future data state.

## Live write result

The approved execution produced [pilot-write-report-2026-09-30T20-30-39.json](../reports/pilot-write-report-2026-09-30T20-30-39.json). It records:

- `success: true`
- `writeAttempted: true`
- `writeAccepted: true`
- `appliedFieldNames: ["officeClassroom"]`
- `appliedFieldCount: 1`
- `verificationComplete: true`
- `manualReviewRequired: false`
- `failureReason: null`
- Jira response status `200`

The independent post-write artifact is [pilot-dry-run-report-2026-10-01T00-31-36Z.json](../reports/pilot-dry-run-report-2026-10-01T00-31-36Z.json). It records one unchanged customer, zero planned field changes, zero errors, and zero retries.

## Bounded rollout readiness

After the pilot, a read-only 10-customer scan produced [pilot-dry-run-report-2026-10-01T00-39-06Z.json](../reports/pilot-dry-run-report-2026-10-01T00-39-06Z.json). It found four exact Entra matches requiring seven field changes and six Jira customers without an Entra match. There were no ambiguous matches, profile failures, errors, or retries.

Milestone 3E implements an approval-bound bounded rollout path. It is disabled after successful live completion. See [bounded-rollout-runbook.md](../cli/bounded-rollout-runbook.md).

The read-only approval preflight [bounded-rollout-preflight-2026-09-30T20-50-08.json](../reports/bounded-rollout-preflight-2026-09-30T20-50-08.json) reproduced all four approved plans from fresh source and target data. `preflightMatchedApproval` is `true`, and attempted customer and field counts are both zero.

The approved live execution produced [bounded-rollout-write-2026-09-30T20-56-47.json](../reports/bounded-rollout-write-2026-09-30T20-56-47.json). The first customer's `title` and `officePhoneNumber` changes were accepted and verified with fresh Jira reads. Jira rejected the next customer's `officePhoneNumber` request, so the service stopped without retrying and did not attempt the remaining two customers.

The independent follow-up [jira-first-dry-run-report-2026-10-01T00-58-44Z.json](../reports/jira-first-dry-run-report-2026-10-01T00-58-44Z.json) confirms one exact-match customer is now unchanged and three exact-match customers still have five planned field changes. It reported zero errors and zero retries. Persistent write gates remain disabled.

Jira returned HTTP 400 for the second customer's formatted office phone and identified the phone attribute value as invalid. The Jira write connector was corrected to send common Entra phone formats as digit-only values while preserving country-code digits. Phone comparison now recognizes Jira's stored digit-only representation as equivalent to formatted Entra input.

The corrected artifact [jira-first-rollout-2026-10-01T08-17-47.json](../reports/jira-first-rollout-2026-10-01T08-17-47.json) and [read-only preflight](../reports/bounded-rollout-preflight-2026-10-01T08-18-35.json) bound the five remaining changes across three customers. The final [bounded rollout report](../reports/bounded-rollout-write-2026-10-01T08-19-26.json) records all three customers and all five fields as verified, with no failure or early stop.

The independent [post-rollout report](../reports/jira-first-post-rollout-2026-10-01T08-20-38.json) confirms all four exact-match customers are unchanged relative to Entra. It records zero planned changes, zero errors, zero retries, and no profile failures. Persistent write gates remain disabled.

## Hardening changes

The current implementation includes:

- Startup and service-boundary rejection when pilot mode has no valid pilot email.
- Bounded Jira customer-search pagination that fails closed on malformed or incomplete pages.
- Verified service-desk membership provenance in pilot reports.
- Explicit decisions for `title`, `officePhoneNumber`, `supervisor`, and `officeClassroom`.
- Separate Graph, Jira, and selected-customer metrics.
- A distinction between an absent manager and an unavailable manager lookup.
- Exclusive report creation with collision retries and ownership-aware cleanup.
- Sanitized external-error reporting that excludes arbitrary response bodies and exception messages from pilot logs and reports.
- Deterministic truncated SHA-256 pseudonymous correlation references. These references are not HMAC values and do not provide mathematical anonymity.

## Local verification

The following checks passed against the saved workspace after the hardening changes:

| Check                      | Result                            |
| -------------------------- | --------------------------------- |
| `npm.cmd run format:check` | Passed                            |
| `npm.cmd run lint`         | Passed                            |
| `npm.cmd run typecheck`    | Passed                            |
| `npm.cmd test`             | 16 files passed; 291 tests passed |
| `npm.cmd run build`        | Passed                            |

The bounded rollout suite includes coverage for accepted writes, approval drift, preflight-only execution, ambiguous outcomes, and sanitized Jira rejections.

The saved `secrets/atlassian-oauth.json` content hash was identical before and after the full automated suite. Automated tests used synthetic inputs and did not alter the saved OAuth token record.

## Sequential PowerShell runbook

Run each stage in the same PowerShell session. The commands set mutually exclusive modes explicitly so state from a previous stage cannot select a different execution path.

### Existing-customer Jira validation

```powershell
$env:DIRECTORY_SOURCE = "memory"
$env:CUSTOMER_TARGET = "jira-readonly"
$env:JSM_API_AUTH_MODE = "oauth-3lo"
$env:SYNC_DRY_RUN = "true"
$env:SYNC_SCOPE_SOURCE = "jira"
$env:END_TO_END_DRY_RUN = "false"
$env:DISCOVERY_ONLY = "false"
$env:JIRA_VALIDATE_EXISTING_CUSTOMER = "true"
$env:JIRA_VALIDATE_CUSTOMER_ENUMERATION = "false"
$env:JIRA_INVESTIGATE_AUTH = "false"
$env:JIRA_PILOT_MODE = "false"
npm.cmd run dev
```

### Jira-first pilot dry run

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
npm.cmd run dev
```

`JIRA_PILOT_CUSTOMER_EMAIL` is preferred when configured. When pilot mode is enabled and that value is absent, the application uses `JIRA_TEST_CUSTOMER_EMAIL`. Startup fails before external requests if neither value is a valid pilot email.

`SYNC_END_TO_END_DRY_RUN` remains a compatibility alias. The runbook uses the canonical `END_TO_END_DRY_RUN` variable.

## Scope and limitations

- Local tests validate failure handling with synthetic responses and errors.
- The live result covers one customer, one service desk, and one detail-field update.
- One Jira customer detail was modified. Microsoft Entra directory data was not modified.
- The OAuth token currently includes `write:customer.detail:jira-service-management`; execution still requires the separate disabled-by-default write gates.
- Any additional write must repeat the dry-run review and explicit approval procedure in [pilot-write-runbook.md](../cli/pilot-write-runbook.md).
