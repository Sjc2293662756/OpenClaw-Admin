import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import {
  beginChatProcessRun,
  migrateChatProcessProjection,
  projectChatHistoryProcessMetadata,
  safeUserVisibleProcessText,
  setChatProcessGatewayRunId,
} from './chat-process-projection.js'

function message(seq, role, content, id = `message-${seq}`, extra = {}) {
  return { role, content, __openclaw: { id, seq }, ...extra }
}

function createDb() {
  const db = new Database(':memory:')
  migrateChatProcessProjection(db)
  return db
}

test('snapshots a new run and projects only safe assistant text paired with a tool call', () => {
  const db = createDb()
  try {
    const history = { messages: [message(1, 'user', [{ type: 'text', text: '旧问题' }])] }
    beginChatProcessRun({
      db,
      userId: 'user-1',
      sessionKey: 'session-1',
      clientRunId: 'client-run-1',
      showProcess: true,
      historyPayload: history,
      now: 10,
    })
    setChatProcessGatewayRunId(db, 'user-1', 'session-1', 'client-run-1', 'gateway-run-1', 20)

    history.messages.push(
      message(2, 'user', [{ type: 'text', text: '生成报告' }]),
      message(3, 'assistant', [
        { type: 'text', text: '数据已采集，正在生成 Word 报告。' },
        { type: 'toolCall', id: 'call-1', name: 'report-export', arguments: { hidden: true } },
      ]),
      message(4, 'toolResult', [{ type: 'text', text: 'raw result' }], 'tool-result-1', { toolCallId: 'call-1' }),
      message(5, 'assistant', [{ type: 'text', text: '报告已生成。' }]),
    )

    projectChatHistoryProcessMetadata(db, 'user-1', 'session-1', history)
    assert.deepEqual(history.messages[2].gaiopProcess, {
      kind: 'user_visible_process',
      sessionKey: 'session-1',
      runId: 'gateway-run-1',
      stepId: 'message-3',
      sequence: 1,
      publicText: '数据已采集，正在生成 Word 报告。',
      status: 'completed',
      visible: true,
      safe: true,
    })
    assert.equal(history.messages[4].gaiopProcess, undefined)
  } finally {
    db.close()
  }
})

test('a results-only snapshot hides process turns without changing final replies or old history', () => {
  const db = createDb()
  try {
    const history = [
      message(1, 'user', '旧问题'),
      message(2, 'assistant', [
        { type: 'text', text: '旧过程' },
        { type: 'toolCall', id: 'old-call', name: 'query' },
      ]),
      message(3, 'toolResult', 'old result', 'old-result', { toolCallId: 'old-call' }),
      message(4, 'assistant', '旧结果'),
    ]
    beginChatProcessRun({
      db,
      userId: 'user-1',
      sessionKey: 'session-1',
      clientRunId: 'client-run-2',
      showProcess: false,
      historyPayload: history,
    })
    history.push(
      message(5, 'user', '新问题'),
      message(6, 'assistant', [
        { type: 'text', text: '正在查询最近 7 天的数据。' },
        { type: 'tool_call', id: 'new-call', name: 'query' },
      ]),
      message(7, 'toolResult', 'new result', 'new-result', { toolCallId: 'new-call' }),
      message(8, 'assistant', '最终结果'),
    )

    projectChatHistoryProcessMetadata(db, 'user-1', 'session-1', history)
    assert.equal(history[1].gaiopProcess, undefined)
    assert.equal(history[5].gaiopProcess.visible, false)
    assert.equal(history[7].gaiopProcess, undefined)
  } finally {
    db.close()
  }
})

test('sequential snapshots remain bound to their exact Gateway user turns', () => {
  const db = createDb()
  try {
    const history = []
    beginChatProcessRun({ db, userId: 'u', sessionKey: 's', clientRunId: 'r1', showProcess: true, historyPayload: history })
    history.push(
      message(1, 'user', '第一轮'),
      message(2, 'assistant', [{ type: 'text', text: '第一步' }, { type: 'toolCall', id: 'c1' }]),
      message(3, 'toolResult', 'done', 'tr1', { toolCallId: 'c1' }),
      message(4, 'assistant', '第一轮结果'),
    )
    projectChatHistoryProcessMetadata(db, 'u', 's', history)
    beginChatProcessRun({ db, userId: 'u', sessionKey: 's', clientRunId: 'r2', showProcess: false, historyPayload: history })
    history.push(
      message(5, 'user', '第二轮'),
      message(6, 'assistant', [{ type: 'text', text: '第二步' }, { type: 'toolCall', id: 'c2' }]),
      message(7, 'toolResult', 'done', 'tr2', { toolCallId: 'c2' }),
      message(8, 'assistant', '第二轮结果'),
    )

    projectChatHistoryProcessMetadata(db, 'u', 's', history)
    assert.equal(history[1].gaiopProcess.runId, 'r1')
    assert.equal(history[1].gaiopProcess.visible, true)
    assert.equal(history[5].gaiopProcess.runId, 'r2')
    assert.equal(history[5].gaiopProcess.visible, false)
  } finally {
    db.close()
  }
})

test('fails closed for unsafe public text and refuses histories without complete stable sequences', () => {
  assert.equal(safeUserVisibleProcessText('正在查询最近 7 天的数据。'), '正在查询最近 7 天的数据。')
  assert.equal(safeUserVisibleProcessText('token=secret-value'), '')
  assert.equal(safeUserVisibleProcessText('请查看 /var/lib/private/report.json'), '')
  assert.equal(safeUserVisibleProcessText('SELECT * FROM alerts'), '')
  assert.equal(safeUserVisibleProcessText('rm -rf /data'), '')
  assert.equal(safeUserVisibleProcessText('PRAGMA integrity_check'), '')
  assert.equal(safeUserVisibleProcessText('正在读取 \\\\server\\private\\report.docx'), '')

  const db = createDb()
  try {
    assert.throws(() => beginChatProcessRun({
      db,
      userId: 'u',
      sessionKey: 's',
      clientRunId: 'r',
      showProcess: true,
      historyPayload: [message(1, 'user', '有序'), { role: 'assistant', content: '无序' }],
    }), /stable sequence/u)
  } finally {
    db.close()
  }
})

test('unsafe process text is explicitly hidden while the final assistant reply remains unmarked', () => {
  const db = createDb()
  try {
    const history = []
    beginChatProcessRun({ db, userId: 'u', sessionKey: 's', clientRunId: 'r', showProcess: true, historyPayload: history })
    history.push(
      message(1, 'user', '执行任务'),
      message(2, 'assistant', [
        { type: 'text', text: '正在读取 /var/lib/private/result.json' },
        { type: 'toolCall', id: 'call-unsafe' },
      ]),
      message(3, 'toolResult', 'done', 'result-unsafe', { toolCallId: 'call-unsafe' }),
      message(4, 'assistant', '任务已完成。'),
    )

    projectChatHistoryProcessMetadata(db, 'u', 's', history)
    assert.equal(history[1].gaiopProcess.safe, false)
    assert.equal(history[1].gaiopProcess.visible, false)
    assert.equal(history[1].gaiopProcess.publicText, '')
    assert.equal(history[3].gaiopProcess, undefined)
  } finally {
    db.close()
  }
})

test('projection is isolated by both account and exact session key', () => {
  const db = createDb()
  try {
    const historyA = []
    beginChatProcessRun({ db, userId: 'user-a', sessionKey: 'session-a', clientRunId: 'run-a', showProcess: false, historyPayload: historyA })
    historyA.push(
      message(1, 'user', '问题 A'),
      message(2, 'assistant', [{ type: 'text', text: '过程 A' }, { type: 'toolCall', id: 'call-a' }]),
    )

    projectChatHistoryProcessMetadata(db, 'user-b', 'session-a', historyA)
    assert.equal(historyA[1].gaiopProcess, undefined)
    projectChatHistoryProcessMetadata(db, 'user-a', 'session-b', historyA)
    assert.equal(historyA[1].gaiopProcess, undefined)
    projectChatHistoryProcessMetadata(db, 'user-a', 'session-a', historyA)
    assert.equal(historyA[1].gaiopProcess.runId, 'run-a')
  } finally {
    db.close()
  }
})

test('an in-progress step keeps its stable identity when a later history pull completes it', () => {
  const db = createDb()
  try {
    const history = []
    beginChatProcessRun({ db, userId: 'u', sessionKey: 's', clientRunId: 'r', showProcess: true, historyPayload: history })
    history.push(
      message(1, 'user', '生成报告'),
      message(2, 'assistant', [{ type: 'text', text: '正在生成报告。' }, { type: 'toolCall', id: 'call-1' }]),
    )
    projectChatHistoryProcessMetadata(db, 'u', 's', history)
    const initial = { ...history[1].gaiopProcess }
    assert.equal(initial.status, 'in_progress')

    history.push(message(3, 'toolResult', 'done', 'result-1', { toolCallId: 'call-1' }))
    projectChatHistoryProcessMetadata(db, 'u', 's', history)
    assert.equal(history[1].gaiopProcess.status, 'completed')
    assert.equal(history[1].gaiopProcess.stepId, initial.stepId)
    assert.equal(history[1].gaiopProcess.sequence, initial.sequence)
  } finally {
    db.close()
  }
})

test('an empty Gateway transcript binds correctly when its first sequence is zero', () => {
  const db = createDb()
  try {
    const history = []
    beginChatProcessRun({ db, userId: 'u', sessionKey: 's', clientRunId: 'r0', showProcess: true, historyPayload: history })
    history.push(
      message(0, 'user', '首条问题'),
      message(1, 'assistant', [{ type: 'text', text: '正在处理首条问题。' }, { type: 'toolCall', id: 'call-0' }]),
    )
    projectChatHistoryProcessMetadata(db, 'u', 's', history)
    assert.equal(history[1].gaiopProcess.runId, 'r0')
  } finally {
    db.close()
  }
})

test('a tool turn without its own call id still fails closed using the stable message sequence', () => {
  const db = createDb()
  try {
    const history = []
    beginChatProcessRun({ db, userId: 'u', sessionKey: 's', clientRunId: 'r', showProcess: false, historyPayload: history })
    history.push(
      message(1, 'user', '执行任务'),
      message(2, 'assistant', [{ type: 'text', text: '正在执行任务。' }, { type: 'toolCall', name: 'query' }], ''),
    )
    projectChatHistoryProcessMetadata(db, 'u', 's', history)
    assert.equal(history[1].gaiopProcess.stepId, 'seq:2')
    assert.equal(history[1].gaiopProcess.visible, false)
    assert.equal(history[1].gaiopProcess.status, 'in_progress')
  } finally {
    db.close()
  }
})
