#!/usr/bin/env python3
import datetime
import hashlib
import json
import os
import pwd
import grp
import re
import sqlite3
import stat
import subprocess
import urllib.request

POLICY_VERSION = "gaiop_retention_qualification.v1"
NOW = datetime.datetime.now(datetime.timezone.utc)
NOW_MS = int(NOW.timestamp() * 1000)
MAX_CLOCK_SKEW_MS = 5 * 60 * 1000
UUID_V4_ZIP = re.compile(r"^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.zip$", re.I)
PROVENANCE_FILE = re.compile(r"^([a-f0-9]{64})\.json$")
PROVENANCE_TEMP = re.compile(r"^\.gaiop-report-provenance-([a-f0-9]{64})\.(\d{1,10})\.(\d{13})\.tmp$")

PATHS = {
    "admin_db": "/var/lib/gaiop/admin/wizard.db",
    "provenance": "/var/lib/gaiop/runtime/report-provenance",
    "admin_staging": "/opt/gaiop/admin/data/upgrade-upload-staging",
    "upgrade_db": "/var/lib/gaiop-upgrade/napm-upgrade.db",
    "upgrade_packages": "/var/lib/gaiop-upgrade/packages",
    "upgrade_staging": "/var/lib/gaiop-upgrade/staging",
    "upgrade_backups": "/var/backups/gaiop/upgrade",
    "watermark_probe": "/var/lib/gaiop/admin",
}

ADMIN_TABLES = ["users", "workspace_sessions", "report_files", "report_deliveries", "audit_logs", "storage_watermark_events"]
UPGRADE_TABLES = ["upgrade_tasks", "components", "backups", "audit_log"]


def utc(value_ms):
    if value_ms is None:
        return None
    return datetime.datetime.fromtimestamp(value_ms / 1000, datetime.timezone.utc).isoformat().replace("+00:00", "Z")


def result(category):
    return {
        "category": category,
        "safe_candidate": {"count": 0, "bytes": 0, "earliestUtc": None, "latestUtc": None},
        "protected": {"count": 0, "reasons": {}},
        "unknown_or_error": {"count": 0, "reasons": {}},
    }


def reason(bucket, code, count=1):
    bucket["count"] += count
    bucket["reasons"][code] = bucket["reasons"].get(code, 0) + count


def candidate(summary, size, time_ms):
    item = summary["safe_candidate"]
    item["count"] += 1
    item["bytes"] += max(0, int(size or 0))
    timestamp = utc(time_ms)
    if timestamp:
        if item["earliestUtc"] is None or timestamp < item["earliestUtc"]:
            item["earliestUtc"] = timestamp
        if item["latestUtc"] is None or timestamp > item["latestUtc"]:
            item["latestUtc"] = timestamp


def safe_owner(item_stat, allowed):
    try:
        owner = pwd.getpwuid(item_stat.st_uid).pw_name
        group = grp.getgrgid(item_stat.st_gid).gr_name
        return owner in allowed and group in allowed.union({"gaiop", "netinside"})
    except (KeyError, PermissionError):
        return False


def direct_entries(path_value):
    root = os.path.abspath(path_value)
    try:
        root_stat = os.lstat(root)
        if stat.S_ISLNK(root_stat.st_mode) or not stat.S_ISDIR(root_stat.st_mode):
            return None, "managed_root_unsafe"
        return list(os.scandir(root)), None
    except FileNotFoundError:
        return None, "managed_root_not_found"
    except PermissionError:
        return None, "managed_root_permission_denied"
    except OSError:
        return None, "managed_root_read_failed"


def entry_stat(entry):
    try:
        return entry.stat(follow_symlinks=False), None
    except PermissionError:
        return None, "entry_permission_denied"
    except OSError:
        return None, "entry_stat_failed"


def open_readonly_database(path_value):
    uri = "file:" + path_value + "?mode=ro"
    conn = sqlite3.connect(uri, uri=True, timeout=5)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA query_only=ON")
    return conn


def database_snapshot(path_value, tables):
    output = {"available": False, "integrity": None, "counts": {}, "reason": None}
    try:
        conn = open_readonly_database(path_value)
        try:
            output["integrity"] = conn.execute("PRAGMA integrity_check").fetchone()[0]
            available = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            for table in tables:
                output["counts"][table] = conn.execute("SELECT COUNT(*) FROM " + table).fetchone()[0] if table in available else None
            output["available"] = True
        finally:
            conn.close()
    except PermissionError:
        output["reason"] = "database_permission_denied"
    except sqlite3.Error:
        output["reason"] = "database_read_failed"
    except OSError:
        output["reason"] = "database_unavailable"
    return output


def directory_snapshot(path_value):
    entries, error = direct_entries(path_value)
    output = {"available": error is None, "count": None, "regularFiles": 0, "directories": 0, "symlinks": 0, "directFileBytes": 0, "reason": error}
    if error:
        return output
    output["count"] = len(entries)
    for entry in entries:
        item, item_error = entry_stat(entry)
        if item_error:
            continue
        if stat.S_ISLNK(item.st_mode):
            output["symlinks"] += 1
        elif stat.S_ISREG(item.st_mode):
            output["regularFiles"] += 1
            output["directFileBytes"] += max(0, item.st_size)
        elif stat.S_ISDIR(item.st_mode):
            output["directories"] += 1
    return output


def parse_db_time(value):
    if not value:
        return None
    try:
        parsed = datetime.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=datetime.timezone.utc)
        result_ms = int(parsed.timestamp() * 1000)
        return result_ms if 0 < result_ms <= NOW_MS + MAX_CLOCK_SKEW_MS else None
    except (TypeError, ValueError, OverflowError):
        return None


def qualify_provenance(admin_db):
    summary = result("admin_report_provenance_envelope")
    entries, error = direct_entries(PATHS["provenance"])
    if error:
        reason(summary["unknown_or_error"], error)
        return summary
    cutoff = NOW_MS - 48 * 60 * 60 * 1000
    for entry in entries:
        item, item_error = entry_stat(entry)
        if item_error:
            reason(summary["unknown_or_error"], item_error)
            continue
        if stat.S_ISLNK(item.st_mode):
            reason(summary["protected"], "symbolic_link")
            continue
        if not stat.S_ISREG(item.st_mode):
            reason(summary["protected"], "unknown_directory" if stat.S_ISDIR(item.st_mode) else "unknown_file_type")
            continue
        matched = PROVENANCE_FILE.fullmatch(entry.name)
        temporary = PROVENANCE_TEMP.fullmatch(entry.name)
        if not matched and not temporary:
            reason(summary["protected"], "unknown_filename")
            continue
        mtime_ms = int(item.st_mtime * 1000)
        if mtime_ms <= 0 or mtime_ms > NOW_MS + MAX_CLOCK_SKEW_MS:
            reason(summary["protected"], "invalid_timestamp")
            continue
        if not safe_owner(item, {"gaiop", "netinside"}):
            reason(summary["protected"], "unexpected_owner")
            continue
        if temporary:
            reason(summary["unknown_or_error"], "temporary_envelope_unowned")
            continue
        if item.st_size <= 0 or item.st_size > 64 * 1024:
            reason(summary["protected"], "invalid_file_size")
            continue
        try:
            with open(entry.path, "r", encoding="utf-8") as handle:
                envelope = json.load(handle)
        except (OSError, UnicodeError, json.JSONDecodeError):
            reason(summary["protected"], "invalid_envelope")
            continue
        issued_at = envelope.get("issuedAt")
        session_id = envelope.get("sessionId")
        expected_hash = hashlib.sha256(str(session_id or "").encode("utf-8")).hexdigest()
        valid = (
            envelope.get("version") == "gaiop_report_provenance.v3"
            and isinstance(envelope.get("userId"), str) and envelope.get("userId").strip()
            and isinstance(session_id, str) and session_id.strip()
            and isinstance(envelope.get("signature"), str) and envelope.get("signature").strip()
            and isinstance(issued_at, (int, float)) and 0 < issued_at <= NOW_MS + MAX_CLOCK_SKEW_MS
            and expected_hash == matched.group(1)
        )
        if not valid:
            reason(summary["protected"], "invalid_envelope")
            continue
        if int(issued_at) >= cutoff or mtime_ms >= cutoff:
            reason(summary["protected"], "not_expired")
            continue
        if admin_db is None:
            reason(summary["unknown_or_error"], "association_database_unavailable")
            continue
        try:
            reports = admin_db.execute("SELECT COUNT(*) FROM report_files WHERE source_session_id=? AND status<>'failed'", (session_id,)).fetchone()[0]
            deliveries = admin_db.execute("SELECT COUNT(*) FROM report_deliveries d JOIN report_files r ON r.id=d.report_id WHERE r.source_session_id=? AND d.status IN ('prepared','handed_off')", (session_id,)).fetchone()[0]
        except sqlite3.Error:
            reason(summary["unknown_or_error"], "association_query_failed")
            continue
        if reports or deliveries:
            reason(summary["protected"], "active_or_pending_reference")
            continue
        candidate(summary, item.st_size, max(int(issued_at), mtime_ms))
    return summary


def qualify_simple_staging(label, root, allowed_owners, task_by_id=None):
    summary = result(label)
    entries, error = direct_entries(root)
    if error:
        reason(summary["unknown_or_error"], error)
        return summary
    cutoff = NOW_MS - 24 * 60 * 60 * 1000
    for entry in entries:
        item, item_error = entry_stat(entry)
        if item_error:
            reason(summary["unknown_or_error"], item_error)
            continue
        if stat.S_ISLNK(item.st_mode):
            reason(summary["protected"], "symbolic_link")
            continue
        if not stat.S_ISREG(item.st_mode):
            reason(summary["protected"], "unknown_directory" if stat.S_ISDIR(item.st_mode) else "unknown_file_type")
            continue
        matched = UUID_V4_ZIP.fullmatch(entry.name)
        if not matched:
            reason(summary["protected"], "unknown_filename")
            continue
        mtime_ms = int(item.st_mtime * 1000)
        if mtime_ms <= 0 or mtime_ms > NOW_MS + MAX_CLOCK_SKEW_MS:
            reason(summary["protected"], "invalid_timestamp")
            continue
        if not safe_owner(item, allowed_owners):
            reason(summary["protected"], "unexpected_owner")
            continue
        if mtime_ms >= cutoff:
            reason(summary["protected"], "not_expired")
            continue
        task = task_by_id.get(matched.group(1).lower()) if task_by_id is not None else None
        if task and task["status"] in ("pending", "running", "rolling_back"):
            reason(summary["protected"], "active_task")
            continue
        reason(summary["unknown_or_error"], "activity_or_lock_proof_unavailable")
    return summary


def load_upgrade_tasks(upgrade_db):
    if upgrade_db is None:
        return None
    try:
        rows = upgrade_db.execute("SELECT id,status,created_at,finished_at FROM upgrade_tasks").fetchall()
        return {str(row["id"]).lower(): row for row in rows if row["id"]}
    except sqlite3.Error:
        return None


def qualify_upgrade_packages(upgrade_db, task_by_id):
    summary = result("upgrade_packages")
    entries, error = direct_entries(PATHS["upgrade_packages"])
    if error:
        reason(summary["unknown_or_error"], error)
        return summary
    if upgrade_db is None or task_by_id is None:
        reason(summary["unknown_or_error"], "database_read_failed")
        return summary
    cutoff = NOW_MS - 7 * 24 * 60 * 60 * 1000
    for entry in entries:
        item, item_error = entry_stat(entry)
        if item_error:
            reason(summary["unknown_or_error"], item_error)
            continue
        if stat.S_ISLNK(item.st_mode):
            reason(summary["protected"], "symbolic_link")
            continue
        if not stat.S_ISREG(item.st_mode):
            reason(summary["protected"], "unknown_directory" if stat.S_ISDIR(item.st_mode) else "unknown_file_type")
            continue
        matched = UUID_V4_ZIP.fullmatch(entry.name)
        if not matched:
            reason(summary["protected"], "unknown_filename")
            continue
        mtime_ms = int(item.st_mtime * 1000)
        if mtime_ms <= 0 or mtime_ms > NOW_MS + MAX_CLOCK_SKEW_MS:
            reason(summary["protected"], "invalid_timestamp")
            continue
        if not safe_owner(item, {"netinside"}):
            reason(summary["protected"], "unexpected_owner")
            continue
        task = task_by_id.get(matched.group(1).lower())
        if task is None:
            reason(summary["protected"], "unknown_package")
            continue
        status_value = task["status"]
        if status_value in ("pending", "running", "rolling_back"):
            reason(summary["protected"], "active_task")
            continue
        task_time = parse_db_time(task["finished_at"] or task["created_at"])
        if task_time is None:
            reason(summary["protected"], "invalid_timestamp")
            continue
        if status_value == "success":
            candidate(summary, item.st_size, max(task_time, mtime_ms))
            continue
        if status_value not in ("failed", "rolled_back"):
            reason(summary["protected"], "unknown_task_status")
            continue
        if task_time >= cutoff or mtime_ms >= cutoff:
            reason(summary["protected"], "not_expired")
            continue
        candidate(summary, item.st_size, max(task_time, mtime_ms))
    return summary


def qualify_upgrade_backups(upgrade_db, task_by_id):
    summary = result("upgrade_rollback_backup")
    root = os.path.abspath(PATHS["upgrade_backups"])
    entries, root_error = direct_entries(root)
    if root_error:
        reason(summary["unknown_or_error"], root_error)
        return summary
    if upgrade_db is None or task_by_id is None:
        reason(summary["unknown_or_error"], "database_read_failed")
        return summary
    try:
        rows = upgrade_db.execute("SELECT id,component,version,backup_path,size_bytes,task_id,created_at FROM backups").fetchall()
    except sqlite3.Error:
        reason(summary["unknown_or_error"], "database_read_failed")
        return summary
    active = any(row["status"] in ("running", "rolling_back") for row in task_by_id.values())
    registered_paths = set()
    groups = {}
    for row in rows:
        task_id = str(row["task_id"] or "").lower()
        if not task_id or task_id not in task_by_id:
            reason(summary["protected"], "database_ownership_missing")
            continue
        target = os.path.abspath(str(row["backup_path"] or ""))
        try:
            if os.path.commonpath([root, target]) != root or target == root:
                reason(summary["protected"], "path_outside_root")
                continue
        except ValueError:
            reason(summary["protected"], "path_outside_root")
            continue
        try:
            item = os.lstat(target)
            if stat.S_ISLNK(item.st_mode) or not stat.S_ISDIR(item.st_mode):
                reason(summary["protected"], "unsafe_backup_directory")
                continue
            real_root = os.path.realpath(root)
            real_target = os.path.realpath(target)
            if os.path.commonpath([real_root, real_target]) != real_root or real_target == real_root:
                reason(summary["protected"], "path_outside_root")
                continue
            registered_paths.add(real_target)
            direct = list(os.scandir(target))
            manifests = [entry for entry in direct if "manifest" in entry.name.lower()]
            if not manifests:
                reason(summary["protected"], "manifest_missing")
                continue
            manifest_stat = manifests[0].stat(follow_symlinks=False)
            if stat.S_ISLNK(manifest_stat.st_mode) or not stat.S_ISREG(manifest_stat.st_mode) or manifest_stat.st_size <= 0:
                reason(summary["protected"], "manifest_invalid")
                continue
            if len([entry for entry in direct if not entry.is_symlink()]) < 2:
                reason(summary["protected"], "backup_files_incomplete")
                continue
        except FileNotFoundError:
            reason(summary["protected"], "backup_directory_unavailable")
            continue
        except PermissionError:
            reason(summary["unknown_or_error"], "backup_directory_permission_denied")
            continue
        except OSError:
            reason(summary["unknown_or_error"], "backup_directory_read_failed")
            continue
        created_at = parse_db_time(row["created_at"])
        if created_at is None:
            reason(summary["protected"], "invalid_timestamp")
            continue
        group = groups.setdefault(real_target, [])
        group.append({"component": row["component"], "createdAt": created_at, "size": row["size_bytes"]})
    for entry in entries:
        try:
            item = entry.stat(follow_symlinks=False)
            if stat.S_ISDIR(item.st_mode) and os.path.realpath(entry.path) not in registered_paths:
                reason(summary["protected"], "unregistered_directory")
        except OSError:
            reason(summary["unknown_or_error"], "unregistered_directory_check_failed")
    recent = set()
    by_component = {}
    for key, records in groups.items():
        for row in records:
            by_component.setdefault(row["component"], []).append((row["createdAt"], key))
    for items in by_component.values():
        for _, key in sorted(items, key=lambda value: (-value[0], value[1]))[:5]:
            recent.add(key)
    cutoff = NOW_MS - 90 * 24 * 60 * 60 * 1000
    for key, records in groups.items():
        if active:
            reason(summary["protected"], "active_task")
        elif len(records) != 1:
            reason(summary["protected"], "shared_physical_directory")
        elif key in recent:
            reason(summary["protected"], "protected_recent_group")
        elif records[0]["createdAt"] >= cutoff:
            reason(summary["protected"], "not_expired")
        else:
            candidate(summary, records[0]["size"], records[0]["createdAt"])
    return summary


def command_state(command):
    try:
        completed = subprocess.run(command, capture_output=True, text=True, timeout=8, check=False)
        value = completed.stdout.strip().splitlines()
        return {"ok": completed.returncode == 0, "value": value[-1][:120] if value else None, "reason": None if completed.returncode == 0 else "command_failed"}
    except (OSError, subprocess.SubprocessError):
        return {"ok": False, "value": None, "reason": "command_unavailable"}


def health(url):
    try:
        with urllib.request.urlopen(url, timeout=5) as response:
            return {"ok": response.status == 200, "status": response.status}
    except Exception:
        return {"ok": False, "status": None}


def water_usage():
    try:
        values = os.statvfs(PATHS["watermark_probe"])
        used = values.f_blocks - values.f_bfree
        denominator = used + values.f_bavail
        usage = used * 100 / denominator if denominator > 0 else None
        if usage is None:
            state = "unknown"
        elif usage >= 90:
            state = "emergency"
        elif usage >= 80:
            state = "cleanup_required"
        elif usage >= 75:
            state = "warning"
        else:
            state = "normal"
        return {"ok": usage is not None, "usagePercent": round(usage, 6) if usage is not None else None, "state": state}
    except OSError:
        return {"ok": False, "usagePercent": None, "state": "unknown"}


def snapshot():
    return {
        "adminDatabase": database_snapshot(PATHS["admin_db"], ADMIN_TABLES),
        "upgradeDatabase": database_snapshot(PATHS["upgrade_db"], UPGRADE_TABLES),
        "directories": {label: directory_snapshot(PATHS[label]) for label in ("provenance", "admin_staging", "upgrade_packages", "upgrade_staging", "upgrade_backups")},
    }


before = snapshot()
admin_conn = None
upgrade_conn = None
try:
    try:
        admin_conn = open_readonly_database(PATHS["admin_db"])
    except (sqlite3.Error, OSError):
        admin_conn = None
    try:
        upgrade_conn = open_readonly_database(PATHS["upgrade_db"])
    except (sqlite3.Error, OSError):
        upgrade_conn = None
    tasks = load_upgrade_tasks(upgrade_conn)
    categories = {
        "adminReportProvenance": qualify_provenance(admin_conn),
        "adminUpgradeStaging": qualify_simple_staging("admin_upgrade_upload_staging", PATHS["admin_staging"], {"gaiop"}),
        "upgradePackages": qualify_upgrade_packages(upgrade_conn, tasks),
        "upgradeStaging": qualify_simple_staging("upgrade_staging", PATHS["upgrade_staging"], {"netinside"}, tasks),
        "upgradeRollbackBackups": qualify_upgrade_backups(upgrade_conn, tasks),
    }
finally:
    if admin_conn is not None:
        admin_conn.close()
    if upgrade_conn is not None:
        upgrade_conn.close()
after = snapshot()

services = {}
for unit in ("gaiop-admin.service", "gaiop-upgrade.service", "caddy.service"):
    services[unit] = command_state(["systemctl", "is-active", unit])
services["openclaw-gateway.service"] = command_state(["systemctl", "--user", "is-active", "openclaw-gateway.service"])

timers = {}
for unit in (
    "gaiop-admin-retention-cleanup.timer",
    "gaiop-upgrade-retention-cleanup.timer",
    "gaiop-report-retention-cleanup.timer",
    "gaiop-admin-session-retention.timer",
    "gaiop-admin-sqlite-backup.timer",
    "gaiop-upgrade-sqlite-backup.timer",
    "gaiop-storage-watermark-monitor.timer",
):
    timers[unit] = {
        "active": command_state(["systemctl", "is-active", unit]),
        "enabled": command_state(["systemctl", "is-enabled", unit]),
    }

output = {
    "policyVersion": POLICY_VERSION,
    "checkedAtUtc": NOW.isoformat().replace("+00:00", "Z"),
    "execution": {"readOnly": True, "cleanersCalled": 0, "deletes": 0, "moves": 0, "compressions": 0, "databaseWrites": 0, "auditWrites": 0, "lockWrites": 0},
    "switches": {"valuesRead": False, "reason": "secret_environment_not_read"},
    "services": services,
    "timers": timers,
    "health": {"admin": health("http://127.0.0.1:3000/api/health"), "upgrade": health("http://127.0.0.1:18900/health")},
    "watermark": water_usage(),
    "categories": categories,
    "before": before,
    "after": after,
    "unchanged": before == after,
}
print(json.dumps(output, ensure_ascii=True, sort_keys=True))
