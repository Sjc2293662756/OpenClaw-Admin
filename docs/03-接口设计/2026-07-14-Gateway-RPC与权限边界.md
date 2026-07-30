# Gateway RPC 与权限边界

| 属性 | 内容 |
|---|---|
| 创建日期 | 2026-07-14 |
| 最后更新 | 2026-07-27 |
| 代码依据 | `server/index.js` 的 `/api/status`、`/api/rpc`、`/api/events`，`server/lib/permissions.js` |

> **当前边界（2026-07-27）：** WebChat发给Gateway/模型的数据面只包含标准对话参数。登录用户、报告来源、活动数据源等管理信息由Admin/GAIOP控制面通过服务器端签名快照独立处理，不再写入 `chat.send.metadata`。`chat.send` 因Gateway版本兼容需要回退到带 `sessionKey` 的 `agent` 时，仅改变RPC适配，不改变会话归属、标题或报告来源边界。本文第3节旧 metadata 方案只用于解释迁移原因。

## 1. 接口

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/api/status` | 登录 | 获取 Gateway 状态 |
| POST | `/api/rpc` | 登录 + 方法级 RBAC + 工作台会话归属校验 | 调用一个 Gateway 方法 |
| GET | `/api/events` | 登录 | SSE 转发 Gateway 事件 |
| POST | `/api/workspace/sessions` | standard/admin | 创建并登记当前用户的工作台会话 |

RPC 请求：

```json
{ "method": "sessions.list", "params": {} }
```

成功：`{ "ok": true, "payload": ... }`。缺方法：`RPC_METHOD_REQUIRED`；Gateway 离线：`GATEWAY_UNAVAILABLE`；底层调用失败：`RPC_CALL_FAILED`。

## 2. 方法权限

- 管理员：全部方法。
- 所有登录角色：明确只读方法、`.list`、`.get`、`.status` 和 `status/health/config.get`；敏感读取方法被排除。
- 标准用户：额外允许对话、停止、会话重置/删除/创建/发送/标注、Skills 安装更新、任务增删改执行等白名单。
- 审计/基础用户：写方法分别返回 `AUDITOR_READ_ONLY`、`BASIC_READ_ONLY`。
- 标准用户调用未列入白名单的写方法返回 `STANDARD_ROLE_RESTRICTED`。

敏感读取包括日志、执行审批、智能体文件和会话导出等，不因名称像读取就自动放行。非管理员 `config.get` 返回值会对密码、Token、API Key、Secret、Credential 等字段递归掩码。

## 3. 对话来源

当前 Web 工作台的 `chat.send` 不携带浏览器来源路由字段，使用 Gateway 默认会话路由。渠道级会话空闲策略的完整适配由 Admin BFF 在后续真实 Gateway 联调中处理，浏览器不能自行冒用来源值。

当 `GAIOP_REPORT_PROVENANCE_ENABLED=true` 且 BFF 配置了至少 32 字符的 `GAIOP_REPORT_PROVENANCE_SIGNING_KEY`，BFF 会在 `chat.send` 的内部 metadata 中附加报告来源信封。信封只含版本、当前登录用户 ID、会话 ID、签发时间和 HMAC 签名；浏览器不会得到密钥，也不能指定 `sourceUserId`。GAIOP 必须同时验签、检查 24 小时时效并确认会话一致后才可将它写入报告审计。

此元数据传递依赖 Gateway 对 `chat.send` metadata 的实际透传。当前未完成真实 Gateway/Web 联调，样例配置保持关闭；不得据此宣称生产报告已写入来源用户。

## 4. 工作台会话归属

`POST /api/workspace/sessions` 不接收会话标识或用户标识。BFF 使用当前登录用户创建 `workspace_sessions` 记录，并返回一次 BFF 签发的 `sessionKey`：

```json
{ "ok": true, "sessionKey": "agent:main:main:dm:webchat-<opaque-id>" }
```

非管理员访问 `sessions.list`、`sessions.history`、`chat.history`、`chat.send`、`chat.abort`、`sessions.delete` 等受控 RPC 时，BFF 仅允许该用户处于 active 状态的登记会话；不匹配或未登记统一返回 `404 SESSION_NOT_FOUND`，避免枚举他人会话。删除成功后登记记录被软删除，不能由普通用户重新认领。会话列表也会按同一登记集合过滤。

管理员保持 Gateway 历史会话的排障访问能力。Gateway SSE 事件仅在事件载荷能解析出当前用户有权访问的会话标识时才下发给非管理员；无会话标识的事件不向非管理员广播。当前规则覆盖 Web 工作台，不为外部渠道会话虚构所有者。

## 5. 审计与风险

当前非只读 RPC 统一记录“执行业务操作 + method”，但没有记录参数摘要、结果和资源对象；需避免把敏感 params 写入审计。仅按方法名后缀判断只读存在版本兼容风险，新增 Gateway 方法应先进入明确分类，不能默认授予标准用户。

## 6. SSE

SSE 使用认证后长连接，响应禁用代理缓冲。生产 Nginx 需要关闭该路径缓冲并设置合理读超时。Token 过期、服务重启或网络断开后前端应重连，但需避免无限快速重试。

## 7. 2026-07-15 对话来源路由兼容修正（优先于第 3 节旧描述）

当前 Admin 浏览器请求不再发送 `originatingChannel`、`originatingTo` 或其他来源路由字段。一次真实 Gateway 返回表明：只要请求使用任一来源路由字段，就必须同时传入完整、相互兼容的路由参数；只传 `originatingChannel: webchat` 会返回 `originatingTo is required when using originating route fields`。

因此浏览器不能为实现 Web 工作台的空闲策略而猜测目的地、伪造路由或把任意来源值透传给 Gateway。若未来恢复该能力，Admin BFF 必须：

1. 依据已验证的 Gateway 版本构造完整来源路由参数；
2. 在 BFF 做固定值校验、版本兼容、权限和审计，前端不提供自由输入；
3. 以真实 Gateway 发送、历史连续性和 `config.patch` 生效结果完成联调后，才更新为“已生效”。

本修正只影响未验证的 Web 渠道级空闲覆盖；不影响 BFF 创建的会话归属校验、SSE 过滤、报告来源信封或告警分析文本交接。

## 8. 变更记录

| 日期 | 内容 |
|---|---|
| 2026-07-15 | 发现并修正当前 Gateway 对单独来源路由字段的兼容性问题；浏览器侧移除不完整字段，完整路由适配留待 BFF/真实 Gateway 联调 |
