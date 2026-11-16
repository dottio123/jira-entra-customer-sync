# User guide

This guide is for administrators who use the Customer Sync web interface day to day: running previews, approving updates, and keeping an eye on the service. For server tasks such as restarting, upgrading, renewing credentials, and fixing problems, see the [support guide](support-guide.md).

## What the service does

The service keeps five details on your **existing** Jira Service Management customers up to date from your company directory (Microsoft Entra ID):

| Shown as      | Jira customer field | Comes from the directory |
| :------------ | :------------------ | :----------------------- |
| Job title     | Title               | Job title                |
| Office phone  | Office Phone Number | First business phone     |
| Supervisor    | Supervisor          | Manager's display name   |
| Office / room | Office/Classroom    | Office location          |
| Email address | Email Address       | Mail (or sign-in name)   |

It always works the same way:

1. **Preview.** Reads the customers of your Jira service desk and finds each one in the directory by exact email address. Nothing changes in Jira.
2. **Review.** Shows every difference side by side.
3. **Apply.** After you approve, it writes only the differing details, one at a time, and reads each one back from Jira to confirm it.

Rules the service always follows:

- Customers are never added, invited, or deleted.
- An empty directory value never erases a value in Jira.
- A customer is updated only when exactly one active directory user has the same email address.
- Only customers whose email domain is on your **Approved email domains** list are included.
- Anything uncertain stops the update. Nothing uncertain is retried automatically.

## Signing in

- Open the service's address in a browser and sign in with your administrator user name and password.
- On first sign-in you must choose a new password of **at least 12 characters**.
- Sessions end after **30 minutes without activity** or **8 hours** in total. Pages that refresh themselves stop doing so after 30 minutes, so an unattended screen still signs out.
- After **5 sign-in attempts in 15 minutes**, further attempts are refused for a while. Wait and try again.
- To change your password, go to **Settings → Account & security → Change password**. Changing it signs out your other sessions.
- If the password is lost, the server administrator can reset it (see [Reset the administrator password](support-guide.md#reset-the-administrator-password)).

The sun/moon button in the top bar switches between light, dark, and system themes.

## The pages

| Page             | What it's for                                                                       |
| :--------------- | :---------------------------------------------------------------------------------- |
| **Overview**     | Current state at a glance, alerts, recent activity, and the **Run preview** button. |
| **Sync history** | Every preview and update, newest first. Also holds **Pause syncing**.               |
| **Schedule**     | When previews run automatically, the safety limits, and automatic updates.          |
| **Settings**     | Approved email domains, operating mode, pause, password, and notifications.         |
| **Connections**  | The state of the Jira and Microsoft Entra ID connections.                           |

### Overview

The large banner at the top tells you what needs attention. You'll see one of these:

- **Syncing is paused.** Nothing runs until you choose **Resume syncing**.
- **A sync is running now.** Use **View progress** to watch it.
- **No Jira service desk is configured.** This is a server setting; contact the server administrator.
- **No previews have run yet.** Choose **Run preview**.
- **_N_ customers have updates ready for review.** Choose **Review changes** to open the preview.
- **Latest changes have been applied.** Run a new preview to confirm everything is in sync.
- **Everything is in sync.** The last preview found no differences.

Below the banner are four cards:

- **Jira connection:** Connected, or Needs attention.
- **Updates to Jira:**
  - **Off:** previews only.
  - **On — needs approval:** updates are applied after you approve them.
  - **Automatic:** updates are applied on schedule.
  - **Paused**
- **Schedule:** the saved schedule in plain words.
- **Last preview:** when it ran and how many customers it checked.

## Running a preview

Choose **Run preview** on Overview or Sync history. A preview only reads Jira and the directory; it never changes anything. The button is unavailable while another run is in progress or syncing is paused.

The run page refreshes itself every few seconds while the preview runs.

### Reading a preview

The summary cards at the top:

- **Customers checked:** customers found in the Jira service desk.
- **Matched in directory:** customers matched to exactly one directory user.
- **Not included:** customers left alone. **See reasons** jumps to the list.
- **Customers with changes:** customers with at least one detail that differs from the directory.

**Proposed changes** lists each customer with the differing details:

- **Now in Jira:** the current value. **(empty)** means the field is blank.
- **New value from directory:** what will be written.

**Customers not included** explains each customer that was left alone. This is normal for customers outside your organization.

| Reason                         | Meaning                                                                 |
| :----------------------------- | :---------------------------------------------------------------------- |
| **Email domain not included**  | The email domain is not on the approved list in Settings.               |
| **No email in Jira**           | Jira did not return an email address, so the customer can't be matched. |
| **Not found in directory**     | No active directory user has this exact email address.                  |
| **Multiple directory matches** | More than one directory user has this email, so no update is made.      |
| **Inactive in Jira**           | The customer account is inactive in Jira.                               |

Disabled and guest directory accounts are not used for matching.

If a preview shows **No changes needed**, every matched customer already agrees with the directory.

## Approving and applying an update

The **Approve and apply** section of a completed preview shows the approval steps only when all of these are true:

1. The **Operating mode** is **Manual approval** or **Automatic** (Settings).
2. **Allow updates to Jira** is on (Settings).
3. Jira has granted permission to update customer details (Connections shows **Update permission** with a green check).
4. Syncing is not paused.

If something is missing, the section says what to change instead.

To apply:

1. Review the **Proposed changes**, then tick **I have reviewed these changes**.
2. Leave the **Approval code** as it is. It's filled in for you. This 64-character code identifies exactly this preview, and the update is refused if it doesn't match.
3. Choose **Apply _N_ changes**. You're taken to the new update run, which refreshes itself while it works.

Before writing to a customer, the service re-reads that customer from Jira and the directory. If anything changed since the preview ("drift"), the update stops safely instead of writing stale values.

**Each preview can be applied once.** After an update, even one that stopped early, run a new preview to apply anything that remains.

## Reading update results

An update run shows:

- **Customers attempted**
- **Details attempted**
- **Not confirmed**
- **Details updated:** values confirmed in Jira after writing.

**Applied updates** lists each customer with a result, and a result for each detail:

| Result              | Meaning                                                        | What to do                                                                                                                                                        |
| :------------------ | :------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Confirmed**       | Written and confirmed by reading it back from Jira.            | Nothing.                                                                                                                                                          |
| **Partly updated**  | Some details were confirmed before the update stopped.         | Read the note, fix the cause, then run a new preview.                                                                                                             |
| **Failed**          | Jira rejected the update, or the value read back didn't match. | Read the red message under the detail. For permission messages, see [Connections](#connections). Otherwise run a new preview and try again.                       |
| **Outcome unknown** | The request was sent but Jira didn't answer.                   | **Check this customer in Jira first.** Open the customer in Jira and look at the detail. Then run a new preview: it will show whether the change is still needed. |
| **Not confirmed**   | Jira accepted the update, but it couldn't be read back.        | Check the customer in Jira, then run a new preview.                                                                                                               |
| **Not attempted**   | The update stopped before this customer or detail was reached. | Run a new preview.                                                                                                                                                |

When an update stops early, a red box at the top reads **This run stopped safely before finishing** and gives the reason. Common reasons:

- **Drift detected…:** Jira or the directory changed after the preview. Run a new preview.
- **…lacks permission to update customer details:** see [Connections](#connections).
- **Approved email domain scope changed…:** the domain list changed after the preview. Run a new preview.
- **Threshold exceeded…:** the update was larger than the safety limits (see [Safety limits](#safety-limits)).

## Run statuses

| Status             | Meaning                                                               |
| :----------------- | :-------------------------------------------------------------------- |
| **Queued**         | Waiting to start.                                                     |
| **In progress**    | Working now.                                                          |
| **Completed**      | Finished without problems.                                            |
| **Stopped safely** | Stopped before finishing. Nothing uncertain was retried.              |
| **Paused**         | Held because syncing is paused or a safety limit was reached.         |
| **Interrupted**    | The service restarted while this run was active. It was not replayed. |

**Technical details** at the bottom of every run page shows the raw codes, service desks, times, and approval codes. Include it when asking for help.

## Pausing syncing

**Pause syncing** (on Sync history, or **Pause all syncing** in Settings) stops new previews and updates straight away, including scheduled ones. An update in progress stops at its next safe point, before its next write. A request already sent to Jira can't be recalled.

Choose **Resume syncing** to continue. A scheduled window that was missed while paused runs later that day if you resume before midnight (in the schedule's time zone).

## Schedule

The **Schedule** page sets when the service runs a preview automatically.

- **How often:** Every day, Weekdays (Mon–Fri), Once a week, Once a month (days 1–28), or Custom (advanced).
- **Time** and **Time zone:** for example `America/Chicago`. Daylight saving time is handled automatically.
- **Advanced: cron expression:** five fields: minute, hour, day of month, month, day of week. For example, `0 4 * * 1-5` means 04:00 on weekdays. Schedules more frequent than once a day aren't allowed.

The service runs once per scheduled window. If it was stopped at the scheduled time and starts again later the same day, it runs then. A window is never run twice.

### Safety limits

- **Maximum customers changed** (recommended 100)
- **Maximum details changed** (recommended 400)

An update larger than either limit is held as **Paused** before anything changes, and an alert is raised. Either review the preview and raise the limits temporarily, or narrow the scope. Then run a new preview and approve it.

### Automatic updates

**Apply updates automatically on schedule** is available only when the operating mode is **Automatic**. When it's on, each scheduled run previews and then applies the changes within the safety limits, without waiting for approval. When it's off, scheduled runs only preview.

## Settings

### Approved email domains

Only customers whose email address ends in one of these domains are synced. Enter one domain per line, for example `example.org`.

- Capitalization doesn't matter.
- Subdomains must be listed separately.
- An empty list blocks previews and updates.
- After changing the list, run a new preview before approving anything.

### Operating mode

| Mode                      | Meaning                                                                  |
| :------------------------ | :----------------------------------------------------------------------- |
| **Setup — previews only** | The service only checks for differences. Nothing can be changed in Jira. |
| **Manual approval**       | Changes are applied only after an administrator approves a preview.      |
| **Automatic**             | Changes may also be applied automatically at the scheduled time.         |

- **Automatic** becomes available after at least one manual update has confirmed a change in Jira.
- Choosing setup mode also turns off updates and automation.

**Allow updates to Jira** is the master switch. When it's off, nothing can be written to Jira, whatever the mode.

### Notifications

Alerts are always shown on the Overview page. You can also send them elsewhere. Alerts never include customer names, emails, or field values.

- **Webhook:** posts a JSON message to an `https://` address, such as a chat or monitoring tool.
- **Email:** fill in the following, then choose **Save notifications**.
  - **Mail server** and **Port**
  - **From address**
  - **Send alerts to:** separate several addresses with commas.
  - An optional **User name** and **Password**.

  Mail is always encrypted: port 465 uses TLS and other ports use STARTTLS. The password is stored encrypted and never shown again; leave it blank to keep the saved one.

Alerts are sent when:

- a preview or update finishes
- an update is held by a safety limit
- a run stops on an error
- a scheduled run can't start

### Alerts on Overview

Each alert shows its severity (Error, Warning, Info), its time, and a link to the run. Choose **Dismiss** once you've dealt with it. Dismissed alerts are kept in the audit history for a year.

## Connections

The **Jira Service Management** card lists these checks:

| Check                 | If it shows a warning                                                                                                                                         |
| :-------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **App configuration** | The Atlassian app details are missing on the server. Contact the server administrator.                                                                        |
| **Sign-in**           | Choose **Connect Jira**.                                                                                                                                      |
| **Permissions**       | Choose **Reconnect Jira** and accept all permissions.                                                                                                         |
| **Update permission** | "Not granted yet": choose **Reconnect Jira** and accept all permissions. "Read-only": updates are turned off on the server; contact the server administrator. |
| **Callback URL**      | The server's address settings don't match. Contact the server administrator.                                                                                  |
| **Service desks**     | No service desk is configured on the server. Contact the server administrator.                                                                                |

**Connect Jira** (or **Reconnect Jira**) opens the Atlassian sign-in in a new tab.

1. Sign in with the Atlassian account the service should act as.
2. Accept all permissions.
3. When the tab shows **Jira connected**, close it and reload Connections.

The connection is renewed automatically and kept across restarts. Use **Reconnect Jira** if any check turns yellow, or after the server administrator says the Atlassian app changed.

The **Microsoft Entra ID** card shows whether directory credentials are set on the server. Running a preview is the real test: if it reads the directory, the connection works.

## Getting help

When something looks wrong, collect the following before contacting support:

- the **run number** (for example, Update #31)
- a screenshot of the red message
- the **Technical details** panel

The [support guide](support-guide.md) lists known problems and their fixes.

## Glossary

| Term                         | Meaning                                                                                        |
| :--------------------------- | :--------------------------------------------------------------------------------------------- |
| **Preview**                  | A read-only comparison of Jira customers with the directory.                                   |
| **Update**                   | A run that writes the approved changes from one preview to Jira.                               |
| **Approval code**            | The 64-character fingerprint of a preview. An update only applies the preview it matches.      |
| **Drift**                    | Jira or the directory changed after the preview; the update stops instead of writing old data. |
| **Confirmed / verification** | After each write, the value is read back from Jira and compared.                               |
| **Safety limits**            | Maximum size of an update before it is held for review.                                        |
| **Approved email domains**   | The email domains whose customers are synced.                                                  |
| **Pause**                    | The emergency stop for all previews and updates.                                               |
