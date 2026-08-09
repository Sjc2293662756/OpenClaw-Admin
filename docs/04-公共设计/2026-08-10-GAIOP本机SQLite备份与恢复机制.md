# GAIOP 本机 SQLite 备份与恢复机制

> 状态：Admin 与 Upgrade 独立协作分支已实现；未部署237，未执行生产备份或恢复。

## 1. 所有权边界

- Admin one-shot 只接受 `GAIOP_ADMIN_DATA_DIR/wizard.db`，组件名固定为 `admin`，没有 Upgrade 路径或数据库配置。
- Upgrade one-shot 只接受升级服务自己的 `upgrade.db`；仓库开发环境兼容历史名 `napm-upgrade.db`，明确拒绝 `wizard.db`。
- `alerts.db` 只预留契约：未来必须由告警接收器自己的服务账户、one-shot、目录和开关接入，Admin 本批不读取、备份或恢复它。
- 开发发布备份、组件升级回滚备份、报告、Gateway、环境文件和秘密均不在本机制范围。

## 2. 一致性备份

每次执行以只读 SQLite 连接调用 `better-sqlite3` 的在线 backup API，得到与运行中 WAL 数据库一致的临时快照；不直接复制正在运行的数据库文件。快照随后转换为独立 `DELETE` journal 模式并执行完整 `PRAGMA integrity_check`。只有验证通过的快照才按当前 UTC 周期发布为日、周、月备份。

日、周、月备份复用同一份已关闭且验证通过的一致性快照，避免同一批次得到三个不同时间点。周期文件名固定为：

- `<component>-daily-YYYY-MM-DD.sqlite3`
- `<component>-weekly-YYYY-Www.sqlite3`
- `<component>-monthly-YYYY-MM.sqlite3`

同一周期重复运行先验证现有备份和 manifest，验证成功后幂等跳过；不覆盖、猜测或修复异常文件。

## 3. Manifest 与权限

每份数据库文件配套同 basename 的 `.manifest.json`，仅包含策略版本、组件、层级、UTC周期、UTC创建时间、`PRAGMA user_version`、SQLite版本、文件名、字节数和 SHA-256。不得记录表名、行数、业务正文、路径、Token或凭据。

备份根目录和恢复测试目录强制 `0700`，数据库、manifest、锁和临时文件使用 `0600`/`UMask=0077`。符号链接、根目录外路径、未知文件和未知目录不参与备份清理。

## 4. 保留周期

- 日备份：当前 UTC 日及此前29个日周期，共30天；
- 周备份：当前 ISO UTC 周及此前11周，共12周；
- 月备份：当前 UTC 月及此前11个月，共12个月。

每天运行都会确保当前日、当前周、当前月各有一份备份，因此服务停机后由 `Persistent=true` 补跑时不会错过周/月周期。只有本次确实创建了新备份，并且新备份完整性检查、大小和哈希全部通过时，才允许进入旧备份清理。备份创建、完整性或manifest任一步失败时，旧备份零删除。

## 5. 开关与恢复验证

Admin：

- `GAIOP_ADMIN_SQLITE_BACKUP_CREATE_ENABLED=false`
- `GAIOP_ADMIN_SQLITE_BACKUP_CLEANUP_ENABLED=false`

Upgrade 使用同名 `GAIOP_UPGRADE_*` 开关。创建和清理独立控制；清理还必须满足“本批新备份已验证”的硬门禁。两个模板中创建与清理均默认关闭，部署后需分别审批启用。

恢复验证只能选择受控备份根中的严格登记文件，先验证manifest、大小、SHA-256和源备份完整性，再通过 SQLite backup API 恢复到程序生成的临时测试数据库，执行完整 `integrity_check` 后删除临时库及 WAL/SHM。代码没有接受生产数据库目标路径的恢复接口。
