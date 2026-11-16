# Support guide

For IT staff who keep Customer Sync running: routine tasks, renewing credentials, and fixing known problems. For day-to-day use of the web interface, see the [user guide](user-guide.md). Details of a specific installation belong in its deployment record under [`docs/acceptance/`](acceptance/).

All commands run on the Docker host, in the folder that contains `compose.yaml` and `.env`.

## The service at a glance

| Item      | Value                                                                                            |
| :-------- | :----------------------------------------------------------------------------------------------- |
| Container | Compose service `sync-service`, project `jira-entra-customer-sync`                               |
| Image     | `entra-jsm-customer-sync:latest`                                                                 |
| Web port  | Container port 8080, published on `WEB_BIND_IP:WEB_BIND_PORT`; usually behind an HTTPS proxy     |
| Health    | `GET /health/live` → `{"status":"alive"}`; `GET /health/ready` → `{"status":"ready"}`            |
| Logs      | `docker compose logs sync-service`: structured JSON, rotated at 10 MB × 5 files                  |
| Settings  | Server settings in `.env`; everything else is set in the web interface and saved in the database |

The service keeps its data in three Docker volumes:

| Volume                                  | Path in container | Contents                                                            | Back up?                            |
| :-------------------------------------- | :---------------- | :------------------------------------------------------------------ | :---------------------------------- |
| `jira-entra-customer-sync_sync_data`    | `/app/data`       | SQLite database: settings, run history, accounts, audit log, alerts | **Yes**                             |
| `jira-entra-customer-sync_sync_secrets` | `/app/secrets`    | `encryption.key` and the Jira sign-in (`atlassian-oauth.json`)      | **Yes**, together with the database |
| `jira-entra-customer-sync_sync_reports` | `/app/reports`    | Backup staging and CLI reports                                      | No                                  |

Host files are `.env`, `deployment-secrets/` and `branding/`. Back them up with your normal configuration backups.

> Never delete the volumes, and never run `docker compose down -v`. That erases the history, the settings, the administrator account, and the Jira connection.

## Routine tasks

### Check health and the running version

```bash
docker compose ps                                   # STATUS should say "(healthy)"
curl -fsS http://127.0.0.1:8080/health/ready        # use WEB_BIND_PORT if not 8080
docker compose exec -T sync-service node -p "require('/app/package.json').version"
```

The startup log line `Customer Sync web server listening` also shows the version.

### Read the logs

```bash
docker compose logs --since 24h sync-service
docker compose logs -f sync-service                 # follow live
```

Each line is a JSON object with `level`, `message` and sometimes `context`.

- Logs never contain passwords, tokens, email addresses, or field values. Customers appear only as references such as `ref-1a2b3c4d5e`, so log excerpts are safe to share with support.
- For more detail, set `LOG_LEVEL=debug` in `.env` and recreate the container. Set it back to `info` afterwards.

### Restart or stop safely

```bash
docker compose restart sync-service                 # restart, same configuration
docker compose stop sync-service                    # stop
docker compose up -d --no-build                     # start, or apply .env changes
```

On stop, the service:

- refuses new runs
- lets an update stop at its next safe point, before its next write
- then closes the database

Compose allows 60 seconds for this. A run cut off by a restart is marked **Interrupted** and is never replayed.

> `docker compose restart` does **not** re-read `.env`. After editing `.env`, run `docker compose up -d --no-build`, which recreates the container with the new values.

### Back up

Follow [backup and restore](backup-and-restore.md). Back up at least weekly, and always before an upgrade. Always keep the database and `encryption.key` together: stored customer details can't be decrypted without the key.

### Upgrade

1. Take a backup.
2. On the build machine, build the new version and export it. Always use the exact tag `entra-jsm-customer-sync:latest`:

   ```bash
   docker compose build
   docker save entra-jsm-customer-sync:latest -o entra-jsm-customer-sync.tar
   ```

3. Copy the tarball **and the matching `compose.yaml`** to the server.
4. On the server:

   ```bash
   docker load -i entra-jsm-customer-sync.tar
   docker compose up -d --no-build
   docker compose exec -T sync-service node -p "require('/app/package.json').version"
   ```

5. Read `CHANGELOG.md` for any new `.env` settings. Sign in and check that Connections shows no warnings.

Database changes are migrated automatically when the service starts. If you build on the server itself, step 2 is just `docker compose up -d --build`.

### Retention

The service prunes old data once a day:

- per-customer run details after 90 days
- audit events and dismissed alerts after 365 days

Run summaries are kept. A preview older than 90 days can no longer be applied; run a new one.

## Renewing credentials

| Credential                    | Where it lives                                              | When to renew                                                    |
| :---------------------------- | :---------------------------------------------------------- | :--------------------------------------------------------------- |
| Microsoft Entra client secret | `MICROSOFT_CLIENT_SECRET` or `MICROSOFT_CLIENT_SECRET_FILE` | Before it expires; the expiry date is shown in the Entra portal. |
| Atlassian OAuth client secret | `ATLASSIAN_OAUTH_CLIENT_SECRET` or `…_FILE`                 | When rotated in the Atlassian developer console.                 |
| Jira sign-in (OAuth tokens)   | `/app/secrets/atlassian-oauth.json`; renewed automatically  | Only when Connections shows a warning, or after app changes.     |
| Administrator password        | Database                                                    | As your policy requires (**Settings → Change password**).        |

### Renew the Microsoft Entra client secret

1. In the Entra portal, create a new client secret for the app registration and copy its **value**.
2. Put the new value in `.env` (`MICROSOFT_CLIENT_SECRET=`), or in the file named by `MICROSOFT_CLIENT_SECRET_FILE`.
3. Run `docker compose up -d --no-build`.
4. Run a preview. If it reads the directory, the new secret works. Then delete the old secret in Entra.

An expired secret shows up as a preview that stops safely with a directory (Microsoft Graph) authentication error.

### Renew the Atlassian client secret

1. Rotate the secret in the Atlassian developer console.
2. Update `ATLASSIAN_OAUTH_CLIENT_SECRET` in `.env`, then run `docker compose up -d --no-build`.
3. Check Connections. If any check is yellow, choose **Reconnect Jira**.

### Reconnect Jira

**Connections → Reconnect Jira**. Sign in as the Atlassian account the service should act as and accept every permission.

That account must be allowed to view the service desk's customers and edit customer details. Reconnecting replaces the saved sign-in, and nothing else changes.

### Reset the administrator password

The web interface has no "forgot password" link, so a lost password is reset on the server. This sets a temporary password that must be changed at the next sign-in, and signs out all sessions.

```bash
docker compose stop sync-service
docker compose run --rm --no-deps -T -e TEMP_PASSWORD='temporary-passphrase-123' sync-service node -e '
const Database = require("better-sqlite3");
const { hashPassword } = require("./dist/web/password");
const user = process.env.ADMIN_USERNAME || "admin";
const db = new Database("/app/data/web.sqlite");
const row = db.prepare("SELECT id FROM users WHERE username = ?").get(user);
if (!row) { console.error("No account named " + user); process.exit(1); }
db.transaction(() => {
  db.prepare("UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?")
    .run(hashPassword(process.env.TEMP_PASSWORD), row.id);
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(row.id);
})();
db.close();
console.log("Password reset for " + user + ". Sign in with the temporary password and choose a new one.");
'
docker compose up -d --no-build
```

- The temporary password must be at least 12 characters.
- The account name is taken from `ADMIN_USERNAME` in `.env`, or `admin` if that isn't set.
- In PowerShell, keep the script in single quotes exactly as shown.
- Clear the command from your shell history afterwards.

## Troubleshooting

Start with the run page. The red box and the **Technical details** panel usually name the cause. Then check `docker compose logs sync-service`.

### Signing in and the web interface

| Symptom                                           | Cause and fix                                                                                                                                                                  |
| :------------------------------------------------ | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Redirected to a different address                 | The browser opened an address other than `PUBLIC_BASE_URL`. Use the configured address.                                                                                        |
| Sign-in refused after several attempts (HTTP 429) | 5 attempts per 15 minutes per client. Wait. Behind a proxy, `WEB_TRUST_PROXY` must name the proxy, or all users share one limit.                                               |
| "The sign-in page expired"                        | The sign-in form was open more than 10 minutes. Enter the details again.                                                                                                       |
| Lost administrator password                       | [Reset the administrator password](#reset-the-administrator-password).                                                                                                         |
| 502 Bad Gateway from the proxy                    | The container isn't running or isn't healthy (`docker compose ps`), or the proxy targets the wrong port, or `localhost`. Forward to `127.0.0.1:<WEB_BIND_PORT>`.               |
| A change is missing after an upgrade              | The server is running an older image. Compare the version (see [Check health](#check-health-and-the-running-version)); re-export `entra-jsm-customer-sync:latest` and load it. |

### Jira connection

| Symptom                                           | Cause and fix                                                                                                                                                                                                                                                       |
| :------------------------------------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Connect Jira** is greyed out                    | The Atlassian app details are missing from `.env`, or `ATLASSIAN_OAUTH_REDIRECT_URI` is set and doesn't equal `<PUBLIC_BASE_URL>/auth/atlassian/callback`.                                                                                                          |
| Atlassian shows a redirect or callback error      | The callback URL in the Atlassian developer console must exactly equal the one shown on Connections.                                                                                                                                                                |
| Connect Jira leaves a blank tab                   | Early 1.0.0 builds started the connection with a form, and browsers block that during Atlassian single sign-on. Upgrade to the current build, in which Connect Jira is a plain link.                                                                                |
| "Start the Jira connection from Connections"      | The sign-in link was opened directly or from another site. Open **Connections** and choose **Connect Jira** there.                                                                                                                                                  |
| "This Jira sign-in link has expired"              | More than 5 minutes passed, or the tab was reused. Start again from Connections.                                                                                                                                                                                    |
| "Sign in to finish connecting Jira"               | The Atlassian tab returned to a browser without an administrator session (a different browser or profile, or signed out). Sign in and connect again in the same browser.                                                                                            |
| **Update permission**: "Read-only…"               | `JIRA_WRITE_SCOPE_ALLOWED` is not `true` (the older name `PILOT_WRITE_SCOPE_ALLOWED` also works). Set it, run `docker compose up -d --no-build`, then **Reconnect Jira**.                                                                                           |
| **Update permission**: "Not granted yet"          | The saved sign-in predates the write permission. **Reconnect Jira** and accept every permission. If it still isn't granted, add `write:customer.detail:jira-service-management` under the app's **Permissions** in the Atlassian developer console, then reconnect. |
| Several Jira sites; previews fail choosing a site | Set `ATLASSIAN_SITE_URL` to the `*.atlassian.net` address (not a custom domain), or set `ATLASSIAN_CLOUD_ID`.                                                                                                                                                       |

### Previews and updates

| Symptom or message                                                                          | Cause and fix                                                                                                                                                                       |
| :------------------------------------------------------------------------------------------ | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An update fails with **Jira … status 401** or "lacks permission to update customer details" | The Jira sign-in has no write permission. See **Update permission** above. Status 403 can also mean the connected Atlassian account isn't allowed to edit customer details in Jira. |
| "Drift detected…"                                                                           | Jira or the directory changed after the preview. Nothing was written to that customer. Run a new preview and approve it.                                                            |
| "Threshold exceeded… Execution paused for safety."                                          | The update was larger than the safety limits on the Schedule page. Review it, raise the limits if the size is expected, then run a new preview and approve it.                      |
| "Preview #N has already been executed in rollout run #M"                                    | Each preview can be applied once, even if that update stopped early. Run a new preview.                                                                                             |
| "…details are no longer available (retention or decryption)"                                | The preview is older than 90 days, or `encryption.key` doesn't match the database (for example after a partial restore). Run a new preview; if it persists, check the restore.      |
| "Approved email domain scope changed…" or "Scope drift detected…"                           | The approved domains or `JSM_SERVICE_DESK_IDS` changed after the preview. Run a new preview.                                                                                        |
| "Microsoft Entra ID is not configured"                                                      | The `MICROSOFT_*` settings are missing from `.env`.                                                                                                                                 |
| A preview stops with a directory (Graph) authentication error                               | The Entra client secret expired or was changed. [Renew it](#renew-the-microsoft-entra-client-secret).                                                                               |
| "No Jira service desk is configured"                                                        | Set `JSM_SERVICE_DESK_IDS` in `.env` and run `docker compose up -d --no-build`.                                                                                                     |
| Many customers **Not found in directory**                                                   | Their Jira email doesn't exactly match an enabled, non-guest directory user's mail or sign-in name. This is expected for people outside the organization.                           |
| **Outcome unknown** or **Not confirmed** on a detail                                        | See [Uncertain outcomes](#uncertain-outcomes).                                                                                                                                      |
| A run stays **In progress** and new runs say "Another run is in progress"                   | Open the run. If it really is stuck (no change for a long time, nothing in the logs), restart the service: the run is marked **Interrupted** and the lock is released.              |

### Schedule and alerts

| Symptom                     | Cause and fix                                                                                                                                                                                                                                            |
| :-------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No scheduled run appeared   | Check, in order:<br>1. Syncing is paused.<br>2. The time zone or schedule is invalid (the logs say "Scheduled synchronization skipped").<br>3. The service was down for the whole scheduled day.<br>4. Another run was active (it retries every minute). |
| Scheduled runs only preview | Expected unless the operating mode is **Automatic**, **Apply updates automatically on schedule** is on, and **Allow updates to Jira** is on.                                                                                                             |
| Email alerts don't arrive   | Check the logs for the notification error. Common causes:<br>- the mail server doesn't offer STARTTLS on that port (use 465 for implicit TLS)<br>- the sign-in was refused<br>- the sender isn't allowed to relay                                        |
| Webhook alerts don't arrive | The URL must be `https://`, and must answer within 10 seconds.                                                                                                                                                                                           |

### The service won't start

Run `docker compose logs sync-service`. Configuration problems are reported in plain language, for example a missing `PUBLIC_BASE_URL`, a non-HTTPS public address, or a missing initial administrator password on an empty database. Fix `.env` and run `docker compose up -d --no-build`.

An error code such as `EADDRINUSE` means another program is using the port.

## Uncertain outcomes

The service never retries a write it isn't sure about. If a detail shows **Outcome unknown** (no answer from Jira) or **Not confirmed** (accepted but couldn't be read back):

1. Note the customer and the detail from the run page.
2. In Jira, open **Customers**, find that customer, and look at the detail.
3. Run a new preview.
   - If the detail no longer appears in Proposed changes, the write did take effect.
   - If it still appears, Jira didn't apply it; approve the new preview to try again.
4. If the same customer fails repeatedly, collect the information below and escalate.

## What to collect when escalating

- The **run number**, a screenshot of the run page, and the **Technical details** panel.
- The **request ID** from Jira, if shown. It's in the logs as `requestId`, and Atlassian support can trace it.
- Log lines from around the run: `docker compose logs --since 2h sync-service > sync-logs.txt`. These are safe to share, since logs contain no secrets, emails, or field values.
- The version (see [Check health](#check-health-and-the-running-version)).
- Never send `.env`, `deployment-secrets/`, `encryption.key`, `atlassian-oauth.json`, or database files.

## Where to find more

| Topic                                   | Document                                          |
| :-------------------------------------- | :------------------------------------------------ |
| Using the web interface                 | [User guide](user-guide.md)                       |
| First installation                      | [Setup](setup.md)                                 |
| HTTPS, reverse proxies, image tarballs  | [Production deployment](production-deployment.md) |
| From first preview to automatic updates | [Commissioning runbook](commissioning-runbook.md) |
| Backups and restore drills              | [Backup and restore](backup-and-restore.md)       |
| How it works inside                     | [Architecture](architecture.md)                   |
| Every `.env` setting                    | [`.env.example`](../.env.example)                 |
| Version history                         | [Changelog](../CHANGELOG.md)                      |
