# Backup and restore

## What to back up

| Item           | Container path                             | Volume                                  | Contents                                                   |
| :------------- | :----------------------------------------- | :-------------------------------------- | :--------------------------------------------------------- |
| Database       | `/app/data/web.sqlite`                     | `jira-entra-customer-sync_sync_data`    | Run history, settings, accounts, audit log, alerts         |
| Encryption key | `/app/secrets/encryption.key`              | `jira-entra-customer-sync_sync_secrets` | AES-256-GCM key for customer details and the SMTP password |
| Jira sign-in   | `/app/secrets/atlassian-oauth.json`        | `jira-entra-customer-sync_sync_secrets` | Rotating Atlassian OAuth tokens                            |
| Configuration  | `.env`, `deployment-secrets/`, `branding/` | host files                              | Environment settings, secret files, logo                   |

> **Back up the database and the encryption key together.** Without the key, stored customer details cannot be decrypted. Keep backups as protected as the live secrets.

All commands below run from the folder that contains `compose.yaml`. `docker compose` always resolves the right container and volumes, whatever the folder is called.

## Back up (Linux/macOS shell)

The database is copied with SQLite's online backup, so the service can keep running.

```bash
set -euo pipefail
BACKUP_DIR="./backups/$(date +%Y%m%d_%H%M%S)"
mkdir -p "$BACKUP_DIR"

# 1. Consistent online copy of the database into the reports volume
docker compose exec -T sync-service node -e '
  const Database = require("better-sqlite3");
  const db = new Database("/app/data/web.sqlite");
  db.backup("/app/reports/backup.sqlite").then(() => { db.close(); console.log("Database backup complete"); });
'

# 2. Copy the database, key, and tokens to the host
docker compose cp sync-service:/app/reports/backup.sqlite "$BACKUP_DIR/web.sqlite"
docker compose cp sync-service:/app/secrets/encryption.key "$BACKUP_DIR/encryption.key"
docker compose cp sync-service:/app/secrets/atlassian-oauth.json "$BACKUP_DIR/atlassian-oauth.json" || true
docker compose exec -T sync-service rm -f /app/reports/backup.sqlite

# 3. Protect and fingerprint the backup
chmod 600 "$BACKUP_DIR"/*
(cd "$BACKUP_DIR" && sha256sum * > checksums.sha256)
```

The Jira sign-in file is absent until Jira has been connected; the `|| true` keeps the backup going in that case. Copy `.env` and `deployment-secrets/` separately as part of your normal configuration backup.

## Restore

1. Check the backup:

   ```bash
   cd "$BACKUP_DIR" && sha256sum -c checksums.sha256 && cd -
   ```

2. Stop the service:

   ```bash
   docker compose stop sync-service
   ```

3. Copy the files into the service's volumes using a one-off container that mounts them (`--no-deps` starts nothing else; `--user root` allows setting ownership):

   ```bash
   docker compose run --rm --no-deps --user root --entrypoint sh \
     -v "$(pwd)/$BACKUP_DIR":/backup:ro sync-service -c '
       cp /backup/web.sqlite /app/data/web.sqlite &&
       rm -f /app/data/web.sqlite-wal /app/data/web.sqlite-shm &&
       cp /backup/encryption.key /app/secrets/encryption.key &&
       if [ -f /backup/atlassian-oauth.json ]; then cp /backup/atlassian-oauth.json /app/secrets/; fi &&
       chown -R node:node /app/data /app/secrets &&
       chmod 600 /app/data/web.sqlite /app/secrets/*'
   ```

4. Start the service and check it:

   ```bash
   docker compose up -d sync-service
   docker compose exec -T sync-service node -e '
     const Database = require("better-sqlite3");
     const db = new Database("/app/data/web.sqlite");
     console.log("Integrity:", db.prepare("PRAGMA integrity_check").pluck().get());
   '
   ```

   Expect `Integrity: ok`. Then sign in, open a recent run, and confirm its customer details display (this proves the key matches the database).

Runs that were in progress when the backup was taken are marked **Interrupted** on start and are never replayed. If the Jira sign-in in the backup has expired or been revoked, choose **Connect Jira** again.

## Test a backup without touching production

Restore into a separate project name so the volumes are separate, for example `docker compose -p sync-restore-test ...` with a copy of `.env` whose `PUBLIC_BASE_URL` uses another port. Keep **Allow updates to Jira** off in the test copy.

## Windows (PowerShell)

The same commands work in PowerShell with these changes: build the folder name with `$BACKUP_DIR = "backups\$(Get-Date -Format yyyyMMdd_HHmmss)"`, use `Get-FileHash` instead of `sha256sum`, skip `chmod`, and replace `"$(pwd)/$BACKUP_DIR"` with `"${PWD}\$BACKUP_DIR"`.
