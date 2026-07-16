# GAIOP 与 GAIOP-Admin 职责和集成关系

| 属性 | 内容 |
|---|---|
| 创建日期 | 2026-07-15 |
| 状态 | 当前双目录集成基线 |
| 适用目录 | `D:\杨硕文件\GAIOP\GAIOP\GAIOP`、`D:\杨硕文件\GAIOP\GAIOP\GAIOP-Admin` |

## 1. 最通俗的关系

两个目录共同组成一个观枢 GAIOP 产品，但职责不同：

```text
GAIOP-Admin = 用户看得见、管理员能操作的产品前台和管理后台
GAIOP       = 真正执行智能运维分析的智能体核心与 NAPM Skills
Gateway     = 两者之间的运行底座和通信桥梁
NAPM        = GAIOP 查询和分析的数据来源
```

`GAIOP-Admin` 不是另一个独立产品，`GAIOP` 也不是传统意义上直接提供网页 REST 接口的普通后台。浏览器先访问 `GAIOP-Admin`，管理服务再通过 Gateway 调用智能体；Gateway 加载 `GAIOP` 工作区中的插件和 Skills。

## 2. 完整运行链路

```text
浏览器
  ↓ HTTPS 443
GAIOP-Admin/src（Vue 页面）
  ↓ /api REST、SSE、RPC
GAIOP-Admin/server（管理服务/BFF）
  ↓ 内部 WebSocket
Gateway（智能体运行底座）
  ↓ 加载插件、会话和工具
GAIOP（插件、规则、Skills、报告、告警能力）
  ↓ HTTPS WebService
NAPM 数据源
```

企业微信等外部渠道从 Gateway 进入，也会使用同一个 `GAIOP` 智能体核心；Web 对话工作台则从 `GAIOP-Admin` 进入 Gateway。

## 3. 两个目录分别负责什么

### GAIOP-Admin

| 目录 | 职责 |
|---|---|
| `src/views` | 欢迎页、登录、对话工作台、管理控制台和模块页面 |
| `src/stores` / `src/api` | 登录状态、REST、SSE、Gateway RPC 客户端 |
| `src/router` | 双工作空间和正式产品路由 |
| `server/routes` | 用户、审计、数据源、报告、主机网络、敏感配置、会话设置 |
| `server/gateway.js` | 管理服务到 Gateway 的 WebSocket 连接 |
| `server/database.js` | 管理平台 SQLite 数据结构 |
| `data` | 用户、配置、审计、报告元数据和本地报告文件 |

它负责“页面、账户、权限、配置入口和管理接口”，不负责理解 NAPM 业务问题，也不直接执行 NAPM 查询。

### GAIOP

| 目录/文件 | 职责 |
|---|---|
| `napm-openclaw-plugin.remote.js` | 意图路由、会话钩子、工具注册、结果约束和输出拦截 |
| `skills` | NAPM 查询、告警、巡检、综述、数据包和报告执行器 |
| `src/runtime` | 管理端配置到 Skills 运行环境的桥接 |
| `config` | 对象、指标、查询语义、巡检和报告规则 |
| `SOUL/IDENTITY/PROJECT/TOOLS` | 智能体身份、业务边界和运行约束 |
| `test` | 智能体核心、查询、报告和告警测试 |
| `memory/docs` | 核心能力的维护记录和设计说明 |

它负责“理解并执行智能运维分析”，不负责 GAIOP 网页账户、后台菜单和普通管理表单。

## 4. 功能归属对照

| 功能 | GAIOP-Admin | Gateway | GAIOP |
|---|---|---|---|
| 欢迎、登录、工作空间 | 页面、认证、路由 | 无 | 无 |
| 用户、角色、管理审计 | 权威实现 | 方法调用审计来源之一 | 仅内部分析审计 |
| 对话工作台 | UI、会话选择、权限 | 会话、消息、流式事件 | 分析路由、工具和结果约束 |
| 会话/记忆/任务/模型/频道 | 管理页面和 RPC 权限 | 权威配置与执行 | 使用对应配置执行分析 |
| Skills 管理 | 展示和管理入口 | Skill 注册/调用 | Skill 源码与业务能力 |
| NAPM 数据源 | 录入、加密、测试、选择运行源 | 传递工具调用 | 读取运行源并请求 NAPM |
| 报告 | 列表、预览、下载、删除 | 调用报告工具/发送文件 | 生成报告和审计 JSON |
| 系统监视器 | 展示管理服务所在主机 | 提供部分状态 | 不替代 NAPM 监控 |
| 告警 | Web 模块尚为框架 | 外部渠道入口 | 告警查询、Syslog watcher 与推送能力 |
| 系统升级 | 页面框架 | 未来被升级组件 | 未来被升级组件之一 |

## 5. 两个目录的共享契约

### 5.1 Gateway RPC

`GAIOP-Admin/server` 使用内部 Gateway WebSocket 连接。浏览器只请求 `/api/rpc` 和 `/api/events`，不持有 Gateway Token。RPC 方法、参数和事件格式由 Gateway 提供；`GAIOP-Admin` 负责角色权限和敏感字段掩码。

### 5.2 活动数据源文件

管理员在 `GAIOP-Admin` 选择运行数据源后，管理服务写入活动数据源 JSON；`GAIOP/src/runtime/ActiveDataSourceRuntime.js` 在 Skill 执行前读取它，并覆盖 `NETINSIDE_*` 运行值。

正式变量统一为：

```text
GAIOP_ACTIVE_DATA_SOURCE_FILE
```

两个服务必须配置为同一个绝对路径。旧管理端变量 `GAIOP_DATA_SOURCE_RUNTIME_FILE` 只作为兼容别名保留。未配置时，本地默认使用 `GAIOP/config/runtime-active-data-source.json`。

该文件包含运行时密码，只能由服务账户读取，不提交 Git、不从浏览器下载、不写入日志或审计。

### 5.3 报告目录和审计 JSON

两个服务必须共享：

```text
GAIOP_REPORTS_DIR
```

`GAIOP` 报告 Skill 写入报告和同名审计 JSON；`GAIOP-Admin` 扫描 JSON、登记元数据并提供预览、下载和删除。报告审计 JSON 的 `reportId/fileName/sourceSessionId/sourceUserId/dataSourceId` 是跨目录数据契约，修改时必须同步两边。对 Web 对话，Admin BFF 可使用独立 HMAC 密钥向 `chat.send` metadata 注入经签名的用户/会话来源，GAIOP 仅在验签、时效和会话一致时写入来源用户；该能力默认关闭，须完成 Gateway 元数据透传联调后才可启用。

### 5.4 会话设置

`GAIOP-Admin` 保存管理策略，并通过 Gateway `config.patch` 写入外部渠道上下文空闲策略。Web 工作台当前不从浏览器传递来源路由字段；其渠道策略需由 BFF 完整适配并经 Gateway 联调后才可生效。报告文件的来源用户可采用签名信封进行可信传递和读取隔离，但 Gateway 会话历史本身的完整所有者映射仍待补齐。

## 6. 部署关系

最终对客户只有一个 GAIOP 地址，不存在让客户分别访问两个目录：

```text
https://<GAIOP主机>/  → GAIOP-Admin
GAIOP-Admin           → 内部 Gateway
Gateway               → 加载 GAIOP 工作区
GAIOP Skills          → NAPM
```

因此不需要单独在页面配置“GAIOP 服务 IP”。两个代码目录可以在同一主机、同一容器编排或同一受控私网中运行，但 Gateway、活动数据源文件和报告目录必须按部署契约连接。

## 7. 修改代码时如何判断改哪边

| 需求 | 修改位置 |
|---|---|
| 页面样式、菜单、登录、用户、权限、配置表单 | `GAIOP-Admin` |
| NAPM 查询语义、指标、对象、分析逻辑、报告模板 | `GAIOP` |
| 新 Skill | 先改 `GAIOP`，再按需补 `GAIOP-Admin` 管理展示与权限 |
| 新 Gateway RPC 或参数 | Gateway/`GAIOP` 能力确认后，同步 `GAIOP-Admin` 类型、调用和权限 |
| 数据源字段或运行时格式 | 两个目录同时修改并做兼容迁移 |
| 报告审计 JSON 字段 | 两个目录同时修改 |
| 用户与会话归属 | `GAIOP-Admin` 建立权威映射，调用 Gateway 时传递可追溯标识；必要时同步 `GAIOP` |
| 生产端口、共享目录和环境变量 | 两个目录部署文档与样例同时更新 |

## 8. 当前尚未完全打通的边界

1. 管理用户与 Gateway/GAIOP 会话尚未形成完整所有者映射，这是下一阶段会话隔离的核心。
2. 报告文件已具备签名来源用户传递与读取隔离，但当前 Gateway/Web 元数据透传未经真实联调，且外部渠道、旧报告或缺少上下文的生成链路仍可能没有来源用户。
3. 环境与敏感配置当前主要存于 `GAIOP-Admin` 数据库，尚未按白名单逐项成为 `GAIOP` 运行参数。
4. Web 告警通知与 `GAIOP` 已有 Syslog watcher 尚未连接成同一持久化链路。
5. 两个目录仍使用部分底层兼容名称；这属于内部实现迁移，不影响对外统一 GAIOP 品牌。

## 9. 验收标准

- 管理端能通过内部 Gateway 使用 `GAIOP` 对话和管理能力。
- 两边设置相同活动数据源路径后，切换运行数据源会影响下一次 NAPM Skill 调用。
- 两边设置相同报告目录后，新报告能在管理端自动出现。
- 浏览器无需知道 Gateway、核心目录或内部端口。
- 任一共享契约变化都有双边代码、环境样例、文档和联调测试。

## 10. 变更记录

| 日期 | 内容 |
|---|---|
| 2026-07-15 | 首次建立两个实际目录的职责、调用链、共享文件和修改边界 |
| 2026-07-15 | 统一活动数据源正式变量为 `GAIOP_ACTIVE_DATA_SOURCE_FILE`，兼容旧管理端变量 |
| 2026-07-15 | 明确 Gateway 来源路由字段不可由浏览器单独传递；后续渠道级会话策略须由 Admin BFF 完整适配并经真实 Gateway 验证 |
