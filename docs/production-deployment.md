# Production deployment

The service is a single container that serves its own web interface on port 8080. In production, put it behind a reverse proxy that terminates HTTPS with a certificate from a trusted authority.

```
Browser ──HTTPS──► reverse proxy (TLS) ──HTTP──► 127.0.0.1:8080 ──► sync-service container
```

## 1. Configure `.env`

| Variable                     | Production value                     | Notes                                                           |
| :--------------------------- | :----------------------------------- | :-------------------------------------------------------------- |
| `PUBLIC_BASE_URL`            | `https://sync.example.com`           | The exact address users open. Must be `https://`, with no path. |
| `WEB_BIND_IP`                | `127.0.0.1`                          | Publish only on loopback when the proxy runs on the same host.  |
| `WEB_BIND_PORT`              | `8080`                               | Host port the proxy forwards to.                                |
| `WEB_TRUST_PROXY`            | `127.0.0.1` (or the proxy's IP/CIDR) | Trust `X-Forwarded-*` headers only from your proxy.             |
| `ALLOW_INSECURE_REMOTE_HTTP` | unset                                | Testing only. Never enable in production.                       |

With an `https://` address the service automatically uses `__Host-` prefixed `Secure` cookies and sends `Strict-Transport-Security`.

The default `WEB_BIND_IP=0.0.0.0` publishes the port on every host interface. That is convenient for a first test, but in production restrict it to `127.0.0.1` behind a proxy, or firewall the port.

## 2. Register the Jira callback

In the [Atlassian developer console](https://developer.atlassian.com/console/myapps/), set the app's callback URL to exactly:

```
https://sync.example.com/auth/atlassian/callback
```

Then open **Connections** in the service and choose **Connect Jira**. The page shows the callback URL it expects and warns if the configuration does not match.

## 3. Reverse proxy examples

Forward to `127.0.0.1`, not `localhost`. On many systems `localhost` resolves to IPv6 `::1` first, which Docker's IPv4 port mapping does not answer, producing a 502 error.

### Nginx

```nginx
server {
    listen 80;
    server_name sync.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name sync.example.com;

    ssl_certificate     /etc/letsencrypt/live/sync.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/sync.example.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
    }
}
```

### Caddy

```caddy
sync.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

### Cloud load balancer

Terminate HTTPS on the load balancer, forward to container port 8080, use `/health/ready` as the health check, and set `WEB_TRUST_PROXY` to the load balancer's subnet.

## 4. Testing on a local network without HTTPS

For a short test from another device on your network:

```env
PUBLIC_BASE_URL=http://192.168.1.50:8080
WEB_BIND_IP=0.0.0.0
ALLOW_INSECURE_REMOTE_HTTP=true
```

Replace the address with your host's LAN IP, and register `http://192.168.1.50:8080/auth/atlassian/callback` in Atlassian for the test. The service logs a warning while this mode is on. Remove it before production use.

Always open the exact `PUBLIC_BASE_URL`. Other host names are redirected to it, so that sign-in cookies and the Jira callback use one address. `localhost` and `127.0.0.1` on any port are always accepted for local administration.

## Deploying without a registry (image tarball)

`compose.yaml` builds and runs the image `entra-jsm-customer-sync:latest`. Always export and load that exact name, and copy the same `compose.yaml` to the server so both sides agree.

On the build machine:

```bash
docker compose build
docker run --rm --entrypoint node entra-jsm-customer-sync:latest -e "console.log(require('/app/package.json').version)"
docker save entra-jsm-customer-sync:latest -o entra-jsm-customer-sync.tar
```

On the server (next to its `.env`, `compose.yaml`, `deployment-secrets/`, and `branding/`):

```bash
docker load -i entra-jsm-customer-sync.tar
docker compose up -d --no-build
docker compose exec sync-service node -e "console.log(require('/app/package.json').version)"
```

The startup log line `web server listening` also reports the running version. If the version is older than expected, the tarball was exported from a different tag: `docker images` lists each tag with its build time.

## 5. Verify the deployment

1. `curl -f https://sync.example.com/health/live` returns `{"status":"alive"}`.
2. `curl -f https://sync.example.com/health/ready` returns `{"status":"ready"}`.
3. Plain HTTP redirects to HTTPS (configured in the proxy).
4. Sign in; the session cookie is `__Host-sync_session` with `Secure; HttpOnly; SameSite=Lax`.
5. **Connections** shows Jira as **Authorized** with no callback warning.

Then follow the [commissioning runbook](commissioning-runbook.md).

## Troubleshooting

| Symptom                           | Likely cause and fix                                                                                      |
| :-------------------------------- | :-------------------------------------------------------------------------------------------------------- |
| 502 Bad Gateway                   | Proxy port differs from `WEB_BIND_PORT`, or the proxy targets `localhost`. Use `127.0.0.1:<port>`.        |
| Redirected to a different address | You opened an address other than `PUBLIC_BASE_URL`. Open the configured address.                          |
| Service exits at start            | Read `docker compose logs sync-service`; configuration problems are reported in plain language.           |
| Too many sign-in attempts         | Five attempts per 15 minutes per client. Behind a proxy, set `WEB_TRUST_PROXY` so clients are told apart. |
| Connect Jira is disabled          | `ATLASSIAN_OAUTH_REDIRECT_URI` is set and does not equal `<PUBLIC_BASE_URL>/auth/atlassian/callback`.     |

More symptoms, including Jira permission and update problems, are covered in the [support guide](support-guide.md#troubleshooting).
