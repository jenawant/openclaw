#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

if [[ -f ".env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source ".env"
  set +a
fi

OPENCLAW_DEPLOY_USER="${OPENCLAW_DEPLOY_USER:-openclaw}"
OPENCLAW_GATEWAY_BIND="${OPENCLAW_GATEWAY_BIND:-loopback}"
OPENCLAW_GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
OPENCLAW_GATEWAY_SERVICE="${OPENCLAW_GATEWAY_SERVICE:-openclaw-localauth}"
OPENCLAW_LOCALAUTH_ENABLE="${OPENCLAW_LOCALAUTH_ENABLE:-1}"
OPENCLAW_NGINX_ENABLE="${OPENCLAW_NGINX_ENABLE:-0}"

OPENCLAW_ENV_FILE="/etc/openclaw/${OPENCLAW_GATEWAY_SERVICE}.env"
OPENCLAW_UNIT_FILE="/etc/systemd/system/${OPENCLAW_GATEWAY_SERVICE}.service"
OPENCLAW_NGINX_SITE="${OPENCLAW_NGINX_SITE:-$OPENCLAW_GATEWAY_SERVICE}"
OPENCLAW_NGINX_FILE="/etc/nginx/sites-available/${OPENCLAW_NGINX_SITE}.conf"
OPENCLAW_NGINX_LINK="/etc/nginx/sites-enabled/${OPENCLAW_NGINX_SITE}.conf"

echo "[1/7] Install dependencies and build"
pnpm install
pnpm build

echo "[2/7] Set baseline gateway config"
pnpm openclaw config set gateway.mode local
pnpm openclaw config set gateway.bind "$OPENCLAW_GATEWAY_BIND"
pnpm openclaw config set gateway.controlUi.localAuth.enabled true
pnpm openclaw config set gateway.controlUi.localAuth.seedAdminOnEmpty true

if [[ -n "${OPENCLAW_NGINX_SERVER_NAME:-}" ]]; then
  pnpm openclaw config set gateway.controlUi.allowedOrigins "[\"https://${OPENCLAW_NGINX_SERVER_NAME}\"]"
fi

echo "[3/7] Write systemd env file (${OPENCLAW_ENV_FILE})"
sudo install -d -m 0750 /etc/openclaw
sudo tee "$OPENCLAW_ENV_FILE" >/dev/null <<EOF
OPENCLAW_GATEWAY_BIND=${OPENCLAW_GATEWAY_BIND}
OPENCLAW_GATEWAY_PORT=${OPENCLAW_GATEWAY_PORT}
OPENCLAW_LOCALAUTH_ENABLE=${OPENCLAW_LOCALAUTH_ENABLE}
OPENCLAW_LOCALAUTH_SESSION_SECRET=${OPENCLAW_LOCALAUTH_SESSION_SECRET:-}
OPENCLAW_LOCALAUTH_ADMIN_USERNAME=${OPENCLAW_LOCALAUTH_ADMIN_USERNAME:-admin}
OPENCLAW_LOCALAUTH_ADMIN_PASSWORD=${OPENCLAW_LOCALAUTH_ADMIN_PASSWORD:-}
OPENCLAW_LOCALAUTH_ADMIN_PASSWORD_HASH=${OPENCLAW_LOCALAUTH_ADMIN_PASSWORD_HASH:-}
OPENCLAW_LOCALAUTH_ADMIN_AGENT_ID=${OPENCLAW_LOCALAUTH_ADMIN_AGENT_ID:-main}
OPENCLAW_BRAND_TITLE=${OPENCLAW_BRAND_TITLE:-Wonder Byte AI}
OPENCLAW_BRAND_SUB=${OPENCLAW_BRAND_SUB:-Gateway Dashboard}
OPENCLAW_GATEWAY_TOKEN=${OPENCLAW_GATEWAY_TOKEN:-}
OPENCLAW_GATEWAY_PASSWORD=${OPENCLAW_GATEWAY_PASSWORD:-}
EOF
sudo chmod 0640 "$OPENCLAW_ENV_FILE"

echo "[4/7] Write systemd unit (${OPENCLAW_UNIT_FILE})"
sudo tee "$OPENCLAW_UNIT_FILE" >/dev/null <<EOF
[Unit]
Description=OpenClaw Gateway (local auth)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${OPENCLAW_DEPLOY_USER}
WorkingDirectory=${ROOT_DIR}
EnvironmentFile=${OPENCLAW_ENV_FILE}
Environment=NODE_ENV=production
ExecStart=/usr/bin/env bash -lc 'cd "${ROOT_DIR}" && exec pnpm openclaw gateway run --bind "\${OPENCLAW_GATEWAY_BIND:-loopback}" --port "\${OPENCLAW_GATEWAY_PORT:-18789}" --force'
Restart=always
RestartSec=3
TimeoutStartSec=90

[Install]
WantedBy=multi-user.target
EOF

echo "[5/7] Reload + restart systemd service"
sudo systemctl daemon-reload
sudo systemctl enable --now "$OPENCLAW_GATEWAY_SERVICE"
sudo systemctl restart "$OPENCLAW_GATEWAY_SERVICE"

if [[ "$OPENCLAW_NGINX_ENABLE" == "1" ]]; then
  echo "[6/7] Configure nginx reverse proxy"
  : "${OPENCLAW_NGINX_SERVER_NAME:?OPENCLAW_NGINX_SERVER_NAME is required when OPENCLAW_NGINX_ENABLE=1}"
  : "${OPENCLAW_SSL_CERT_PATH:?OPENCLAW_SSL_CERT_PATH is required when OPENCLAW_NGINX_ENABLE=1}"
  : "${OPENCLAW_SSL_KEY_PATH:?OPENCLAW_SSL_KEY_PATH is required when OPENCLAW_NGINX_ENABLE=1}"
  sudo tee "$OPENCLAW_NGINX_FILE" >/dev/null <<EOF
server {
    listen 443 ssl;
    http2 on;
    server_name ${OPENCLAW_NGINX_SERVER_NAME};

    ssl_certificate ${OPENCLAW_SSL_CERT_PATH};
    ssl_certificate_key ${OPENCLAW_SSL_KEY_PATH};

    location / {
        proxy_pass http://127.0.0.1:${OPENCLAW_GATEWAY_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
EOF
  sudo ln -sfn "$OPENCLAW_NGINX_FILE" "$OPENCLAW_NGINX_LINK"
  sudo nginx -t
  sudo systemctl reload nginx
else
  echo "[6/7] Skip nginx setup (OPENCLAW_NGINX_ENABLE=${OPENCLAW_NGINX_ENABLE})"
fi

echo "[7/7] Health checks"
sudo systemctl status "$OPENCLAW_GATEWAY_SERVICE" --no-pager -n 30 || true
curl -fsS "http://127.0.0.1:${OPENCLAW_GATEWAY_PORT}/health" || true
pnpm openclaw doctor || true

echo
echo "Deploy done."
echo "Service: ${OPENCLAW_GATEWAY_SERVICE}"
echo "Local health: http://127.0.0.1:${OPENCLAW_GATEWAY_PORT}/health"
if [[ -n "${OPENCLAW_NGINX_SERVER_NAME:-}" ]]; then
  echo "Public URL: https://${OPENCLAW_NGINX_SERVER_NAME}/"
fi
