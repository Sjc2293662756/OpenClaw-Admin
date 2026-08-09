# GAIOP 本机 SQLite 备份部署与恢复验证说明

> 本文是未实施模板，不是237发布记录。禁止据此直接覆盖生产数据库。

## 1. 安装前核查

分别由组件维护者只读确认数据库真实路径、服务账户、SQLite版本、`PRAGMA integrity_check`结果、备份根真实路径与剩余空间。Admin不得检查Upgrade数据库，Upgrade不得检查Admin数据库。不得读取表内容、环境文件、Token、私钥或其他秘密。

## 2. Admin模板

安装 `deploy/systemd/gaiop-admin-sqlite-backup.service` 和 `.timer`。服务仅以 `gaiop:gaiop` 运行，读取 `wizard.db`，可写 `/var/lib/gaiop/admin/sqlite-backups` 与自己的运行锁目录。timer每日UTC 01:20执行并启用 `Persistent=true`。

安装unit前必须由部署流程显式创建 `/var/lib/gaiop/admin/sqlite-backups` 与 `/var/lib/gaiop/admin/sqlite-restore-tests`，所有者为 `gaiop:gaiop`、权限为`0700`；不得放宽父目录权限。`ReadWritePaths`中的目录不存在时，unit应视为安装未完成，不能通过放宽systemd沙箱绕过。

环境变量模板位于 `deploy/iso/env/admin.env.example`。首次部署必须保持创建和清理开关均为 `false`，确认关闭态执行不创建数据库、备份或目录。

## 3. Upgrade模板

Upgrade对应模板由 `GAIOP-upgrade` 仓库提供；只读取 `NAPM_UPGRADE_DB_PATH` 指向的升级数据库，可写 `/var/lib/gaiop/upgrade/sqlite-backups` 与自己的锁目录。不得把组件升级回滚备份目录作为SQLite备份根。

## 4. 安全恢复验证

Admin示例仅允许以受控备份文件为参数：

```bash
node /opt/gaiop/admin/server/sqlite-restore-test.js /var/lib/gaiop/admin/sqlite-backups/admin-daily-YYYY-MM-DD.sqlite3
```

命令只在 `GAIOP_ADMIN_SQLITE_RESTORE_TEST_DIR` 下创建随机临时数据库，完成完整性检查后自动删除。它没有生产目标参数，不会停止服务或替换 `wizard.db`。

真正的灾难恢复不在本批自动化范围。若未来需要恢复生产库，必须另行审批停机窗口、备份当前故障库、校验目标备份、明确回滚点并由人工执行；不得修改本测试工具使其接受生产目标。

## 5. 关闭与回滚

1. 保持或改回清理开关 `false`，再停止并禁用timer；
2. 如需停止创建，再将创建开关改为 `false`；
3. 回滚代码和unit时保留全部备份与manifest，不删除备份目录；
4. 新增机制不迁移业务表，不需要删除数据库结构；
5. 任一manifest、哈希、完整性或路径异常时保留现场，不能扩大目录、改用文件复制或跳过检查。

## 6. 生产启用前待办

重新核查237实际数据库与目录、服务账户、systemd沙箱、timer、开关、SELinux/AppArmor（如有）和备份空间；先只启用创建并验证至少一个完整日/周/月批次，再单独审批清理开关。本文和当前协作分支均未执行上述生产操作。
