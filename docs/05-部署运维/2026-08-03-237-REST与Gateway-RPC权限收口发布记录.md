# 237 REST 与 Gateway RPC 权限收口发布记录

> 发布日期：2026-08-03（UTC+8）  
> 分支：`dev-yangshuo`  
> 发布批次：`20260803T032539Z`  
> 功能提交：`dev-yangshuo@5de8924`

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

## 2. 自动化与构建

- Node 全量：72 项通过；新增真实前置 `410` 可达性、媒体认证/越权/路径约束、四角色 RPC 与直接 `/api/rpc` 绕过测试。
- Vitest 全量：15 个文件、54 项通过。
- SSE 用例覆盖 Authorization 请求头、URL 无 Token、跨 chunk/CRLF 事件解析、心跳忽略、401 停止、重复连接、Abort 和重连恢复。
- `vue-tsc -b && vite build`：通过，4631 个模块完成生产构建。
- `git diff --check`：通过。

## 3. 发布包与受控备份

- 发布包条目：299。
- 发布包大小：3571257 B。
- SHA-256：`a5bed26ca30aca8cf6641bfb26445b8c5a3c84c2eb125cc21f1733492c48e5c4`。
- 包内容仅含 `dist/`、`server/`、`package.json`、`package-lock.json`；不含 `.env`、数据库、备份、报告、密钥或客户配置。
- 暂存阶段已创建 Admin 快照和 `wizard.db` 受控备份，服务未启动，Caddy、网络和公网路由未改变。

## 4. 237 验证结果

- 受控启动完成，未回滚；服务 active，进程退出码 0，重启次数 0。
- 健康接口 HTTP 200，Gateway connected。
- 监听保持 `127.0.0.1:3000`，源代码回环绑定保护存在，公网路由未改变。
- 会话运行探针：列表、`sessions.usage`、抽样 `chat.history` 均成功；默认运行会话未暴露，外部渠道来源误判为 0。
- 未登录生产探针：`/api/events`、`/api/media`、`/api/rpc`、`/api/system-upgrade/overview` 均返回 401。
- 遗留生产探针：npm、backup、terminal、desktop、files、config、agents workspace、Hermes 均返回 410。
- 管理员未知 RPC 默认拒绝和四角色正式方法矩阵由隔离 HTTP/Node 测试验证；未读取生产登录密码或借用生产用户执行写操作。

## 5. 安全、保护和回滚

- 未读取、输出、打包或提交密码、Token、私钥、频道密钥、NAPM 凭据、`.env` 或本机安全存储内容。
- 本地 `data/wizard.db`、所有 `.bak`、`docs/images` 删除记录、`.codex-temp` 和既有用户改动均保持原状。
- 未修改 GAIOP 后端、OpenClaw 核心、频道插件、Caddy、证书、防火墙或 DNS。

```powershell
& '..\ops\237\Invoke-237AdminRollback.ps1' -ReleaseId '20260803T032539Z'
```

回滚恢复本批次前的 Admin 代码、静态资源、服务单元、环境配置快照和受控数据库备份，不操作 GAIOP 后端、OpenClaw 核心、频道插件或其他服务器。

## 6. 后续任务

- “遗留接口清退”：物理删除已 410 的旧源码、无用前端组件、依赖和遗留结构。
- “权限拒绝审计”：将 401/403/410 拒绝纳入独立审计方案和审计信息改造。
