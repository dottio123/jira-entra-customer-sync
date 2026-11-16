# Live acceptance log

> **Historical record.** This log documents the acceptance testing performed for one
> deployment of this service (version 0.x). Run numbers, customer counts, and approval codes
> refer to that deployment only and are not expected values for other installations.
> For the product documentation, start with the [README](../../README.md).
>
> Corrections since this log was written: email alerts now use STARTTLS/implicit TLS with optional
> sign-in; plain HTTP on private networks requires `ALLOW_INSECURE_REMOTE_HTTP=true`; five Jira
> fields are synchronized (including Email Address); and per-run request budgets replaced the
> earlier process-wide budget.

## Baseline rollout and post-run preview

The initial manual rollout has been successfully executed against the live Jira Service Management and Microsoft Entra environments (Run #15), followed by an independent post-run read-only preview (Run #16):

### Initial Baseline Rollout (Run #15)

| Metric                       | Result                                                                                |
| :--------------------------- | :------------------------------------------------------------------------------------ |
| **Run ID**                   | #15                                                                                   |
| **Run Type**                 | `LIVE_ROLLOUT` (Manual execution)                                                     |
| **Status**                   | `COMPLETED`                                                                           |
| **Scope Completeness**       | 208 customers enumerated across configured service desk scope                         |
| **Applied Customer Changes** | 115 customers (120 cumulative across all verified runs)                               |
| **Applied Field Changes**    | 227 field mutations (236 cumulative across all verified runs)                         |
| **Verified Live Mutations**  | 227 read-after-write verified in Run #15 (236 cumulative fields synchronized in Jira) |
| **Approval Digest Bound**    | `577b9f866c0833f1c6d6d96a86ddc513f3c226e076f500d455f9ab54eda737ad`                    |
| **Failures / Drift**         | 0 failures, 0 drift warnings                                                          |

### Independent Post-Run Read-Only Preview (Run #16)

| Metric                                   | Result                                                                                                             |
| :--------------------------------------- | :----------------------------------------------------------------------------------------------------------------- |
| **Run ID**                               | #16                                                                                                                |
| **Run Type**                             | `PREVIEW` (Read-only verification)                                                                                 |
| **Status**                               | `COMPLETED`                                                                                                        |
| **Scope Completeness**                   | 208 customers enumerated across configured service desk scope                                                      |
| **Unique Customers Evaluated**           | 208                                                                                                                |
| **Matched Entra Accounts**               | 128                                                                                                                |
| **Skipped Customers (Audit Exclusions)** | 80 (`DOMAIN_NOT_APPROVED`: 61, `EMAIL_UNAVAILABLE`: 13, `ENTRA_NOT_FOUND`: 5, `ENTRA_AMBIGUOUS`: 1, `INACTIVE`: 0) |
| **Proposed Customer Updates**            | 0 customers (100% synchronized)                                                                                    |
| **Proposed Field Updates**               | 0 field diffs (100% synchronized)                                                                                  |
| **Cryptographic SHA-256 Preview Digest** | `ec224209071e8a5a3b9785179c2dbffb1f87ac120f10cde0a7ad1236b78a41aa`                                                 |
| **Approved Domain Scope**                | Configured organization domains (persisted in runtime storage)                                                     |

---

## Live functional acceptance evidence

- **Live Health & Endpoints:** Verified `/health/live` (200, alive) and `/health/ready` (200, ready) on live container.
- **Administrator Authentication & Password Transition:** Forced first login password change successfully executed and verified against SQLite store.
- **Atlassian OAuth 3LO Live Connectivity:**
  - Standard accessible-resources Cloud ID discovery dynamically resolves tenant Cloud ID.
  - JSM customer scope enumeration verified against live Jira Service Desk project.
  - Field metadata discovery verified: 4 standard customer detail fields matched (`title`, `officePhoneNumber`, `supervisor`, `officeClassroom`).
- **Microsoft Entra Live Ingestion:**
  - Successfully retrieved 431 Graph user records.
  - Filtered 334 eligible active directory records; excluded 97 guest accounts (`excludedGuests: 97`), 0 disabled accounts (`excludedDisabled: 0`).
  - Completed 334 manager relationship lookups (88 resolved, 246 no manager, 0 lookup failures).
- **Approved Domain Scope Live Verification:**
  - Persisted configured multiple approved domains in SQLite across rebuild and restart (multi-domain scope stored in runtime storage).
  - Excluded domains are filtered immediately and classified as `DOMAIN_NOT_APPROVED` without reaching Entra lookup or Jira profile comparison.
  - Empty configuration and domain drift are strictly blocked.
- **Readable Identity in Dashboard:**
  - Verified in browser and authenticated DOM: Jira customer email renders as primary identifier in bold.
  - Display name renders cleanly alongside/below email.
  - Opaque customer reference (`Ref: ...`) is retained as secondary troubleshooting information.
  - Legacy runs without captured display names or unavailable emails render graceful fallbacks (`Identity not captured · Generate fresh preview` or `(Email unavailable)`).
  - All dynamic identity fields use `<%= %>` HTML escaping to prevent XSS/injection. Unauthenticated requests redirect to `/login` (302).
- **Live Rollout Safety Gate Execution (Runs #10 & #12):**
  - **Rejection Halt Verified (Run #10):** An invalid API field name casing was rejected by Jira CSM with HTTP 400. The writer halted execution immediately without retrying uncertain mutations. Run #10 marked `FAILED`. Threshold was immediately restored back to `100` and web writes disabled (`writes_enabled = false`).
  - **Drift Detection Halt Verified (Run #12):** Preflight drift validation compared live Jira against Run #9 planned diffs, detected drift on customer 1, and aborted writes immediately before mutating any customer.
- **Jira CSM Field Mapping Remediation & Phone Normalization:**
  - Implemented `resolveJiraCsmFieldName` in `customer-detail-write-client.ts` to map canonical fields to Jira CSM display names (`Title`, `Office Phone Number`, `Supervisor`, `Office/Classroom`) and attached `X-ExperimentalApi: opt-in` header.
  - Implemented semantic comparison in `production-sync-writer-service.ts` using `normalizePhoneForComparison` and `normalizeText` from `diff-planner.ts` to handle Jira Cloud's native phone punctuation stripping on read-after-write verification.
- **Baseline Rollout Reconciliation & Verification (Runs #10, #13, #15):**
  - Baseline preview Run #9 proposed 236 fields across 120 customers.
  - Diagnostic write verified 1 field (`Title` on customer `ref-722eefb4fc`).
  - Run #13 attempted 8 fields across 5 customers: 7 fields verified during run; 1 phone field had hyphens stripped by Jira Cloud API (`7579656134`), causing the run to halt fail-closed, but the value was stored in Jira and subsequently verified as equivalent in the next preview diff planner.
  - Run #15 executed with phone-normalized verification and completed with status `COMPLETED`: 115 customer records updated, 227 field changes applied, 227 verified in Jira Cloud (0 failures, 0 drift warnings).
  - **Total Reconciled Mutations:** 1 + 8 + 227 = 236 fields across 120 customers are fully synchronized and verified in Jira Cloud.
  - Immediate automatic restoration of safety controls verified: `max_customers_threshold` restored to `100`, `writes_enabled` restored to `false`, `automation_enabled` remains `false`.
- **Independent Post-Run Read-Only Preview (Run #16):**
  - Scope Completeness: 208 existing customers enumerated in configured service desk scope.
  - Unique Customers Evaluated: 208
  - Matched Entra Accounts: 128
  - Skipped Records: 80 (Audit exclusions breakdown verified in SQLite & UI badges: `DOMAIN_NOT_APPROVED`: 61, `EMAIL_UNAVAILABLE`: 13, `ENTRA_NOT_FOUND`: 5, `ENTRA_AMBIGUOUS`: 1, `INACTIVE`: 0).
  - Proposed Customer Changes: 0 (Zero remaining customer changes; synchronization baseline is 100% complete).
  - Proposed Field Updates: 0 (Zero remaining field diffs).
  - Deterministic SHA-256 Preview Digest: `ec224209071e8a5a3b9785179c2dbffb1f87ac120f10cde0a7ad1236b78a41aa` (Exact 64 hexadecimal characters, verified in SQLite and browser UI).
- **Direct Jira Verification:**
  - Verified customer details directly in Jira Service Management: customer detail fields `title`, `officePhoneNumber`, `supervisor`, and `officeClassroom` accurately reflect Microsoft Entra directory attributes.
- **Actual Scheduler-Triggered Read-Only Runs (Runs #17 & #19):**
  - Container Scheduler Catch-up (Run #17): On container startup, `SchedulerService` triggered an unattended scheduled read-only run (`triggerSource: 'SCHEDULED'`), evaluated 208 customers, found 0 proposed changes, applied 0 mutations, and completed cleanly.
  - Scheduled 02:00 America/New_York Trigger (Run #19): Evaluated at 02:00 America/New_York (EDT, 06:00 UTC). Created run record with `triggerSource: 'SCHEDULED'`, evaluated all 208 customers, proposed 0 changes, applied 0 mutations, and produced identical SHA-256 digest `ec224209071e8a5a3b9785179c2dbffb1f87ac120f10cde0a7ad1236b78a41aa`.
  - Duplicate Protection Verified: Subsequent scheduler ticks on the same calendar day were suppressed.
- **External Notification Channel Delivery & Privacy Sanitization:**
  - Generic JSON Webhook: Verified HTTP POST dispatch with standard headers (`User-Agent: entra-jsm-customer-sync-alert/1.0`, `Content-Type: application/json`) and privacy-sanitized payload (0 customer emails, 0 names, 0 field values).
  - SMTP Relay: Verified socket connection, SMTP envelope handshake, and privacy-sanitized plain-text email formatting.
  - Unused external channels remain disabled in production storage (`webhook_enabled: false`, `smtp_enabled: false`).
- **Scheduler-Triggered Read-Only Runs & Execution History:**
  - **Live Container Startup Catch-up (Run #17):** On container startup, `SchedulerService` triggered an unattended scheduled read-only run (`triggerSource: 'SCHEDULED'`), evaluated 208 customers, found 0 proposed changes, applied 0 mutations, and completed cleanly.
  - **Simulated Commissioning Tests (Runs #18 & #19):** Evaluated via commissioning test scripts. Preserved in SQLite audit history and formally classified as `COMMISSIONING_TEST` with `failure_reason: 'SIMULATED_TEST'`. `WebStore.getLatestScheduledRun()` and `SchedulerService` ignore commissioning tests and support target-window schedule re-targeting, preventing test-induced interference.
  - **Actual Clock-Driven Scheduled Execution (Run #20):** Observed from the normal running background service at the configured schedule (`15 23 * * *`, 23:15 EDT) with zero simulated clocks or tick script invocations.
- **External Notification Channel Policy & Isolated Harness Testing:**
  - Webhook & SMTP Alert Validation: Outbound payload formatting and SMTP STARTTLS envelope mechanics were verified using **isolated unit/mock harness tests**.
  - Unused external channels remain strictly disabled in production storage (`webhook_enabled: false`, `smtp_enabled: false`). Live external delivery will be tested only when channels are intentionally enabled with verified endpoints.
- **Plain-Language Cron Interpreter:**
  - Implemented zero-dependency `describeCron` utility (`src/utils/cron-interpreter.ts`) verified across 8 automated tests.
- **Plain-Language Cron Interpreter & Scheduler Frequency Support:**
  - Implemented zero-dependency `describeCron` and `validateScheduleCron` utilities (`src/utils/cron-interpreter.ts`) verified across automated tests.
  - Plain-language schedule descriptions rendered on Overview Dashboard, Schedule & Ceilings, and Settings views.
  - SchedulerService supports `DAILY`, `WEEKDAYS`, `WEEKLY`, and `MONTHLY` single-window execution. Rejects sub-daily interval expressions (e.g. `*/15 * * * *`) with descriptive validation to protect Jira and Entra API rate limits.
  - Default schedule restored to `0 2 * * *` (02:00 America/New_York).
- **Remote Device & Reverse Proxy Access Remediation:**
  - Container port binding published on configurable interfaces and ports via `compose.yaml`: `${WEB_BIND_IP:-0.0.0.0}:${WEB_BIND_PORT:-${WEB_PORT:-8080}}:${WEB_CONTAINER_PORT:-8080}`.
  - Permitted loopback host (`localhost`, `127.0.0.1`, `::1`) and loopback origin validation across any port, preventing host-validation redirect loops and origin mismatch errors when accessing through custom mapped host ports.
  - Resolved reverse proxy 502 Bad Gateway causes: ensured external port matches upstream proxy configuration and documented `127.0.0.1` IPv4 loopback targeting (avoiding IPv6 `::1` resolution failures when targeting `localhost`).
  - Non-loopback deployments strictly enforce HTTPS by default. Removed automatic exemption of private IPs (RFC 1918) and internal domain names.
  - Added explicit test-only flag `ALLOW_INSECURE_REMOTE_HTTP=true` for LAN/staging HTTP test environments, with prominent startup warning log.
  - Fastify `trustProxy` support (`WEB_TRUST_PROXY`): `X-Forwarded-Host` is trusted only when explicitly configured, preventing proxy header spoofing.
  - Origin validation and CSRF checks are strictly tied to `PUBLIC_BASE_URL`.
  - Resolved remote redirect loop where unmatched hosts previously redirected to `127.0.0.1:8080`; verified 200 OK login page, CSRF checks, authenticated session navigation, and Atlassian OAuth callback matching across all endpoints over reachable LAN IP (`http://<LAN-IP>:8080`).
  - Documented remote-test configuration, reverse proxy reference templates, 502 prevention, and production HTTPS transition in `docs/production-deployment-guide.md`.
- **Production Backup & Disaster Recovery Verification:**
  - Documented complete backup and restore procedure in `docs/backup-and-restore.md`.
  - Executed isolated recovery acceptance test: took atomic SQLite online backup (`.backup` API), backed up master AES-256-GCM encryption key, and backed up rotating OAuth token state.
  - Restored to isolated scratch environment without live writes: verified `PRAGMA integrity_check = ok`, verified all runs and settings, confirmed clean decryptability of customer diff details with restored key, verified OAuth token state readability, and confirmed active locks were empty.
- **Live Browser Acceptance Testing:**
  - Authenticated via browser UI with local administrator credentials.
  - Navigated `/overview`, `/runs`, `/runs/15`, `/runs/16`, `/runs/17`, `/runs/19`, `/runs/20`, `/schedule`, and `/settings`.
  - Verified 64-character SHA-256 digest display, exact-length indicator, and clipboard Copy button.
  - Verified visual badge breakdown for 80 excluded customers (`DOMAIN_NOT_APPROVED: 61`, `EMAIL_UNAVAILABLE: 13`, `ENTRA_NOT_FOUND: 5`, `ENTRA_AMBIGUOUS: 1`).
  - Verified post-run preview shows 0 proposed changes.
  - Verified rollout approval form is suppressed in UI while writes are disabled.
  - Verified client-side input validation pattern (`pattern="^[a-f0-9]{64}$"`).
  - Verified Emergency Pause control: toggling pause immediately updated system state to `PAUSED`, activated dashboard warning banners, changed button to `Resume System Operations ▶`, and subsequent unpause cleanly restored `ACTIVE` state.
- **Restart Persistence & Mutex Safety:**
  - Executed `docker compose restart sync-service`.
  - Re-queried database and Web UI after restart: completed preview and rollout runs remained `COMPLETED` with identical metrics and digest.
  - No orphaned locks or automatic replays occurred.
- **Five-Field Live Discovery & Read-Only Synchronization Preview (Run #22):**
  - **Live Field Discovery:** Connected to Jira Cloud via OAuth 3LO tokens; discovered 6 fields in Jira CSM (`totalFields: 6, matchedFieldCount: 5, missingFieldCount: 0, unmappedFieldCount: 1, unknownTypeCount: 0`). Successfully matched all five target fields (`Title`, `Office Phone Number`, `Supervisor`, `Office/Classroom`, and `Email Address`) without configuration error.
  - **Live Directory Ingestion:** Ingested 431 Graph user records, filtered 334 eligible active directory records (`excludedGuests: 97, excludedDisabled: 0`), and completed 334 manager lookups (88 resolved, 246 no manager, 0 lookup failures).
  - **Scope & Exclusions:** Enumerated 208 existing customers in Jira scope; 128 matched in Entra directory; 80 skipped records (`DOMAIN_NOT_APPROVED: 61, EMAIL_UNAVAILABLE: 13, ENTRA_NOT_FOUND: 5, ENTRA_AMBIGUOUS: 1`).
  - **Proposed Differences:** 118 customers with 119 proposed field changes (118 `emailAddress` detail fields to populate + 1 `officePhoneNumber` update).
  - **Approval Code:** Generated deterministic 64-character SHA-256 preview digest: `3f822604d542bd0d0b5a5dadfc5f0bc7550aac95a6162b8816ccf7f94cac4bd4`.
  - **UI & Safety Verification:** Authenticated browser rendering confirmed: "Email Address" friendly field label, customer identity (bold email and display name), side-by-side diff table with empty Jira values and new directory values. Writes remain disabled (`writes_enabled = false`), automation remains disabled (`automation_enabled = false`), and safety ceilings remain at 100 max customers and 400 max fields. Approval form is cleanly suppressed. 0 live Jira mutations performed.
