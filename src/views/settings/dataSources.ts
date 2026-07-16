export type DataSourceType = 'local' | 'remote'
export type DataSourceStatus = 'success' | 'failed' | 'untested' | 'disabled'

export type DataSourceDraft = {
  id: string
  ip: string
  description: string
  type: DataSourceType
  username: string
  status: DataSourceStatus
  isActive?: boolean
  createdAt: number
  updatedAt: number
  lastTestedAt?: number
  lastTestMessage?: string
  passwordConfigured?: boolean
}

export const dataSourceTypeText: Record<DataSourceType, string> = {
  local: '本机',
  remote: '远程',
}

export const dataSourceStatusText: Record<DataSourceStatus, string> = {
  success: '成功',
  failed: '失败',
  untested: '未测试',
  disabled: '已停用',
}
