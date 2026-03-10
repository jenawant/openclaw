## Fork ops (localAuth) + cloud deployment

If you maintain a fork with local-auth/user-management extensions and regularly sync with `openclaw/openclaw`, use this runbook.

### 1) Keep your fork synced with upstream

```bash
# one-time
git remote add upstream https://github.com/openclaw/openclaw.git

# recurring (weekly/bi-weekly recommended)
git fetch upstream
git checkout main
git rebase upstream/main

# run minimal regression for your fork changes
pnpm test -- src/gateway/control-ui-auth.test.ts src/gateway/user-authz.test.ts

git push --force-with-lease origin main
```

Tip: keep auth changes concentrated in thin integration points (`server-http`, WS connect handler, gateway method authz hook) plus independent modules to reduce rebase conflicts.

### 2) Production bootstrap (server)

Runtime baseline: **Node 22+**.

```bash
git clone https://github.com/jenawant/openclaw.git
cd openclaw
pnpm install
pnpm build
```

Prepare config once (or import existing config):

```bash
openclaw setup
openclaw config set gateway.mode local
openclaw config set gateway.bind loopback
```

### 3) Use `.env` + `deploy.sh` for one-click deploy (recommended)

All deploy/runtime variables are centralized in repo root `.env.example` and `.env`.
This includes localAuth seed vars and Web UI branding vars:

- `OPENCLAW_LOCALAUTH_*`
- `OPENCLAW_BRAND_TITLE`
- `OPENCLAW_BRAND_SUB`
- `OPENCLAW_GATEWAY_*`
- `OPENCLAW_NGINX_*`

Usage:

```bash
cp .env.example .env
# edit .env with your server/domain/secrets

./deploy.sh
```

`deploy.sh` will:

1. install deps + build
2. enforce baseline gateway config (`gateway.mode=local`, `gateway.bind`, `localAuth.enabled`)
3. write `/etc/openclaw/<service>.env`
4. write and restart `systemd` service
5. optionally write/reload nginx config when `OPENCLAW_NGINX_ENABLE=1`
6. run health checks (`/health`, `openclaw doctor`)

### 4) Optional manual flow (advanced)

Skip this section if you use `./deploy.sh`.

Manual equivalents (for custom infra/debugging):

1. Recommended: seed from environment on first start (admin password plaintext never stored in config).

```bash
export OPENCLAW_LOCALAUTH_ENABLE=1
export OPENCLAW_LOCALAUTH_SESSION_SECRET='replace-with-strong-random-secret'
export OPENCLAW_LOCALAUTH_ADMIN_USERNAME='admin'
export OPENCLAW_LOCALAUTH_ADMIN_PASSWORD='replace-with-strong-admin-password'
export OPENCLAW_LOCALAUTH_ADMIN_AGENT_ID='main'
```

Notes:

- `OPENCLAW_LOCALAUTH_ENABLE=1` auto-seeds `gateway.controlUi.localAuth.enabled=true` and `sessionSecret` at startup if missing.
- When the auth DB is empty, the gateway auto-creates a single admin user from env seed inputs.
- Alternative to plaintext password: set `OPENCLAW_LOCALAUTH_ADMIN_PASSWORD_HASH` (argon2id PHC string).

2. systemd service example

Create `/etc/systemd/system/openclaw-localauth.service`:

```ini
[Unit]
Description=OpenClaw Gateway (local auth)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=openclaw
WorkingDirectory=/home/openclaw/openclaw
Environment=NODE_ENV=production
Environment=OPENCLAW_LOCALAUTH_ENABLE=1
Environment=OPENCLAW_LOCALAUTH_SESSION_SECRET=replace-with-strong-random-secret
Environment=OPENCLAW_LOCALAUTH_ADMIN_USERNAME=admin
Environment=OPENCLAW_LOCALAUTH_ADMIN_PASSWORD=replace-with-strong-admin-password
Environment=OPENCLAW_LOCALAUTH_ADMIN_AGENT_ID=main
ExecStart=/usr/bin/env pnpm openclaw gateway run --bind loopback --port 18789 --force
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now openclaw-localauth
sudo systemctl status openclaw-localauth
```

3. Nginx HTTPS reverse proxy (public)

```nginx
server {
    listen 443 ssl http2;
    server_name your.domain.example;

    ssl_certificate     /etc/ssl/certs/your-cert.pem;
    ssl_certificate_key /etc/ssl/private/your-key.pem;

    location / {
        proxy_pass http://127.0.0.1:18789;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;

        # WebSocket upgrade
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

After enabling Nginx, set allowed origins explicitly:

```bash
openclaw config set gateway.controlUi.allowedOrigins '["https://your.domain.example"]'
```

4. Post-deploy checks

```bash
curl -i http://127.0.0.1:18789/health
openclaw doctor
openclaw channels status --probe
```

Expected:

- Gateway healthy on loopback
- Control UI shows login page when `localAuth` is enabled
- Admin can log in and manage users from Settings > Users
