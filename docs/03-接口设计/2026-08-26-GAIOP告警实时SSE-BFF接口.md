# GAIOP 告警实时 SSE BFF 接口

| 属性 | 内容 |
|---|---|
| 日期 | 2026-08-26 |
| 状态 | 阶段三 BFF 已实现，尚未部署；阶段四前端待接入 |
| 上游契约 | Receiver `gaiop.alert-event.v1` / `GET /events` |
| 浏览器入口 | 既有 Bearer 认证 `GET /api/events` |
| 代码 | `server/lib/alert-receiver-stream.js`、`server/lib/alert-stream-state.js`、`server/lib/sse-access.js` |

## 1. 边界与链路

```text
Receiver GET /events（BFF 进程唯一连接）
→ SSE 分帧与契约校验
→ mapGAIOPAlertEvent() 页面模型投影
→ 既有 BFF SSE 广播
→ 浏览器 GET /api/events
```

- 浏览器只连接 Admin BFF，不获得 Receiver URL、Token、原始信封或内部部署信息。
- BFF 复用 `GAIOP_ALERT_RECEIVER_URL` 和可选的 `GAIOP_ALERT_RECEIVER_TOKEN`；上游请求使用 `Accept: text/event-stream`、`X-GAIOP-Alert-Token` 和续传时的 `Last-Event-ID`。
- Token 只进入请求头，不进入 URL、日志、审计、浏览器事件或错误正文。
- 上游连接属于 BFF 进程，不属于浏览器客户端；浏览器连接数变化不会新增 Receiver 连接。
- Receiver 不可用只改变告警流运行状态，不阻塞 Gateway、登录、普通管理 REST 或既有 `GET /api/alerts` 查询实现。

## 2. 上游校验与处理顺序

BFF 只接受同时满足以下条件的事件：

1. SSE `event` 为 `alert.created`；
2. SSE `id` 是正安全整数；
3. JSON `schemaVersion` 为 `gaiop.alert-event.v1`；
4. JSON `eventType` 为 `alert.created`；
5. JSON `cursor` 与 SSE `id` 相等，并严格大于当前续传游标；
6. `alert` 是对象且存在非空业务 `id`；
7. `alert.severity` 只允许 `轻微`、`重大`、`紧急`。

通过校验后严格按下列顺序执行：

```text
mapGAIOPAlertEvent(alert)
→ 交给既有 BFF 广播流程
→ SQLite 推进 resume_cursor 与 last_processed_cursor
```

因此进程在“已广播、未落游标”窗口退出时可能重复通知，但不会因提前推进游标而漏通知。重复/倒序 cursor、重复业务告警 ID、畸形 JSON、未知 schema/eventType 和未知级别不广播；单条坏事件只记录不含业务字段的诊断码，不结束 BFF。

## 3. SSE 分帧和首次基线

BFF 分帧器支持跨网络 chunk、LF/CRLF、`id`、`event`、多行 `data` 和注释帧。Receiver 心跳 `: heartbeat ...` 只维持连接，不生成业务事件。

首次没有本地游标时，BFF 不发送 `Last-Event-ID`。Receiver 首先发送：

```text
: connected cursor=N
```

BFF 必须先解析并持久化 `N`，再接受后续业务事件。该 `N` 是连接建立时的实时基线，不表示旧告警已经作为实时事件重放。这样即使首条告警到达前连接中断，下次也会携带 `Last-Event-ID: N` 补偿断线窗口。

已有游标或重启恢复时，BFF 使用持久化 `resume_cursor` 作为 `Last-Event-ID`；Receiver 有界补发结束连接后，BFF 继续从最新成功游标分批追平。

## 4. SQLite 运行状态

Admin 既有 SQLite 增加单例表 `alert_stream_runtime`，不引入新的数据库或消息系统。

| 字段 | 含义 |
|---|---|
| `resume_cursor` | 下一次 `Last-Event-ID`；可来自首次/重建基线或成功处理事件 |
| `last_processed_cursor` | 最近一次完成校验、投影、广播并成功落库的业务事件游标 |
| `connection_state` | `idle/connecting/connected/unavailable/authentication_error/gap/receiver_reset/protocol_error` |
| `gap_state` | `unresolved` 或 `receiver_reset`；不会因重新连上而自动声明已补齐 |
| `oldest_available_sequence/latest_sequence` | Receiver 返回的非敏感可用边界 |
| `last_error_code/gap_detected_at/updated_at` | 非敏感诊断和时间 |

表由 `migrateAlertStreamState()` 幂等创建。首次基线只更新 `resume_cursor`；正常事件同时推进两个 cursor；断档或 Receiver 重置只重建 `resume_cursor`，保留 `last_processed_cursor` 的历史事实。

## 5. 重连和错误状态

- 普通 EOF、读取失败或网络失败：无限重连，延迟按 `1/2/5/10/30` 秒递增并封顶；成功取得基线后重置退避。
- `401 ALERT_RECEIVER_UNAUTHORIZED`：记录 `authentication_error`，按 30 秒低频重试；不回显 Token、URL 或底层错误正文。
- `409 ALERT_CURSOR_EXPIRED`：保存 `gap_state=unresolved` 及两个边界，发送 `alertStreamState: gap`，将 `resume_cursor` 重建为 `latestSequence` 后恢复实时连接。缺失区间不会写入 `last_processed_cursor`，也不会标记为已补齐。
- `409 ALERT_CURSOR_AHEAD`：视为 Receiver 数据重置或本地游标异常，记录 `receiver_reset`，以 Receiver `latestSequence` 安全重建实时基线，并要求页面刷新历史列表。
- 非 SSE Content-Type、游标冲突响应缺少合法边界或基线注释不匹配：记录 `protocol_error`，不猜测数据。

停止 BFF 时会中止 fetch、reader 和退避定时器；配置重新加载且 Receiver URL/Token 名称对应值发生变化时，会中止当前连接并由同一管理循环使用新配置重连，不并行保留旧连接。

## 6. 浏览器事件契约

正常告警：

```json
{
  "type": "alert",
  "action": "triggered",
  "cursor": 12345,
  "payload": {
    "id": "业务告警ID",
    "occurredAt": "2026-08-26T04:00:00.000Z",
    "sourceHost": "198.51.100.10",
    "category": "userAlerts",
    "categoryLabel": "用户体验告警",
    "severity": "紧急",
    "name": "告警名称",
    "restored": false
  }
}
```

`payload` 完整形态与 `GET /api/alerts` 单条页面模型一致，由唯一的 `mapGAIOPAlertEvent()` 生成。`action` 在 `payload.restored=true` 时为 `recovered`，否则为 `triggered`。

控制事件示例：

```json
{
  "type": "alertStreamState",
  "state": "gap",
  "code": "ALERT_CURSOR_EXPIRED",
  "oldestAvailableSequence": 100,
  "latestSequence": 180,
  "historyRefreshRequired": true
}
```

控制事件只含状态、序列边界和刷新提示，不含告警正文、Receiver 地址、Token、原始错误或日志路径。还可能出现 `connected`、`unavailable`、`authenticationError`、`receiverReset`、`protocolError`、`idle`。

## 7. 浏览器权限

`alert` 和 `alertStreamState` 与 `GET /api/alerts` 使用同一角色范围：

| 角色 | 告警实时事件 |
|---|---|
| 基础 | 拒绝；不得获得告警字段、序列边界或流状态 |
| 标准 | 允许 |
| 审计 | 允许，只读 |
| 管理员 | 允许 |

Gateway `type:event` 继续执行既有 `sessionKey` 归属隔离；`gatewayState`、`backupProgress` 等非告警事件维持原行为。浏览器 `/api/events` 仍必须先通过 Bearer 登录认证，Token 不允许进入 URL。

## 8. 阶段四前端消费

阶段四只需扩展现有浏览器 SSE 消息分派，不新建第二条连接：

1. 收到 `type: alert` 时，以 `cursor` 和 `payload.id` 幂等；按 `action` 生成触发/恢复通知，并按需要合并当前列表。
2. 收到 `alertStreamState` 的 `gap` 或 `receiverReset` 时调用既有 `GET /api/alerts` 刷新当前历史视图；不得把刷新成功解释为缺失实时区间已经补齐。
3. `unavailable/authenticationError/protocolError` 只展示非敏感连接提示，不清空已有列表；历史查询仍按 `GET /api/alerts` 的实际结果处理。
4. 前端继续忽略未知 `type`，避免协议增量破坏现有工作台。

## 9. 当前限制

- 本阶段不实现前端 Store、弹窗、列表热更新或详情跳转。
- 不保存浏览器通知队列；沿用现有 SSE response 写入，不增加无界缓存。
- Receiver 是单写实例；BFF 保证每个进程一个上游连接，不提供跨多个 BFF 进程的分布式领导者选举。
- `gap_state=unresolved` 没有自动清除机制；后续若要人工确认或对账，必须另行定义可审计流程。
- 本阶段未部署 237，未修改 Receiver、GAIOP 后端、Gateway 或前端源码。
