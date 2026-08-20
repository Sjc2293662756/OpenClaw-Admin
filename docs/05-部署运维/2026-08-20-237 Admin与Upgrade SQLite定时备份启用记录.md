# 2026-08-20 237 Admin 与 Upgrade SQLite 定时备份启用记录

## 1. 结论与范围

本批已在 237 启用两套组件自有 SQLite 定时备份：

- Admin：`/var/lib/gaiop/admin/wizard.db`；
- Upgrade：当前 `gaiop-upgrade.service` 进程实际打开的 `/var/lib/gaiop-upgrade/napm-upgrade.db`。

两套机制均只启用备份创建，过期备份清理开关继续为 `false`。本批没有删除、替换或恢复生产数据库，没有重启 Admin、Upgrade、Gateway 或 Caddy，也没有启用报告、会话或其他留存 timer。

- 成功批次：`20260820T084000Z`；
- 回滚点：`/var/backups/gaiop/sqlite-backup-enable-20260820T084000Z`；
- Admin 发布器：`dev-yangshuo` 的 `a3f0f17411c6550dfe152fa8d45406b3243feb43`；
- Upgrade 备份代码：`dev-yangshuo` 的 `cdd9fdb5fed46a9bb82889e9db117a202717a66c`。

## 2. 实施方式

两个备份 one-shot 均通过组件现有 `better-sqlite3` 依赖调用 SQLite online backup API，不直接复制运行中的 WAL 数据库。一次一致性快照分别发布为当前 UTC 日、ISO 周和月份三层备份；每份数据库配套 manifest，并验证：

- 文件名、组件、层级和周期；
- 文件大小及 SHA-256；
- 完整 `PRAGMA integrity_check=ok`；
- 独立备份为 `DELETE` journal；
- 同一组件三层文件来自同一快照，大小和哈希一致；
- 目录为 `0700`，数据库和 manifest 为 `0600`。

保留设计仍为每日 30 个周期、每周 12 个周期、每月 12 个周期。当前清理开关关闭，因此 timer 只幂等补齐当前三个周期，不会删除历史备份。

生产 unit 使用独立、无业务秘密的策略文件和生产 drop-in，不再继承 Admin 或 Upgrade 主服务环境文件。有效 unit 固定真实数据库、真实代码入口、组件自有备份根和 `/run` 锁目录；`RuntimeDirectoryPreserve=no`、`TimeoutStartSec=15min`、`UMask=0077`，并隐藏另一组件数据库、告警目录、升级包/回滚目录及主环境文件。

Admin 备份执行入口目录和文件、两组件备份依赖树均收紧为组用户及其他用户不可写；收紧前权限清单保存在回滚点。Upgrade 主数据库、WAL 和 SHM 从 `0644` 收紧为 `0640`，未重启主服务，健康检查保持正常。

## 3. 首次备份与恢复验证

首次三层文件在受控尝试中生成。该次备份文件、manifest、哈希和完整性均已通过，但临时恢复验证因沙箱把备份根设为只读而失败；发布器完整回退 timer、drop-in、策略和 Upgrade 数据库原权限，并保留已经验证的备份证据，没有覆盖生产库。

成功批次修正恢复验证沙箱后，对已有当前周期文件重新执行全部身份、权限、manifest、哈希、journal 和完整性校验，不覆盖同周期备份；随后完成：

| 组件 | 当前周期备份 | 临时恢复验证 | 幂等复跑 | 清理状态 |
| --- | --- | --- | --- | --- |
| Admin | daily / weekly / monthly 各 1 份 | 3/3 通过 | `created=[]` | `disabled` |
| Upgrade | daily / weekly / monthly 各 1 份 | 3/3 通过 | `created=[]` | `disabled` |

恢复测试仅在组件自有 `sqlite-restore-tests` 随机临时库中执行。每层恢复后再次完成完整性检查，临时数据库、WAL 和 SHM 随即移除；两个临时恢复目录最终均为空。

启用前容量门禁要求至少保留两库当前大小 60 倍再加 100 MiB。现场可用 `42,068,979,712 B`，门禁需求 `449,224,480 B`，通过。

## 4. Timer 与最终状态

- `gaiop-admin-sqlite-backup.timer`：`active/enabled`；每日 `01:20 UTC`，随机延迟 0 至 10 分钟，下一次为 2026-08-21 09:27:56 CST。
- `gaiop-upgrade-sqlite-backup.timer`：`active/enabled`；每日 `01:35 UTC`，随机延迟 0 至 10 分钟，下一次为 2026-08-21 09:37:01 CST。
- `Persistent=true`，服务器错过计划时间后会补跑。

成功批次后 2026-08-20 08:18:16 UTC 只读复核：

- `wizard.db` 和 `napm-upgrade.db` 完整性均为 `ok`；
- Admin 总行数 1942；用户 6、会话 63、报告 228、交付 9；
- Upgrade 总行数 19；任务 2、组件 14、回滚备份登记 0；
- Admin、Upgrade、Gateway、Caddy 均为 `active`；内部健康、Gateway、HTTPS 回环和公网均为 HTTP 200，Upgrade 未认证接口为 HTTP 401；
- 文件系统 `df -P` 为 58%，原始使用率约 57.28%，水位正常；
- Admin 第一批清理、Upgrade 第一批清理、水位监测及两套 SQLite 备份 timer 均为 `active/enabled`；
- 报告留存和会话留存 timer 仍为 `inactive/disabled`。

首次自然计划周期尚未到达；本批已使用与 timer 相同的正式 systemd service 完成关闭态、创建态和幂等态 one-shot 验证。自然周期不得在到达前伪报为已观察。

## 5. 回滚与权限边界

如需停止本批，应先禁用并停止两个 SQLite timer，再按成功回滚点恢复或移除本批 drop-in 和独立策略文件，执行 `systemctl daemon-reload` 后恢复原 timer 状态。回滚不得删除已经生成的数据库备份、manifest、发布前在线安全快照或恢复验证证据，也不得用任何备份自动覆盖生产数据库。

发布器失败回滚会恢复 timer、unit、drop-in、策略文件和 Upgrade 数据库原权限；代码入口取消组/其他用户写权限属于保留的安全加固，不自动放宽。成功批次将 Upgrade 数据库权限保留为 `0640`。未来若主数据库被重新创建，仍需在 Upgrade 主服务交付基线中统一收紧 `UMask`，不能仅依赖本次文件权限。

过期备份自动清理仍未启用。后续只有在自然周期和跨周期备份均验证正常后，才能单独评估开启清理；开启前必须再次列举备份对、未知项、损坏项和可释放空间，不能把本次“创建已启用”描述为“过期删除已启用”。
