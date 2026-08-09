#!/usr/bin/env bash
set -euo pipefail

mode="${1:---templates}"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(cd -- "$script_dir/../../.." && pwd -P)"
tmp_dir="$(mktemp -d)"
trap 'rm -rf -- "$tmp_dir"' EXIT

fail() {
  printf 'FAIL %s\n' "$1" >&2
  exit 1
}

ok() {
  printf 'OK   %s\n' "$1"
}

quiet_check() {
  local code="$1"
  shift
  if "$@" > /dev/null 2>&1; then
    ok "$code"
  else
    fail "$code"
  fi
}

quiet_check templates.static node "$repo_root/deploy/iso/scripts/validate-system-entry-log-retention.mjs"

if command -v caddy > /dev/null 2>&1; then
  {
    printf 'http://127.0.0.1:18081 {\n'
    printf '\timport %s\n' "$repo_root/deploy/iso/caddy/gaiop-access-log.caddy"
    printf '\trespond 204\n'
    printf '}\n'
  } > "$tmp_dir/Caddyfile"
  quiet_check caddy.syntax caddy adapt --config "$tmp_dir/Caddyfile" --adapter caddyfile
else
  printf 'SKIP caddy.syntax (caddy unavailable)\n'
fi

if command -v logrotate > /dev/null 2>&1; then
  quiet_check logrotate.syntax logrotate --debug --state "$tmp_dir/logrotate.state" \
    "$repo_root/deploy/iso/logrotate/gaiop-netinside-syslog"
else
  printf 'SKIP logrotate.syntax (logrotate unavailable)\n'
fi

case "$mode" in
  --templates)
    ;;
  --installed)
    quiet_check caddy.installed caddy adapt --config /etc/caddy/Caddyfile --adapter caddyfile
    quiet_check logrotate.installed logrotate --debug /etc/logrotate.d/gaiop-netinside-syslog
    quiet_check journald.installed systemd-analyze cat-config systemd/journald.conf
    quiet_check caddy.active systemctl is-active --quiet caddy.service
    quiet_check rsyslog.active systemctl is-active --quiet rsyslog.service
    test -d /var/log/gaiop/caddy || fail caddy.log_directory_missing
    test ! -L /var/log/gaiop/caddy || fail caddy.log_directory_symlink
    test -f /var/log/gaiop/caddy/access.log || fail caddy.current_missing
    test ! -L /var/log/gaiop/caddy/access.log || fail caddy.current_symlink
    test -f /var/log/netinside/syslog.log || fail syslog.current_missing
    test ! -L /var/log/netinside/syslog.log || fail syslog.current_symlink
    ok installed.metadata
    ;;
  --exercise-syslog-rotation)
    [[ "${GAIOP_LOG_RETENTION_LIVE_ROTATION_APPROVED:-}" == 'YES' ]] || \
      fail live_rotation.approval_missing
    [[ "${EUID}" -eq 0 ]] || fail live_rotation.root_required
    test -f /var/log/netinside/syslog.log || fail live_rotation.current_missing
    test ! -L /var/log/netinside/syslog.log || fail live_rotation.current_symlink
    before_inode="$(stat -c '%d:%i' /var/log/netinside/syslog.log)"
    quiet_check live_rotation.logrotate logrotate --force /etc/logrotate.d/gaiop-netinside-syslog
    quiet_check live_rotation.rsyslog systemctl is-active --quiet rsyslog.service
    after_inode="$(stat -c '%d:%i' /var/log/netinside/syslog.log)"
    [[ "$before_inode" != "$after_inode" ]] || fail live_rotation.inode_unchanged
    before_size="$(stat -c '%s' /var/log/netinside/syslog.log)"
    logger --tag gaiop-retention-validation -- 'GAIOP_SYSLOG_ROTATION_CONTINUITY_CHECK'
    grew=false
    for _ in 1 2 3 4 5; do
      sleep 1
      after_size="$(stat -c '%s' /var/log/netinside/syslog.log)"
      if (( after_size > before_size )); then grew=true; break; fi
    done
    [[ "$grew" == true ]] || fail live_rotation.rsyslog_not_writing
    if systemctl list-unit-files gaiop-syslog-receiver.service 2> /dev/null | \
      grep -q '^gaiop-syslog-receiver\.service'; then
      quiet_check live_rotation.receiver systemctl is-active --quiet gaiop-syslog-receiver.service
    elif [[ -n "${GAIOP_SYSLOG_RECEIVER_USER:-}" ]] && id "$GAIOP_SYSLOG_RECEIVER_USER" > /dev/null 2>&1; then
      receiver_uid="$(id -u "$GAIOP_SYSLOG_RECEIVER_USER")"
      quiet_check live_rotation.receiver runuser -u "$GAIOP_SYSLOG_RECEIVER_USER" -- \
        env "XDG_RUNTIME_DIR=/run/user/$receiver_uid" systemctl --user is-active --quiet \
        gaiop-syslog-receiver.service
    else
      fail live_rotation.receiver_scope_unconfirmed
    fi
    ok live_rotation.continuity
    ;;
  *)
    fail arguments.invalid
    ;;
esac

printf 'Validation completed without reading log contents.\n'
