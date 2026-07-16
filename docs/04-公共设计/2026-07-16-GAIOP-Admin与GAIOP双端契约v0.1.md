# GAIOP-Admin 与 GAIOP 双端契约 v0.1

| 属性 | 内容 |
|---|---|
| 创建日期 | 2026-07-16 |
| 状态 | 契约准备完成，等待后端负责人确认；尚未进入真实 Gateway 或服务器部署联调 |
| Admin 基线 | `dev-yangshuo` 的当前工作树；浏览器仅调用 Admin BFF |
| GAIOP 基线 | `GAIOP-latest`，`8fe0cbe`（`origin/main`） |
| 不在范围 | 服务器网络、域名、DNS、网关、NTP、时区、真实环境凭据和部署操作 |

## 1. 目的与原则

本文件冻结跨仓库模块的产品语义和数据边界，供 Admin 与 GAIOP 分别实现。它不是部署说明，也不授权修改 237、NAPM、Syslog、Gateway 或防火墙。

1. 浏览器只依赖 Admin BFF 的稳定接口；不会直连 GAIOP 内部文件、运行时目录或 Gateway RPC。
2. GAIOP 是报告生成、告警接收/解析/持久化和运行时能力的权威提供者；Admin BFF 负责权限、脱敏、审计、版本兼容和页面适配。
3. 契约字段未完成真实链路验证前，页面只能显示“待联调/未记录”，不能伪造已生效状态。
4. 真实路径、密码、Token、私钥、NAPM 凭据和签名密钥不进入接口响应、审计、日志、文档或 Git。
5. 每一条链路采用“模拟测试 → 本地端到端 → 237 并行部署验证”的顺序；不得用 OpenClaw 过渡实现声明 GAIOP 已正式接入。

## 2. 当前实现盘点与需确认差异

| 领域 | 已确认实现 | 尚未冻结或尚未完成 |
|---|---|---|
| 报告 | GAIOP 报告 Skill 会生成报告与同名审计 JSON；Admin 可安全扫描、下载、管理员删除并按来源字段隔离 | 当前 GAIOP 审计生成链未写入 `sourceUserId`、`sourceSessionId`、`dataSourceId`；当前只写根目录，不支持用户/类型分层 |
| 告警 | GAIOP 已有 NAPM Alert Query 与 Syslog watcher；Admin 临时通过只读 SSH 读取并解析 Syslog | watcher 当前主要用于企业微信推送，不是 GAIOP 的持久化告警服务；Admin 临时 SSH 读取不能作为正式运行时 |
| 会话 | Admin BFF 已有会话归属、Gateway `config.get/config.patch` 适配和基础测试 | Web 路由字段、真实 Gateway 版本兼容和生效回显尚未验收 |
| 数据源 | Admin 已实现加密存储、单一激活源和受控运行时桥接 | 该桥接消费能力目前在原 GAIOP 本地未提交工作树中，不能假定已进入 `8fe0cbe` 最新基线；需后端确认合并方式 |

### 2.1 已发现的文档差异

- `ReportGenerationService` 的实际白名单包含 `quick_report`、`diagnostic_report`、`comparative_report`、`operation_report`、`inspection_report`、`summary_report`；旧 `report-workflow-contract.md` 仍只列出前四种。正式契约以实现与测试为准，后端需更新旧说明。
- 报告 Skill 当前输出含绝对 `filePath/auditPath`，而 Admin 正式消费不应依赖或回显绝对路径。v0.1 要求新增安全相对路径字段，并逐步停止把绝对路径当作跨端字段。
- Syslog watcher 的默认用途是实时推送，尚未提供告警入库、查询、分页或状态 API；这些能力须作为 GAIOP 正式告警模块实现，不能由页面推断。

## 3. 通用约定

### 3.1 标识、时间与枚举

| 项目 | 约定 |
|---|---|
| ID | 所有跨端 ID 为不透明字符串；浏览器不得由用户名、文件名或规则 ID 推导所有者 |
| 时间 | API 传输使用 Unix 毫秒；需要喂给 NAPM Skill 的 `start/end` 使用对齐到分钟的 Unix 秒，并在字段名或对象层级中明确单位 |
| 缺失值 | `null` 或字段缺失表示“未记录”；不可使用当前登录用户、通道账号或默认数据源补写 |
| 分页 | `page` 从 1 开始，`pageSize` 最大 100，读取/结果上限最大 3000；返回 `availableCount`、`hasMore`、`limitReached` |
| 错误 | 返回稳定 `code` 与面向用户的非敏感 `message`；BFF 记录动作与结果，不记录原始 Syslog、请求体、绝对路径或凭据 |

### 3.2 生效状态

所有跨端配置或运行时对象统一使用：

- `pending`：已保存目标或尚未联调，不代表运行时生效。
- `applied`：目标服务确认已接收，仍需按模块定义回显。
- `failed`：目标服务明确拒绝或不可达，附非敏感错误码。
- `unknown`：无法安全确认，不得显示为成功。

## 4. 报告生成、审计与管理契约

### 4.1 职责分界

```text
当前登录用户
→ Admin BFF 签发可信来源信封（仅 Web 会话）
→ Gateway / GAIOP 报告生成链验签并写审计 JSON
→ GAIOP_REPORTS_DIR 受控共享目录
→ Admin BFF 安全扫描、入库、权限隔离
→ 列表、下载、管理员删除与审计
```

GAIOP 负责生成报告实体、审计 JSON、来源验签与目录安全；Admin 负责读取隔离、管理操作审计和展示。报告不得由管理页面上传、创建、编辑或重命名。

### 4.2 报告审计 JSON v1（待后端确认）

正式生成的配套 JSON 必须至少包含：

```json
{
  "schemaVersion": "gaiop.report-audit.v1",
  "reportId": "opaque-report-id",
  "reportType": "diagnostic_report",
  "format": "docx",
  "title": "报告标题",
  "fileName": "opaque-report-id.docx",
  "relativePath": "<受控相对路径>",
  "generatedAt": "2026-07-16T00:00:00.000Z",
  "sourceUserId": "opaque-user-id-or-null",
  "sourceSessionId": "opaque-session-id-or-null",
  "dataSourceId": "opaque-data-source-id-or-null",
  "audit": { "sourceSkill": "openclaw-napm-report" }
}
```

- `fileName` 必须为基名，不能带路径分隔符；`relativePath` 必须相对 `GAIOP_REPORTS_DIR`，不能包含 `..`、绝对路径或符号链接越界。
- `filePath`、`auditPath`、`downloadUrl` 可保留为 GAIOP 内部结果字段，但不再是 Admin 的正式输入，且不得由 Admin 回显。
- `sourceUserId`、`sourceSessionId`、`dataSourceId` 可为空；为空时 GAIOP 写入 `_unattributed/<reportType>/`，Admin 仅向管理员展示。
- `reportType` 使用第 2.1 节的六项白名单；模板 ID 可以额外记录，但不能替代报告类型。

### 4.3 可信来源信封

Admin BFF 已准备在 `chat.send.metadata.gaiopReportProvenance` 中附加用户 ID、会话 ID、签发时间和 HMAC。正式启用前，GAIOP 必须实现并测试：

1. 仅接受服务端 metadata，浏览器提交的同名字段必须被覆盖或拒绝；
2. 使用部署侧共享密钥验签，校验 24 小时时效和会话 ID 一致性；
3. 验证失败时不写入 `sourceUserId/sourceSessionId`，并以不含敏感信息的状态记录；
4. 通过后将来源字段写入报告审计 JSON，供 Admin 扫描；
5. 该开关默认关闭，直到真实 Gateway metadata 透传验证通过。

### 4.4 报告目录与 Admin 扫描改造

最终目录约定为 `<GAIOP_REPORTS_DIR>/<sourceUserId 或 _unattributed>/<reportType>/`。GAIOP 与 Admin 使用同一受控卷；Admin 后续需从“仅扫描根目录”改为安全递归扫描 JSON 配对文件，并只保存/使用验证后的相对路径。

### 4.5 验收

1. 两个不同 Web 用户各生成一份报告，来源字段和目录均正确。
2. 普通用户只能下载自己的报告；管理员可查看 `_unattributed`；未知来源不误授权。
3. 篡改 JSON、`relativePath`、用户 ID 或报告类型不能越界或冒充来源。
4. 管理员删除同时删除实体与 JSON，并记录不含路径的审计。
5. 共享卷下的新报告无需手工导入即可出现在 Admin 列表。

## 5. 告警接收、持久化、列表与分析契约

### 5.1 正式与过渡链路

正式链路固定为：

```text
NAPM Syslog → GAIOP 接收器 → 解析/去重/持久化 → Admin BFF → 告警通知 → 对话分析
```

当前 `GAIOP-Admin → 只读 SSH → OpenClaw Syslog` 仅是页面过渡数据源：不写入远端、不修改 NAPM/OpenClaw，也不替代正式接收器。正式接收器可复用 watcher 的解析、GBK 兼容、分钟窗口和告警详情补充逻辑，但不得绑定企业微信推送或 OpenClaw 固定目录。

### 5.2 告警记录 v1（待后端确认）

GAIOP 应持久化并向 Admin BFF 提供以下脱敏字段：

```json
{
  "id": "persistent-alert-id",
  "eventId": "NAPM-event-id-or-null",
  "ruleId": "NAPM-rule-id-or-null",
  "occurredAt": 1780000000000,
  "sourceIp": "198.51.100.10",
  "category": "userAlerts",
  "severity": "紧急",
  "name": "告警名称",
  "description": "可选摘要",
  "groupPath": "可选对象路径",
  "start": 1780000000,
  "end": 1780000060,
  "metrics": [{ "name": "指标", "value": "1", "unit": "毫秒" }],
  "triggerCondition": "可选触发条件",
  "status": "active",
  "receivedAt": 1780000000000
}
```

- `eventId` 是与 NAPM `alertsDetail` 和数据包分析关联的优先标识；`ruleId` 只是规则标识，不得作为事件唯一键。
- `start/end` 为 Unix 秒，传给告警/数据包 Skill 前由 Admin BFF 按既有规则扩展至分钟边界；没有 `eventId` 或 `start` 时，页面必须禁用“告警数据包详细分析”。
- `category` 必须是已知七类键之一；严重级别当前使用轻微/重大/紧急。未识别值保留原值并标注未知，不强制映射。
- 持久化去重键、保留期、状态流转和接收协议（UDP/TCP/TLS）由后端负责人确认后补入 v1.1；当前不得猜测。

### 5.3 服务边界与列表操作

浏览器继续使用 Admin BFF 的 `GET /api/alerts`、`GET /api/alerts/time` 和当前页导出接口。Admin BFF 对 GAIOP 告警服务的实际传输可为受控 REST、数据库适配或消息读取，但必须在后端确认后固定，不能让浏览器感知或选择服务器地址。

列表至少支持时间、级别、类型、告警名称/来源 IP/事件 ID、分页与 TOP 上限。返回必须明确来源状态；GAIOP 不可用时为 `503 ALERT_SOURCE_UNAVAILABLE`，不能回退成空列表。

### 5.4 告警到对话

Admin 维持现有文本交接：`分析告警数据包 eventId=<id> start=<seconds> end=<seconds> <metric>`。它只作为新会话输入草稿，不写入 URL 长期存储、审计详情或远端原始日志。GAIOP Alert Query Skill 已支持基于 `eventId/start/end` 的详情、时间序列和数据包衔接；正式联调需验证该文本能触发正确 Skill 且时间窗口一致。

### 5.5 验收

1. NAPM 新告警到达后，GAIOP 接收器持久化一次；重启后记录仍可查询。
2. 不同类别、严重级别、恢复告警和未知字段均按约定展示。
3. Admin 分页、TOP、时间筛选不读取原始 Syslog，也不泄露接收配置。
4. 从详情进入新会话，`eventId/start/end` 与持久化记录一致；返回按钮恢复原筛选状态。
5. 接收或查询失败展示明确不可用状态，不静默丢弃或伪造空结果。

## 6. 会话归属与 Gateway 配置契约

### 6.1 稳定 BFF 接口

浏览器只使用以下 Admin BFF 接口：

| 操作 | Admin BFF 接口 | 当前状态 |
|---|---|---|
| 创建工作台会话 | `POST /api/workspace/sessions` | 本地基础收口完成 |
| 工作台 RPC | `POST /api/rpc` | 已有 RBAC、会话归属与 SSE 过滤 |
| 读取/保存会话策略 | `GET/PUT /api/system-settings/sessions` | 参数适配和模拟测试完成 |

GAIOP/Gateway 必须把配置差异封装在 BFF 适配层后面。浏览器不能发送 `originatingChannel`、`originatingTo` 或其它来源路由字段；当前 Gateway 已验证会拒绝不完整组合。

### 6.2 会话策略与真实生效

会话设置字段固定为 `loginSessionHours`、`idleTimeoutMinutes`、`agentContextIdleMinutes`、`historyRetentionDays`。BFF 先调用 Gateway `config.get/config.patch`，成功后保存本地策略，并返回 `pending/applied/failed/unknown` 运行时状态。真实 Gateway 版本、完整路由字段组合和 `config.patch` 回显须由后端确认后纳入适配测试；在此之前 Web 渠道超长空闲窗口只能显示待验证。

### 6.3 验收

1. 非管理员不能通过直接请求修改会话策略。
2. Gateway 拒绝时 SQLite 不保存新目标；Gateway 成功但 SQLite 失败时返回可诊断错误。
3. 新建、发送、历史、继续、删除均不能越过 Admin 会话所有者隔离。
4. 真实 Gateway 对话发送正常，且不再出现 `originatingTo is required`。

## 7. 数据源运行时消费契约

Admin 保存多条数据源、仅允许一条激活源，并只向页面回显脱敏状态。GAIOP Skill 在调用前必须读取同一受控运行时桥接，消费 `dataSourceId` 与必要的连接信息；日志不写地址、账号、密码或桥接路径。

该能力当前不应直接从原 GAIOP 脏工作树复制到 `GAIOP-latest`。后端负责人需先确认哪些本地改动进入其后续分支，再以测试证明 `dataSourceId` 能从激活源传到报告审计 JSON。

## 8. 责任、确认项与下一步

| 项目 | Admin 负责人 | GAIOP 后端负责人 | 集成人 |
|---|---|---|---|
| 报告审计 v1、来源信封 | 保持 BFF 签发、扫描与隔离 | 验签、写入 JSON、目录分层 | 共享卷与密钥部署 |
| 正式告警服务 | 保持页面/BFF 稳定接口 | 接收、解析、去重、持久化、查询 | Syslog 并行迁移与观察 |
| Gateway 会话 | BFF 参数适配、权限、页面状态 | 确认版本/路由/配置能力 | 环境变量与真实联调 |
| 数据源桥接 | 管理与脱敏状态 | 消费桥接与来源 ID | 密钥、权限、回退 |

后端负责人确认本文件后，实施顺序为：

1. 报告审计 v1 与来源验签（最小可验证闭环）。
2. 告警接收/持久化与 Admin BFF 适配（替换只读 SSH 过渡源）。
3. Gateway 会话策略真实版本适配。
4. 数据源桥接从本地未提交改动整理为后端正式能力。
5. 所有模块在本地完成契约测试后，才进入 237 并行部署。
