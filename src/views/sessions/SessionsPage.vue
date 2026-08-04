<script setup lang="ts">
import { computed, h, onMounted, ref, watch } from 'vue'
import {
  NAlert,
  NButton,
  NCard,
  NDataTable,
  NGrid,
  NGridItem,
  NIcon,
  NInput,
  NModal,
  NForm,
  NFormItem,
  NPopconfirm,
  NSelect,
  NSpace,
  NTag,
  NText,
  useMessage,
} from 'naive-ui'
import type { DataTableColumns, SelectOption } from 'naive-ui'
import {
  AddOutline,
  ChatbubblesOutline,
  RefreshOutline,
  RemoveOutline,
  SearchOutline,
  TimeOutline,
  TrashOutline,
} from '@vicons/ionicons5'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useSessionStore } from '@/stores/session'
import { useAgentStore } from '@/stores/agent'
import { useConfigStore } from '@/stores/config'
import { usePermissions } from '@/composables/usePermissions'
import TimeRangePicker from '@/components/common/TimeRangePicker.vue'
import { formatRelativeTime, parseSessionKey } from '@/utils/format'
import {
  isTimestampWithinRange,
  rangeForPreset,
  type TimeRange,
  type TimeRangePreset,
} from '@/utils/time-range'
import {
  formatSessionChannelLabel,
  formatSessionConversationTitle,
  isLegacyDefaultSession,
  isWebConversation,
  sessionMatchesSearch,
} from '@/utils/session-presentation'
import type { Session } from '@/api/types'

type SortMode = 'recent' | 'messages'

type SessionRow = Session & {
  parsed: ReturnType<typeof parseSessionKey>
  lastActivityTs: number
  active24h: boolean
}

const sessionStore = useSessionStore()
const agentStore = useAgentStore()
const configStore = useConfigStore()
const router = useRouter()
const message = useMessage()
const { t, locale } = useI18n()
const text = (zhCN: string, enUS: string) => locale.value === 'zh-CN' ? zhCN : enUS
const {
  canUseFunctions,
  canDeleteSessions,
  canContinueSessions,
} = usePermissions()

const searchQuery = ref('')
const channelFilter = ref<string>('all')
const modelFilter = ref<string>('all')
const sortMode = ref<SortMode>('recent')
const showCreateModal = ref(false)
const creating = ref(false)
const createForm = ref({
  agentId: 'main',
  channel: 'webchat',
  peer: '',
  label: '',
})
const allSelectedKeys = ref<string[]>([])
const batchDeleting = ref(false)
const currentPage = ref(1)
const pageSize = 12
const serverNow = ref(Date.now())
const serverNowReceivedAt = ref(Date.now())
const timePreset = ref<TimeRangePreset>('last7days')
const appliedRange = ref<TimeRange>(rangeForPreset('last7days', serverNow.value))
const timeRangeTouched = ref(false)
const allSessionKeys = computed(() => filteredSessions.value.map((s) => s.key))
const isAllSelected = computed(() => {
  if (allSessionKeys.value.length === 0) return false
  return allSessionKeys.value.every((key) => allSelectedKeys.value.includes(key))
})
const isPartialSelected = computed(() => {
  if (allSessionKeys.value.length === 0) return false
  const selectedCount = allSessionKeys.value.filter((key) =>
    allSelectedKeys.value.includes(key)
  ).length
  return selectedCount > 0 && selectedCount < allSessionKeys.value.length
})

const currentPageKeys = computed(() => {
  const start = (currentPage.value - 1) * pageSize
  const end = start + pageSize
  return filteredSessions.value.slice(start, end).map((s) => s.key)
})

function onUpdateCheckedRowKeys(keys: (string | number)[]) {
  const currentKeys = new Set<string>(currentPageKeys.value)
  const newKeys = new Set<string>(keys.map(String))
  const toRemove: string[] = []
  const toAdd: string[] = []

  for (const key of currentKeys) {
    if (!newKeys.has(key)) {
      toRemove.push(key)
    }
  }
  for (const key of newKeys) {
    if (!currentKeys.has(key)) {
      toAdd.push(key)
    }
  }

  const removeSet = new Set<string>(toRemove)
  allSelectedKeys.value = [
    ...allSelectedKeys.value.filter((k) => !removeSet.has(k)),
    ...toAdd,
  ]
}

function handlePageChange(page: number) {
  currentPage.value = page
}

const sortOptions = computed<SelectOption[]>(() => ([
  { label: t('pages.sessions.list.sort.recent'), value: 'recent' },
  { label: t('pages.sessions.list.sort.messages'), value: 'messages' },
]))

const agentOptions = computed<SelectOption[]>(() => {
  const agents = agentStore.agents || []
  return agents.map((agent) => ({
    label: agent.identity?.name || agent.name || agent.id,
    value: agent.id,
  }))
})

const deliveryChannelLabelMap = computed<Record<string, string>>(() => ({
  whatsapp: 'WhatsApp',
  telegram: 'Telegram',
  discord: 'Discord',
  slack: 'Slack',
  mattermost: 'Mattermost',
  signal: 'Signal',
  imessage: 'iMessage',
  qqbot: 'QQ Bot',
  qq: 'QQ',
  webchat: 'webchat',
  'openclaw-lark': locale.value === 'zh-CN' ? '飞书' : 'Feishu',
  lark: locale.value === 'zh-CN' ? '飞书' : 'Feishu',
  'dingtalk-connector': locale.value === 'zh-CN' ? '钉钉' : 'DingTalk',
  'wecom-openclaw-plugin': locale.value === 'zh-CN' ? '企业微信' : 'WeCom',
  main: 'GAIOP Web Chat',
}))

function formatChannelLabel(channelKey: string): string {
  const normalized = channelKey.trim().toLowerCase()
  if (normalized === 'web') return 'webchat'
  if (normalized === 'feishu' || normalized === 'lark') return text('飞书', 'Feishu')
  if (normalized === 'dingtalk') return text('钉钉', 'DingTalk')
  if (normalized === 'wecom') return text('企业微信', 'WeCom')
  return deliveryChannelLabelMap.value[normalized] || channelKey
}

function isWebChatSession(session: SessionRow): boolean {
  return isWebConversation(session)
}

function isLegacySharedWebChatSession(session: SessionRow): boolean {
  return isLegacyDefaultSession(session)
}

function displaySessionTitle(session: SessionRow): string {
  return formatSessionConversationTitle(session)
}

function sessionChannelLabel(session: SessionRow): string {
  return formatSessionChannelLabel(session)
}

function sessionChannelUser(session: SessionRow): string {
  if (isLegacySharedWebChatSession(session)) return text('历史共享会话（无账户归属）', 'Historical shared session (no account owner)')
  if (isWebChatSession(session)) {
    return session.channelUserName || session.channelUserId || session.ownerUsername || text('历史 webchat 用户未登记', 'Historical webchat user not recorded')
  }
  const display = session.channelUserName || session.ownerUsername || session.label || session.channelUserId || session.peer || session.parsed.peer
  if (!display) return '-'
  if ((session.sourceChannel || session.channel || session.parsed.channel) === 'feishu' && /^ou_[a-z0-9_-]+$/i.test(display)) {
    return text(`飞书用户（${display}）`, `Feishu user (${display})`)
  }
  return display
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return null
}

function normalizeChannelKey(value: string): string {
  return value.trim().toLowerCase()
}

function isConfiguredChannelEnabled(value: unknown): boolean {
  const record = toRecord(value)
  if (!record) return false
  const enabled = record.enabled
  if (typeof enabled === 'boolean') return enabled
  return true
}

const configuredChannelConfigMap = computed<Record<string, unknown>>(() => {
  const source = toRecord(configStore.config?.channels)
  const map: Record<string, unknown> = {}
  if (!source) return map
  for (const [channelKey, channelValue] of Object.entries(source)) {
    const normalized = normalizeChannelKey(channelKey)
    if (!normalized) continue
    map[normalized] = channelValue
  }
  return map
})

const channelOptionsForCreate = computed<SelectOption[]>(() => {
  const options: SelectOption[] = [
    { label: 'GAIOP Web Chat', value: 'webchat' },
  ]
  const seen = new Set<string>(['main', 'webchat'])
  const channels = configuredChannelConfigMap.value
  if (channels) {
    const configured = Object.entries(channels)
      .filter(([, value]) => isConfiguredChannelEnabled(value))
      .map(([channelKey]) => channelKey.trim())
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b))

    for (const channelKey of configured) {
      const normalized = normalizeChannelKey(channelKey)
      if (seen.has(normalized)) continue
      seen.add(normalized)
      options.push({
        label: formatChannelLabel(channelKey),
        value: channelKey,
      })
    }
  }
  return options
})

const sessionRows = computed<SessionRow[]>(() => {
  return sessionStore.sessions.map((session) => {
    const parsed = parseSessionKey(session.key)
    const lastActivityTs = parseTimestamp(session.lastActivity)
    return {
      ...session,
      parsed,
      lastActivityTs,
      active24h: isActiveIn24h(lastActivityTs),
    }
  })
})

const channelOptions = computed<SelectOption[]>(() => {
  const set = new Set(sessionRows.value.map((item) => item.sourceChannel || item.parsed.channel).filter(Boolean))
  return [
    { label: t('pages.sessions.list.filters.allChannels'), value: 'all' },
    ...Array.from(set)
      .sort((a, b) => a.localeCompare(b))
      .map((channel) => ({
        label: channel === 'main' ? 'GAIOP Web Chat' : formatChannelLabel(channel),
        value: channel,
      })),
  ]
})

const modelOptions = computed<SelectOption[]>(() => {
  const set = new Set(sessionRows.value.map((item) => item.model || '').filter(Boolean))
  return [
    { label: t('pages.sessions.list.filters.allModels'), value: 'all' },
    ...Array.from(set)
      .sort((a, b) => a.localeCompare(b))
      .map((model) => ({ label: model, value: model })),
  ]
})

const filteredSessions = computed<SessionRow[]>(() => {
  const q = searchQuery.value.trim().toLowerCase()

  let list = sessionRows.value.filter((item) => {
    if (!isTimestampWithinRange(item.lastActivityTs, appliedRange.value)) return false
    if (channelFilter.value !== 'all' && (item.sourceChannel || item.parsed.channel) !== channelFilter.value) return false
    if (modelFilter.value !== 'all' && (item.model || '') !== modelFilter.value) return false

    return sessionMatchesSearch(item, q)
  })

  list = [...list].sort((a, b) => {
    if (sortMode.value === 'messages') {
      if (b.messageCount !== a.messageCount) return b.messageCount - a.messageCount
      return b.lastActivityTs - a.lastActivityTs
    }
    return b.lastActivityTs - a.lastActivityTs
  })

  return list
})

const stats = computed(() => {
  const total = sessionRows.value.length
  const active24h = sessionRows.value.filter((item) => item.active24h).length
  const totalMessages = sessionRows.value.reduce((acc, item) => acc + (item.messageCount || 0), 0)
  const uniqueChannels = new Set(sessionRows.value.map((item) => item.sourceChannel || item.parsed.channel).filter(Boolean)).size
  return {
    total,
    active24h,
    totalMessages,
    uniqueChannels,
  }
})

const sessionColumns = computed<DataTableColumns<SessionRow>>(() => {
  const columns: DataTableColumns<SessionRow> = [
  {
    title: t('pages.sessions.list.columns.session'),
    key: 'session',
    minWidth: 360,
    render(row) {
      const title = displaySessionTitle(row)
      return h(NSpace, { vertical: true, size: 3 }, () => [
        h(
          'span',
          {
            class: 'session-title-ellipsis',
            title,
            style: 'display:block; max-width:340px; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:500;',
          },
          title
        ),
        h(NSpace, { size: 6, align: 'center' }, () => [
          h(NTag, { size: 'small', type: 'info', bordered: false, round: true }, { default: () => row.parsed.agent }),
          h(NTag, { size: 'small', bordered: false, round: true }, { default: () => sessionChannelLabel(row) }),
          row.active24h
            ? h(NTag, { size: 'small', bordered: false, type: 'success', round: true }, { default: () => t('pages.sessions.list.badges.active24h') })
            : null,
        ]),
        // Gateway's historical label is internal transport metadata (for
        // example “OpenClaw Web Backend”), not a GAIOP-facing session name.
        // External channel labels are shown only through 渠道用户 above.
      ])
    },
  },
  {
    title: text('渠道用户', 'Channel user'),
    key: 'channelUser',
    minWidth: 180,
    ellipsis: { tooltip: true },
    render(row) {
      return h(NSpace, { vertical: true, size: 2 }, () => [
        h(NText, { style: 'font-size: 13px;' }, { default: () => sessionChannelUser(row) }),
        row.originKind === 'web' && row.ownerUsername
          ? h(NText, { depth: 3, style: 'font-size: 11px;' }, { default: () => text('GAIOP 登录用户', 'GAIOP signed-in user') })
          : row.originKind === 'channel'
            ? h(NText, { depth: 3, style: 'font-size: 11px;' }, { default: () => text('外部频道用户', 'External channel user') })
            : null,
      ])
    },
  },
  {
    title: t('pages.sessions.list.columns.messageCount'),
    key: 'messageCount',
    width: 90,
    sorter: (a, b) => a.messageCount - b.messageCount,
    render(row) {
      return row.messageCount || 0
    },
  },
  {
    title: t('pages.sessions.list.columns.model'),
    key: 'model',
    minWidth: 160,
    ellipsis: { tooltip: true },
    render(row) {
      return row.model || '-'
    },
  },
  {
    title: t('pages.sessions.list.columns.tokenTotal'),
    key: 'tokenTotal',
    width: 110,
    render(row) {
      const total = resolveSessionTokenTotal(row)
      if (total === null) return '-'
      return formatTokenTotalK(total)
    },
  },
  {
    title: t('pages.sessions.list.columns.lastActivity'),
    key: 'lastActivity',
    width: 140,
    sorter: (a, b) => a.lastActivityTs - b.lastActivityTs,
    render(row) {
      return row.lastActivity ? formatRelativeTime(row.lastActivity) : '-'
    },
  },
  {
    title: t('pages.sessions.list.columns.actions'),
    key: 'actions',
    width: canDeleteSessions.value ? 220 : 130,
    render(row) {
      const actions = [
        h(
          NButton,
          {
            size: 'small',
            type: 'success',
            secondary: true,
            strong: true,
            class: 'sessions-action-btn sessions-action-btn--continue',
            onClick: () => handleContinueConversation(row),
          },
          {
            icon: () => h(NIcon, { component: ChatbubblesOutline }),
            default: () => canContinueSessions.value
              ? t('pages.sessions.list.continueConversation')
              : text('查看历史', 'View history'),
          }
        ),
      ]
      if (canDeleteSessions.value) {
        actions.push(h(
          NPopconfirm,
          { onPositiveClick: () => handleDelete(row) },
          {
            trigger: () => h(
              NButton,
              {
                size: 'small',
                type: 'error',
                secondary: true,
                strong: true,
                class: 'sessions-action-btn sessions-action-btn--delete',
              },
              {
                icon: () => h(NIcon, { component: TrashOutline }),
                default: () => t('common.delete'),
              }
            ),
            default: () => t('pages.sessions.detail.confirmDelete'),
          }
        ))
      }
      return h(NSpace, { size: 8, wrap: false, class: 'sessions-row-actions' }, () => actions)
    },
  },
  ]
  if (canDeleteSessions.value) columns.unshift({ type: 'selection' })
  return columns
})

onMounted(() => {
  void syncServerNow()
  void sessionStore.fetchSessions()
  if (canUseFunctions.value) {
    void agentStore.fetchAgents()
    void configStore.fetchConfig()
  }
})

watch([searchQuery, channelFilter, modelFilter, sortMode, appliedRange], () => {
  currentPage.value = 1
})

function parseTimestamp(value?: string): number {
  if (!value) return 0
  const ts = new Date(value).getTime()
  return Number.isFinite(ts) ? ts : 0
}

function isActiveIn24h(timestamp: number): boolean {
  if (!timestamp) return false
  return Date.now() - timestamp <= 24 * 60 * 60 * 1000
}

function resolveSessionTokenTotal(session: Session): number | null {
  const usage = session.tokenUsage
  if (!usage) return null
  const input = Number.isFinite(usage.totalInput) ? usage.totalInput : 0
  const output = Number.isFinite(usage.totalOutput) ? usage.totalOutput : 0
  return Math.max(0, Math.floor(input + output))
}

function formatTokenTotalK(total: number): string {
  const value = Math.max(0, total) / 1000
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2
  const text = value.toFixed(digits).replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1')
  return `${text}K`
}

function clearFilters() {
  searchQuery.value = ''
  channelFilter.value = 'all'
  modelFilter.value = 'all'
  sortMode.value = 'recent'
  timePreset.value = 'last7days'
  timeRangeTouched.value = false
  appliedRange.value = rangeForPreset('last7days', currentServerNow())
}

function applyTimeRange(range: TimeRange, preset: TimeRangePreset) {
  timeRangeTouched.value = true
  appliedRange.value = [...range] as TimeRange
  timePreset.value = preset
}

async function syncServerNow() {
  try {
    const response = await fetch('/api/health', { cache: 'no-store' })
    const responseTime = Date.parse(response.headers.get('date') || '')
    if (Number.isFinite(responseTime)) {
      serverNow.value = responseTime
      serverNowReceivedAt.value = Date.now()
      if (!timeRangeTouched.value) {
        appliedRange.value = rangeForPreset('last7days', serverNow.value)
      }
    }
  } catch {
    serverNow.value = Date.now()
    serverNowReceivedAt.value = Date.now()
  }
}

function currentServerNow(): number {
  const elapsed = Math.max(0, Date.now() - serverNowReceivedAt.value)
  return serverNow.value + elapsed
}

async function handleRefresh() {
  await sessionStore.fetchSessions()
}

function handleContinueConversation(session: SessionRow) {
  void router.push({ name: 'ChatWorkspace', query: { session: session.key } })
}

async function handleDelete(session: SessionRow) {
  if (!canDeleteSessions.value) {
    message.error(text('当前用户仅有查看权限，不能删除会话', 'The current user has read-only access and cannot delete sessions'))
    return
  }
  try {
    await sessionStore.deleteSession(session.key)
    message.success(t('pages.sessions.detail.deleteSuccess'))
  } catch {
    message.error(t('pages.sessions.detail.deleteFailed'))
  }
}

async function handleBatchDelete() {
  if (!canDeleteSessions.value) {
    message.error(text('当前用户仅有查看权限，不能删除会话', 'The current user has read-only access and cannot delete sessions'))
    return
  }
  if (allSelectedKeys.value.length === 0) return
  batchDeleting.value = true
  try {
    const result = await sessionStore.deleteSessions(allSelectedKeys.value)
    if (result.failedCount > 0) {
      message.warning(t('pages.sessions.list.batchDeletePartial', {
        deleted: result.deletedCount,
        failed: result.failedCount,
      }))
    } else {
      message.success(t('pages.sessions.list.batchDeleteSuccess', { count: result.deletedCount }))
    }
    allSelectedKeys.value = []
  } catch {
    message.error(t('pages.sessions.list.batchDeleteFailed'))
  } finally {
    batchDeleting.value = false
  }
}

function handleSelectAll() {
  if (!canDeleteSessions.value) return
  if (isAllSelected.value) {
    allSelectedKeys.value = []
  } else {
    allSelectedKeys.value = [...allSessionKeys.value]
  }
}

function openCreateModal() {
  if (!canUseFunctions.value) return
  createForm.value = {
    agentId: 'main',
    channel: 'webchat',
    peer: '',
    label: '',
  }
  showCreateModal.value = true
}

async function handleCreateSession() {
  if (!canUseFunctions.value) return
  creating.value = true
  try {
    await sessionStore.createSession({
      agentId: createForm.value.agentId || 'main',
      channel: createForm.value.channel || 'webchat',
      peer: createForm.value.peer || undefined,
      label: createForm.value.label || undefined,
    })
    message.success(t('pages.sessions.list.createSuccess'))
    showCreateModal.value = false
  } catch (e: any) {
    message.error(e?.message || t('pages.sessions.list.createFailed'))
  } finally {
    creating.value = false
  }
}
</script>

<template>
  <div class="sessions-page">
    <NCard class="sessions-hero" :bordered="false">
      <template #header>
        <div class="sessions-hero-title">{{ t('pages.sessions.list.title') }}</div>
      </template>
      <template #header-extra>
        <NSpace :size="8">
          <NButton
            v-if="canDeleteSessions && filteredSessions.length > 0"
            size="small"
            :type="isAllSelected ? 'warning' : 'default'"
            :ghost="!isAllSelected && !isPartialSelected"
            @click="handleSelectAll"
          >
            <template #icon>
              <NIcon :component="isAllSelected ? RemoveOutline : AddOutline" />
            </template>
            {{ isAllSelected ? t('pages.sessions.list.deselectAll') : t('pages.sessions.list.selectAll') }}
            ({{ filteredSessions.length }})
          </NButton>
          <NPopconfirm
            v-if="canDeleteSessions && allSelectedKeys.length > 0"
            :disabled="batchDeleting"
            @positive-click="handleBatchDelete"
          >
            <template #trigger>
              <NButton
                size="small"
                type="error"
                :loading="batchDeleting"
                :disabled="batchDeleting"
              >
                <template #icon>
                  <NIcon :component="TrashOutline" />
                </template>
                {{ t('pages.sessions.list.batchDelete', { count: allSelectedKeys.length }) }}
              </NButton>
            </template>
            {{ t('pages.sessions.list.confirmBatchDelete', { count: allSelectedKeys.length }) }}
          </NPopconfirm>
          <NButton v-if="canUseFunctions" size="small" type="primary" @click="openCreateModal">
            <template #icon>
              <NIcon :component="AddOutline" />
            </template>
            {{ t('pages.sessions.list.createSession') }}
          </NButton>
          <NButton size="small" :loading="sessionStore.loading" @click="handleRefresh">
            <template #icon>
              <NIcon :component="RefreshOutline" />
            </template>
            {{ t('common.refresh') }}
          </NButton>
        </NSpace>
      </template>

      <NAlert type="info" :bordered="false">
        {{ t('pages.sessions.list.hint') }}
      </NAlert>

      <NGrid cols="1 s:2 m:4" responsive="screen" :x-gap="10" :y-gap="10" style="margin-top: 12px;">
        <NGridItem>
          <NCard embedded :bordered="false" class="sessions-metric-card">
            <NSpace justify="space-between" align="center">
              <NText depth="3">{{ t('pages.sessions.list.metrics.totalSessions') }}</NText>
              <NIcon :component="ChatbubblesOutline" />
            </NSpace>
            <div class="sessions-metric-value">{{ stats.total }}</div>
          </NCard>
        </NGridItem>
        <NGridItem>
          <NCard embedded :bordered="false" class="sessions-metric-card">
            <NSpace justify="space-between" align="center">
              <NText depth="3">{{ t('pages.sessions.list.metrics.active24h') }}</NText>
              <NIcon :component="TimeOutline" />
            </NSpace>
            <div class="sessions-metric-value">{{ stats.active24h }}</div>
          </NCard>
        </NGridItem>
        <NGridItem>
          <NCard embedded :bordered="false" class="sessions-metric-card">
            <NSpace justify="space-between" align="center">
              <NText depth="3">{{ t('pages.sessions.list.metrics.totalMessages') }}</NText>
              <NText depth="3">{{ t('pages.sessions.list.units.messages') }}</NText>
            </NSpace>
            <div class="sessions-metric-value">{{ stats.totalMessages }}</div>
          </NCard>
        </NGridItem>
        <NGridItem>
          <NCard embedded :bordered="false" class="sessions-metric-card">
            <NSpace justify="space-between" align="center">
              <NText depth="3">{{ t('pages.sessions.list.metrics.uniqueChannels') }}</NText>
              <NText depth="3">{{ t('pages.sessions.list.units.channels') }}</NText>
            </NSpace>
            <div class="sessions-metric-value">{{ stats.uniqueChannels }}</div>
          </NCard>
        </NGridItem>
      </NGrid>

      <div class="sessions-filter-bar">
        <NInput v-model:value="searchQuery" clearable :placeholder="t('pages.sessions.list.searchPlaceholder')">
          <template #prefix>
            <NIcon :component="SearchOutline" />
          </template>
        </NInput>
        <NSelect v-model:value="channelFilter" :options="channelOptions" />
        <NSelect v-model:value="modelFilter" :options="modelOptions" />
        <NSelect v-model:value="sortMode" :options="sortOptions" />
        <NButton @click="clearFilters">{{ t('pages.sessions.list.clearFilters') }}</NButton>
      </div>
    </NCard>

    <NCard :title="t('pages.sessions.list.listTitle')" class="sessions-card">
      <template #header-extra>
        <NSpace align="center" wrap :size="8">
          <NTag v-if="sessionStore.usageLoading" size="small" type="info" :bordered="false" round>
            {{ t('pages.sessions.list.usageLoading') }}
          </NTag>
          <NText depth="3" style="font-size: 12px;">
            {{ t('pages.sessions.list.listCount', { current: filteredSessions.length, total: stats.total }) }}
          </NText>
          <TimeRangePicker
            v-model="appliedRange"
            :preset="timePreset"
            :server-now="serverNow"
            compact
            placement="bottom-end"
            @apply="applyTimeRange"
          />
        </NSpace>
      </template>

      <NDataTable
        :checked-row-keys="allSelectedKeys"
        :columns="sessionColumns"
        :data="filteredSessions"
        :loading="sessionStore.loading"
        :bordered="false"
        :row-key="(row: SessionRow) => row.key"
        :pagination="{ pageSize, page: currentPage, onChange: handlePageChange }"
        :scroll-x="1310"
        :max-height="600"
        striped
        @update:checked-row-keys="onUpdateCheckedRowKeys"
      />
    </NCard>

    <NModal
      v-if="canUseFunctions"
      v-model:show="showCreateModal"
      preset="card"
      :title="t('pages.sessions.list.createModal.title')"
      style="width: 500px; max-width: 90vw;"
      :mask-closable="false"
    >
      <NForm label-placement="left" label-width="80">
        <NFormItem :label="t('pages.sessions.list.createModal.agent')">
          <NSelect
            v-model:value="createForm.agentId"
            :options="agentOptions"
            :placeholder="t('pages.sessions.list.createModal.agentPlaceholder')"
          />
        </NFormItem>
        <NFormItem :label="t('pages.sessions.list.createModal.channel')">
          <NSelect
            v-model:value="createForm.channel"
            :options="channelOptionsForCreate"
            :placeholder="t('pages.sessions.list.createModal.channelPlaceholder')"
          />
        </NFormItem>
        <NFormItem :label="t('pages.sessions.list.createModal.peer')">
          <NInput
            v-model:value="createForm.peer"
            :placeholder="t('pages.sessions.list.createModal.peerPlaceholder')"
          />
        </NFormItem>
        <NFormItem :label="t('pages.sessions.list.createModal.label')">
          <NInput
            v-model:value="createForm.label"
            :placeholder="t('pages.sessions.list.createModal.labelPlaceholder')"
          />
        </NFormItem>
      </NForm>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="showCreateModal = false">{{ t('common.cancel') }}</NButton>
          <NButton type="primary" :loading="creating" @click="handleCreateSession">
            {{ t('common.create') }}
          </NButton>
        </NSpace>
      </template>
    </NModal>
  </div>
</template>

<style scoped>
.sessions-page {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.sessions-hero {
  border-radius: var(--radius-lg);
  background:
    radial-gradient(circle at 84% 16%, rgba(32, 128, 240, 0.22), transparent 36%),
    linear-gradient(120deg, var(--bg-card), rgba(24, 160, 88, 0.08));
  border: 1px solid rgba(32, 128, 240, 0.18);
}

.sessions-hero-title {
  font-size: 18px;
  font-weight: 700;
  line-height: 1.2;
}

.sessions-metric-card {
  border-radius: 10px;
}

.sessions-metric-value {
  margin-top: 8px;
  font-size: 22px;
  font-weight: 700;
  line-height: 1.2;
}

.sessions-filter-bar {
  margin-top: 12px;
  display: grid;
  grid-template-columns: minmax(0, 2fr) repeat(3, minmax(0, 1fr)) auto;
  gap: 8px;
}

.sessions-card {
  border-radius: var(--radius-lg);
}

.session-title-ellipsis {
  display: block;
  width: 100%;
  overflow: hidden;
  color: var(--text-color-1);
  font-size: 13px;
  line-height: 20px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sessions-row-actions {
  align-items: center;
  flex-wrap: nowrap;
}

.sessions-action-btn {
  min-width: 78px;
  height: 34px;
  padding: 0 12px;
  border-radius: 9px;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.1px;
  transition: transform 0.16s ease, box-shadow 0.16s ease;
}

.sessions-action-btn:not(:disabled):hover {
  transform: translateY(-1px);
  box-shadow: 0 3px 10px rgba(15, 23, 42, 0.12);
}

@media (max-width: 1100px) {
  .sessions-filter-bar {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
