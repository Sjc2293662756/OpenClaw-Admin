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

const TYPE_TEXT = {
  'zh-CN': { local: '本机', remote: '远程' },
  'en-US': { local: 'Local', remote: 'Remote' },
} satisfies Record<'zh-CN' | 'en-US', Record<DataSourceType, string>>

const STATUS_TEXT = {
  'zh-CN': { success: '成功', failed: '失败', untested: '未测试', disabled: '已停用' },
  'en-US': { success: 'Successful', failed: 'Failed', untested: 'Not tested', disabled: 'Disabled' },
} satisfies Record<'zh-CN' | 'en-US', Record<DataSourceStatus, string>>

function normalizedLocale(locale?: string) {
  return locale === 'en-US' ? 'en-US' : 'zh-CN'
}

export function dataSourceTypeText(type: DataSourceType, locale?: string) {
  return TYPE_TEXT[normalizedLocale(locale)][type]
}

export function dataSourceStatusText(status: DataSourceStatus, locale?: string) {
  return STATUS_TEXT[normalizedLocale(locale)][status]
}
