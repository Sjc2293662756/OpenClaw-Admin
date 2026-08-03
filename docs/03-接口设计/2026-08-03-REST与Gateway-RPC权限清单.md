# REST 与 Gateway RPC 权限清单（2026-08-03）

## 1. 口径与结论

本清单以 `server/index.js` 的 Express 实际注册顺序、挂载 Router、前端调用、BFF 调用和自动化测试为依据。`410` 前置屏障注册在全部产品 Router 和遗留处理器之前，因此后方同名源码不可达。当前正式决策是保留这些源码，不把物理删除列为安全缺口；后期仅在依赖明确时分阶段整理。

角色列使用：`—` 未登录返回 `401`（公开项除外）；`本人` 仅本人会话或报告；`只读` 可读安全投影；`全量只读` 可读全部业务数据但不可写；`管理` 管理员读写。停用接口对所有调用方稳定返回 `410 ENDPOINT_RETIRED`。

除 `/api/auth/config`、`/api/auth/login`、`/api/auth/logout`、`/api/health` 和构建产物静态资源外，所有正式业务 REST 均需 Bearer 登录认证。登录 Token 不再接受 URL 查询参数。

### 1.1 核查依据

| 依据 | 用途 |
|---|---|
| `server/index.js` | 确定 Express 中间件和直接路由的真实注册顺序 |
| `server/routes/**` | 展开每个挂载 Router 内的方法、子路径和中间件 |
| `src/router/routes.ts` | 判断是否存在正式 GAIOP 页面入口 |
| `src/api/rpc-client.ts`、`src/stores/**`、`src/views/**` | 确定前端和 BFF 实际调用的 RPC 及兼容别名 |
| `server/lib/permissions.js` | 权威的 RPC 正式集合、四角色决策和默认拒绝规则 |
| `server/lib/session-ownership-service.js` | 会话归属、事件隔离、本人 Usage 重聚合和历史默认会话隐藏 |
| Node/Vitest 直接测试 | 验证绕过前端时 REST/RPC 仍受限，测试数据与生产用户隔离 |
| 237 回环生产探针 | 验证未登录 401、遗留入口 410、健康状态和回环监听 |

### 1.2 Express 真实注册层次

Express 以“先注册先匹配”执行，本次不以文本中是否还能搜到旧 handler 判断可达性。实际层次如下：

1. `cors`、`compression`、`express.json()` 全局中间件。`/api/events` 不进入压缩，避免 SSE 缓冲。
2. `registerRetiredApiBarriers(app)` 立即注册九组遗留前缀；这一层早于任何正式 Router 和遗留 handler。
3. 认证、系统设置、系统配置、升级、仪表盘、频道、工作台会话、告警、用户、审计、数据源、报告和媒体等正式 Router。
4. `/api/health`、`/api/system/metrics`、`/api/status`、`/api/rpc`、`/api/events` 等直接正式路由。
5. terminal、desktop、Hermes、files、config、backup 等遗留 handler 仍保留在文件后部，但已被第 2 层截断。
6. Wizard 正式管理路由、生产静态资源和 SPA fallback。

### 1.3 稳定状态码语义

| HTTP | 稳定含义 | 典型 code | 是否暴露对象存在性 |
|---:|---|---|---|
| 400 | 请求结构、方法名或路径输入无效 | `RPC_METHOD_REQUIRED`、`INVALID_MEDIA_PATH` | 不适用 |
| 401 | 未携带 Bearer、Token 无效或登录过期 | `UNAUTHORIZED` | 否 |
| 403 | 已登录，但角色或 RPC 正式集合不允许 | `PERMISSION_DENIED`、`RPC_METHOD_NOT_SUPPORTED`、`AUDITOR_READ_ONLY` | 否 |
| 404 | 资源不存在或不能证明归属；两者故意统一 | `SESSION_NOT_FOUND`、`MEDIA_NOT_FOUND`、`REPORT_NOT_FOUND` | 否 |
| 410 | 接口已从正式产品退役，不应再试 | `ENDPOINT_RETIRED` | 仅表明前缀已退役 |
| 503 | 正式能力存在，但 Gateway 或依赖服务暂不可用 | `GATEWAY_UNAVAILABLE` 等 | 否 |

### 1.4 本清单覆盖规模

| 对象 | 数量 | 说明 |
|---|---:|---|
| 正式 REST 方法+路径 | 64 | 第 2 节逐项列出，不把同一路径的不同 HTTP 方法合并 |
| 统一退役前缀 | 9 | 对任意方法和子路径前置返回 410；详见第 3 节 |
| 正式 Gateway RPC 方法 | 106 | 均在 `FORMAL_RPC_METHODS` 中逐字登记，没有管理员通配 |
| 管理员诊断 RPC | 8 | 上述 106 项的子集，单独列出并说明正式使用理由 |
| 特殊保留内容链路 | 2 | `/api/events` 实时事件和 `/api/media` 聊天图片 |

数量用于后续复核变更：新增 REST/RPC 时必须同步更新代码白名单、本清单和四角色直接调用测试；不能只在前端增加按钮或页面调用。

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
| POST `/api/channels/feishu/onboarding` | 频道接入 | 是 | — | 403 | 403 | 403 | 管理 | 启动短期二维码接入流程 | 管理员专属 |
| GET `/api/channels/feishu/onboarding/:id` | 频道接入 | 是 | — | 403 | 403 | 403 | 管理 | 仅返回短期流程状态 | 管理员专属 |
| DELETE `/api/channels/feishu/onboarding/:id` | 频道接入 | 是 | — | 403 | 403 | 403 | 管理 | 取消接入流程 | 管理员专属 |
| POST `/api/workspace/sessions` | 工作台会话 | 是 | — | 403 | 本人创建 | 403 | 管理 | 会话归属 | 标准/管理员 |
| GET `/api/alerts` | 告警 | 是 | — | 只读 | 只读 | 全量只读 | 全量 | 告警业务数据 | 保留 |
| GET `/api/alerts/time` | 告警 | 是 | — | 只读 | 只读 | 只读 | 只读 | 服务器时间 | 保留 |
| POST `/api/alerts/export` | 告警 | 是 | — | 当前页导出 | 当前页导出 | 当前页导出 | 当前页导出 | 告警业务数据 | 明确登录写能力 |
| GET `/api/users` | 账户 | 是 | — | 403 | 403 | 安全字段只读 | 管理读取 | 用户名、角色、状态；无密码哈希 | 审计/管理员可读 |
| POST `/api/users` | 账户 | 是 | — | 403 | 403 | 403 | 管理 | 新账户与临时密码入参 | 管理员专属 |
| PUT `/api/users/:id` | 账户 | 是 | — | 403 | 403 | 403 | 管理 | 角色、状态 | 管理员专属 |
| POST `/api/users/:id/reset-password` | 账户 | 是 | — | 403 | 403 | 403 | 管理 | 临时密码入参 | 管理员专属 |
| PUT `/api/users/:id/password` | 账户 | 是 | — | 本人 | 本人 | 本人 | 本人 | 当前密码和新密码入参 | 仅本人改密并校验当前密码；管理员修改他人须走 reset-password |
| DELETE `/api/users/:id` | 账户 | 是 | — | 403 | 403 | 403 | 管理 | 账户状态 | 管理员专属 |
| GET `/api/audit-logs` | 审计 | 是 | — | 403 | 403 | 全量只读 | 全量 | 审计业务数据 | 审计/管理员只读 |
| GET `/api/reports` | 报告 | 是 | — | 本人 | 本人 | 全量只读 | 全量 | 报告元数据、安全来源字段 | 保留归属隔离 |
| GET `/api/reports/:id/download` | 报告 | 是 | — | 本人 | 本人 | 全量只读 | 全量 | 报告文件 | 保留归属隔离 |
| GET `/api/reports/:id/preview` | 报告 | 是 | — | 本人 | 本人 | 全量只读 | 全量 | PDF/文本报告内容 | 保留归属隔离 |
| DELETE `/api/reports/:id` | 报告 | 是 | — | 403 | 403 | 403 | 管理 | 报告和审计伴随文件 | 管理员专属 |
| GET `/api/data-sources` | 数据源 | 是 | — | 安全列表 | 安全列表 | 安全列表 | 管理读取 | 不返回密码明文或密文 | 保留安全投影 |
| POST `/api/data-sources` | 数据源 | 是 | — | 403 | 403 | 403 | 管理 | 数据源地址和凭据写入 | 管理员专属，凭据加密存储 |
| PUT `/api/data-sources/:id` | 数据源 | 是 | — | 403 | 403 | 403 | 管理 | 更新地址、描述和凭据 | 管理员专属 |
| DELETE `/api/data-sources/:id` | 数据源 | 是 | — | 403 | 403 | 403 | 管理 | 删除配置记录 | 管理员专属 |
| POST `/api/data-sources/:id/test` | 数据源 | 是 | — | 403 | 403 | 403 | 管理 | 连接诊断 | 管理员专属 |
| POST `/api/data-sources/:id/activate` | 数据源 | 是 | — | 403 | 403 | 403 | 管理 | 运行数据源选择 | 管理员专属 |
| GET `/api/system-settings/report-storage` | 系统设置 | 是 | — | 403 | 403 | 403 | 管理 | 正式报告目录，只读 | 管理员专属 |
| GET `/api/system-settings/sessions` | 会话策略 | 是 | — | 只读 | 只读 | 只读 | 管理读取 | 超时和保留策略 | 保留 |
| PUT `/api/system-settings/sessions` | 会话策略 | 是 | — | 403 | 403 | 403 | 管理 | 登录与 Gateway 策略 | 管理员专属 |
| GET `/api/system-config/gaiop-service` | 系统配置 | 是 | — | 403 | 403 | 403 | 管理 | Gateway 地址和“Token 已配置”布尔摘要 | 管理员专属，Token 不回传 |
| PUT `/api/system-config/gaiop-service` | 系统配置 | 是 | — | 403 | 403 | 403 | 管理 | Gateway 地址和 Token 只写更新 | 管理员专属 |
| GET `/api/system-config/alert-ingestion` | 系统配置 | 是 | — | 403 | 403 | 403 | 管理 | 告警接收器安全状态 | 管理员专属 |
| PUT `/api/system-config/alert-ingestion` | 系统配置 | 是 | — | 403 | 403 | 403 | 管理 | 接收器启停和目标配置 | 管理员专属 |
| GET `/api/system-config/environment` | 敏感配置 | 是 | — | 403 | 403 | 403 | 管理 | 配置项元数据和掩码状态 | 管理员专属，不回传敏感明文 |
| PUT `/api/system-config/environment/:key` | 敏感配置 | 是 | — | 403 | 403 | 403 | 管理 | 敏感值只写并加密 | 管理员专属 |
| DELETE `/api/system-config/environment/:key` | 敏感配置 | 是 | — | 403 | 403 | 403 | 管理 | 删除指定配置记录 | 管理员专属 |
| GET `/api/system/metrics` | 系统监控 | 是 | — | 403 | 只读 | 全量只读 | 全量 | 主机指标安全摘要 | 保留既有角色边界 |
| GET `/api/media?path=...` | 聊天媒体 | 是 | — | 本人会话 | 本人会话 | 全量只读会话 | 管理 | 图片业务内容、服务器文件 | 保留；Bearer + 会话头；路径/类型/大小约束 |
| GET `/api/wizard/scenarios` | Wizard | 是 | — | 403 | 403 | 403 | 管理 | 场景列表 | 管理员专属 |
| GET `/api/wizard/scenarios/:id` | Wizard | 是 | — | 403 | 403 | 403 | 管理 | 场景详情 | 管理员专属 |
| POST `/api/wizard/scenarios` | Wizard | 是 | — | 403 | 403 | 403 | 管理 | 创建场景 | 管理员专属 |
| PUT `/api/wizard/scenarios/:id` | Wizard | 是 | — | 403 | 403 | 403 | 管理 | 更新场景 | 管理员专属 |
| DELETE `/api/wizard/scenarios/:id` | Wizard | 是 | — | 403 | 403 | 403 | 管理 | 删除场景 | 管理员专属 |
| GET `/api/wizard/tasks` | Wizard/Office | 是 | — | 403 | 403 | 403 | 管理 | 任务列表 | 管理员专属 |
| GET `/api/wizard/tasks/:id` | Wizard/Office | 是 | — | 403 | 403 | 403 | 管理 | 任务、会话和执行历史 | 管理员专属 |
| POST `/api/wizard/tasks` | Wizard/Office | 是 | — | 403 | 403 | 403 | 管理 | 创建任务 | 管理员专属 |
| PUT `/api/wizard/tasks/:id` | Wizard/Office | 是 | — | 403 | 403 | 403 | 管理 | 更新任务和历史 | 管理员专属 |
| DELETE `/api/wizard/tasks/:id` | Wizard/Office | 是 | — | 403 | 403 | 403 | 管理 | 删除任务 | 管理员专属 |
| GET `/api/system-upgrade/overview` | 系统升级 | 是 | — | 403 | 403 | 403 | 管理 | 安全版本/备份摘要 | 管理员专属 |
| POST `/api/system-upgrade/validate` | 系统升级 | 是 | — | 403 | 403 | 403 | 管理 | 升级包上传 | 管理员专属 |
| POST `/api/system-upgrade/tasks/:taskId/execute` | 系统升级 | 是 | — | 403 | 403 | 403 | 管理 | 执行升级 | 管理员专属 |
| GET `/api/system-upgrade/tasks/:taskId` | 系统升级 | 是 | — | 403 | 403 | 403 | 管理 | 任务进度安全字段 | 管理员专属 |
| POST `/api/system-upgrade/backups/:backupId/rollback` | 系统升级 | 是 | — | 403 | 403 | 403 | 管理 | 回滚操作 | 管理员专属 |
| DELETE `/api/system-upgrade/backups/:backupId` | 系统升级 | 是 | — | 403 | 403 | 403 | 管理 | 受控备份删除 | 管理员专属 |

### 2.1 同路径多实现的真实可达性

| 路径 | 源码现状 | 实际命中 | 安全结论 |
|---|---|---|---|
| `GET /api/audit-logs` | `server/index.js` 直接 handler 与 `createAuditRouter()` 都存在 | 先注册的直接 handler | 两者均使用 `auditViewerMiddleware`；审计/管理员读边界一致 |
| `/api/data-sources` 列表、创建、编辑、删除、测试 | 直接 handler 和 `createDataSourcesRouter()` 有重复 | 先注册的直接 handler | 读使用安全投影，写/测试为管理员；后续物理清理可合并为单一 Router |
| `POST /api/data-sources/:id/activate` | 仅 `createDataSourcesRouter()` 提供 | Router handler | 管理员专属 |
| `/api/files/*` | 前置退役屏障、中部二次屏障和后部文件 handler 并存 | 最前置 410 | 认证中间件和后续 handler 都不再可达 |
| `/api/config` | 前置退役屏障、中部二次屏障和后部原始配置 handler 并存 | 最前置 410 | 不可用旧路径绕过 `/api/system-config/*` |
| npm、backup、terminal、desktop、Hermes | 旧 handler 仍可在 `server/index.js` 搜到 | 最前置 410 | “搜到源码”不等于“网络可达” |

### 2.2 业务数据范围执行点

| 数据类型 | 基础/标准 | 审计 | 管理员 | 服务端执行点 |
|---|---|---|---|---|
| WebChat 会话列表、历史、用量 | 仅 `workspace_sessions.owner_user_id` 归属的 active 会话 | 全量只读 | 全量 | `listOwnedWorkspaceSessionKeys`、`ensureWorkspaceSessionAccess`、`filterSessionListPayload` |
| WebChat 会话删除/重置/发送 | 基础仅可删本人；标准可在本人会话中执行正式对话操作 | 全部拒绝 | 允许 | `/api/rpc` 在转发 Gateway 前先解析 sessionKey 并查归属 |
| Usage | 先过滤本人会话，再重算消息、Token、趋势、模型、工具和分组聚合 | 全量只读 | 全量 | `filterSessionUsagePayload`；不是全局数据透传，也不是简单清零 |
| 报告列表、预览、下载 | 仅 `source_user_id` 匹配本人 | 全量只读 | 全量 | `resolveReportOrError`和报告列表 SQL 条件 |
| 实时 SSE 会话事件 | 仅能接收可访问 sessionKey 的事件 | 全量只读 | 全量 | `extractSessionKeyFromEvent` + `canAccessWorkspaceSession` |
| 聊天媒体 | 必须携带并通过 `X-GAIOP-Session-Key` 归属 | 携带会话标识后全量只读 | 管理访问 | `createMediaRouter` 先认证/会话授权，再读文件 |
| 用户账户 | 无权列表 | 只读安全字段 | 管理 | `accountViewerMiddleware` + `publicUser` |
| 频道、插件、Skills、标准配置 | 仅页面需要的安全状态/模型选择投影 | 相应安全只读投影 | 完整管理数据 | `projectSafe*Payload`、`projectStandardGatewayConfig` |

## 3. 已停用入口（410，源码尚未删除）

以下前缀在 `express.json()` 之后、所有业务 Router 之前由 `registerRetiredApiBarriers()` 注册。任何 HTTP 方法和子路径均先命中 `410 ENDPOINT_RETIRED`，后面的遗留实现不可达。

| 前缀 | 遗留模块 | 原风险/判定 | 当前结论 |
|---|---|---|---|
| `/api/npm/*` | 旧 npm 升级 | versions 曾匿名；update 是旧升级链 | 410；不影响 `/api/system-upgrade/*` |
| `/api/backup/*` | 旧 Admin 备份 | list/tasks/download 曾允许普通登录读取 | 410；正式升级备份仍由升级 BFF 管理 |
| `/api/terminal/*` | 远程终端 | 命令执行和流式终端，无正式路由依赖 | 410；源码保留，后期按依赖评估 |
| `/api/desktop/*` | 远程桌面 | 屏幕和输入控制，无正式路由依赖 | 410；源码保留，后期按依赖评估 |
| `/api/hermes/*`、`/api/hermes-cli/*` | Hermes 遗留 | 非正式运行模式 | 从 404 统一为 410；源码保留，后期按依赖评估 |
| `/api/files/*` | 旧工作区文件 | 文件路径和内容操作；正式“文件管理”实际走 `/api/reports` | 410，后续处理器不可达 |
| `/api/config/*` | 旧原始配置 | 原始配置读写；正式配置走 `/api/system-config/*` | 410，后续处理器不可达 |
| `/api/agents/workspace/*` | 旧文件辅助 | 返回服务器工作区真实路径；仅为旧 files 链路服务 | 410；源码保留，后期按依赖评估 |

### 3.1 被屏蔽的已知遗留路由

| 前缀 | 后方仍保留的典型路由 | 为何本次不物理删除 |
|---|---|---|
| `/api/npm` | `GET /versions`、`POST /update` | 与正式 `/api/system-upgrade` 区分后先停用网络入口，依赖和源码删除留待专项 |
| `/api/backup` | `GET /list`、`GET /tasks`、`GET /tasks/:taskId`、`GET /download`、`POST /create`、`POST /restore`、`POST /upload`、DELETE 路由 | 正式升级备份责任已归 `/api/system-upgrade`，旧表和依赖未在本次删除 |
| `/api/terminal` | `GET /stream`、`POST /input`、`POST /resize`、`POST /destroy`、`POST /heartbeat` | 涉及 PTY 生命周期和依赖，先确保入口 410 |
| `/api/desktop` | `GET /displays`、`GET /list`、`POST /create`、`GET /stream`、鼠标/键盘/剪贴板输入、resize/destroy/heartbeat | 涉及屏幕流和输入控制，物理删除需同步清理前端和依赖 |
| `/api/hermes-cli` | sessions、rename、stream、input、resize、destroy、heartbeat | 旧 Hermes 运行模式源码暂作历史参考 |
| `/api/hermes` | Hermes 代理和辅助入口 | 当前 GAIOP 正式运行态不启用 |
| `/api/files` | list、get、set、mkdir、delete、rename、upload | 正式“文件管理”为报告档案，走 `/api/reports`；旧通用工作区文件能力不再开放 |
| `/api/config` | `GET /api/config`、`POST /api/config` | 原始 Gateway/本地配置能力已由安全 BFF 取代 |
| `/api/agents/workspace` | `GET /api/agents/workspace` | 返回真实 workspace/expandedPath，是旧 files 链路的辅助入口 |

### 3.2 410 屏障的维护约束

- 新增正式接口不得复用上述前缀；确需恢复时必须作为新任务重新威胁建模，不能只删屏障。
- 前置 410 不读 Bearer、不连数据库、不调 Gateway、不触发后方 handler。
- 当前及后期任何分阶段整理中，`server/lib/legacy-api.test.js` 都必须继续证明各前缀对 GET/POST/DELETE 均先返回 410，且 sentinel 遗留 handler 未命中。

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

### 4.1 `/api/rpc` 授权和转发顺序

1. `authMiddleware` 验证 Bearer 登录、过期时间、空闲超时和必须修改密码状态。
2. `rpcPermissionMiddleware` 检查 `method` 是否存在、长度是否合法、是否在 `FORMAL_RPC_METHODS` 中。
3. 再应用四角色决策；管理员只对“已登记方法”放行，不是先行通配。
4. 检查 Gateway 连接状态。未登记/越权方法在此之前已经 403，不会因 Gateway 离线变成 503，也不会被转发。
5. 对会话范围方法解析 `sessionKey`/`key`/`session`，检查历史默认会话隐藏和本人归属。
6. 仅在以上检查全部通过后调用 `gateway.call(method, params)`。
7. 对非管理员结果执行安全字段投影，对会话列表/Usage 执行数据范围过滤，然后才返回浏览器。

### 4.2 精确的正式 RPC 方法集

#### 会话读方法

`sessions.list`、`session.list`、`sessions.get`、`session.get`、`sessions.history`、`session.history`、`chat.history`、`sessions.usage`、`usage.sessions`。

- 基础/标准：允许，但只能看本人会话。
- 审计：全量只读。
- 管理员：全量。

#### 会话写方法

`agent`、`chat.send`、`chat.abort`、`agent.abort`、`sessions.delete`、`session.delete`、`sessions.reset`、`session.reset`、`sessions.spawn`、`session.spawn`、`sessions.send`、`session.send`、`sessions.patch`、`session.patch`。

- 基础：仅 `sessions.delete`/`session.delete` 可用，且必须是本人会话。
- 标准：上述正式对话和本人会话操作可用，必须通过归属检查。
- 审计：全部拒绝。
- `agent.model.set` 不属于标准用户会话写集，仅管理员可用。

#### 全局 Usage、频道、Skills 和系统状态

| 集合 | 精确方法 |
|---|---|
| 全局成本 | `usage.cost`、`cost.usage` |
| 频道/插件安全状态 | `channels.status`、`channels.list`、`channel.list`、`channel.status`、`plugins.list`、`plugin.list`、`plugins.status`、`plugin.status` |
| Skills 安全状态 | `skills.status`、`skills.list` |
| 计划任务只读 | `cron.list`、`crons.list`、`schedule.list`、`schedules.list`、`cron.status`、`crons.status`、`schedule.status`、`schedules.status`、`cron.runs`、`crons.runs`、`cron.history`、`crons.history` |
| 基础系统状态 | `status`、`health` |
| 系统监控 | `system-presence`、`node.list` |
| 其他正式管理读 | `config.get`、`tools.list`、`models.list`、`model.list`、`agents.list`、`agent.list`、`agents.files.list`、`agent.files.list`、`agents.files.get`、`agent.files.get` |

#### 管理员正式写方法

| 模块 | 精确方法 |
|---|---|
| 配置 | `config.patch`、`config.apply`、`config.set` |
| 频道认证/配对 | `channel.auth`、`channels.auth`、`web.login.start`、`channel.pair`、`channels.pair` |
| Skills | `skills.install`、`skills.update` |
| 智能体 | `agents.create`、`agents.update`、`agents.delete`、`agent.model.set` |
| 智能体文件 | `agents.files.set`、`agent.files.set` |
| 计划任务创建 | `cron.add`、`cron.create`、`crons.add`、`crons.create` |
| 计划任务更新 | `cron.update`、`crons.update`、`schedule.update`、`schedules.update` |
| 计划任务删除 | `cron.remove`、`cron.delete`、`crons.remove`、`crons.delete`、`schedule.delete`、`schedules.delete` |
| 计划任务执行 | `cron.run`、`crons.run`、`cron.trigger`、`crons.trigger` |
| Gateway 更新 | `update.run` |
| 会话导出 | `sessions.export`、`session.export` |

#### 单列管理员诊断集合

`logs.tail`、`exec.approvals.get`、`exec.approvals.node.get`、`exec.approvals.set`、`exec.approvals.node.set`、`node.invoke`、`node.pair.request`、`node.pair.approve`。

该集合不向基础、标准或审计用户开放；日志、执行审批和节点控制不会因方法名包含 `.get` 自动成为只读权限。

### 4.3 明确不在正式集合的 RPC

- `unknown.list`、`unknown.get`、`unknown.status` 及任意其他未登记方法。
- 通用消息 `send`。
- `desktop.*`、`remote-desktop.*`、`vnc.*` 等远程桌面方法。
- 前端历史封装中存在、但当前正式路由未使用的其他 RPC。

这些方法对管理员也返回 `403 RPC_METHOD_NOT_SUPPORTED`。方法名以 `.list`、`.get`、`.status` 结尾不构成授权依据。

管理员正式集合的精确代码定义位于 `server/lib/permissions.js`；集合包含前端 `rpc-client.ts` 中正式页面实际使用的当前方法及兼容别名，不包含远程桌面 RPC、通用 `send` 或其他未使用能力。

## 5. `/api/events` 与 `/api/media` 特殊保留说明

### 5.1 `/api/events` 请求与生命周期

| 阶段 | 前端行为 | 服务端行为 | 安全不变量 |
|---|---|---|---|
| 建连 | `fetch('/api/events')`，携带 `Accept: text/event-stream`、`Authorization: Bearer ...`、`cache: no-store` 和 `AbortSignal` | `authMiddleware` 先验证，然后设置 SSE/no-cache/no-buffer 响应头 | URL 中没有 Token；不使用 Cookie 或短期 URL Token |
| 初始事件 | 解析 `connected`和 `gatewayState` | 生成 clientId，登记 `{res,user}`，发送 Gateway 初始状态 | SSE 客户端与已验证用户绑定 |
| 分帧 | `TextDecoder` 支持跨 chunk 缓冲、CRLF 归一和多 `data:` 行合并 | 以 `data: <JSON>\n\n` 发送业务事件 | 不假定一个 fetch chunk 就是一个 SSE 事件 |
| 心跳 | 忽略以 `:` 开头的 SSE 注释 | 每 15 秒写入 `: heartbeat` | 心跳不进入业务事件解析 |
| 事件隔离 | 仅消费服务端已筛选的事件 | 非管理员的 `event` 必须提取到 sessionKey 且通过归属检查 | 前端过滤不是安全边界 |
| 断线重连 | 传输异常/正常 EOF 后按 1.5 倍退避，上限 30 秒、默认最多 20 次 | 释放断开的 clientId | connection generation 防止旧请求回写新状态 |
| 401 | 进入 failed，发出 `unauthorized`，清除本地登录并不再重连 | 返回稳定 401 JSON，不升级为 SSE | 过期登录不会形成无限重连 |
| 退出/页面卸载 | 清理 timer，递增 generation，Abort 当前 fetch | request close 清理心跳和 client 记录 | 退出后不留后台连接 |
| 重复 connect | 已有 AbortController 或重连 timer 时直接返回；store 替换客户端前先 disconnect 旧实例 | 每个已验证 HTTP 流仅对应一个 clientId | 防止页面重复调用产生多条长连接 |

### 5.2 `/api/media` 请求和文件边界

1. `AuthenticatedMediaImage.vue` 从 auth store 获取当前 Token，仅放在 `Authorization` 请求头。
2. 非管理员请求同时携带 `X-GAIOP-Session-Key`；基础/标准用户必须是本人 active 会话，审计用户保持全量只读。
3. 服务端只接受最长 1024 字符的相对路径，统一分隔符后拒绝空段、`.`、`..`、NUL、Unix 绝对路径和 Windows 盘符路径。
4. 仅搜索部署配置的媒体根目录；对根目录和候选文件都执行 `realpath`，再用 `relative` 判定最终真实路径是否仍在根目录中，因此符号链接也不能越界。
5. 仅允许 PNG、JPEG、GIF、WebP、BMP；SVG 和其他格式不在白名单中。单文件上限 25 MiB。
6. 响应设置精确 MIME、`Cache-Control: private, no-store`、`X-Content-Type-Options: nosniff`。
7. 前端将成功响应转为 Blob object URL，在路径变化、会话变化和组件卸载时 revoke；不将 Bearer 放入图片 URL。

### 5.3 特殊保留的原因

- `/api/events` 是正式页面 Gateway 连接状态和会话实时更新通道，不能改为 410。
- `/api/media` 被聊天页和 Office 对话面板用于展示 Gateway 生成的图片，不能改为 410。
- `/api/system-upgrade/*` 是已发布的正式升级 BFF；与已 410 的 `/api/npm/*` 和 `/api/backup/*` 互不替代。

## 6. 自动化与生产验证覆盖

| 层级 | 用例 | 关键断言 |
|---|---|---|
| Node | `server/lib/legacy-api.test.js` | 九组前缀的 GET/POST/DELETE 均 410，后方 sentinel handler 零命中 |
| Node | `server/routes/media.test.js` | 未登录 401；本人 200；他人 404；绝对/穿越/非图片 400；管理员正常读取 |
| Node | `server/lib/permissions.test.js` | 四角色对 `FORMAL_RPC_METHODS` 每一个方法的 allow/deny 全量矩阵；未知后缀方法全拒绝 |
| Node/HTTP | `server/lib/permissions.test.js` | 直接 POST `/api/rpc` 不能绕过标准写限制、审计只读或管理员方法登记 |
| Node | session/projection/dashboard/reports/users/channels 相关用例 | 本人会话和 Usage、报告归属、审计账户只读、安全字段投影 |
| Vitest | `src/api/http-client.test.ts` | Bearer 请求头、URL 无 Token、分 chunk/CRLF、心跳、401、Abort、重复连接和断线恢复 |
| 237 未登录探针 | `gateway237-admin-security-probe.cjs` | health 200；events/media/rpc/upgrade 401；遗留入口 410 |
| 237 运行探针 | 受控 start/listener/performance 脚本 | service active、Gateway connected、回环监听、会话列表/Usage/历史正常 |

生产探针不读取生产登录密码，也不借用生产角色做写操作；四角色详细 allow/deny 和本人数据范围由隔离测试数据验证。

## 7. 后续边界

- “遗留代码依赖评估与分阶段整理”：当前模块、页面和入口已隐藏，服务端前置 410 与自动化不可达测试已经满足安全要求；源码物理删除不再作为当前待办。后期仅在确认无正式依赖且具备完整回归条件时逐组整理，不进行一次性删除，数据库结构和生产数据另行决策。
- “权限拒绝审计”：记录 401/403/410 拒绝事件并改造审计信息；本次不做。
- 不建设动态 RBAC/ABAC，不修改 GAIOP 后端、OpenClaw 核心或频道插件。
