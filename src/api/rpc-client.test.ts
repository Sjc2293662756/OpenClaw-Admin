import { describe, expect, it } from 'vitest'
import { RPCClient } from './rpc-client'
import type { RPCFrame } from './types'

class FakeSocket {
  private handlers = new Map<string, (payload: unknown) => void>()

  on(event: string, handler: (payload: unknown) => void) {
    this.handlers.set(event, handler)
    return () => this.handlers.delete(event)
  }

  async send(frame: RPCFrame) {
    if (frame.type !== 'req') return
    queueMicrotask(() => {
      this.handlers.get(`rpc:${frame.id}`)?.({
        type: 'res',
        id: frame.id,
        ok: true,
        payload: {
          messages: [{
            role: 'assistant',
            content: [
              { type: 'text', text: '数据已采集，正在生成报告。' },
              { type: 'toolCall', id: 'call-1', name: 'report-export', arguments: { internal: true } },
            ],
            __openclaw: { id: 'gateway-message-7', seq: 7 },
            gaiopProcess: {
              kind: 'user_visible_process',
              sessionKey: 'session-1',
              runId: 'run-1',
              stepId: 'gateway-message-7',
              sequence: 1,
              publicText: '数据已采集，正在生成报告。',
              status: 'completed',
              visible: true,
              safe: true,
            },
          }],
        },
      })
    })
  }
}

describe('RPC chat history normalization', () => {
  it('keeps Gateway identity, sequence, and safe process metadata', async () => {
    const client = new RPCClient(new FakeSocket() as never)
    const history = await client.listChatHistory('session-1')

    expect(history).toEqual([expect.objectContaining({
      id: 'gateway-message-7',
      gatewaySequence: 7,
      content: '数据已采集，正在生成报告。',
      rawContent: expect.arrayContaining([
        expect.objectContaining({ type: 'tool_call', id: 'call-1' }),
      ]),
      process: {
        kind: 'user_visible_process',
        sessionKey: 'session-1',
        runId: 'run-1',
        stepId: 'gateway-message-7',
        sequence: 1,
        publicText: '数据已采集，正在生成报告。',
        status: 'completed',
        visible: true,
        safe: true,
      },
    })])
  })
})
