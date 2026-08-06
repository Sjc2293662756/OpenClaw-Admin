import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import {
  canAccessWorkspaceSession,
  backfillHistoricalWebChatTitles,
  createWorkspaceSession,
  deriveWorkspaceSessionTitle,
  deriveFirstUserMessageTitle,
  enrichSessionPayload,
  ensureWorkspaceSessionAccess,
  extractSessionKeyFromEvent,
  filterHiddenLegacySessions,
  filterSessionListPayload,
  filterSessionUsagePayload,
  getConversationTitleCandidate,
  hideLegacySharedSession,
  isConversationSessionSend,
  isLegacySessionHidden,
  listOwnedWorkspaceSessionKeys,
  markWorkspaceSessionDeleted,
  __test__,
  setRecoveredWebChatTitle,
  setWorkspaceSessionTitleIfEmpty,
} from './session-ownership-service.js'

function createTestDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE workspace_sessions (
      session_key TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      session_title TEXT,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    );
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL
    );
    CREATE TABLE hidden_legacy_sessions (
      session_key TEXT PRIMARY KEY,
      hidden_by_user_id TEXT NOT NULL,
      hidden_at INTEGER NOT NULL
    );
    CREATE TABLE historical_webchat_titles (
      session_key TEXT PRIMARY KEY,
      session_title TEXT NOT NULL,
      title_source TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE personal_wechat_accounts (
      account_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      wechat_user_id TEXT
    );
  `)
  db.prepare('INSERT INTO users (id, username) VALUES (?, ?), (?, ?)').run('user-alice', 'alice', 'user-bob', 'bob')
  return db
}

describe('personal WeChat session presentation', () => {
  it('enriches openclaw-weixin sessions with the GAIOP-entered account name', () => {
    const db = createTestDb()
    db.prepare('INSERT INTO personal_wechat_accounts (account_id, display_name, wechat_user_id) VALUES (?, ?, ?)')
      .run('9150aa2b4764-im-bot', '杨硕微信', 'o9cq809TQf_XX4Jktqcs8859KS5E@im.wechat')
    const enriched = enrichSessionPayload(db, {
      key: 'agent:main:openclaw-weixin:9150aa2b4764-im-bot:direct:o9cq809tqf_xx4jktqcs8859ks5e@im.wechat',
      channel: 'openclaw-weixin',
      peer: 'o9cq809tqf_xx4jktqcs8859ks5e@im.wechat',
    })
    expect(enriched.channelUserName).toBe('杨硕微信')
    expect(enriched.sourceChannel).toBe('openclaw-weixin')
  })
})

const alice = { id: 'user-alice', username: 'alice', role: 'standard' }
const bob = { id: 'user-bob', username: 'bob', role: 'standard' }
const auditor = { id: 'user-auditor', username: 'auditor', role: 'auditor' }

it('usage projection removes non-owned rows and recomputes all aggregates from owned sessions', () => {
  const result = filterSessionUsagePayload({
    sessions: [
      {
        key: 'owned-1',
        agentId: 'main',
        channel: 'webchat',
        modelProvider: 'provider-a',
        model: 'model-a',
        usage: {
          input: 10,
          output: 2,
          cacheRead: 3,
          totalTokens: 15,
          totalCost: 0.15,
          messageCounts: { total: 3, user: 1, assistant: 1, toolCalls: 1, toolResults: 0, errors: 0 },
          toolUsage: { totalCalls: 1, tools: [{ name: 'query', count: 1 }] },
          dailyBreakdown: [{ date: '2026-07-30', tokens: 15, cost: 0.15 }],
        },
      },
      {
        key: 'owned-2',
        agentId: 'main',
        channel: 'webchat',
        modelProvider: 'provider-a',
        model: 'model-b',
        usage: {
          input: 20,
          output: 5,
          totalTokens: 25,
          totalCost: 0.25,
          messageCounts: { total: 4, user: 2, assistant: 2, toolCalls: 0, toolResults: 0, errors: 1 },
          toolUsage: { totalCalls: 2, tools: [{ name: 'query', count: 1 }, { name: 'report', count: 1 }] },
          dailyBreakdown: [
            { date: '2026-07-30', tokens: 5, cost: 0.05 },
            { date: '2026-07-31', tokens: 20, cost: 0.2 },
          ],
        },
      },
      {
        key: 'other',
        modelProvider: 'secret-provider',
        model: 'secret-model',
        usage: {
          totalTokens: 99,
          messageCounts: { total: 99 },
          toolUsage: { totalCalls: 99, tools: [{ name: 'secret-tool', count: 99 }] },
          dailyBreakdown: [{ date: '2026-07-31', tokens: 99, cost: 9.9 }],
        },
      },
    ],
    totals: { totalTokens: 139, totalCost: 10.3 },
    aggregates: { byModel: [{ model: 'secret-model' }], daily: [{ tokens: 139 }] },
  }, new Set(['owned-1', 'owned-2']))

  expect(result.sessions.map((item) => item.key)).toEqual(['owned-1', 'owned-2'])
  expect(result.totals).toMatchObject({
    input: 30,
    output: 7,
    cacheRead: 3,
    totalTokens: 40,
    totalCost: 0.4,
  })
  expect(result.aggregates.messages).toEqual({
    total: 7,
    user: 3,
    assistant: 3,
    toolCalls: 1,
    toolResults: 0,
    errors: 1,
  })
  expect(result.aggregates.tools).toEqual({
    totalCalls: 3,
    uniqueTools: 2,
    tools: [
      { name: 'query', count: 2 },
      { name: 'report', count: 1 },
    ],
  })
  expect(result.aggregates.byModel.map((item) => ({
    provider: item.provider,
    model: item.model,
    totalTokens: item.totals.totalTokens,
  }))).toEqual([
    { provider: 'provider-a', model: 'model-b', totalTokens: 25 },
    { provider: 'provider-a', model: 'model-a', totalTokens: 15 },
  ])
  expect(result.aggregates.daily).toEqual([
    { date: '2026-07-30', tokens: 20, cost: 0.2, messages: 0, toolCalls: 0, errors: 0 },
    { date: '2026-07-31', tokens: 20, cost: 0.2, messages: 0, toolCalls: 0, errors: 0 },
  ])
  expect(JSON.stringify(result)).not.toContain('secret-model')
  expect(JSON.stringify(result)).not.toContain('secret-tool')
})
const admin = { id: 'user-admin', username: 'admin', role: 'admin' }

describe('workspace session ownership service', () => {
  it('creates a BFF-issued session that its owner, auditors and administrators can read', () => {
    const db = createTestDb()
    const sessionKey = createWorkspaceSession(db, alice, 1)

    expect(sessionKey).toMatch(/^agent:main:main:dm:webchat-[a-z0-9]{32}$/)
    expect(canAccessWorkspaceSession(db, alice, sessionKey)).toBe(true)
    expect(canAccessWorkspaceSession(db, bob, sessionKey)).toBe(false)
    expect(canAccessWorkspaceSession(db, auditor, sessionKey)).toBe(true)
    expect(canAccessWorkspaceSession(db, admin, sessionKey)).toBe(true)
  })

  it('does not allow a standard user to claim a session that was not registered by the BFF', () => {
    const db = createTestDb()
    const unregistered = 'agent:main:main:dm:webchat-123456789012'

    expect(ensureWorkspaceSessionAccess(db, alice, unregistered)).toMatchObject({
      ok: false,
      code: 'SESSION_NOT_FOUND',
    })
    expect(ensureWorkspaceSessionAccess(db, admin, unregistered)).toMatchObject({ ok: true })
    expect(ensureWorkspaceSessionAccess(db, auditor, unregistered)).toMatchObject({ ok: true })
  })

  it('filters session lists and permanently hides a soft-deleted owned session', () => {
    const db = createTestDb()
    const aliceSession = createWorkspaceSession(db, alice, 1)
    const bobSession = createWorkspaceSession(db, bob, 2)
    const gatewayPayload = {
      sessions: [
        { key: aliceSession },
        { key: bobSession },
        { key: 'agent:main:feishu:dm:external-user' },
      ],
    }

    expect(filterSessionListPayload(gatewayPayload, listOwnedWorkspaceSessionKeys(db, alice))).toEqual({
      sessions: [{ key: aliceSession }],
    })
    expect(filterSessionListPayload(
      gatewayPayload,
      listOwnedWorkspaceSessionKeys(db, { ...alice, role: 'basic' }),
    )).toEqual({
      sessions: [{ key: aliceSession }],
    })
    expect(filterSessionListPayload(gatewayPayload, listOwnedWorkspaceSessionKeys(db, admin))).toEqual(gatewayPayload)
    expect(filterSessionListPayload(gatewayPayload, listOwnedWorkspaceSessionKeys(db, auditor))).toEqual(gatewayPayload)

    markWorkspaceSessionDeleted(db, aliceSession, 3)
    expect(ensureWorkspaceSessionAccess(db, alice, aliceSession)).toMatchObject({ ok: false })
    expect(listOwnedWorkspaceSessionKeys(db, alice)).toEqual(new Set())
  })

  it('retires the old shared main WebChat locally without attempting Gateway storage deletion', () => {
    const db = createTestDb()
    expect(hideLegacySharedSession(db, admin, 'main', 5)).toBe(true)
    expect(isLegacySessionHidden(db, 'main')).toBe(true)
    expect(hideLegacySharedSession(db, admin, 'agent:main:main', 6)).toBe(true)
    expect(isLegacySessionHidden(db, 'agent:main:main')).toBe(true)
    expect(filterHiddenLegacySessions(db, {
      sessions: [
        { key: 'main' },
        { key: 'agent:main:main' },
        { key: 'agent:main:feishu:dm:open-id-1' },
      ],
    })).toEqual({
      sessions: [{ key: 'agent:main:feishu:dm:open-id-1' }],
    })
    expect(hideLegacySharedSession(db, admin, 'agent:main:main:dm:webchat-123456789012', 7)).toBe(false)
  })

  it('finds a nested Gateway event session key before event delivery is authorized', () => {
    expect(extractSessionKeyFromEvent({
      payload: { message: { sessionKey: 'agent:main:main:dm:webchat-123456789012' } },
    })).toBe('agent:main:main:dm:webchat-123456789012')
  })

  it('derives and persists a fixed, no-AI WebChat title only from the first request', () => {
    const db = createTestDb()
    const key = createWorkspaceSession(db, alice, 1)

    expect(deriveWorkspaceSessionTitle('  今天业务系统的情况怎么样， 有什么报错或慢访问吗？  ')).toBe('今天业务系统的情况怎么样， 有什么报错或慢访问吗…')
    expect(setWorkspaceSessionTitleIfEmpty(db, key, '今天业务系统的情况怎么样， 有什么报错或慢访问吗？', 2)).toBe('今天业务系统的情况怎么样， 有什么报错或慢访问吗…')
    expect(setWorkspaceSessionTitleIfEmpty(db, key, '这条后续消息不能覆盖标题', 3)).toBeNull()
    expect(enrichSessionPayload(db, [{ key }])[0]).toMatchObject({
      sessionTitle: '今天业务系统的情况怎么样， 有什么报错或慢访问吗…',
    })
  })

  it('supports the Gateway agent fallback and ignores transport envelopes and control commands', () => {
    const db = createTestDb()
    const key = createWorkspaceSession(db, alice, 1)
    expect(isConversationSessionSend('agent', { sessionKey: key, input: '查询业务情况' })).toBe(true)
    expect(isConversationSessionSend('agent', { agentId: 'main', input: '普通智能体调用' })).toBe(false)
    expect(getConversationTitleCandidate('agent', {
      sessionKey: key,
      input: '[Mon 2026-07-27 11:20 GMT+8] 查询最近七天的告警情况',
    })).toBe('查询最近七天的告警情况')
    expect(deriveWorkspaceSessionTitle('/status')).toBe('')
    expect(setWorkspaceSessionTitleIfEmpty(db, key, '/status', 2)).toBeNull()
    expect(setWorkspaceSessionTitleIfEmpty(db, key, '真实问题', 3)).toBe('真实问题')
  })

  it('repairs only blank or command-placeholder historical titles', () => {
    const db = createTestDb()
    const key = createWorkspaceSession(db, alice, 1)
    db.prepare('UPDATE workspace_sessions SET session_title = ? WHERE session_key = ?').run('/status', key)
    expect(enrichSessionPayload(db, [{ key }])[0].sessionTitle).toBeNull()
    expect(setRecoveredWebChatTitle(db, key, '查询网络性能', 2)).toBe('查询网络性能')
    expect(setRecoveredWebChatTitle(db, key, '不能覆盖已有标题', 3)).toBeNull()
    expect(enrichSessionPayload(db, [{ key }])[0].sessionTitle).toBe('查询网络性能')
  })

  it('backfills a legacy WebChat title from its first user message without reading external channels', async () => {
    const db = createTestDb()
    const webKey = 'agent:main:main:dm:webchat-123456789012'
    const requestedKeys = []
    const result = await backfillHistoricalWebChatTitles(db, {
      sessions: [
        { key: webKey, channel: 'main' },
        { key: 'agent:main:feishu:dm:open-id-1', channel: 'feishu' },
      ],
    }, async (key) => {
      requestedKeys.push(key)
      return { messages: [
        { role: 'assistant', content: '欢迎' },
        { role: 'user', content: '/status' },
        { role: 'user', content: '[Wed 2026-07-22 13:34 GMT+8]  分析今天业务系统是否有报错和慢访问  ' },
        { role: 'user', content: '后续问题不会覆盖标题' },
      ] }
    })

    expect(requestedKeys).toEqual([webKey])
    expect(result).toEqual({ eligible: 1, updated: 1, alreadyTitled: 0, withoutUserMessage: 0, failed: 0 })
    expect(deriveFirstUserMessageTitle({ messages: [{ role: 'user', content: '第一条问题' }] })).toBe('第一条问题')
    expect(enrichSessionPayload(db, { sessions: [{ key: webKey, channel: 'main' }] }).sessions[0]).toMatchObject({
      sessionTitle: '分析今天业务系统是否有报错和慢访问',
      channelUserId: null,
      channelUserName: null,
    })
  })

  it('adds a stable Web owner or external channel peer to the visible session origin', () => {
    const db = createTestDb()
    const webSession = createWorkspaceSession(db, alice, 1)
    const payload = enrichSessionPayload(db, {
      sessions: [
        { key: 'main', channel: 'main', label: 'OpenClaw Web Backend' },
        { key: webSession, channel: 'main', peer: 'webchat-fallback' },
        { key: 'agent:main:feishu:dm:open-id-1', channel: 'openclaw-lark', peer: 'open-id-1' },
        { key: 'agent:main:dingtalk-connector:dm:030856161901851437', channel: 'dingtalk-connector', label: '杨硕', peer: '030856161901851437' },
        {
          key: 'agent:main:main',
          channel: 'main',
          updatedAt: 1785131550912,
          lastInteractionAt: 1783584390254,
        },
      ],
    })

    expect(payload.sessions[0]).toMatchObject({
      originKind: 'web',
      sourceChannel: 'web',
      ownerUserId: null,
      ownerUsername: null,
    })
    expect(payload.sessions[1]).toMatchObject({
      originKind: 'web',
      sourceChannel: 'web',
      ownerUserId: 'user-alice',
      ownerUsername: 'alice',
      channelUserName: 'alice',
      sessionTitle: null,
    })
    expect(payload.sessions[2]).toMatchObject({
      originKind: 'channel',
      sourceChannel: 'feishu',
      channelUserId: 'open-id-1',
      channelUserName: 'open-id-1',
    })
    expect(payload.sessions[3]).toMatchObject({
      originKind: 'channel',
      sourceChannel: 'dingtalk',
      channelUserId: '030856161901851437',
      channelUserName: '杨硕',
    })
    expect(payload.sessions[4]).toMatchObject({
      originKind: 'web',
      sourceChannel: 'web',
      conversationLastActivity: '2026-07-09T08:06:30.254Z',
    })
  })

  it('never lets background Gateway updatedAt move a stale conversation to the top', () => {
    expect(__test__.resolveConversationLastActivity({
      key: 'agent:main:main',
      lastInteractionAt: 1783584390254,
      updatedAt: 1785131550912,
      pendingFinalDeliveryLastAttemptAt: 1785131550912,
    })).toBe('2026-07-09T08:06:30.254Z')
    expect(__test__.resolveConversationLastActivity({
      sessionStartedAt: 1785131689226,
      updatedAt: 1785131704158,
    })).toBe('2026-07-27T05:54:49.226Z')
    expect(__test__.resolveConversationLastActivity({
      key: 'agent:main:main',
      updatedAt: 1785131704158,
      pendingFinalDeliveryLastAttemptAt: 1785131704158,
    })).toBeNull()
    expect(__test__.resolveConversationLastActivity({
      key: 'agent:main:wecom:direct:yangs',
      updatedAt: 1785131704158,
    })).toBe('2026-07-27T05:55:04.158Z')
    expect(__test__.resolveConversationLastActivity({
      key: 'agent:main:main:dm:webchat-123456789012',
      updatedAt: 1785131704158,
    })).toBe('2026-07-27T05:55:04.158Z')
  })
})
