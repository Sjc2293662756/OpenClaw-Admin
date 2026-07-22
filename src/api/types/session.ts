export interface Session {
  key: string
  agentId: string
  channel: string
  peer: string
  messageCount: number
  lastActivity: string
  model?: string
  tokenUsage?: TokenUsage
  label?: string
  sessionTitle?: string | null
  originKind?: 'web' | 'channel'
  sourceChannel?: string
  ownerUserId?: string | null
  ownerUsername?: string | null
  channelUserId?: string | null
  channelUserName?: string | null
}

export interface SessionDetail extends Session {
  transcript: TranscriptMessage[]
  tokenUsage?: TokenUsage
  directives?: string[]
}

export interface TranscriptMessage {
  role: 'user' | 'assistant' | 'tool' | 'system'
  content: string
  timestamp: string
  name?: string
  input?: unknown
  output?: unknown
  tokens?: { input: number; output: number }
}

export interface TokenUsage {
  totalInput: number
  totalOutput: number
}

export interface SessionExport {
  key: string
  transcript: TranscriptMessage[]
  exportedAt: string
}
