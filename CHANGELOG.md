# Changelog

## 1.0.0

First consumer-ready release. Existing installations upgrade in place: settings, history, the Jira connection, and the administrator password are kept.

### Fixed

- **Large previews no longer fail on request limits.** Jira clients and request budgets are now created per run. Previously every profile read repeated field discovery against a process-wide limit, so previews of more than about 50 matched customers, and long-running services, could fail.
- **Updates use each Jira site's own field names** (for example "Job Title") instead of fixed names.
- **An invalid schedule time zone can no longer crash the service.** Scheduler ticks never throw, and the time zone is validated when saved.
- **Changing `NODE_ENV` can no longer lock out the administrator.** The password hash now stores its own cost; older hashes are upgraded at the next sign-in.
- **A saved 23:15 schedule is no longer reset** to 02:00 on every start.
- **Yearly schedules** (`M H D <month> *`) now run only in that month.
- **Scheduled updates are linked to their preview**, so duplicate-apply protection and "based on preview" links work for them.
- **A run that was stopped part-way is recorded as Partial.** Applied writes are kept even after unexpected errors. Writes with no answer are reported as **Outcome unknown**, and failed confirmations as **Not confirmed**.
- **A preview whose details expired** (90-day retention) or cannot be decrypted is refused instead of "completing" with no writes. Automatic mode now requires a manual update that confirmed at least one field.
- **Customer enumeration** follows Jira's `isLastPage` instead of stopping at a short page.
- **The guest filter now works against live Microsoft Graph** (`userType` is requested). Manager-lookup state resets on every run.
- **Jira site selection fails closed** when the connection can reach several sites and none is configured.
- **The emergency pause now also blocks previews**, as the interface stated. Approving while a run is active or paused no longer leaves a run stuck as Queued.
- **Duplicate alerts for scheduled failures** were removed.
- **Tests are now type-checked** as part of `npm run check`, which surfaced and fixed several incorrect test mocks.

- **Connect Jira now opens the Atlassian sign-in in a new tab from a plain link.** Previously it submitted a form, and browsers block form redirects through Atlassian single sign-on, which left a blank page. The link only works when clicked from the service's own pages.
- **Updates no longer fail with Jira status 401 because the write permission was never requested.**
  - `JIRA_WRITE_SCOPE_ALLOWED=true` now requests the write permission by itself. Previously it also had to be added to `ATLASSIAN_OAUTH_SCOPES`; otherwise Connect Jira saved a read-only connection.
  - Connections shows an **Update permission** check.
  - Approval is replaced by a "Reconnect Jira" prompt while the permission is missing.
  - An update is refused before any write if the saved connection lacks it.
  - A 401/403 rejection is explained in plain language.
- **Update runs show attempted and unconfirmed counts** instead of zero customer counts, and Sync history shows "—" rather than 0 under Customers checked for updates.

### Security

- Email alerts use STARTTLS (or implicit TLS on port 465) with optional sign-in; the password is stored encrypted. Header and command injection is prevented, and dot-stuffing is applied.
- Webhooks must use HTTPS, and requests time out after 10 seconds. Alerts are sent after the run lock is released.
- Settings are validated on the server: time zone, safety limits, SMTP port and addresses, webhook URL, and operating mode.
- The audit log no longer records webhook URLs or credentials, and unchanged settings are no longer logged.
- An open redirect through a crafted `Referer` header was fixed. `__Host-` cookies are now cleared correctly on sign-out.
- `Strict-Transport-Security` is sent over HTTPS. Forwarded host headers are honored only from trusted proxies.
- The password-change form is rate-limited. Failure reasons shown in the interface and sent in alerts are sanitized.
- Jira and webhook requests have timeouts.
- SQLite WAL files are restricted to the service user.
- Graceful shutdown: new runs are refused, in-flight runs stop at a safe point, and the wait is bounded.

### Changed

- **Configuration:**
  - `.env.example` is reorganized into numbered sections, with CLI-only settings at the end.
  - Blank values now behave like unset ones.
  - Startup errors are reported in plain language, and `LOG_LEVEL` applies to the web service.
- **Renamed variable:** `JIRA_WRITE_SCOPE_ALLOWED` replaces `PILOT_WRITE_SCOPE_ALLOWED`. The old name still works and logs a deprecation notice.
- **New variable:** `MICROSOFT_CLIENT_SECRET_FILE`.
- **Service desk default:** there is no silent default service desk any more. Set `JSM_SERVICE_DESK_IDS`.
- **compose.yaml:**
  - The project name is fixed, so volume names no longer depend on the folder.
  - The root filesystem is read-only, capabilities are dropped, and `no-new-privileges` is set.
  - There's a 60-second stop grace period and log rotation.
- **npm scripts:** `npm start` runs the web service. The CLI moves to `npm run cli`/`cli:dev`, and `npm run cli:compare-reports` is new.
- **Interface wording:**
  - Consistent "preview"/"update" language and plain-language result labels.
  - Friendly error pages and notices instead of plain-text errors.
  - Schedule is hidden from viewers.
- **Default time zone:** new installations default to UTC. Existing installations keep their saved time zone.
- **Documentation:**
  - New [user guide](docs/user-guide.md) for administrators, [support guide](docs/support-guide.md) for IT (including a tested administrator password reset), and a [documentation index](docs/README.md).
  - Rewritten for operators.
  - Deployment-specific acceptance records moved to `docs/acceptance/`.
  - CLI material moved to `docs/cli/`.
