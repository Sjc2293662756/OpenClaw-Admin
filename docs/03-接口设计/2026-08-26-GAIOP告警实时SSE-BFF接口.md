# GAIOP 告警实时 SSE BFF 接口

| 属性 | 内容 |
|---|---|
| 日期 | 2026-08-26 |
 | 状态 | 阶段四浏览器全局消费与断线补偿已实现，尚未部署 |
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

通过校验后严格按下列顺序执行。首次出现的业务告警走广播分支；同一 BFF 进程已经成功处理过相同 `alert.id` 时走幂等消费分支：

```text
mapGAIOPAlertEvent(alert)
→ 新业务 ID：交给既有 BFF 广播流程
  或已处理业务 ID：抑制重复广播并确认幂等消费
→ SQLite 推进 resume_cursor 与 last_processed_cursor
```

因此进程在“已广播、未落游标”窗口退出时可能重复通知，但不会因提前推进游标而漏通知。合法的新 cursor 若只因业务 `alert.id` 已处理而被抑制，仍作为成功的幂等消费推进两个 cursor，避免断线后反复重放；重复/倒序 cursor、畸形 JSON、未知 schema/eventType 和未知级别绝不推进。单条坏事件只记录不含业务字段的诊断码，不结束 BFF。

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
| `last_processed_cursor` | 最近一次完成校验、投影，并成功广播或成功幂等消费后落库的业务事件游标 |
| `connection_state` | `idle/connecting/connected/unavailable/authentication_error/gap/receiver_reset/protocol_error` |
| `gap_state` | `unresolved` 或 `receiver_reset`；不会因重新连上而自动声明已补齐 |
| `oldest_available_sequence/latest_sequence` | Receiver 返回的非敏感可用边界 |
| `last_error_code/gap_detected_at/updated_at` | 非敏感诊断和时间 |

表由 `migrateAlertStreamState()` 幂等创建。首次基线只更新 `resume_cursor`；正常广播和已处理业务 ID 的幂等消费都同时推进两个 cursor；断档或 Receiver 重置只重建 `resume_cursor`，保留 `last_processed_cursor` 的历史事实。

## 5. 重连和错误状态

- 普通 EOF、读取失败或网络失败：无限重连，延迟按 `1/2/5/10/30` 秒递增并封顶；成功取得基线后重置退避。
- `401 ALERT_RECEIVER_UNAUTHORIZED`：记录 `authentication_error`，按 30 秒低频重试；不回显 Token、URL 或底层错误正文。
- `409 ALERT_CURSOR_EXPIRED`：保存 `gap_state=unresolved` 及两个边界，发送 `alertStreamState: gap`，将 `resume_cursor` 重建为 `latestSequence` 后恢复实时连接。缺失区间不会写入 `last_processed_cursor`，也不会标记为已补齐。
- `409 ALERT_CURSOR_AHEAD`：视为 Receiver 数据重置或本地游标异常，记录 `receiver_reset`，以 Receiver `latestSequence` 安全重建实时基线，并要求页面刷新历史列表。
- 非 SSE Content-Type、游标冲突响应缺少合法边界或基线注释不匹配：记录 `protocol_error`，不猜测数据。

所有发给浏览器的 `alertStreamState` 都从上述 SQLite 单例状态统一投影。`connected` 仅表示实时通道恢复；只要 `gap_state` 仍为 `unresolved` 或 `receiver_reset`，`connected`、`unavailable`、`authenticationError`、`protocolError` 等状态都会同时保留 `gapState`、序列边界和 `historyRefreshRequired=true`。因此在线浏览器收到的后续状态与新浏览器连接时获得的初始状态语义一致，连接恢复不会隐藏历史断档。

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
  "gapState": "unresolved",
  "oldestAvailableSequence": 100,
  "latestSequence": 180,
  "historyRefreshRequired": true
}
```

控制事件只含状态、固定诊断码、序列边界和刷新提示，不含告警正文、Receiver 地址、Token、原始错误或日志路径。还可能出现 `connected`、`unavailable`、`authenticationError`、`receiverReset`、`protocolError`、`idle`。当存在未解决 gap/reset 时，这些状态都继续携带 `gapState` 与 `historyRefreshRequired=true`。

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
2. 收到任意 `alertStreamState` 且 `historyRefreshRequired=true` 时调用既有 `GET /api/alerts` 刷新当前历史视图；不能只判断顶层 `state`，也不得把刷新成功或后续 `connected` 解释为缺失实时区间已经补齐。
3. `unavailable/authenticationError/protocolError` 只展示非敏感连接提示，不清空已有列表；历史查询仍按 `GET /api/alerts` 的实际结果处理。
4. 前端继续忽略未知 `type`，避免协议增量破坏现有工作台。

## 9. 当前限制

- 本阶段不实现前端 Store、弹窗、列表热更新或详情跳转。
- 不保存浏览器通知队列；沿用现有 SSE response 写入，不增加无界缓存。
- Receiver 是单写实例；BFF 保证每个进程一个上游连接，不提供跨多个 BFF 进程的分布式领导者选举。
- `gap_state=unresolved` 没有自动清除机制；后续若要人工确认或对账，必须另行定义可审计流程。
- 已处理业务 ID 集合是每进程有界内存状态，不引入持久业务 ID 账本。重启后由持久化 `resume_cursor` 保证已经幂等消费的 cursor 不会再次请求；若 Receiver 在重启后以全新 cursor 再次发送相同业务 ID，BFF 会重新广播，阶段四仍须按 `cursor` 和 `payload.id` 幂等。
- 本阶段未部署 237，未修改 Receiver、GAIOP 后端、Gateway 或前端源码。

## 10. 阶段四浏览器补偿接口与连接底座

`GET /api/alerts/changes?afterSequence=<cursor>&limit=<n>` 使用与 `GET /api/alerts` 相同的登录边界，其中标准、审计、管理员可读，基础账号返回 `403 ALERT_ACCESS_DENIED`。`afterSequence` 必须为非负安全整数，`limit` 为 1–300；非法游标返回 `400 ALERT_CURSOR_INVALID`。接口通过 Receiver 保留窗口的 `GET /alerts?pageSize=3000` 构造连续序列后缀，并复用 `mapGAIOPAlertEvent()`，不会另建告警映射。

- 无 `afterSequence`：仅返回 `{ events: [], latestSequence }` 作为首次浏览器基线，绝不回放历史告警。
- 有游标且连续：`events` 以 `cursor` 升序返回，单页最多 `limit` 条；`hasMore=true` 时浏览器有限分批追平。
- 游标早于可证明连续的保留窗口、晚于最新序列，或补偿超出 1000 条/6 页：返回或前端标记 `historyRefreshRequired=true`，不把不完整窗口伪装成补齐结果。
- Receiver 不可用统一返回 `503 ALERT_SOURCE_UNAVAILABLE`，不暴露地址、Token、原始错误或日志。

浏览器仍只建立一条带 Bearer 头的 `GET /api/events`。应用根节点在“Token + 当前用户”就绪时创建连接、激活按用户 ID（回退用户名）隔离的轻量游标；路由切换不会重建连接。SSE `connected` 后再执行一次补偿，实时与补偿事件以 `cursor` 和 `payload.id` 共同去重。退出、401 和应用卸载会立刻断开并清空内存告警正文；该账号的仅游标 localStorage 留存以便下次安全续传。

普通实时事件只能严格推进该账号的 cursor 高水位，已淘汰的内存去重键不会让陈旧 cursor 再次进入通知队列。补偿批次单独保留其 `afterSequence`：若 SSE 在补偿期间先到达更大 cursor，补偿仍可接收介于批次下界和该高水位之间、尚未收到的事件；同 cursor 或同业务 ID 则不重复通知。补偿 fetch 使用 AbortController、账号快照和运行代次，退出、账号切换或应用卸载时立即失效，任何晚到响应均不得写入新会话。浏览器默认无限退避重连（上限 30 秒）；显式断开和 401 仍会停止重试。

`alertStreamState` 额外可带 `latestCursor` 与 `lastProcessedCursor`，均为非敏感序号。`gapState` 或 `historyRefreshRequired` 一旦出现，后续 `connected` 不得自动清除；阶段五可从全局 `alertRealtime` Store 读取 `recentEvents`（150 条）、`unreadCount`、`lastCursor`、`streamState`、`gapState`、`historyRefreshRequired` 与 `lastErrorCode`，再调用 `markRead`、`remove` 或 `clear` 实现弹窗/消息面板。
