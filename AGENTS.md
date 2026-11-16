# Agent handoff: Entra to Jira Customer Sync

## Product goal

A single-host Docker service that synchronizes selected Microsoft Entra user details into **existing** Jira Service Management customer detail fields.

- **Scope:** Jira service-desk customer enumeration defines it. Matching is by exact normalized email.
- **Mapped fields:** `title`, `officePhoneNumber`, `supervisor`, `officeClassroom`, `emailAddress`.
- **Non-erasure:** empty or unavailable Entra values never erase populated Jira values.
- **No account changes:** the service never creates, invites, or deletes Jira customers.

Keep the application white-label. Do not add tenant, organization, or customer-specific names, IDs, emails, IPs, colors, or credentials to source, templates, examples, tests, or product docs. Deployment-specific evidence belongs only in `docs/acceptance/`.

## Current state (1.0.0)

**Status:** 1.0.0 has been **in production since 2026-10-02**. It is feature-complete for this release, so changes now are maintenance and support. Details of the live installation are in [`docs/acceptance/production-deployment-record.md`](docs/acceptance/production-deployment-record.md): address, proxy, image delivery, legacy env names, and launch issues. Read it before touching deployment, compose naming, Jira site selection, or env var names.

### Web service

- **Entry point:** `src/web/index.ts` → `createWebApp` (`src/web/app.ts`), with routes in `src/web/routes/*`.
- **Wiring:** `src/web/wiring.ts` builds a fresh set of Jira clients and request budgets **per run**.
- **Preview** (`ProductionSyncPreviewService`): read-only. It enumerates the scope, filters by approved domains, matches Entra, plans diffs, and produces a deterministic SHA-256 approval code.
- **Update** (`ProductionSyncWriterService`):
  - Runs a digest-bound preflight and per-customer drift re-reads.
  - Writes one field at a time with pacing, using the field names discovered on the site.
  - Verifies each write by reading it back with `DiffPlanner`.
  - Per-customer statuses: VERIFIED, PARTIAL, FAILED, or NOT_ATTEMPTED. Per-field statuses include OUTCOME_UNKNOWN and VERIFICATION_UNAVAILABLE.
  - Halts on any uncertainty.
- **Scheduler** (`SchedulerService`):
  - One run per window: daily, weekdays, weekly, or monthly, with an optional month.
  - DST-safe and duplicate-protected.
  - Never throws.
  - Defers while the run lock is held.
  - Automatic writes only in COMMISSIONED_AUTOMATED with automation and writes enabled.
- **Notifications:** dashboard alerts, an HTTPS webhook (10 s timeout), and SMTP via `src/services/smtp-client.ts` (STARTTLS or implicit TLS, optional AUTH PLAIN/LOGIN, injection-safe).
- **Store** (`src/web/store.ts`):
  - SQLite with a versioned `schema_version` migration.
  - AES-256-GCM encryption of run details and the SMTP password.
  - An audit log that redacts sensitive settings.
  - PID-aware run lock and restart recovery.
  - Retention: 90 days for details, 365 days for audit events and acknowledged alerts.
- **Shutdown:** `RunTracker` refuses new runs, services stop at their next safe point via `shouldStop`, and the wait is bounded.
- **Operating modes:**
  - Lifecycle: `UNCOMMISSIONED` → `COMMISSIONED_MANUAL_ONLY` → `COMMISSIONED_AUTOMATED`.
  - **Automatic** requires a completed manual update with at least one verified field.
  - **Allow updates to Jira** (`writes_enabled`) is a separate master switch.
  - Emergency pause blocks previews and updates.

### UI conventions

- Plain-language labels live in `src/web/view-helpers.ts`; unknown codes fall back to a humanized form. Raw codes appear only in tooltips and "Technical details".
- Standard redirect notices use `?notice=<code>` (the `NOTICES` map). Friendly error pages render `pages/error.ejs`.
- The CSP is `script-src 'self'; style-src 'self'`. Never use inline `style=`, `on*=` handlers, or inline scripts. `tests/web/ui-render.test.ts` enforces this.
- The synchronized field catalog (names, aliases, labels) lives in `src/connectors/jira/field-catalog.ts`.

### Configuration

- `.env.example` is the reference. Shared env helpers are in `src/config/env.ts`, and web config is in `src/web/config.ts` (it throws `ConfigError` for messages safe to show the operator).
- `JIRA_WRITE_SCOPE_ALLOWED` replaces the deprecated `PILOT_WRITE_SCOPE_ALLOWED`, which is still accepted. In the web app it also adds the write scope to the requested scopes. Updates are refused before any write unless the saved token was granted that scope (`services.jiraWritePermission()`).
- `JSM_SERVICE_DESK_IDS` is required; there is no silent default.
- New installs default to the UTC time zone.

### Legacy CLI

- `src/index.ts` (`npm run cli`) provides diagnostics and the bounded pilot/rollout writers, documented in `docs/cli/`.
- It is independent of the web app.

## Verification

- `npm run check` runs format, lint, typecheck (source and `tsconfig.test.json`), all tests, and the build. At 1.0.0 it reports 30 test files and 415 tests passing.
- `tests/production-hardening.test.ts` holds the regression tests for the 1.0.0 fixes.
- Live acceptance evidence from the original deployment is in `docs/acceptance/`.

## Documentation map and upkeep

| Document                                          | Audience                    | Update it when…                                                                                                                                      |
| :------------------------------------------------ | :-------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/user-guide.md`                              | Administrators using the UI | A page, label, status, notice, skip reason, or setting changes. Quote labels exactly as `src/web/view-helpers.ts` and the templates render them.     |
| `docs/support-guide.md`                           | IT / support                | A failure mode, error message, operational command, credential, or `.env` setting changes. Add every new support case to its troubleshooting tables. |
| `docs/setup.md`, `docs/production-deployment.md`  | Installers                  | Installation, proxy, or image-delivery steps change.                                                                                                 |
| `docs/commissioning-runbook.md`                   | Installers / administrators | Operating-mode rules change.                                                                                                                         |
| `docs/backup-and-restore.md`                      | IT                          | Volumes, paths, or stored files change.                                                                                                              |
| `docs/architecture.md`                            | Developers                  | Data flow, safety mechanisms, or code layout change.                                                                                                 |
| `docs/acceptance/production-deployment-record.md` | Support for this deployment | The live deployment changes (version, host, proxy, credentials' expiry, incidents).                                                                  |
| `docs/README.md`, `README.md`                     | Everyone                    | A document is added, renamed, or removed.                                                                                                            |
| `CHANGELOG.md`                                    | Everyone                    | Any user-visible change.                                                                                                                             |

Only `docs/acceptance/` may contain deployment-specific details. Everything else stays white-label.

## Support playbook for agents

When asked to diagnose a problem in a running installation:

1. **Get the run page first:** the red reason box, per-field results, and **Technical details**. Most failure reasons are self-describing, and the support guide maps each one to a fix.
2. **Logs:** `docker compose logs sync-service` (sanitized JSON). The startup line reports the version. Compare it with `package.json` before suspecting code: production running a stale image has already happened once.
3. **Connections page:** shows the Jira connection checks, including **Update permission** (`services.jiraWritePermission()`).
4. **Ask before reading production data.** Don't read OAuth tokens, `.env` secrets, or the live database without explicit permission. Test risky procedures on a separate Compose project (`docker compose -p <scratch> ...`) with its own volumes, never on the live ones.
5. **Never write to Jira to "test" a fix.** Use mocked `fetch` in tests (see `tests/production-hardening.test.ts`). Real updates happen only through an administrator's approval in the UI.
6. **After a fix:**
   - add a regression test
   - update the support guide's troubleshooting tables and the changelog
   - record any production incident in the deployment record

## Open items

1. Explicit administrator sign-off before switching to Automatic.
2. A live kill-during-write drill. Crash recovery is unit-tested, but this has not been exercised against production Jira.
3. Missing details in the deployment record (marked _To be filled in_).

Done at launch (2026-10-02): live operation over HTTPS behind the operator's reverse proxy.

## Safety and security rules

1. Do not connect a web route to the pilot or bounded CLI writers. Legacy CLI write environment variables do not authorize web writes.
2. Keep OAuth authorization codes, access/refresh tokens, client secrets, field values, and full emails out of logs, outbound alerts, and error pages. Sanitize failure reasons with `sanitizeFailureReason`.
3. Bind OAuth state to the administrator session; store only the state hash; expire it promptly; consume it once. The browser callback URL must exactly match the Atlassian developer-console setting. Preserve token rotation and atomic persistence.
4. Retain project-scoped Jira enumeration, exact-match identity resolution, non-erasure, fresh-plan checks, sequential writes, pacing, post-write verification, and fail-closed handling of partial reads or uncertain mutations. Never truncate customer enumeration to bypass safety ceilings, and never retry a write whose outcome is unknown.
5. The production web app requires an HTTPS `PUBLIC_BASE_URL` for non-loopback hosts, secure cookies, CSRF checks, rate-limited login, and a configured local administrator. Trust forwarded headers only from `WEB_TRUST_PROXY`.
6. Keep secrets out of Git and Docker images. `data/`, `secrets/`, `reports/`, `backups/`, and `deployment-secrets/` are runtime storage. Never copy `.env` into the image.
7. Approved email domains are matched exactly and case-insensitively before Entra matching. An empty list blocks previews and writes. The domain scope is bound into each preview's digest and re-checked before every mutation.

## Deferred

Generic OIDC, Entra SSO, and viewer accounts (the viewer role exists in code but no account can be created yet).
