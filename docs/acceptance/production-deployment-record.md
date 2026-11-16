# Production deployment record

> **Deployment-specific.** This record describes one installation of the service. It is kept here, outside the generic product documentation, to support that installation. Keep it current whenever the deployment changes. It must never contain secrets: no passwords, client secrets, tokens, or keys.
>
> Items marked _To be filled in_ were not known when this record was written.

## Summary

| Item              | Value                                                  |
| :---------------- | :----------------------------------------------------- |
| Version           | 1.0.0                                                  |
| In production     | Since 2026-10-02                                       |
| Public address    | `https://sync.example.org`                             |
| Reverse proxy     | OpenResty, terminating HTTPS in front of the container |
| Service owner     | _To be filled in_                                      |
| Technical contact | _To be filled in_                                      |

## Production host

| Item              | Value                                                                                                                          |
| :---------------- | :----------------------------------------------------------------------------------------------------------------------------- |
| Host name / OS    | _To be filled in_                                                                                                              |
| Deployment folder | _To be filled in_ (holds `compose.yaml`, `.env`, `deployment-secrets/`, `branding/`)                                           |
| Compose project   | `jira-entra-customer-sync` (fixed by `name:` in `compose.yaml`)                                                                |
| Volumes           | `jira-entra-customer-sync_sync_data`, `_sync_secrets`, `_sync_reports`                                                         |
| Image             | `entra-jsm-customer-sync:latest`                                                                                               |
| How images arrive | Built on the build machine, exported as a tarball (`je-sync_v1.tar`), then `docker load` and `docker compose up -d --no-build` |
| Proxy upstream    | _To be filled in_ (host and port that OpenResty forwards to)                                                                   |
| `WEB_TRUST_PROXY` | _To be filled in_                                                                                                              |
| Backup schedule   | _To be filled in_                                                                                                              |
| Backup location   | _To be filled in_                                                                                                              |

The Atlassian app's callback URL is `https://sync.example.org/auth/atlassian/callback`. It must stay identical to `PUBLIC_BASE_URL` + `/auth/atlassian/callback`.

## Test instance

A separate instance runs on the build machine for testing.

| Item                     | Value                                                                                                              |
| :----------------------- | :----------------------------------------------------------------------------------------------------------------- |
| Address                  | `http://192.168.1.50:8080`: plain HTTP on the LAN, with `ALLOW_INSECURE_REMOTE_HTTP=true`                          |
| Compose project, volumes | Same names as production, on a different host                                                                      |
| Operating mode           | Manual approval; **Allow updates to Jira** off unless testing an update                                            |
| Schedule                 | `0 4 * * 1-5`, `America/New_York` (04:00 on weekdays)                                                              |
| Pre-1.0.0 backup         | `backups/pre-1.0.0-20261002_155138/` in the project folder on the build machine                                    |
| Reference preview        | Run #24 after the upgrade to 1.0.0: 208 customers, 128 matched, 80 not included. Identical to the last 0.x preview |

## Configuration notes

- **`JIRA_SITE_URL` is a custom domain**, not `*.atlassian.net`. The web service never uses it to choose a Jira site: the connection has a single site and its cloud ID is taken from the token. Don't set `ATLASSIAN_SITE_URL` to the custom domain, because site matching would fail closed.
- **Legacy names:** `.env` uses the legacy name `PILOT_WRITE_SCOPE_ALLOWED=true`. It still works and logs a deprecation warning at start. Rename it to `JIRA_WRITE_SCOPE_ALLOWED=true` at the next configuration change.
- **Production settings at launch:**
  - Production operating mode: _To be filled in_
  - Schedule: _To be filled in_
  - Approved domains: _To be filled in_ (number only)

## Credential expiry

| Credential                    | Expires           | Renewal procedure                                                            |
| :---------------------------- | :---------------- | :--------------------------------------------------------------------------- |
| Microsoft Entra client secret | _To be filled in_ | [Support guide](../support-guide.md#renew-the-microsoft-entra-client-secret) |
| Atlassian OAuth client secret | _To be filled in_ | [Support guide](../support-guide.md#renew-the-atlassian-client-secret)       |
| TLS certificate (OpenResty)   | _To be filled in_ | Managed by the proxy                                                         |

## Launch history

| Date       | Event                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| :--------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-10-02 | Upgraded the test instance from 0.x to 1.0.0 in place. Settings, history, the admin account, and the Jira connection were all kept. A live read-only preview matched the pre-upgrade result.                                                                                                                                                                                                                                                                  |
| 2026-10-02 | First production deployment. Three issues were found and fixed:<br>1. The tarball had been exported from an outdated image, so production ran an old version.<br>2. **Connect Jira** left a blank page during Atlassian single sign-on; it is now a plain link.<br>3. The first update failed with Jira status 401 because the Jira sign-in lacked the write permission. The permission is now requested automatically, and reconnecting Jira grants it. |
| 2026-10-02 | 1.0.0 accepted in production.                                                                                                                                                                                                                                                                                                                                                                                                                                 |

## Open items

1. Explicit administrator sign-off before switching to **Automatic**.
2. A controlled stop-during-update drill against production Jira. Recovery is covered by automated tests, but has not been exercised live.
3. Fill in the _To be filled in_ items above.
