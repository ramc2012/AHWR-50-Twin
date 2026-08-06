#!/bin/sh
# Generate the CRMF portal's TLS server block — but ONLY when a certificate and
# key are actually readable at the configured paths. Missing certs => the portal
# still serves plain HTTP on :80 and nginx starts normally.
#
# This is the nginx equivalent of how dev already does TLS for the MCP servers
# (edge-mcp-server/src/index.ts:414-427):
#     if (TLS_CERT_FILE && TLS_KEY_FILE) https.createServer(...) else app.listen(...)
# with the same read-only ./certs:/certs volume. nginx cannot branch on file
# existence inside its config, so the branch happens here instead — in nginx's own
# /docker-entrypoint.d hook, which the official image runs before starting nginx.
set -eu

CERT="${TLS_CERT_FILE:-/certs/crmf.crt}"
KEY="${TLS_KEY_FILE:-/certs/crmf.key}"
OUT="/etc/nginx/conf.d/zz-crmf-tls.conf"

# Never leave a stale TLS block behind if the certs were removed.
rm -f "$OUT"

if [ ! -r "$CERT" ] || [ ! -r "$KEY" ]; then
    echo "[crmf-tls] no readable cert/key at ${CERT} / ${KEY} — serving plain HTTP on :80 only"
    exit 0
fi

cat >"$OUT" <<EOF
# GENERATED at container start by /docker-entrypoint.d/40-crmf-tls.sh. Do not edit.
server {
    listen 443 ssl;
    http2 on;
    server_name _;
    root /usr/share/nginx/html;
    index index.html;

    ssl_certificate     ${CERT};
    ssl_certificate_key ${KEY};
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers off;
    ssl_session_cache   shared:CRMF_TLS:10m;
    ssl_session_timeout 1d;
    ssl_session_tickets off;

    include /etc/nginx/crmf-shared.conf;
}
EOF

echo "[crmf-tls] HTTPS enabled on :443 using ${CERT}"
