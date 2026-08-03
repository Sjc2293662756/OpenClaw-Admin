# 237 REST 与 Gateway RPC 权限收口发布记录

> 发布日期：2026-08-03（UTC+8）
> 分支：`dev-yangshuo`
> 发布批次：`20260803T032539Z`
> 功能提交：`dev-yangshuo@5de8924`

## 0. 基线和发布边界

| 项目 | 本轮事实 |
|---|---|
| 工作仓库 | `GAIOP-Admin` |
| 分支 | `dev-yangshuo` |
| 开始基线 | `f815773` |
| 运行代码提交 | `5de8924 fix: close REST and Gateway RPC permissions` |
| 首次发布文档提交 | `ca2fc4b docs: record REST and RPC permission release` |
| 文档格式修正 | `d570e57 docs: normalize permission release record` |
| 四角色 RPC 全量矩阵测试 | `13129c0 test: exhaust four-role RPC method matrix` |
| 首次闭环后远端 HEAD | `dev-yangshuo@13129c0` |
| 237 发布内容 | `5de8924` 对应的 `dist/`、`server/`和 npm 清单 |
| 不在本轮 | GAIOP 后端、OpenClaw 核心、频道插件、Caddy/证书/防火墙/DNS、动态 RBAC、拒绝审计、遗留源码物理删除 |

发布前已确认本地存在需保护的用户改动：`data/wizard.db`、`docs/images` 删除记录、`.codex-temp`和三个 `.bak`。所有 Git 暂存、提交和发布包均使用精确路径，没有把这些内容纳入本轮。

## 1. 发布范围

本轮完成“REST 接口清单和收口”与“Gateway RPC 权限收口”，并按确认范围一并整改正式 `/api/events`：

- 按 Express 实际注册顺序建立正式 REST、特殊保留接口和遗留入口清单。
- `/api/npm`、`/api/backup`、`/api/terminal`、`/api/desktop`、`/api/hermes`、`/api/hermes-cli`、`/api/files`、`/api/config`、`/api/agents/workspace` 在最前置入口统一返回 `410 ENDPOINT_RETIRED`；后方遗留源码保留但不可达。
- `/api/media` 保留为正式聊天图片链路，改为 Bearer 认证、会话范围头、真实路径包含校验、图片类型和 25 MiB 大小上限；前端通过认证 fetch 取得 Blob，不在 URL 中携带 Token。
- `/api/events` 从原生 `EventSource` 改为带 `Authorization: Bearer` 的 fetch 流式 SSE；保留事件分帧、心跳、断线重连、401 清理登录、退出 Abort、重复连接防护和服务端会话事件隔离。
- 登录认证不再接受任何 URL 查询参数 Token。
- 管理员 Gateway RPC 从任意方法通配改为正式产品集合与单列诊断集合；所有角色对未登记 `unknown.list/get/status` 默认拒绝。
- 基础/标准本人会话归属、本人 Usage 重聚合、审计全量只读、频道/插件/Skills/配置安全字段投影均保持现有方案。

完整接口和角色矩阵见 [REST 与 Gateway RPC 权限清单](../03-接口设计/2026-08-03-REST与Gateway-RPC权限清单.md)。

### 1.1 代码文件与职责

| 文件 | 变更职责 |
|---|---|
| `server/index.js` | 在最前置注册遗留 410 屏障；挂载受控 media Router；移除 URL/Cookie Token 兼容；RPC 进入集中中间件；SSE 增加心跳 |
| `server/lib/legacy-api.js` | 定义九组退役前缀和统一 `410 ENDPOINT_RETIRED` 响应 |
| `server/routes/media.js` | 媒体认证、会话权限、相对路径、realpath 包含、格式/大小和安全响应头 |
| `server/lib/permissions.js` | 管理员从通配改为 `FORMAL_RPC_METHODS`；单列诊断集合；未登记方法默认拒绝；提取 `/api/rpc` 授权中间件 |
| `src/api/http-client.ts` | 从 `EventSource(?token=...)` 改为 Bearer fetch SSE，实现分帧、重连、401、Abort 和连接代次 |
| `src/api/websocket.ts` | 向上转发 `unauthorized` 事件 |
| `src/stores/websocket.ts` | 401 清理登录；重建客户端前断开旧实例，避免重复长连接 |
| `src/stores/auth.ts` | 增加不发送无效 logout 的本地过期清理入口 |
| `src/components/common/AuthenticatedMediaImage.vue` | 用 Bearer/会话头 fetch 图片 Blob，对 object URL 进行生命周期清理 |
| `src/views/chat/ChatPage.vue` | 媒体消息不再生成匿名 `/api/media` URL，交给认证图片组件 |
| `src/components/office/AgentChatPanel.vue` | Office 对话图片同步改用认证 Blob 链路 |
| `package.json` | 将新增 Node/Vitest 安全用例纳入默认 `npm test` |

### 1.2 与既有四角色方案的兼容关系

- 没有重新设计角色，仍为基础、标准、审计、管理员。
- 基础/标准的会话、报告和 Usage 本人范围未改变。
- 审计用户仍可查看全量会话、报告、审计和安全账户信息，但不能执行写 RPC/REST。
- 基础、标准和审计用户的频道/插件/Skills/配置结果仍经过安全字段投影。
- 本轮新增的主要收紧是：管理员也不能通过通用代理调用未登记 RPC。

## 2. 自动化与构建

本轮先执行与改动直接相关的定向用例，再执行仓库默认全量测试和生产构建。测试使用临时目录、临时媒体文件、隔离的 Express 应用和内存用户/会话数据，不读取或修改 237 生产用户、生产会话和本地 `data/wizard.db`。

### 2.1 服务端 Node 测试

| 用例文件/领域 | 覆盖重点 | 验收结果 |
|---|---|---|
| `server/lib/legacy-api.test.js` | 九组退役前缀在真实前置顺序下对 GET/POST/DELETE 均返回 410；后方 sentinel handler 不可达 | 通过 |
| `server/routes/media.test.js` | 未登录 401、本人读取、他人会话隐藏、管理员读取、绝对路径/路径穿越/符号链接逃逸/非图片拒绝、大小约束 | 通过 |
| `server/lib/permissions.test.js` | `FORMAL_RPC_METHODS` 中每个方法的四角色允许/拒绝矩阵；会话归属；审计只读；未知 `.list/.get/.status` 对管理员也拒绝 | 通过 |
| `/api/rpc` 隔离 HTTP 应用 | 直接请求不能绕过前端；未登记方法在 Gateway 转发前 403；标准用户不能管理配置/频道/Skills/任务；管理员正式方法可用 | 通过 |
| 会话、仪表盘、报告、账户、频道安全用例 | 基础/标准本人会话与本人 Usage 重聚合、审计全量只读、账户安全字段、频道/插件/Skills/配置投影 | 通过 |

执行 `npm run test:node`；Node 默认测试命令共执行 **72 项，72 项通过，0 失败**。

### 2.2 前端 Vitest 与 SSE 生命周期

`src/api/http-client.test.ts` 对 fetch 流式 SSE 的关键生命周期逐项验证：

1. 请求使用 `Authorization: Bearer`，请求 URL 不出现登录 Token。
2. 一个事件跨多个网络 chunk 时仍能正确缓冲和解析。
3. 同时兼容 LF、CRLF、多 `data:` 行和连续事件。
4. `: heartbeat` 注释不会进入业务事件分发。
5. HTTP 401 触发 `unauthorized`，停止重连并交由 auth store 清理登录。
6. 主动退出会 Abort 正在读取的 fetch，并清理重连计时器。
7. 重复 `connect()` 不创建第二条长连接；客户端替换前会先断开旧实例。
8. 非认证传输错误或正常 EOF 进入有上限的退避重连，恢复后重置重试状态。

执行 `npm run test:vitest`；Vitest 默认测试命令共执行 **15 个文件、54 项，全部通过**。随后再次执行聚合命令 `npm test`，确认 Node 与 Vitest 在同一默认入口下连续通过。

### 2.3 类型、构建与差异检查

| 检查 | 结果 | 证据 |
|---|---|---|
| TypeScript/Vue 类型检查 | 通过 | `npm run build` 内的 `vue-tsc -b` 无错误 |
| 生产构建 | 通过 | `npm run build` 内的 `vite build` 完成 4631 个模块转换并生成 `dist/` |
| Git 空白检查 | 通过 | `git diff --check` 无输出 |
| 发布文件范围检查 | 通过 | 仅运行代码、测试、文档和 npm 清单进入精确提交；保护项未暂存 |

## 3. 发布包与受控备份

### 3.1 发布前检查

发布前确认：

- 本地分支为 `dev-yangshuo`，运行代码提交为 `5de8924`，没有把冻结的 GAIOP 后端 `dev-yangshuo` 纳入操作。
- 237 既有 Admin 服务、Gateway 连接和回环监听状态可读取；部署脚本和回滚脚本存在。
- 本地工作树中的 `data/wizard.db`、`.bak`、`docs/images` 删除记录和 `.codex-temp` 被列为保护项，不参与打包、覆盖或提交。
- 没有读取 `.env`、密码、Token、私钥、频道密钥、NAPM 凭据或本机安全存储。

### 3.2 发布包清单

| 项目 | 值 |
|---|---|
| 文件条目 | 299 |
| 文件大小 | 3,571,257 B |
| SHA-256 | `a5bed26ca30aca8cf6641bfb26445b8c5a3c84c2eb125cc21f1733492c48e5c4` |
| 允许内容 | `dist/`、`server/`、`package.json`、`package-lock.json` |
| 明确排除 | `.env`、数据库、备份、报告、日志、密钥、客户配置、Git 元数据和本地临时目录 |

上传前后均以条目数、总大小和 SHA-256 校验同一发布包，防止传输、暂存或解包过程中内容漂移。

### 3.3 受控发布阶段

237 发布按下列顺序完成；只有在新的 release 目录准备好并完成离线检查后，才切换服务：

1. 读取现有服务、监听、Gateway 和磁盘状态，确认可以进入发布窗口。
2. 上传并校验发布包，在独立 staging/release 目录解包，不直接覆盖当前运行目录。
3. 保存本批次前的 Admin 代码、静态资源、服务单元和环境配置快照。
4. 对生产 `wizard.db` 创建受控备份；本轮没有执行表结构迁移或业务数据覆盖。
5. 在候选目录安装/核对运行依赖并执行 Node 入口检查；服务仍使用既有配置来源，未查看秘密内容。
6. 切换到新 release，受控重启 Admin 服务。
7. 依次验证 systemd 状态、进程退出码/重启次数、回环监听、健康接口、Gateway 连接、会话链路和安全探针。
8. 全部验证通过后确认发布完成；本批次没有触发自动回滚。

整个过程没有修改 Caddy、证书、防火墙、DNS、公网映射或 OpenClaw/频道插件。

## 4. 237 验证结果

### 4.1 启动、服务与监听

| 验证项 | 237 实际结果 | 判定 |
|---|---|---|
| 发布脚本完成状态 | `completed=true`，`status=admin-started-loopback-verified` | 通过 |
| 自动回滚 | `rollback=false` | 未触发 |
| Admin 服务 | active | 通过 |
| 主进程退出码 | 0 | 通过 |
| 本轮重启次数 | 0 | 通过 |
| 监听地址 | `127.0.0.1:3000` | 保持回环，不扩大暴露面 |
| 健康接口 | HTTP 200 | 通过 |
| Gateway | connected | 通过 |
| 公网/Caddy | 未修改 | 保持原状 |

### 4.2 正式会话链路运行探针

| 探针 | 结果 |
|---|---|
| 会话基表数量 | 78 |
| `sessions.list` | 560.06 ms |
| BFF 会话增强 | 10.78 ms |
| 会话列表总耗时 | 570.84 ms |
| 成功增强条目 | 77 |
| 历史默认运行会话暴露 | false |
| 外部渠道来源误判 | 0 |
| `sessions.usage` | 4508.71 ms，成功 |
| 抽样 `chat.history` | 30.22 ms，返回 36 条消息 |

该探针用于确认本次 RPC 正式集合、本人会话过滤前置逻辑和 SSE/media 改动没有破坏既有列表、Usage 与历史链路。它不修改会话，也不向生产渠道发送消息。

### 4.3 未登录与退役入口生产探针

| 路径/分组 | 期望 | 237 实际 | 结论 |
|---|---:|---:|---|
| `GET /api/health` | 200 | 200 | 健康检查保持公开 |
| `GET /api/events` | 401 | 401 | SSE 必须 Bearer 登录 |
| `GET /api/media?path=...` | 401 | 401 | 未认证时不解析文件路径 |
| `POST /api/rpc` | 401 | 401 | 通用代理不能匿名使用 |
| `GET /api/system-upgrade/overview` | 401 | 401 | 正式升级 BFF 受认证保护 |
| `/api/npm/*` | 410 | 410 | 旧 npm 升级入口已停用 |
| `/api/backup/*` | 410 | 410 | 旧备份入口已停用 |
| `/api/terminal/*` | 410 | 410 | 远程终端入口已停用 |
| `/api/desktop/*` | 410 | 410 | 远程桌面入口已停用 |
| `/api/files/*` | 410 | 410 | 通用文件入口已停用 |
| `/api/config/*` | 410 | 410 | 原始配置入口已停用 |
| `/api/agents/workspace/*` | 410 | 410 | 工作区真实路径入口已停用 |
| `/api/hermes*` | 410 | 410 | Hermes 遗留入口已停用 |

### 4.4 四角色验证证据的边界

237 生产探针只使用无需生产凭据的健康、未登录和退役入口检查，以及既有只读运行探针。没有读取生产登录密码，也没有借用基础、标准、审计或管理员生产账号执行写操作。

四角色对每一个正式 RPC 方法的允许/拒绝结果、基础/标准他人会话拒绝、审计写方法拒绝、管理员未知方法拒绝、非管理员安全投影和直接 `/api/rpc` 防绕过，均由隔离 Node/HTTP 测试提供证据。这样既覆盖角色矩阵，也不污染生产用户和业务数据。

## 5. 安全、保护和回滚

- 未读取、输出、打包或提交密码、Token、私钥、频道密钥、NAPM 凭据、`.env` 或本机安全存储内容。
- 本地 `data/wizard.db`、所有 `.bak`、`docs/images` 删除记录、`.codex-temp` 和既有用户改动均保持原状。
- 未修改 GAIOP 后端、OpenClaw 核心、频道插件、Caddy、证书、防火墙或 DNS。

```powershell
& '..\ops\237\Invoke-237AdminRollback.ps1' -ReleaseId '20260803T032539Z'
```

### 5.1 自动回滚触发边界

受控发布脚本在候选版本无法启动、服务未进入 active、健康检查失败、监听不满足回环要求或关键发布校验失败时进入回滚。业务安全探针若出现正式接口匿名 2xx、退役入口不再 410 或 Gateway 正式链路不可用，也应停止验收并执行上述回滚命令。

### 5.2 回滚恢复内容

回滚按发布批次标识恢复：

- 本批次前的 Admin server 与静态 `dist/`。
- 本批次前的服务单元和环境配置快照。
- 发布前创建的受控 `wizard.db` 备份（仅在数据库实际受影响时恢复）。
- 恢复后重新启动并复核 active、回环监听、健康接口和 Gateway 连接。

回滚不操作 GAIOP 后端、OpenClaw 核心、频道插件、Caddy、证书、防火墙、DNS 或其他服务器。本批次所有发布后检查通过，因此没有执行回滚，备份作为可恢复证据保留。

## 6. 后续任务

### 6.1 遗留接口清退

后续专项可在保持 410 网络语义的前提下，逐组删除旧 handler、前端组件、PTY/桌面依赖、旧备份结构和无用数据库表。物理清理前应再次扫描正式页面与 237 调用，删除后仍需保留回归测试，避免同一前缀被意外重新开放。

### 6.2 权限拒绝审计

后续独立设计 401/403/410 的审计记录、字段最小化、采样/去重和审计页面展示。本轮只保证稳定拒绝结果，不扩展审计表结构，也不把 Token、原始请求体或秘密字段写入日志。

### 6.3 本轮明确没有遗留的实施项

- 正式 REST 入口已经处于公开固定项、认证业务项、角色受控项或统一 410 四种可解释状态。
- Gateway 管理员通配已经移除，未登记方法对所有角色默认拒绝。
- `/api/events` 已完成请求头认证迁移并保留既有生命周期和事件隔离。
- `/api/media` 因正式聊天图片依赖而保留，已完成认证、会话范围和文件边界收口。

后续任务不是为了补上本轮尚未生效的安全措施，而是物理移除已不可达源码，以及增加本轮明确不在范围内的“权限拒绝审计”能力。
