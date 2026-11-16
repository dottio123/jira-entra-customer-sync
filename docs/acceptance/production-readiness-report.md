# Production Readiness & Acceptance Report: Entra to Jira Customer Sync

> **Historical record.** This report describes one deployment of this service (version 0.x)
> and is kept for audit purposes. Figures, run numbers, and approval codes are specific to that
> deployment. Links to `reports/` point at runtime files that are not part of the repository.
> Corrections since it was written: email alerts now use STARTTLS/implicit TLS with optional
> sign-in; private-network HTTP is no longer exempt from HTTPS (it needs
> `ALLOW_INSECURE_REMOTE_HTTP=true`); and five Jira fields are synchronized.

## 1. Executive Summary & Operational Posture

The Microsoft Entra ID to Jira Service Management Customer Sync service has achieved operational baseline stability. The service operates under strict safety invariants: non-erasure of existing customer data, zero customer creation or deletion, project-scoped enumeration, cryptographic SHA-256 preview digest approvals, paced writes with read-after-write verification, and dual-gate commissioning controls.

### Current System Posture

| Setting / Metric             | Current Production Value               | Status                                                                 |
| :--------------------------- | :------------------------------------- | :--------------------------------------------------------------------- |
| **Commissioning Status**     | `COMMISSIONED_MANUAL_ONLY`             | **Gated** (Manual rollouts only with explicit digest approval)         |
| **Web Writes**               | `false` (Disabled)                     | **Closed** (No live web mutations permitted)                           |
| **Automation**               | `false` (Disabled)                     | **Closed** (Scheduled runs execute read-only previews only)            |
| **Emergency Pause**          | `false` (Active)                       | **Normal**                                                             |
| **Safety Ceilings**          | 100 customers / 400 fields             | **Enforced**                                                           |
| **Synchronization Baseline** | 100% complete (0 remaining diffs)      | **Verified** (236 cumulative fields synchronized across 120 customers) |
| **Notification Channels**    | Webhook: `Disabled` · SMTP: `Disabled` | **Safe default**                                                       |

---

## 2. Taxonomy of Verification Evidence

All acceptance evidence is categorized into three distinct tiers:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       TIERS OF VERIFICATION EVIDENCE                        │
├─────────────────────────┬─────────────────────────┬─────────────────────────┤
│ Tier 1: Simulated /     │ Tier 2: Live            │ Tier 3: Actual          │
│ Harness Tests           │ Integration Tests       │ Unattended Execution    │
├─────────────────────────┼─────────────────────────┼─────────────────────────┤
│ • 353 automated tests   │ • Live Graph ingestion  │ • Clock-driven cron     │
│ • Synthetic test runs   │ • Live Jira CSM reads   │ • Real service process  │
│   (Runs #18, #19)       │ • Baseline rollout #15  │ • Zero operator input   │
│ • Mocked notifications  │ • Post-rollout #16      │ • Zero injected clock   │
│ • SQLite in-memory      │ • Catch-up run #17      │ • Read-only preview     │
│   recovery simulations  │ • Web UI browser check  │   (Run #20 at 23:15 EDT)│
└─────────────────────────┴─────────────────────────┴─────────────────────────┘
```

### Tier 1: Simulated & Harness Tests

- **Automated Vitest Suite:** 353 automated unit and integration tests across 25 test files (`npm run check` passes cleanly with zero errors).
- **Simulated Test Runs (Runs #18 & #19):** Runs executed via synthetic test scripts during commissioning development. To ensure audit integrity, these runs are preserved in the persistent database and formally reclassified as `COMMISSIONING_TEST` with `failure_reason: 'SIMULATED_TEST'`.
- **Synthetic Alert Delivery:** Webhook payload JSON structure and zero-dependency SMTP formatting were validated using isolated mock socket and synthetic HTTP harness tests. No unapproved external transmissions were sent.

### Tier 2: Live Integration Tests

- **Microsoft Graph Directory Ingestion:** Retrieved 431 user records, filtered 334 eligible active directory users, and resolved 88 manager relationships against live tenant endpoints.
- **Jira Service Management Customer Scope:** Enumerated 208 existing customer accounts across configured service desk projects and matched 4 canonical customer detail fields (`Title`, `Office Phone Number`, `Supervisor`, `Office/Classroom`).
- **Baseline Rollout (Run #15):** Applied 227 field changes across 115 customers with sequential pacing (500ms), exact Jira CSM display-name resolution, phone format normalization, and 100% read-after-write verification.
- **Post-Rollout Read-Only Preview (Run #16):** Evaluated all 208 customers; confirmed 128 matched, 80 audit exclusions (`DOMAIN_NOT_APPROVED`: 61, `EMAIL_UNAVAILABLE`: 13, `ENTRA_NOT_FOUND`: 5, `ENTRA_AMBIGUOUS`: 1), 0 proposed customer updates, 0 proposed field updates, and generated deterministic SHA-256 digest `ec224209071e8a5a3b9785179c2dbffb1f87ac120f10cde0a7ad1236b78a41aa`.
- **Disaster Recovery & Backup Validation:** Executed atomic SQLite online backup (`.backup`), encryption key backup, and OAuth token backup; verified full data integrity, decryptability, and zero orphaned locks in an isolated recovery environment.

### Tier 3: Actual Unattended Execution

- **Real Clock-Driven Scheduled Execution (Run #20):** Triggered purely by the background `SchedulerService` interval timer running in the normal background Docker container at 23:15 EDT. Executed without manual intervention, tick script invocations, or injected clocks.

---

## 3. Itemized Acceptance Findings

### 3.1. Scheduler State & Test Interference Remediation

#### Finding

During initial deployment, test runs (Run #18 and Run #19) were inserted with `trigger_source = 'SCHEDULED'` on `2026-10-01`. Because `WebStore.getLatestScheduledRun()` queried solely on `trigger_source = 'SCHEDULED'`, and `SchedulerService.tick()` compared calendar date keys (`runDateKey === dateKey`), simulated Run #19 caused the scheduler to conclude that today's scheduled run had already executed. This test interference would have caused any subsequent clock-driven scheduled run on `2026-10-01` (such as a run scheduled for 23:15 EDT) to be skipped.

#### Remediation Implemented

1. **Audit-Preserving Reclassification:** Runs #18 and #19 were updated in the persistent SQLite database to `run_type = 'COMMISSIONING_TEST'`, preserving all timestamps, digests, customer metrics, and encrypted diff payloads. An explicit maintenance event was recorded in `audit_events`.
2. **Store Query Filtering:** `WebStore.getLatestScheduledRun()` was updated to filter `run_type != 'COMMISSIONING_TEST'`, ensuring test runs never satisfy the production scheduled run requirement.
3. **Target Window Re-targeting:** `SchedulerService.tick()` was enhanced to calculate `targetScheduleKey` combining the calendar date and the configured target time (`${dateKey}@${targetHour}:${targetMinute}`). A prior run only marks today as completed if it was initiated at or after the target schedule window. Reconfiguring the schedule to an upcoming time allows the newly targeted run to execute on schedule.
4. **Container Rebuild:** Rebuilt and restarted `sync-service` with zero downtime to persistent volume data.

---

### 3.2. Real Clock-Driven Scheduled Read-Only Run (Run #20)

Observed live from the normal background service at the configured schedule (`15 23 * * *`, 23:15 EDT) with zero operator intervention and zero clock manipulation:

| Metric                           | Recorded Value                                                     | Acceptance Result                 |
| :------------------------------- | :----------------------------------------------------------------- | :-------------------------------- |
| **Run ID**                       | #20                                                                | Sequential persistent ID          |
| **Run Type**                     | `PREVIEW`                                                          | Read-only preview                 |
| **Trigger Source**               | `SCHEDULED`                                                        | Background clock tick             |
| **Start Time (UTC)**             | `2026-10-02T03:15:35.352Z`                                         | Exact schedule window             |
| **Start Time (EDT)**             | `2026-10-01 23:15:35`                                              | 23:15 EDT scheduled tick          |
| **Completion Time (UTC)**        | `2026-10-02T03:17:47.356Z`                                         | 132.0s duration                   |
| **Completion Time (EDT)**        | `2026-10-01 23:17:47`                                              | Clean completion                  |
| **Status**                       | `COMPLETED`                                                        | Success                           |
| **Unique Customers Evaluated**   | 208                                                                | Complete scope                    |
| **Matched Entra Customers**      | 128                                                                | 100% resolved                     |
| **Skipped Customers**            | 80                                                                 | Verified audit exclusions         |
| **Proposed Customer Changes**    | 0                                                                  | In-sync baseline                  |
| **Proposed Field Changes**       | 0                                                                  | In-sync baseline                  |
| **Applied Customer Changes**     | 0                                                                  | **Zero mutations**                |
| **Applied Field Changes**        | 0                                                                  | **Zero mutations**                |
| **Deterministic Preview Digest** | `ec224209071e8a5a3b9785179c2dbffb1f87ac120f10cde0a7ad1236b78a41aa` | Identical to baseline preview #16 |
| **Duplicate Run Suppression**    | Verified on subsequent tick at 23:18 EDT                           | `alreadyRanToday = true`          |

---

### 3.3. Production HTTPS Endpoint & Security Evaluation

#### Current State & Administrator Self-Deployment Handoff

The application is prepared for administrator deployment to production:

- **HTTPS Acceptance Status:** **PENDING ADMINISTRATOR DEPLOYMENT**
- **Deployment Mode:** The administrator will self-deploy the container to production, configure the public reverse proxy (Nginx, Caddy, Traefik, ALB, etc.), and provision CA-signed TLS.
- **Loopback & Private Network Safety:** Configuration logic enforces HTTPS outside loopback and private networks. RFC 1918 private IPv4 addresses (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), link-local, `.local`, and `.internal` hosts are permitted for staging and LAN operation.
- **Production Public Origin:** In production, `PUBLIC_BASE_URL` must use HTTPS (`https://sync.example.com`), which automatically activates secure cookie attributes (`__Host-sync_session`, `Secure`, `HttpOnly`, `SameSite=Lax`).
- **Atlassian OAuth 3LO Registration:** The administrator will register `${PUBLIC_BASE_URL}/auth/atlassian/callback` in the Atlassian developer console.

---

### 3.4. External Notification Channels

- **Status in Production Storage:**
  - `smtp_enabled`: `false`
  - `webhook_enabled`: `false`
- **Audit Clarification:** All prior notification verification recorded in project logs represents **isolated harness tests** (mock socket verification for SMTP STARTTLS handshake and synthetic POST requests for generic webhooks).
- **Policy:** Unused notification channels remain strictly disabled. Live external delivery testing will be conducted only if and when an administrator explicitly configures and enables an external endpoint.

---

### 3.5. Supported Cron Expressions & Plain-Language Interpreter

Implemented `src/utils/cron-interpreter.ts` and aligned `SchedulerService`:

- **Supported Schedules:** The scheduler strictly validates and supports exact single-execution windows:
  - `DAILY`: e.g. `0 2 * * *` ("Every day at 2:00 AM")
  - `WEEKDAYS`: e.g. `0 2 * * 1-5` or `0 2 * * MON-FRI` ("Every weekday (Monday through Friday) at 2:00 AM")
  - `WEEKLY`: e.g. `0 2 * * 0` or `0 2 * * SUN` ("Every Sunday at 2:00 AM")
  - `MONTHLY`: e.g. `0 2 1 * *` ("On the 1st of every month at 2:00 AM")
- **Descriptive Validation & Rejection:** Sub-daily interval or multi-execution schedules (e.g. `*/15 * * * *`, `* * * * *`) are rejected with descriptive validation feedback on `/schedule` to protect Jira and Entra API rate limits.
- **UI & Scheduler Alignment:** Plain-language descriptions strictly reflect actual scheduler execution, rendering on Overview, Schedule, and Settings pages.
- **Default Schedule Restored:** Default schedule is restored to `0 2 * * *` (02:00 America/New_York).

---

### 3.6. Remote IP Access & Reverse Proxy Remediation

#### Finding

Remote devices on the local network or accessing via server IP address experienced connectivity issues and redirects to loopback addresses.

#### Remediation Implemented

1. **Container Port Binding (`compose.yaml`):** Updated port mapping from hardcoded loopback `127.0.0.1:8080:8080` to `${WEB_BIND_IP:-0.0.0.0}:8080:8080`, allowing the container to listen on all interfaces or a designated private IP.
2. **Private IP Support (`src/web/config.ts`):** Implemented `isLoopbackOrPrivateHost` recognizing RFC 1918 private IPv4 ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), link-local, and `.local`/`.internal` domains, allowing HTTP during private network testing without throwing HTTPS production errors.
3. **Reverse Proxy Header Support (`src/web/config.ts`, `src/web/app.ts`):** Added `WEB_TRUST_PROXY` support and passed `trustProxy` to Fastify. Effective host resolution now respects `X-Forwarded-Host` and `X-Forwarded-Proto`.
4. **Origin & CSRF Validation:** Enhanced `isAllowedOrigin` and `getSafeReferer` to support direct LAN IP access without triggering cross-site request forgery blocks, while still strictly rejecting untrusted external domains.

---

## 4. Promotion Prerequisites

To promote commissioning status from `COMMISSIONED_MANUAL_ONLY` to `COMMISSIONED_AUTOMATED`:

- [x] Initial live rollout executed and verified in Jira Cloud (Run #15: 227/227 fields verified).
- [x] Independent post-rollout preview confirms zero remaining diffs (Run #16: 0 proposed changes).
- [x] Test-induced scheduler interference safely resolved and audit history preserved.
- [x] Real clock-driven scheduled read-only run observed from normal running service (Run #20: 0 mutations).
- [x] Default schedule restored to `0 2 * * *` (02:00 America/New_York).
- [x] Scheduler and cron interpreter verified for all supported expressions with validation rejection for intervals.
- [x] Remote device and reverse proxy IP access issues resolved and verified.
- [x] Production deployment instructions and post-deployment acceptance checklist documented.
- [ ] **Production HTTPS Acceptance (Pending Administrator Deployment):** Reverse proxy and public HTTPS URL configured with valid TLS certificate and `__Host-` cookies.
- [ ] **Atlassian OAuth Callback Verification (Pending Administrator Deployment):** Registered and verified against public HTTPS URL.
- [ ] **Explicit Administrator Sign-Off:** Promotion to `COMMISSIONED_AUTOMATED` approved.
