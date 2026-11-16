# Entra to Jira Customer Sync

Keeps the contact details of your **Jira Service Management customers** up to date from **Microsoft Entra ID**, with a preview of every change, administrator approval, and a confirmed read-back of each value written.

| Jira customer field | Comes from Entra ID    |
| :------------------ | :--------------------- |
| Title               | Job title              |
| Office Phone Number | First business phone   |
| Supervisor          | Manager's display name |
| Office/Classroom    | Office location        |
| Email Address       | Mail (or sign-in name) |

## What it guarantees

- **Existing customers only.** It reads the customers of the Jira service desks you choose and never creates, invites, or deletes anyone.
- **Exact matching.** Each customer is matched to exactly one directory user by email address. Ambiguous or missing matches are skipped and listed.
- **Never erases.** An empty directory value never replaces a populated Jira value.
- **Nothing changes without a preview.** Updates are bound to a reviewed preview by an approval code and stop if anything changed since.
- **Verified writes.** Values are written one at a time and read back from Jira; anything uncertain stops the run and is never retried automatically.
- **Guard rails.** Approved email domains, safety limits, an emergency pause, a single active run at a time, and full run history with an audit log.
- **Private by design.** Customer details are encrypted at rest. Logs and alerts contain counts and references, never names, emails, field values, or credentials.

## How it works

```
 Preview ──► Review ──► Approve ──► Update ──► Verify
 (read-only)  side-by-side  approval    one field      read back
              differences   code        at a time      from Jira
```

The service runs one preview per scheduled window. In **Manual approval** mode an administrator approves each update; in **Automatic** mode, available after a successful manual update, scheduled runs also apply changes within the safety limits.

## Quick start

You need Docker with Compose v2, an Entra app registration with the Graph **User.Read.All** application permission, and an Atlassian OAuth 2.0 (3LO) app. [docs/setup.md](docs/setup.md) lists the exact permissions.

```bash
cp .env.example .env                       # 1. fill in sections 1–4
mkdir -p deployment-secrets                # 2. first administrator password (12+ characters)
printf '%s' 'a-long-unique-passphrase' > deployment-secrets/admin_initial_password
docker compose up -d --build               # 3. start
```

4. Open `PUBLIC_BASE_URL`, sign in as `admin`, and choose a new password.
5. **Connections → Connect Jira**, then **Settings → Approved email domains**.
6. **Overview → Run preview**, review the result, and follow the [commissioning runbook](docs/commissioning-runbook.md).

For a public deployment, put the service behind an HTTPS reverse proxy: see [docs/production-deployment.md](docs/production-deployment.md).

## Configuration

Everything is configured through `.env`. [.env.example](.env.example) documents each setting, in this order:

1. **Web access:** `PUBLIC_BASE_URL`, bind address and port, proxy trust, log level.
2. **Administrator:** the first account and its initial password.
3. **Microsoft Entra ID:** tenant, client ID, and secret.
4. **Atlassian Jira:** OAuth app, service desk IDs, and permission for the write scope.
5. **Branding:** display name and logo.

Runtime settings (approved domains, operating mode, schedule and time zone, safety limits, pause, notifications) are managed in the web interface and stored in the database.

## Operations

| Task               | Where                                                                  |
| :----------------- | :--------------------------------------------------------------------- |
| Health checks      | `GET /health/live` (process), `GET /health/ready` (database)           |
| Logs               | `docker compose logs sync-service` (structured JSON, sanitized)        |
| Alerts             | Overview page, plus optional webhook and email (TLS, optional sign-in) |
| Backup and restore | [docs/backup-and-restore.md](docs/backup-and-restore.md)               |
| Stop safely        | `docker compose stop`: in-flight runs stop at the next safe point      |
| Upgrade            | `docker compose up -d --build`; schema migrations run automatically    |

## Getting help

- **Using the web interface:** the [user guide](docs/user-guide.md) explains every page, status, and message.
- **Running and fixing the service:** the [support guide](docs/support-guide.md) covers health checks, upgrades, credential renewal, password reset, and troubleshooting by symptom.
- **When reporting a problem:** include the run number, the run page's **Technical details**, and recent `docker compose logs sync-service` output. Logs contain no secrets or customer data.

## Documentation

The full index is in [docs/README.md](docs/README.md).

- [User guide](docs/user-guide.md): day-to-day use, for administrators
- [Support guide](docs/support-guide.md): operations and troubleshooting, for IT
- [Setup](docs/setup.md): prerequisites, first start, upgrading, local development
- [Production deployment](docs/production-deployment.md): HTTPS, reverse proxies, troubleshooting
- [Commissioning runbook](docs/commissioning-runbook.md): from first preview to automatic updates
- [Backup and restore](docs/backup-and-restore.md)
- [Architecture](docs/architecture.md): data flow, safety mechanisms, code layout
- [CLI diagnostics](docs/cli/README.md): optional command-line validation tools
- [Changelog](CHANGELOG.md)

## Development

```bash
npm install
npm run web:dev     # web interface from source on http://127.0.0.1:8080
npm run check       # format, lint, type-check (source and tests), tests, build
```

| Script                 | Purpose                                      |
| :--------------------- | :------------------------------------------- |
| `npm start`            | Run the compiled web service                 |
| `npm run web:dev`      | Run the web service from source              |
| `npm run build`        | Compile TypeScript to `dist/`                |
| `npm test`             | Run the test suite                           |
| `npm run check`        | Full verification pipeline                   |
| `npm run cli:dev`      | CLI diagnostics ([docs](docs/cli/README.md)) |
| `npm run oauth:status` | Inspect the CLI's stored Jira token          |

Requires Node.js 22 or newer.

## Known limitations

- The five synchronized fields and their Entra sources are fixed.
- Only local administrator accounts are supported; single sign-on is not yet available.
- Dates and numbers are shown in US English format.
