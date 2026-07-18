# GAIOP ISO backup and recovery contract

This contract defines what an ISO deployment must back up before upgrade,
migration, or disaster recovery. It is deliberately not an executable backup
script: secret storage, retention, and destination are deployment decisions.

## Required backup sets

| Set | Source | Handling |
|---|---|---|
| Admin state | `/var/lib/gaiop/admin` | Quiesce writes or use a SQLite-consistent backup method. |
| Alert state | `/var/lib/gaiop/alerts` | Preserve normalized events and receiver enabled state together. |
| Formal reports | `/var/lib/gaiop/reports` | Preserve each report and its paired audit JSON. |
| Runtime bridge | `/var/lib/gaiop/runtime` | Sensitive: store with the protected backup set. |
| Deployment secrets | `/etc/gaiop/*.env` and key material | Encrypt separately; never include in a normal application archive. |

Program directories under `/opt/gaiop` are rebuilt from the approved release
package and are not authoritative user data.

## Recovery order

1. Install the approved program release and service definitions.
2. Restore protected environment files and key material with service-account-only permissions.
3. Restore Admin state, alert state, report pairs, then the runtime bridge.
4. Run the ISO preflight; only then start rsyslog, Gateway, receiver, Admin and Nginx in the documented order.
5. Verify login, active data source, receiver health, one report listing, and role isolation before declaring recovery complete.

## Recovery acceptance

- No secret appears in the restore log or browser response.
- Reports remain paired with their audit JSON and retain their access isolation.
- Alert receiver restores its enabled/disabled state.
- A service restart does not recreate data under program directories.
- Backup retention period, encryption method and off-host destination require a customer/deployment decision before ISO freeze.
