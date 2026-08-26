import { ConnectionState, type RPCResponse, type RPCEvent } from './types'

type EventHandler = (...args: unknown[]) => void

export interface ApiClientConfig {
  baseUrl?: string
  reconnectInterval?: number
  maxReconnectAttempts?: number
  getToken?: () => string | null
}

const DEFAULT_CONFIG: Required<ApiClientConfig> = {
  baseUrl: '',
  reconnectInterval: 3000,
  maxReconnectAttempts: 20,
  getToken: () => null,
}

export class ApiClient {
  private config: Required<ApiClientConfig>
  private listeners = new Map<string, Set<EventHandler>>()
  private abortController: AbortController | null = null
  private connectionGeneration = 0
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private _state: ConnectionState = ConnectionState.DISCONNECTED
  private clientId: string | null = null

  get state(): ConnectionState {
    return this._state
  }

  constructor(config?: Partial<ApiClientConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  connect(): void {
    if (this.abortController || this.reconnectTimer) return
    const generation = ++this.connectionGeneration
    this._state = ConnectionState.CONNECTING
    this.emit('stateChange', ConnectionState.CONNECTING)
    this.reconnectAttempts = 0
    void this.createEventStream(generation)
  }

  disconnect(): void {
    this.connectionGeneration++
    this.clearTimers()
    this._state = ConnectionState.DISCONNECTED
    this.abortController?.abort()
    this.abortController = null
    this.emit('stateChange', ConnectionState.DISCONNECTED)
  }

  private async createEventStream(generation: number): Promise<void> {
    if (generation !== this.connectionGeneration || this.abortController) return
    const controller = new AbortController()
    this.abortController = controller
    try {
      const url = this.config.baseUrl
        ? `${this.config.baseUrl}/api/events`
        : '/api/events'
      const token = this.config.getToken()
      const headers: Record<string, string> = { Accept: 'text/event-stream' }
      if (token) headers.Authorization = `Bearer ${token}`

      const response = await fetch(url, {
        method: 'GET',
        headers,
        cache: 'no-store',
        signal: controller.signal,
      })
      if (response.status === 401) {
        this._state = ConnectionState.FAILED
        this.emit('stateChange', ConnectionState.FAILED)
        this.emit('unauthorized')
        this.emit('disconnected', 401, 'Unauthorized')
        return
      }
      if (!response.ok || !response.body) {
        throw new Error(`SSE request failed (${response.status})`)
      }
      this.reconnectAttempts = 0

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (generation === this.connectionGeneration) {
        const { value, done } = await reader.read()
        if (done) break
        buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n')
        let boundary = buffer.indexOf('\n\n')
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const data = frame.split('\n')
            .filter((line) => line === 'data:' || line.startsWith('data:'))
            .map((line) => line.slice(5).replace(/^ /, ''))
            .join('\n')
          if (data) this.handleMessage(data)
          boundary = buffer.indexOf('\n\n')
        }
      }
      if (generation === this.connectionGeneration) this.handleDisconnect(generation)
    } catch (error) {
      if (generation === this.connectionGeneration && !controller.signal.aborted) {
        console.error('[ApiClient] SSE connection failed:', error)
        this.handleDisconnect(generation)
      }
    } finally {
      if (this.abortController === controller) this.abortController = null
    }
  }

  private handleMessage(data: string): void {
    try {
      const message = JSON.parse(data)

      switch (message.type) {
        case 'connected':
          this.clientId = message.clientId
          console.log('[ApiClient] Connected with clientId:', this.clientId)
          break

        case 'gatewayState':
          console.log('[ApiClient] Gateway state:', message.state, 'version:', message.version)
          if (message.state === 'connected') {
            this._state = ConnectionState.CONNECTED
            this.emit('stateChange', ConnectionState.CONNECTED)
            this.emit('connected', { version: message.version, updateAvailable: message.updateAvailable })
          } else if (message.state === 'disconnected' || message.state === 'failed') {
            const nextState = message.state === 'failed'
              ? ConnectionState.FAILED
              : ConnectionState.RECONNECTING
            this._state = nextState
            this.emit('stateChange', nextState)
          } else if (message.state === 'connecting') {
            this._state = ConnectionState.CONNECTING
            this.emit('stateChange', ConnectionState.CONNECTING)
          }
          if (message.version || message.updateAvailable) {
            this.emit('connected', { version: message.version, updateAvailable: message.updateAvailable })
          }
          break

        case 'event':
          const evt = message as { event: string; payload: unknown }
          queueMicrotask(() => {
            this.emit('event', { type: 'event', event: evt.event, payload: evt.payload } as RPCEvent)
            this.emit(`event:${evt.event}`, evt.payload)
          })
          break

        case 'backupProgress':
          queueMicrotask(() => {
            this.emit('backupProgress', message)
          })
          break

        case 'alert':
          if ((message.action === 'triggered' || message.action === 'recovered')
            && Number.isSafeInteger(message.cursor) && message.cursor >= 0
            && message.payload && typeof message.payload === 'object') {
            queueMicrotask(() => this.emit('alert', message))
          }
          break

        case 'alertStreamState':
          if (typeof message.state === 'string') {
            queueMicrotask(() => this.emit('alertStreamState', message))
          }
          break
      }
    } catch (e) {
      console.error('[ApiClient] Failed to parse message:', e)
    }
  }

  private handleDisconnect(generation: number): void {
    if (generation !== this.connectionGeneration) return
    this.emit('disconnected', 0, 'SSE disconnected')

    const shouldReconnect =
      this._state !== ConnectionState.DISCONNECTED &&
      this._state !== ConnectionState.FAILED

    if (shouldReconnect) {
      this.scheduleReconnect(generation)
    }
  }

  private scheduleReconnect(generation: number): void {
    if (generation !== this.connectionGeneration || this.reconnectTimer) return
    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      console.error('[ApiClient] Max reconnect attempts reached:', this.reconnectAttempts)
      this._state = ConnectionState.FAILED
      this.emit('stateChange', ConnectionState.FAILED)
      this.emit('failed', 'Max reconnect attempts reached')
      return
    }

    this._state = ConnectionState.RECONNECTING
    this.emit('stateChange', ConnectionState.RECONNECTING)

    const delay = Math.min(
      this.config.reconnectInterval * Math.pow(1.5, this.reconnectAttempts),
      30000
    )
    this.reconnectAttempts++
    
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.createEventStream(generation)
    }, delay)

    this.emit('reconnecting', this.reconnectAttempts, delay)
  }

  private clearTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  async rpc<T = unknown>(method: string, params?: unknown): Promise<T> {
    const url = this.config.baseUrl
      ? `${this.config.baseUrl}/api/rpc`
      : '/api/rpc'

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }

    const token = this.config.getToken()
    if (token) {
      headers['Authorization'] = `Bearer ${token}`
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ method, params }),
    })

    if (response.status === 401) {
      throw new Error('Unauthorized')
    }

    const result: RPCResponse<T> = await response.json()

    if (!result.ok) {
      const errorMessage = typeof result.error === 'string'
        ? result.error
        : result.error?.message
      throw new Error(errorMessage || 'RPC call failed')
    }

    return result.payload as T
  }

  async health(): Promise<{ ok: boolean; gateway: string; clients: number }> {
    const url = this.config.baseUrl
      ? `${this.config.baseUrl}/api/health`
      : '/api/health'

    const response = await fetch(url)
    return response.json()
  }

  on(event: string, handler: EventHandler): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set())
    }
    this.listeners.get(event)!.add(handler)
    return () => this.off(event, handler)
  }

  off(event: string, handler: EventHandler): void {
    this.listeners.get(event)?.delete(handler)
  }

  private emit(event: string, ...args: unknown[]): void {
    const handlers = this.listeners.get(event)
    if (!handlers || handlers.size === 0) return
    
    handlers.forEach((handler) => {
      try {
        handler(...args)
      } catch (e) {
        console.error(`[ApiClient] Event handler error for "${event}":`, e)
      }
    })
  }
}
