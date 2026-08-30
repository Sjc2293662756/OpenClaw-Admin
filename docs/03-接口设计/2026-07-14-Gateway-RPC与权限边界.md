# Gateway RPC 与权限边界

| 属性 | 内容 |
|---|---|
| 创建日期 | 2026-07-14 |
| 最后更新 | 2026-08-10 |
| 代码依据 | `server/index.js` 的 `/api/status`、`/api/rpc`、`/api/events`，`server/lib/permissions.js` |

> **当前边界（2026-07-27）：** WebChat发给Gateway/模型的数据面只包含标准对话参数。登录用户、报告来源、活动数据源等管理信息由Admin/GAIOP控制面通过服务器端签名快照独立处理，不再写入 `chat.send.metadata`。`chat.send` 因Gateway版本兼容需要回退到带 `sessionKey` 的 `agent` 时，仅改变RPC适配，不改变会话归属、标题或报告来源边界。本文第3节旧 metadata 方案只用于解释迁移原因。

## 1. 接口

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/api/status` | 登录 | 获取 Gateway 状态 |
| POST | `/api/rpc` | 登录 + 方法级 RBAC + 工作台会话归属校验 | 调用一个 Gateway 方法 |
| GET | `/api/events` | 登录 | SSE 转发 Gateway 事件 |
| POST | `/api/workspace/sessions` | standard/admin | 创建并登记当前用户的工作台会话 |
| GET | `/api/session-retention` | auditor/admin | 读取 180 天、7 天缓冲、开关和待删除/长期保留安全摘要 |
| POST | `/api/session-retention/cancel` | admin | 取消一个待删除会话 |
| PUT | `/api/session-retention/long-term` | admin | 设置或取消长期保留 |
| POST | `/api/session-retention/attachments` | admin | 登记附件留存元数据；不返回附件路径，不执行文件删除 |

RPC 请求：

```json
{ "method": "sessions.list", "params": {} }
```

成功：`{ "ok": true, "payload": ... }`。缺方法：`RPC_METHOD_REQUIRED`；Gateway 离线：`GATEWAY_UNAVAILABLE`；底层调用失败：`RPC_CALL_FAILED`。

## 2. 方法权限

> **2026-08-31 模块覆盖更新：** 每个已登记管理 RPC 先映射到服务端固定模块 key。有效模块为 deny 时返回 `MODULE_ACCESS_DENIED`；个人 allow 只能扩展已登记的安全读取，不改变下列写动作、会话归属和敏感投影。`usage.cost/cost.usage` 为全局数据，不因 dashboard allow 授予原角色无权用户。完整映射见[2026-08-31-单用户模块权限覆盖设计](../04-公共设计/2026-08-31-单用户模块权限覆盖设计.md)。

- 管理员：全部方法。
- 所有登录角色：`status/health` 和会话读取；基础/标准的会话列表及使用量按本人归属投影，审计和管理员可读取全部。
- 标准用户：额外允许对话、停止以及本人会话的重置、删除、创建、发送和标注。
- 审计用户：额外允许任务只读、频道/插件/Skills 安全状态、系统监控和全局费用统计读取。
- 标准用户：额外允许频道/插件/Skills 安全状态、系统监控及经过白名单投影的模型选择配置读取。
- 模型明细、智能体、记忆和未显式列入角色集合的管理读取均拒绝；方法名以 `.list/.get/.status` 结尾不再自动获得业务授权。
- Skills 安装/更新、模型切换、任务增删改执行和 Office/Wizard REST 仅管理员可用。
- 审计/基础用户：写方法分别返回 `AUDITOR_READ_ONLY`、`BASIC_READ_ONLY`。
- 标准用户调用未列入白名单的写方法返回 `STANDARD_ROLE_RESTRICTED`。

敏感读取包括日志、执行审批、智能体文件和会话导出等，不因名称像读取就自动放行。非管理员读取 `config.get`、频道、插件和 Skills 时使用安全字段白名单投影，而不是在完整配置上做泛化掩码。

## 3. 对话来源

当前 Web 工作台的 `chat.send` 不携带浏览器来源路由字段，使用 Gateway 默认会话路由。渠道级会话空闲策略的完整适配由 Admin BFF 在后续真实 Gateway 联调中处理，浏览器不能自行冒用来源值。

当 `GAIOP_REPORT_PROVENANCE_ENABLED=true` 且 BFF 配置了至少 32 字符的 `GAIOP_REPORT_PROVENANCE_SIGNING_KEY`，BFF 会在 `chat.send` 的内部 metadata 中附加报告来源信封。信封只含版本、当前登录用户 ID、会话 ID、签发时间和 HMAC 签名；浏览器不会得到密钥，也不能指定 `sourceUserId`。GAIOP 必须同时验签、检查 24 小时时效并确认会话一致后才可将它写入报告审计。

此元数据传递依赖 Gateway 对 `chat.send` metadata 的实际透传。当前未完成真实 Gateway/Web 联调，样例配置保持关闭；不得据此宣称生产报告已写入来源用户。

## 4. 工作台会话归属

`POST /api/workspace/sessions` 不接收会话标识或用户标识。BFF 使用当前登录用户创建 `workspace_sessions` 记录，并返回一次 BFF 签发的 `sessionKey`：

```json
{ "ok": true, "sessionKey": "agent:main:main:dm:webchat-<opaque-id>" }
```

基础和标准用户访问 `sessions.list`、`sessions.history`、`chat.history`、`sessions.usage`、`chat.send`、`chat.abort`、`sessions.delete` 等受控 RPC 时，BFF 仅允许该用户处于 active 状态的登记会话；不匹配或未登记统一返回 `404 SESSION_NOT_FOUND`，避免枚举他人会话。删除成功后登记记录被软删除，不能由普通用户重新认领。会话列表和使用量也按同一登记集合过滤，全局聚合不会旁路泄露。

审计用户保持全部会话只读，管理员保持全部会话管理和 Gateway 排障能力。Gateway SSE 事件仅在事件载荷能解析出当前用户有权访问的会话标识时才下发给基础/标准用户；无会话标识的事件不向这些角色广播。当前规则覆盖 Web 工作台，不为外部渠道会话虚构所有者。

## 5. 会话留存删除边界

定时留存任务先通过 `sessions.list` 取得 Gateway 会话，再由 BFF 补充 Web/频道归属。自动处理只接受真实用户/助手活动字段；`updatedAt`、`createdAt`、`sessionStartedAt`、时间缺失、归属不明、多渠道共享、活动/流式中以及存在待处理任务或待交付结果都不能进入删除。

超过 180 天只写 Admin `pending_delete` 元数据，7 天后再次执行同样保护检查。最终删除只允许：

```json
{ "method": "sessions.delete", "params": { "key": "<sessionKey>", "deleteTranscript": true } }
```

Gateway 调用失败时不更新 `session_retention_records`、`workspace_sessions` 或附件记录。Gateway 成功后才在本地事务中更新两项会话元数据。普通用户或管理员通过 `/api/rpc` 手工删除时也先检查登记附件，不能绕过附件保护。

当前 Gateway 正式方法集中没有 `media.delete`、`attachment.delete` 或等价接口，也没有“删除会话必然原子删除附件”的正式契约。因此登记附件会阻止会话最终删除，临时附件虽登记最多 7 天到期时间，但只能报告能力缺口，不能直接操作 Gateway 私有文件。项目/智能体 memory、正式报告、配置和设备身份不进入本流程。

自动标记和最终删除使用独立环境开关且默认关闭。删除与失败审计只记录 sessionKey、动作、结果和稳定错误码，不记录聊天正文、附件内容或附件路径，按核心审计不少于 3 年保护。

## 6. 审计与风险

当前非只读 RPC 统一记录“执行业务操作 + method”，但没有记录参数摘要、结果和资源对象；需避免把敏感 params 写入审计。仅按方法名后缀判断只读存在版本兼容风险，新增 Gateway 方法应先进入明确分类，不能默认授予标准用户。

## 7. SSE

SSE 使用认证后长连接，响应禁用代理缓冲。生产 Nginx 需要关闭该路径缓冲并设置合理读超时。Token 过期、服务重启或网络断开后前端应重连，但需避免无限快速重试。

## 8. 2026-07-15 对话来源路由兼容修正（优先于第 3 节旧描述）

当前 Admin 浏览器请求不再发送 `originatingChannel`、`originatingTo` 或其他来源路由字段。一次真实 Gateway 返回表明：只要请求使用任一来源路由字段，就必须同时传入完整、相互兼容的路由参数；只传 `originatingChannel: webchat` 会返回 `originatingTo is required when using originating route fields`。

因此浏览器不能为实现 Web 工作台的空闲策略而猜测目的地、伪造路由或把任意来源值透传给 Gateway。若未来恢复该能力，Admin BFF 必须：

1. 依据已验证的 Gateway 版本构造完整来源路由参数；
2. 在 BFF 做固定值校验、版本兼容、权限和审计，前端不提供自由输入；
3. 以真实 Gateway 发送、历史连续性和 `config.patch` 生效结果完成联调后，才更新为“已生效”。

本修正只影响未验证的 Web 渠道级空闲覆盖；不影响 BFF 创建的会话归属校验、SSE 过滤、报告来源信封或告警分析文本交接。

## 9. 变更记录

| 日期 | 内容 |
|---|---|
| 2026-08-10 | 新增会话 180 天、7 天待删除、长期保留、附件保护、正式 Gateway 删除和独立关闭开关边界；代码未部署 237 |
| 2026-07-31 | 四角色改为显式 RPC 集合；会话使用量按归属投影；频道、插件、Skills 和标准配置使用安全白名单投影；移除标准用户任务、Skills 和模型管理写权限 |
| 2026-07-15 | 发现并修正当前 Gateway 对单独来源路由字段的兼容性问题；浏览器侧移除不完整字段，完整路由适配留待 BFF/真实 Gateway 联调 |
