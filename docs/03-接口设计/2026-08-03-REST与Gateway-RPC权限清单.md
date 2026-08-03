# REST 与 Gateway RPC 权限清单（2026-08-03）

## 1. 口径与结论

本清单以 `server/index.js` 的 Express 实际注册顺序、挂载 Router、前端调用、BFF 调用和自动化测试为依据。`410` 前置屏障注册在全部产品 Router 和遗留处理器之前，因此后方同名源码不可达；它们仍保留在源码中，等待后续“遗留接口清退”。

角色列使用：`—` 未登录返回 `401`（公开项除外）；`本人` 仅本人会话或报告；`只读` 可读安全投影；`全量只读` 可读全部业务数据但不可写；`管理` 管理员读写。停用接口对所有调用方稳定返回 `410 ENDPOINT_RETIRED`。

除 `/api/auth/config`、`/api/auth/login`、`/api/auth/logout`、`/api/health` 和构建产物静态资源外，所有正式业务 REST 均需 Bearer 登录认证。登录 Token 不再接受 URL 查询参数。

## 2. 正式 REST 接口

| 方法与路径 | 模块 | 正式 | 未登录 | 基础 | 标准 | 审计 | 管理员 | 数据/敏感性 | 结论 |
|---|---|---:|---|---|---|---|---|---|---|
| GET `/api/auth/config` | 认证 | 是 | 公开 | 公开 | 公开 | 公开 | 公开 | 固定认证开关 | 保留 |
| POST `/api/auth/login` | 认证 | 是 | 公开 | 公开 | 公开 | 公开 | 公开 | 登录凭据入参；响应登录 Token | 保留，限流/锁定策略不变 |
| POST `/api/auth/logout` | 认证 | 是 | 幂等 200 | 本人 | 本人 | 本人 | 本人 | 仅请求头 Token | 保留 |
| GET `/api/auth/check` | 认证 | 是 | — | 本人 | 本人 | 本人 | 本人 | 当前安全账户字段 | 保留 |
| GET `/api/health` | 健康 | 是 | 公开 | 公开 | 公开 | 公开 | 公开 | 固定健康和连接摘要 | 保留 |
| GET `/api/status` | Gateway 状态 | 是 | — | 只读 | 只读 | 只读 | 只读 | Gateway 状态 | 保留 |
| POST `/api/rpc` | Gateway BFF | 是 | — | 显式集合 | 显式集合 | 显式只读 | 显式管理集合 | 业务数据；见第 4 节 | 收紧为默认拒绝 |
| GET `/api/events` | 实时事件 | 是 | — | 本人事件 | 本人事件 | 全量只读事件 | 全量事件 | 会话事件流 | 保留；Bearer fetch SSE、心跳和隔离 |
| GET `/api/dashboard/summary` | 仪表盘 | 是 | — | 本人会话口径 | 本人会话口径 | 全量只读 | 全量 | 聚合指标 | 保留 |
| GET `/api/dashboard/usage` | 仪表盘 Usage | 是 | — | 本人聚合 | 本人聚合 | 全量只读 | 全量 | 消息、Token、趋势、模型、工具聚合 | 保留 |
| GET `/api/channels/config` | 频道 | 是 | — | 安全状态 | 安全状态 | 安全状态 | 管理读取 | 非管理员无地址、密钥、原始配置 | 保留安全投影 |
| PUT `/api/channels/config` | 频道 | 是 | — | 403 | 403 | 403 | 管理 | 配置和凭据写入 | 管理员专属 |
| POST/GET/DELETE `/api/channels/feishu/onboarding[/:id]` | 频道接入 | 是 | — | 403 | 403 | 403 | 管理 | 接入凭据、二维码状态 | 管理员专属 |
| POST `/api/workspace/sessions` | 工作台会话 | 是 | — | 403 | 本人创建 | 403 | 管理 | 会话归属 | 标准/管理员 |
| GET `/api/alerts` | 告警 | 是 | — | 只读 | 只读 | 全量只读 | 全量 | 告警业务数据 | 保留 |
| GET `/api/alerts/time` | 告警 | 是 | — | 只读 | 只读 | 只读 | 只读 | 服务器时间 | 保留 |
| POST `/api/alerts/export` | 告警 | 是 | — | 当前页导出 | 当前页导出 | 当前页导出 | 当前页导出 | 告警业务数据 | 明确登录写能力 |
| GET `/api/users` | 账户 | 是 | — | 403 | 403 | 安全字段只读 | 管理读取 | 用户名、角色、状态；无密码哈希 | 审计/管理员可读 |
| POST `/api/users` | 账户 | 是 | — | 403 | 403 | 403 | 管理 | 新账户与临时密码入参 | 管理员专属 |
| PUT `/api/users/:id` | 账户 | 是 | — | 403 | 403 | 403 | 管理 | 角色、状态 | 管理员专属 |
| POST `/api/users/:id/reset-password` | 账户 | 是 | — | 403 | 403 | 403 | 管理 | 临时密码入参 | 管理员专属 |
| PUT `/api/users/:id/password` | 账户 | 是 | — | 本人 | 本人 | 本人 | 本人/管理 | 密码入参 | 本人改密并校验身份 |
| DELETE `/api/users/:id` | 账户 | 是 | — | 403 | 403 | 403 | 管理 | 账户状态 | 管理员专属 |
| GET `/api/audit-logs` | 审计 | 是 | — | 403 | 403 | 全量只读 | 全量 | 审计业务数据 | 审计/管理员只读 |
| GET `/api/reports` | 报告 | 是 | — | 本人 | 本人 | 全量只读 | 全量 | 报告元数据、安全来源字段 | 保留归属隔离 |
| GET `/api/reports/:id/download` | 报告 | 是 | — | 本人 | 本人 | 全量只读 | 全量 | 报告文件 | 保留归属隔离 |
| GET `/api/reports/:id/preview` | 报告 | 是 | — | 本人 | 本人 | 全量只读 | 全量 | PDF/文本报告内容 | 保留归属隔离 |
| DELETE `/api/reports/:id` | 报告 | 是 | — | 403 | 403 | 403 | 管理 | 报告和审计伴随文件 | 管理员专属 |
| GET/POST/PUT/DELETE `/api/data-sources[/:id]` | 数据源 | 是 | — | 安全列表/403 写 | 安全列表/403 写 | 安全列表/403 写 | 管理 | 密码永不回传，写入加密 | 保留；写管理员专属 |
| POST `/api/data-sources/:id/test` | 数据源 | 是 | — | 403 | 403 | 403 | 管理 | 连接诊断 | 管理员专属 |
| POST `/api/data-sources/:id/activate` | 数据源 | 是 | — | 403 | 403 | 403 | 管理 | 运行数据源选择 | 管理员专属 |
| GET `/api/system-settings/report-storage` | 系统设置 | 是 | — | 403 | 403 | 403 | 管理 | 正式报告目录，只读 | 管理员专属 |
| GET `/api/system-settings/sessions` | 会话策略 | 是 | — | 只读 | 只读 | 只读 | 管理读取 | 超时和保留策略 | 保留 |
| PUT `/api/system-settings/sessions` | 会话策略 | 是 | — | 403 | 403 | 403 | 管理 | 登录与 Gateway 策略 | 管理员专属 |
| GET/PUT `/api/system-config/gaiop-service` | 系统配置 | 是 | — | 403 | 403 | 403 | 管理 | 地址安全摘要；Token 只写不回传 | 管理员专属 |
| GET/PUT `/api/system-config/alert-ingestion` | 系统配置 | 是 | — | 403 | 403 | 403 | 管理 | 接收器配置安全摘要 | 管理员专属 |
| GET/PUT/DELETE `/api/system-config/environment[/:key]` | 敏感配置 | 是 | — | 403 | 403 | 403 | 管理 | 密钥只写/掩码，永不回传明文 | 管理员专属 |
| GET `/api/system/metrics` | 系统监控 | 是 | — | 403 | 只读 | 全量只读 | 全量 | 主机指标安全摘要 | 保留既有角色边界 |
| GET `/api/media?path=...` | 聊天媒体 | 是 | — | 本人会话 | 本人会话 | 全量只读会话 | 管理 | 图片业务内容、服务器文件 | 保留；Bearer + 会话头；路径/类型/大小约束 |
| GET/POST/PUT/DELETE `/api/wizard/scenarios[/:id]` | Wizard | 是 | — | 403 | 403 | 403 | 管理 | 场景配置 | 管理员专属 |
| GET/POST/PUT/DELETE `/api/wizard/tasks[/:id]` | Wizard | 是 | — | 403 | 403 | 403 | 管理 | 任务与会话历史 | 管理员专属 |
| GET `/api/system-upgrade/overview` | 系统升级 | 是 | — | 403 | 403 | 403 | 管理 | 安全版本/备份摘要 | 管理员专属 |
| POST `/api/system-upgrade/validate` | 系统升级 | 是 | — | 403 | 403 | 403 | 管理 | 升级包上传 | 管理员专属 |
| POST `/api/system-upgrade/tasks/:taskId/execute` | 系统升级 | 是 | — | 403 | 403 | 403 | 管理 | 执行升级 | 管理员专属 |
| GET `/api/system-upgrade/tasks/:taskId` | 系统升级 | 是 | — | 403 | 403 | 403 | 管理 | 任务进度安全字段 | 管理员专属 |
| POST `/api/system-upgrade/backups/:backupId/rollback` | 系统升级 | 是 | — | 403 | 403 | 403 | 管理 | 回滚操作 | 管理员专属 |
| DELETE `/api/system-upgrade/backups/:backupId` | 系统升级 | 是 | — | 403 | 403 | 403 | 管理 | 受控备份删除 | 管理员专属 |

## 3. 已停用入口（410，源码尚未删除）

以下前缀在 `express.json()` 之后、所有业务 Router 之前由 `registerRetiredApiBarriers()` 注册。任何 HTTP 方法和子路径均先命中 `410 ENDPOINT_RETIRED`，后面的遗留实现不可达。

| 前缀 | 遗留模块 | 原风险/判定 | 当前结论 |
|---|---|---|---|
| `/api/npm/*` | 旧 npm 升级 | versions 曾匿名；update 是旧升级链 | 410；不影响 `/api/system-upgrade/*` |
| `/api/backup/*` | 旧 Admin 备份 | list/tasks/download 曾允许普通登录读取 | 410；正式升级备份仍由升级 BFF 管理 |
| `/api/terminal/*` | 远程终端 | 命令执行和流式终端，无正式路由依赖 | 410，源码待清退 |
| `/api/desktop/*` | 远程桌面 | 屏幕和输入控制，无正式路由依赖 | 410，源码待清退 |
| `/api/hermes/*`、`/api/hermes-cli/*` | Hermes 遗留 | 非正式运行模式 | 从 404 统一为 410，源码待清退 |
| `/api/files/*` | 旧工作区文件 | 文件路径和内容操作；正式“文件管理”实际走 `/api/reports` | 410，后续处理器不可达 |
| `/api/config/*` | 旧原始配置 | 原始配置读写；正式配置走 `/api/system-config/*` | 410，后续处理器不可达 |
| `/api/agents/workspace/*` | 旧文件辅助 | 返回服务器工作区真实路径；仅为旧 files 链路服务 | 410，源码待清退 |

## 4. Gateway RPC 正式集合与四角色矩阵

所有方法先经过 `FORMAL_RPC_METHODS`。未登记方法在 Gateway 连接检查和实际转发前返回 `403 RPC_METHOD_NOT_SUPPORTED`；管理员也没有通配放行。`unknown.list`、`unknown.get`、`unknown.status` 不因名称看似只读而获得权限。

| 方法组 | 基础 | 标准 | 审计 | 管理员 | 数据范围/投影 |
|---|---|---|---|---|---|
| `sessions.list/get/history/usage`、`session.*` 读别名、`chat.history` | 本人 | 本人 | 全量只读 | 全量 | BFF 校验归属；Usage 按本人完整重聚合 |
| `sessions.delete`、`session.delete` | 本人 | 本人 | 拒绝 | 全量 | 本人归属校验；审计只读 |
| `chat.send`、`agent` 对话回退、`chat.abort`、`agent.abort` | 拒绝 | 本人 | 拒绝 | 允许 | 标准必须携带并通过本人 sessionKey |
| `sessions.reset/spawn/send/patch` 及单数别名 | 拒绝 | 本人 | 拒绝 | 允许 | 标准必须通过本人归属校验 |
| `usage.cost`、`cost.usage` | 拒绝 | 拒绝 | 全量只读 | 全量 | 全局成本不下放基础/标准 |
| `channels.status/list`、`channel.status/list`、`plugins.list/status` | 安全只读 | 安全只读 | 安全只读 | 全量 | 非管理员移除地址、路径、Token、密钥、原始配置 |
| `skills.status/list` | 拒绝 | 安全只读 | 安全只读 | 全量 | 非管理员安全投影 |
| `config.get` | 拒绝 | 模型选择安全投影 | 拒绝 | 全量 | 标准不获得底层连接/凭据 |
| `health`、`status` | 只读 | 只读 | 只读 | 全量 | 正式状态页所需 |
| `system-presence`、`node.list` | 拒绝 | 只读 | 全量只读 | 全量 | 系统监控页面 |
| `cron.list/status/runs/history` 及现用别名 | 拒绝 | 拒绝 | 全量只读 | 全量 | 审计只读 |
| `config.patch/apply/set`、频道认证/配对、Skills 安装/更新 | 拒绝 | 拒绝 | 拒绝 | 允许 | 管理写 |
| Agents/agent files、models、tools、Cron 写方法 | 拒绝 | 拒绝 | 拒绝 | 允许 | 正式管理员页面 |
| `logs.tail`、`exec.approvals.*`、`node.invoke/pair.*` | 拒绝 | 拒绝 | 拒绝 | 允许 | 单列管理员诊断集合，含日志/审批/节点控制 |
| `update.run` | 拒绝 | 拒绝 | 拒绝 | 允许 | 现有系统监控页面 Gateway 更新动作 |
| `sessions.export`、`session.export` | 拒绝 | 拒绝 | 拒绝 | 允许 | 敏感会话导出 |
| 任意未登记 RPC | 拒绝 | 拒绝 | 拒绝 | 拒绝 | 默认拒绝，不做后缀推断 |

管理员正式集合的精确代码定义位于 `server/lib/permissions.js`；集合包含前端 `rpc-client.ts` 中正式页面实际使用的当前方法及兼容别名，不包含远程桌面 RPC、通用 `send` 或其他未使用能力。

## 5. `/api/events` 与 `/api/media` 特殊保留说明

- `/api/events` 使用 `fetch` 读取流式 SSE，并仅在 `Authorization: Bearer` 请求头携带登录 Token；URL 无 Token。保留 SSE 分帧、注释心跳、指数退避重连、401 停止重连并清除登录、退出 Abort、重复连接防护，以及 BFF 的 sessionKey 事件隔离。
- `/api/media` 不支持原生 `<img>` 匿名读取。前端先用 Bearer 和 `X-GAIOP-Session-Key` 获取 Blob，再生成临时对象 URL。服务端只允许配置媒体根目录内的 PNG/JPEG/GIF/WebP/BMP，拒绝绝对路径、`.`/`..`、符号链接越界、非图片扩展和超过 25 MiB 的文件；非管理员必须通过会话范围校验。

## 6. 后续边界

- “遗留接口清退”：物理删除第 3 节源码、旧前端组件、依赖和无用数据库结构；本次不做。
- “权限拒绝审计”：记录 401/403/410 拒绝事件并改造审计信息；本次不做。
- 不建设动态 RBAC/ABAC，不修改 GAIOP 后端、OpenClaw 核心或频道插件。
