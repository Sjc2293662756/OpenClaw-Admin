import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiClient } from './http-client'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function streamingResponse(chunks: string[], status = 200) {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  }), { status, headers: { 'Content-Type': 'text/event-stream' } })
}

describe('ApiClient authenticated fetch SSE', () => {
  it('uses Authorization header without putting the token in the URL and parses split events', async () => {
    const fetchMock = vi.fn().mockResolvedValue(streamingResponse([
      ': heartbeat\n\n',
      'data: {"type":"event","event":"chat.delta",',
      '"payload":{"sessionKey":"owned"}}\n\n',
    ]))
    vi.stubGlobal('fetch', fetchMock)
    const client = new ApiClient({ getToken: () => 'login-token', reconnectInterval: 60_000 })
    const events: unknown[] = []
    client.on('event:chat.delta', (payload) => events.push(payload))
    client.connect()

    await vi.waitFor(() => expect(events).toEqual([{ sessionKey: 'owned' }]))
    const [url, options] = fetchMock.mock.calls[0]!
    expect(url).toBe('/api/events')
    expect(String(url)).not.toContain('token=')
    expect(options.headers.Authorization).toBe('Bearer login-token')
    expect(options.headers.Accept).toBe('text/event-stream')
    client.disconnect()
  })

  it('stops on 401, emits unauthorized, and prevents duplicate live connections', async () => {
    let firstSignal: AbortSignal | undefined
    const fetchMock = vi.fn((_: string, options: RequestInit) => {
      firstSignal = options.signal as AbortSignal
      return Promise.resolve(new Response(null, { status: 401 }))
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = new ApiClient({ getToken: () => 'expired' })
    const unauthorized = vi.fn()
    client.on('unauthorized', unauthorized)
    client.connect()
    client.connect()
    await vi.waitFor(() => expect(unauthorized).toHaveBeenCalledOnce())
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(firstSignal?.aborted).toBe(false)
    client.disconnect()
  })

  it('aborts the active stream on logout-style disconnect', async () => {
    let signal: AbortSignal | undefined
    const fetchMock = vi.fn((_: string, options: RequestInit) => {
      signal = options.signal as AbortSignal
      return new Promise<Response>(() => {})
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = new ApiClient({ getToken: () => 'token' })
    client.connect()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    client.disconnect()
    expect(signal?.aborted).toBe(true)
  })

  it('reconnects after a transport failure and resumes event parsing', async () => {
    const encoder = new TextEncoder()
    const resumedResponse = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(
          'data: {"type":"gatewayState","state":"connected","version":"test"}\r\n\r\n'
        ))
      },
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(resumedResponse)
    vi.stubGlobal('fetch', fetchMock)
    const client = new ApiClient({ getToken: () => 'token', reconnectInterval: 1 })
    const connected = vi.fn()
    client.on('connected', connected)
    client.connect()
    await vi.waitFor(() => expect(connected).toHaveBeenCalled())
    expect(fetchMock).toHaveBeenCalledTimes(2)
    client.disconnect()
  })

  it('keeps retrying past the historic twenty-attempt cap by default, while finite caps remain configurable', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchMock = vi.fn().mockRejectedValue(new Error('offline'))
    vi.stubGlobal('fetch', fetchMock)
    const infinite = new ApiClient({ getToken: () => 'token', reconnectInterval: 1 })
    infinite.connect()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(fetchMock.mock.calls.length).toBeGreaterThan(20)
    infinite.disconnect()

    const finite = new ApiClient({ getToken: () => 'token', reconnectInterval: 1, maxReconnectAttempts: 0 })
    finite.connect()
    await vi.advanceTimersByTimeAsync(1)
    expect(finite.state).toBe('failed')
    finite.disconnect()
    vi.useRealTimers()
  })

  it('dispatches BFF alert events and stream state while safely ignoring unknown types', async () => {
    const fetchMock = vi.fn().mockResolvedValue(streamingResponse([
      'data: {"type":"alert","action":"triggered","cursor":9,"payload":{"id":"a-9"}}\n\n',
      'data: {"type":"alertStreamState","state":"connected","latestCursor":9}\n\n',
      'data: {"type":"futureEvent","secret":"ignored"}\n\n',
    ]))
    vi.stubGlobal('fetch', fetchMock)
    const client = new ApiClient({ getToken: () => 'login-token', reconnectInterval: 60_000 })
    const alert = vi.fn()
    const state = vi.fn()
    client.on('alert', alert)
    client.on('alertStreamState', state)
    client.connect()
    await vi.waitFor(() => expect(alert).toHaveBeenCalledOnce())
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ cursor: 9, action: 'triggered' }))
    expect(state).toHaveBeenCalledWith(expect.objectContaining({ state: 'connected' }))
    client.disconnect()
  })

  it('dispatches a validated targeted permission-version refresh event', async () => {
    const fetchMock = vi.fn().mockResolvedValue(streamingResponse([
      'data: {"type":"permissionsChanged","userId":"user-1","permissionVersion":7}\n\n',
      'data: {"type":"permissionsChanged","userId":"user-1","permissionVersion":-1}\n\n',
    ]))
    vi.stubGlobal('fetch', fetchMock)
    const client = new ApiClient({ getToken: () => 'login-token', reconnectInterval: 60_000 })
    const changed = vi.fn()
    client.on('permissionsChanged', changed)
    client.connect()
    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce())
    expect(changed).toHaveBeenCalledWith({ userId: 'user-1', permissionVersion: 7 })
    client.disconnect()
  })
})
