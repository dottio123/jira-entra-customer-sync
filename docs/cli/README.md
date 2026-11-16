# CLI diagnostics

The command-line tools predate the web interface. They are useful for checking connectivity and data shape step by step, and for audits. **Day-to-day operation uses the web interface**; nothing here is needed for a normal deployment, and no web route can reach these code paths.

All CLI settings are read from `.env` (section 7 of `.env.example`). Every default is read-only (`SYNC_DRY_RUN=true`, all write flags `false`).

## Commands

| Command                       | What it does                                                                                 |
| :---------------------------- | :------------------------------------------------------------------------------------------- |
| `npm run cli:dev`             | Runs the CLI from source (`npm run cli` runs the compiled build)                             |
| `npm run oauth:login`         | Interactive Atlassian sign-in through a loopback callback (`http://127.0.0.1:8080/callback`) |
| `npm run oauth:status`        | Prints token presence, expiry, and granted scopes as JSON (no secrets)                       |
| `npm run cli:compare-reports` | Compares two dry-run JSON reports: `npm run cli:compare-reports -- a.json b.json`            |

The CLI loopback callback differs from the web callback. Register both in the Atlassian app if you use both, and set `ATLASSIAN_OAUTH_REDIRECT_URI` for the CLI only while you use it (the web app disables **Connect Jira** when that value differs from its own callback).

## Read-only validation stages

Run stage by stage and stop at the first failure. The examples use PowerShell; in a POSIX shell use `VAR=value npm run cli:dev`.

### 1. Token status

```powershell
npm run oauth:status
```

### 2. Customer enumeration (one service desk)

```powershell
$env:CUSTOMER_TARGET="jira-readonly"; $env:JSM_API_AUTH_MODE="oauth-3lo"; `
$env:JIRA_VALIDATE_CUSTOMER_ENUMERATION="true"; npm run cli:dev
```

### 3. Field discovery

```powershell
$env:CUSTOMER_TARGET="jira-readonly"; $env:JSM_API_AUTH_MODE="oauth-3lo"; `
$env:DISCOVERY_ONLY="true"; npm run cli:dev
```

### 4. One existing customer

```powershell
$env:CUSTOMER_TARGET="jira-readonly"; $env:JSM_API_AUTH_MODE="oauth-3lo"; `
$env:JIRA_VALIDATE_EXISTING_CUSTOMER="true"; $env:JIRA_TEST_CUSTOMER_EMAIL="user@example.com"; `
npm run cli:dev
```

### 5. Jira-first end-to-end dry run

```powershell
$env:DIRECTORY_SOURCE="entra"; $env:CUSTOMER_TARGET="jira-readonly"; $env:JSM_API_AUTH_MODE="oauth-3lo"; `
$env:SYNC_SCOPE_SOURCE="jira"; $env:CUSTOMER_ENUMERATION_VALIDATED="true"; `
$env:END_TO_END_DRY_RUN="true"; $env:END_TO_END_MAX_RECORDS="10"; npm run cli:dev
```

More than 25 records requires `FULL_DIRECTORY_DRY_RUN_ACKNOWLEDGED=true`. Reports can be written under `reports/` with `DRY_RUN_REPORT_PATH`.

## Legacy write paths

Two tightly bounded write paths remain for controlled diagnostics. Both require `JIRA_WRITE_SCOPE_ALLOWED=true`, explicit confirmation phrases, and an approved report. Read the runbooks before use:

- [Single-customer write pilot](pilot-write-runbook.md)
- [Bounded rollout](bounded-rollout-runbook.md)
