#!/usr/bin/env bash
set -euo pipefail

failures=0
check() { if "$@"; then printf 'OK   %s\n' "$*"; else printf 'FAIL %s\n' "$*"; failures=$((failures + 1)); fi; }
require_env() { local name="$1"; [[ -n "${!name:-}" ]] && printf 'OK   env %s\n' "$name" || { printf 'FAIL env %s is required\n' "$name"; failures=$((failures + 1)); }; }

echo 'GAIOP ISO preflight (read-only)'
check test -x /usr/local/bin/node
check test -f /opt/gaiop/admin/server/index.js
check test -f /opt/gaiop/admin/dist/index.html
check test -f /etc/gaiop/admin.env
check test -f /etc/gaiop/gateway.env
check test -f /etc/gaiop/alert-receiver.env
check test -d /var/lib/gaiop/admin
check test -d /var/lib/gaiop/alerts
check test -d /var/lib/gaiop/reports
check test -r /var/log/netinside/syslog.log

if [[ -f /etc/gaiop/admin.env ]]; then
  set -a; source /etc/gaiop/admin.env; set +a
  require_env DATA_SOURCE_ENCRYPTION_KEY
  require_env GAIOP_ACTIVE_DATA_SOURCE_FILE
  require_env GAIOP_REPORTS_DIR
  require_env GAIOP_ALERT_RECEIVER_URL
fi

if command -v systemctl >/dev/null 2>&1; then
  check systemctl cat gaiop-gateway.service
  check systemctl cat gaiop-syslog-receiver.service
  check systemctl cat gaiop-admin.service
fi

if (( failures > 0 )); then
  printf 'Preflight failed: %s check(s) need attention.\n' "$failures" >&2
  exit 1
fi
echo 'Preflight passed. This script did not start, stop, or install services.'
