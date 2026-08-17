# 2026-08-17 237 Admin 与 Upgrade 统一留存关闭态发布记录

## 1. 范围与结论

第十批仅发布第九批已收口的 Admin 与 Upgrade 代码版本，并保持所有自动留存处理、SQLite 备份创建/清理和数据库切换关闭。Upgrade 先发布，Admin 后发布；后端留存分支没有部署，Caddy、rsyslog、journald 和 logrotate 模板没有应用。

非水位留存和备份 timer 在发布后通过固定 allowlist 停止并禁用。磁盘水位 one-shot 已验证，但由于 `upgrade_rollback` 无法由 `gaiop` 完成 `stat/statfs`，水位 timer 保持禁用。本批未调用清理器、未删除或移动生产业务数据、未读取生产会话或附件内容。

## 2. 实时基线与发布批次

发布前从实时 `origin/dev-yangshuo` 建立隔离 worktree，未修改原工作副本。

| 组件 | 实际发布批次 | 生产目录 | 回滚点 | 发布包 SHA-256 |
| --- | --- | --- | --- | --- |
| Upgrade | `20260817T083414Z` | `/opt/gaiop-upgrade-e2e-20260805` | `/var/backups/gaiop/deployments/upgrade-retention-20260817T083414Z` | `5041715bf6ba4fe06e347cd8e58f243b9c7817feb5bcb7fe4204c4cf32efcc12` |
| Admin | `20260817T085823Z` | `/opt/gaiop/admin` | `/var/backups/gaiop/admin-prestage-20260817T085823Z` | `90e3263e228c5e756d554279037eb688134278933d2c9f13037bb9eab563127e` |

Upgrade 使用 `/var/lib/gaiop-upgrade/napm-upgrade.db` 的受控 SQLite 在线备份，`PRAGMA integrity_check` 为 `ok`；Admin 使用 `/var/lib/gaiop/admin/wizard.db` 的受控 SQLite 在线备份，完整性为 `ok`。两次发布均记录发布前后计数并保持不变。Admin 三个失败批次 `20260817T083414Z`、`20260817T085035Z`、`20260817T085500Z` 已按发布器自动回滚并保留，未清理发布备份。

## 3. 发布后验证

- `gaiop-admin.service`、`gaiop-upgrade.service`、Gateway 和 Caddy 均为 `active`。
- Admin 监听 `127.0.0.1:3000`，Upgrade 监听 `127.0.0.1:18900`；Admin/Upgrade/Gateway 内部健康均为 `200`，Upgrade 未认证接口为 `401`，公网 HTTPS 为 `200`。
- `wizard.db` 完整性为 `ok`；最终核查总行数 `1906`，用户 `6`、会话 `63`、报告文件 `222`、交付 `9`、审计 `1575`。相对发布后首轮核查仅新增 `3` 条验证审计，四项业务计数不变。
- `napm-upgrade.db` 完整性为 `ok`，总行数 `19`；升级任务 `2`、组件 `14`、SQLite 备份 `0`。
- 发布前后目录计数不变：报告来源信封 `63`、Admin staging `0`、升级包 `2`、升级 staging `0`、升级回滚目录 `3`、正式报告根目录 `11`。
- Admin/Upgrade 第一批清理、报告留存、会话留存和 SQLite 备份 one-shot 均返回关闭态；没有调用清理器。
- 全部非水位 timer 均为 `inactive/disabled`：Admin/Upgrade 第一批、报告、会话、Admin SQLite、Upgrade SQLite。水位 timer 也为 `inactive/disabled`。

## 4. 水位监测门禁

配置实际登记九个标签：`admin_state`、`runtime_state`、`formal_reports`、`upgrade_state`、`upgrade_rollback`、`admin_upgrade_staging`、`gateway_state`、`raw_syslog`、`caddy_access_logs`。

直接以 `gaiop` 进行固定根目录核查时，`admin_state`、`runtime_state`、`formal_reports`、`upgrade_state`、`admin_upgrade_staging`、`raw_syslog`、`caddy_access_logs` 合并到同一设备文件系统，使用率约 `54.92%`，状态 `normal`；`upgrade_rollback` 和 `gateway_state` 返回 `managed_root_permission_denied`。水位服务自身的 systemd 只读绑定使 one-shot 状态表识别了 `gateway_state`，但仍有 `upgrade_rollback` 未识别，因此不能启用 timer。

水位验证结果：原生 `systemd-analyze verify` 为 `ok`；连续两次 one-shot 的事件计数为 `1 -> 1 -> 1`，事件增量 `0/0`；数据库完整性为 `ok`；角色边界和输出脱敏测试通过。验证只执行 `stat/statfs` 和状态写入，没有遍历目录、读取业务文件、调用清理器或删除文件。

## 5. 关闭态与未闭环

自动删除、报告/会话自动处理、Admin/Upgrade SQLite 备份创建与清理、后端告警 SQLite 导入/切换/删除均未启用。80% 清理、90% 应急清理、高容量写入阻断和数据删除 API 均不存在或未接入。

由于 `upgrade_rollback` 的权限问题，本批不修改权限、不扩大监测范围，水位 timer 保持禁用。后续需单独规划可由 `gaiop` 安全核查全部九个标签后的 timer 启用；本记录不授权任何清理机制。

## 6. 测试结果

- Admin Node：`173/174`；唯一失败是实时基线已有的报告来源固定时间/文件 mtime 用例，本批未修改该逻辑。
- Admin Vitest：`21` 个文件、`87/87` 通过。
- Admin 前端生产构建：`4646` modules，通过。
- Upgrade：Node 22.23.2 下全仓 `89/89` 通过。Node 24 直接运行因本机 `better-sqlite3` ABI 127/137 不匹配而不可用，不属于代码失败。
- Admin/Upgrade JavaScript 语法、PowerShell parser、systemd 静态契约及 `git diff --check` 通过。
