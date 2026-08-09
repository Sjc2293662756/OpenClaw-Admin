# GAIOP ISO deployment inputs

These files are ISO build inputs, not an installer. The deployment owner copies
the examples to the controlled paths below, supplies secrets outside Git, sets
ownership to the service account, then runs the read-only preflight script.

`release-manifest.example.yaml` is the build-time inventory for the two
repositories: it distinguishes image content, controlled deployment files,
first-boot generation, persistent data, and deliberately excluded material.
The ISO build pipeline should copy it into its release record with the actual
source revisions and release ID filled in.

`release-freeze-record.example.yaml` is the delivery evidence template. A
completed copy records immutable source revisions, ISO checksum, local/Linux
validation, secret/data boundary confirmation, and acceptance signoff. It must
remain free of credentials and customer data.

Before releasing, run `node deploy/iso/scripts/validate-release-freeze-record.mjs
<completed-record.yaml>`. The validator prints field names only and rejects
placeholders, failed/missing evidence, unconfirmed security boundaries, and
invalid source/ISO checksums; it does not read environment files or secrets.

| Source | Controlled target |
|---|---|
| `env/admin.env.example` | `/etc/gaiop/admin.env` |
| `GAIOP-latest/deploy/iso/env/gateway.env.example` | `/etc/gaiop/gateway.env` |
| `GAIOP-latest/deploy/iso/env/alert-receiver.env.example` | `/etc/gaiop/alert-receiver.env` |
| `systemd/gaiop-admin.service` | `/etc/systemd/system/gaiop-admin.service` |
| `../systemd/gaiop-report-retention-cleanup.service` | `/etc/systemd/system/gaiop-report-retention-cleanup.service` |
| `../systemd/gaiop-report-retention-cleanup.timer` | `/etc/systemd/system/gaiop-report-retention-cleanup.timer` |
| `GAIOP-latest/deploy/iso/systemd/gaiop-gateway.service` | `/etc/systemd/system/gaiop-gateway.service` |
| `GAIOP-latest/skills/openclaw-napm-syslog-receiver/scripts/gaiop-syslog-receiver.service` | `/etc/systemd/system/gaiop-syslog-receiver.service` |
| `nginx/gaiop.conf` | deployment-managed Nginx site configuration |
| `caddy/gaiop-access-log.caddy` | `/etc/caddy/gaiop-access-log.caddy`, imported once inside the GAIOP HTTPS site |
| `logrotate/gaiop-netinside-syslog` | `/etc/logrotate.d/gaiop-netinside-syslog` |
| `journald/60-gaiop-retention.conf` | `/etc/systemd/journald.conf.d/60-gaiop-retention.conf` |

The final Linux validation is: `bash -n` for the preflight script,
`systemd-analyze verify` for unit files, `nginx -t`, then a controlled service
start and the ISO acceptance matrix. None of those actions are performed by
this repository.

System and entry log retention inputs are templates, not an authorization to
change a running host. Run `node deploy/iso/scripts/validate-system-entry-log-retention.mjs`
for repository-safe checks. On a Linux staging host, run
`bash deploy/iso/scripts/validate-system-entry-log-retention-linux.sh --templates`
for native Caddy/logrotate syntax checks. The `--installed` mode is read-only
and suppresses configuration contents; the deliberately mutating
`--exercise-syslog-rotation` mode refuses to run unless the operator is root
and sets `GAIOP_LOG_RETENTION_LIVE_ROTATION_APPROVED=YES` after separate change
approval. See the [system and entry log retention guide](../../docs/05-部署运维/2026-08-09-GAIOP系统与入口日志留存ISO配置.md)
before installation, disablement, or rollback.
