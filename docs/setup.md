# Setup

This guide covers a first installation with Docker Compose. For HTTPS and reverse proxies see [production deployment](production-deployment.md); for the step-by-step path to automatic updates see the [commissioning runbook](commissioning-runbook.md).

## Prerequisites

- Docker Engine with Compose v2 (`docker compose version`).
- A Microsoft Entra ID **app registration** with the Microsoft Graph _application_ permission **User.Read.All**, admin consent granted, and a client secret.
- An Atlassian **OAuth 2.0 (3LO)** app in the [developer console](https://developer.atlassian.com/console/myapps/) with these Jira Service Management permissions:
  - `read:servicedesk.customer:jira-service-management`
  - `read:customer.detail-field:jira-service-management`
  - `read:customer.profile:jira-service-management`
  - `read:user:jira`
  - `write:customer.detail:jira-service-management` (needed only to apply updates)
- The ID of the Jira service desk whose customers should be kept in sync. It appears in the portal URL (`.../servicedesk/customer/portal/<id>`) or through the service desk API.
- In Jira, five customer detail fields named **Title**, **Office Phone Number**, **Supervisor**, **Office/Classroom**, and **Email Address**. Common alternatives such as _Job Title_, _Office Phone_, _Manager_, _Office Location_, and _Email_ are also recognized.

## 1. Configure

```bash
cp .env.example .env
```

Fill in sections 1 to 4 of `.env`. The comments explain every value. The important ones:

- `PUBLIC_BASE_URL`: the address you will open in the browser.
- `MICROSOFT_TENANT_ID`, `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`
- `ATLASSIAN_OAUTH_CLIENT_ID`, `ATLASSIAN_OAUTH_CLIENT_SECRET`
- `JSM_SERVICE_DESK_IDS`
- `JIRA_WRITE_SCOPE_ALLOWED=true` once you intend to apply updates. The write permission is then requested automatically. If Jira was already connected, choose **Reconnect Jira** under Connections afterwards so the permission is granted; Connections shows **Update permission** once it is.

In the Atlassian app, set the callback URL to `<PUBLIC_BASE_URL>/auth/atlassian/callback`.

## 2. Create the first administrator password

```bash
mkdir -p deployment-secrets
printf '%s' 'choose-a-long-unique-passphrase' > deployment-secrets/admin_initial_password
chmod 600 deployment-secrets/admin_initial_password
```

The password must be at least 12 characters. It is used only when the database has no accounts yet, and you must change it at first sign-in. Afterwards you can delete the file.

Secrets can also be provided as files in `deployment-secrets/` (mounted at `/run/secrets`), for example `ATLASSIAN_OAUTH_CLIENT_SECRET_FILE=/run/secrets/atlassian_client_secret`.

## 3. Start

```bash
docker compose up -d --build
docker compose logs -f sync-service
```

Open `PUBLIC_BASE_URL`, sign in as `ADMIN_USERNAME`, and choose a new password.

## 4. Connect and configure

1. **Connections**: choose **Connect Jira** and accept the permissions. Check that Microsoft Entra ID shows **Configured** and the service desk is listed.
2. **Settings → Approved email domains**: list the email domains of the customers to keep in sync, one per line. Customers with other domains are left untouched. An empty list blocks previews.
3. **Settings → Notifications** (optional): add a webhook (HTTPS) and/or email alerts. Email always uses TLS; port 465 uses implicit TLS and other ports use STARTTLS. A user name and password are optional.
4. **Schedule**: choose when previews run and set your time zone (new installations default to UTC).

Then run your first preview from **Overview** and follow the [commissioning runbook](commissioning-runbook.md).

## Branding

Set `APP_DISPLAY_NAME`. For a logo, place an SVG, PNG, or WebP file (1 MB maximum) in `branding/` and set `APP_LOGO_FILE=/app/branding/<file>`.

## Upgrading

```bash
docker compose pull   # if you use a registry image
docker compose up -d --build
```

Settings, history, and the Jira connection live in Docker volumes and are kept across upgrades. The database schema is migrated automatically on start. Take a [backup](backup-and-restore.md) before upgrading.

## Local development without Docker

```bash
npm install
cp .env.example .env    # set ADMIN_INITIAL_PASSWORD instead of the _FILE variant
npm run web:dev         # http://127.0.0.1:8080
npm run check           # format, lint, type-check, tests, build
```

Data is stored in `./data` and `./secrets` (both git-ignored).

## Sign-in troubleshooting

- Open the exact `PUBLIC_BASE_URL`. Other addresses redirect there so cookies and the Jira callback use one origin.
- After five failed attempts within 15 minutes, sign-in is paused for that client; wait and try again.
- If a form says it has expired, reload the page.
- `docker compose logs sync-service` shows sanitized reasons. Logs never contain passwords, cookies, or tokens.
- A forgotten administrator password can be reset on the server: see [Reset the administrator password](support-guide.md#reset-the-administrator-password).

For everything else, see the [support guide](support-guide.md#troubleshooting).
