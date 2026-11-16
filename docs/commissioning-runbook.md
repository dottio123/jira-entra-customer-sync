# Commissioning runbook

This runbook takes a new installation from first sign-in to (optionally) unattended automatic updates. Every step can be stopped or reversed; nothing is written to Jira until you explicitly allow it.

## Operating modes

```
Setup — previews only  ──►  Manual approval  ──►  Automatic
  (UNCOMMISSIONED)        (COMMISSIONED_MANUAL_ONLY)   (COMMISSIONED_AUTOMATED)
```

| Mode                  | Previews | Updates to Jira                                    |
| :-------------------- | :------- | :------------------------------------------------- |
| Setup — previews only | Yes      | Never                                              |
| Manual approval       | Yes      | Only after an administrator approves a preview     |
| Automatic             | Yes      | Also applied by the schedule, within safety limits |

**Allow updates to Jira** is a separate master switch. When it is off, nothing is written in any mode. Automatic mode is available only after at least one manual update has completed and been confirmed in Jira.

## Safety guarantees

- Only **existing** customers in the configured Jira service desks are updated. Customers are never created, invited, or deleted.
- Customers are matched to the directory by exact email address. Ambiguous or missing matches are skipped and listed.
- Empty or unavailable directory values never erase a populated Jira value.
- Every update is bound to a specific preview by a 64-character approval code. If Jira or the directory changed since that preview, the update stops before writing.
- Changes are written one field at a time, paced, and each is read back from Jira to confirm it. Anything uncertain stops the run; nothing uncertain is retried.
- Updates larger than the safety limits (default 100 customers / 400 details) are held for review.
- Only one run can be active at a time. A run interrupted by a restart is marked **Interrupted** and never replayed.

## 1. Before you start

- [ ] The service is reachable at `PUBLIC_BASE_URL` over HTTPS (see [production deployment](production-deployment.md)).
- [ ] You have signed in and changed the initial administrator password.
- [ ] **Connections** shows Jira as **Authorized** with all permissions granted, and Microsoft Entra ID as **Configured**.
- [ ] **Settings → Approved email domains** lists your organization's domains.
- [ ] **Settings → Notifications** is configured if you want alerts by webhook or email.

## 2. Run and review a preview

1. On **Overview**, choose **Run preview**. Nothing is changed in Jira.
2. When the run completes, open it from **Sync history**.
3. Review **Proposed changes** (current Jira value next to the new directory value) and **Customers not included** (with reasons).
4. If anything looks wrong, fix the directory or settings and run a new preview.

## 3. Apply a first manual update

1. In **Settings → Operating mode**, choose **Manual approval**, turn on **Allow updates to Jira**, and save.
2. If the preview exceeds the safety limits, raise them on the **Schedule** page for this run. Never narrow the scope to get under a limit.
3. Open the preview, tick **I have reviewed these changes**, confirm the approval code, and choose **Apply**.
4. Follow progress on the run page. When it completes, check that **Details updated** matches the number of proposed details.
5. Spot-check a few customers in Jira, then run a new preview and confirm it finds no changes.
6. Restore the safety limits if you raised them. Turn **Allow updates to Jira** off again until the next approved update, if you prefer.

## 4. Schedule

On the **Schedule** page choose when previews run (daily, weekdays, weekly, or monthly, once per window) and the time zone. Until the service is in Automatic mode, scheduled runs only preview.

Confirm at least one scheduled preview completes on its own before moving on.

## 5. Optional: automatic updates

1. In **Settings → Operating mode**, choose **Automatic** and make sure **Allow updates to Jira** is on.
2. On the **Schedule** page, turn on **Apply updates automatically on schedule**.
3. Scheduled runs now preview and then apply changes, still guarded by drift checks, safety limits, pacing, and read-back verification. Anything held or stopped raises an alert.

To return to manual operation, choose **Manual approval** (this also turns automatic updates off).

## Emergency controls

- **Pause syncing** (Sync history or Settings) immediately stops new previews and updates, and stops a running update before its next write. A request already sent to Jira cannot be recalled, and confirmed changes are not rolled back.
- **Drift detected**: run a new preview, review it, and approve the new approval code.
- **Outcome unknown** on a field: Jira did not answer a write. Check that customer in Jira before approving another update.
- **Interrupted**: the service stopped during a run. Run a new preview; interrupted runs are never replayed.

## Acceptance checklist for a new production deployment

| Check    | How                                      | Expected                                                                     |
| :------- | :--------------------------------------- | :--------------------------------------------------------------------------- |
| HTTPS    | Open `PUBLIC_BASE_URL`                   | Valid certificate, no browser warnings, `Strict-Transport-Security` sent     |
| Cookies  | Browser developer tools                  | `__Host-sync_session` with `Secure; HttpOnly; SameSite=Lax; Path=/`          |
| Sign-in  | Sign in                                  | Redirects to **Overview** (or password change on first sign-in)              |
| Jira     | **Connections**                          | Authorized; callback URL matches `<PUBLIC_BASE_URL>/auth/atlassian/callback` |
| Preview  | **Run preview**                          | Completes; full scope enumerated; approval code shown                        |
| Schedule | Wait for the scheduled time              | A **Scheduled** preview completes                                            |
| Health   | `curl -f <PUBLIC_BASE_URL>/health/ready` | `{"status":"ready"}`                                                         |
