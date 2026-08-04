<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NAvatar, NButton, NEmpty, NIcon, NModal, NPopconfirm, NSpin, NSpace, NText, NTooltip, useMessage } from 'naive-ui'
import {
  AddOutline,
  ArrowBackOutline,
  ChatbubbleEllipsesOutline,
  ChevronForwardOutline,
  GridOutline,
  LockClosedOutline,
  LogOutOutline,
  PersonOutline,
  TrashOutline,
} from '@vicons/ionicons5'
import ChatPage from '@/views/chat/ChatPage.vue'
import { ConnectionState } from '@/api/types'
import { useAuthStore } from '@/stores/auth'
import { useChatStore } from '@/stores/chat'
import { useSessionStore } from '@/stores/session'
import { useWebSocketStore } from '@/stores/websocket'
import { usePermissions } from '@/composables/usePermissions'
import {
  compareSessionsByConversationActivity,
  formatSessionConversationTitle,
  isLegacyDefaultSession,
} from '@/utils/session-presentation'
import type { Session } from '@/api/types'
import { canAccessPage, MANAGEMENT_ACCESS_DENIED_NOTICE } from '@/permissions/access-control'
import { useI18n } from 'vue-i18n'

const router = useRouter()
const route = useRoute()
const authStore = useAuthStore()
const chatStore = useChatStore()
const sessionStore = useSessionStore()
const wsStore = useWebSocketStore()
const { t } = useI18n()
const {
  canUseFunctions,
  canDeleteSessions,
  chatReadOnlyHint,
} = usePermissions()
const message = useMessage()
const canAccessAdminConsole = computed(() => canAccessPage(authStore.currentUser?.role, 'dashboard'))

const ready = ref(wsStore.state === ConnectionState.CONNECTED)
const creatingSession = ref(false)
const historyRefreshing = ref(false)
const userMenuOpen = ref(false)
const showManagementAccessDenied = ref(false)
let unsubscribeState: (() => void) | null = null

const connectionText = computed(() => {
  if (wsStore.state === ConnectionState.FAILED) return t('pages.gaiop.workspace.serviceUnavailable')
  if (wsStore.state === ConnectionState.RECONNECTING) return t('pages.gaiop.workspace.reconnecting')
  return t('pages.gaiop.workspace.connectingService')
})

const canRetryConnection = computed(() =>
  wsStore.state === ConnectionState.FAILED || wsStore.state === ConnectionState.DISCONNECTED
)

function readAlertAnalysisDraft() {
  const value = route.query.alertAnalysis
  return (typeof value === 'string' ? value : Array.isArray(value) ? value[0] || '' : '').trim()
}

// Keep the handoff text in the workspace shell. ChatPage may mount only after the
// Gateway connection becomes ready, so route query data must survive that gap.
const alertAnalysisDraft = ref(readAlertAnalysisDraft())
const alertReturnAvailable = ref(route.query.alertReturn === '1')

const selectedSession = computed(() => {
  const value = route.query.session
  return typeof value === 'string' ? value : Array.isArray(value) ? value[0] || '' : ''
})

function clearWorkspacePreviewForNewConversation() {
  if (selectedSession.value) return
  // 进入新对话时同步清掉 Pinia 中上一会话的消息，避免工作台先闪现旧内容。
  chatStore.setSessionKey('')
  void chatStore.fetchHistory('')
}

clearWorkspacePreviewForNewConversation()

watch(selectedSession, () => {
  clearWorkspacePreviewForNewConversation()
})

watch(
  () => route.query.notice,
  () => consumeManagementAccessNotice(),
  { immediate: true },
)

const historySessions = computed(() =>
  [...sessionStore.sessions]
    // OpenClaw's protected default runtime session is not a user conversation.
    // Keep it available to the runtime while excluding it from WebChat history.
    .filter((session) => !isLegacyDefaultSession(session))
    .sort(compareSessionsByConversationActivity)
    .slice(0, 50)
)

function sessionTitle(session: Session) {
  return formatSessionConversationTitle(session)
}

function openSession(key: string) {
  router.replace({ name: 'ChatWorkspace', query: { session: key, ...(alertReturnAvailable.value ? { alertReturn: '1' } : {}) } })
}

function openAdminConsole() {
  userMenuOpen.value = false
  if (canAccessAdminConsole.value) {
    void router.push({ name: 'Dashboard' })
    return
  }
  showManagementAccessDenied.value = true
}

function consumeManagementAccessNotice() {
  if (route.query.notice !== MANAGEMENT_ACCESS_DENIED_NOTICE || canAccessAdminConsole.value) return

  showManagementAccessDenied.value = true
  const { notice: _notice, ...query } = route.query
  void router.replace({ name: 'ChatWorkspace', query })
}

function returnToAlertNotifications() {
  alertReturnAvailable.value = false
  void router.push({ name: 'AlertNotifications', query: { restoreAlertState: '1' } })
}

async function startNewConversation() {
  if (!canUseFunctions.value || creatingSession.value) return
  creatingSession.value = true
  try {
    // 新对话在用户发送第一条分析需求前不调用底层接口，避免出现“New session started”系统消息。
    await router.replace({ name: 'ChatWorkspace', query: alertReturnAvailable.value ? { alertReturn: '1' } : {} })
  } catch (error) {
    console.error('[ChatWorkspace] Failed to create session:', error)
  } finally {
    creatingSession.value = false
  }
}

async function deleteSession(key: string) {
  try {
    await sessionStore.deleteSession(key)
    if (selectedSession.value === key) {
      await router.replace({ name: 'ChatWorkspace', query: alertReturnAvailable.value ? { alertReturn: '1' } : {} })
    }
    message.success(t('pages.gaiop.workspace.sessionDeleted'))
  } catch (error) {
    console.error('[ChatWorkspace] Failed to delete session:', error)
    message.error(t('pages.gaiop.workspace.deleteFailed'))
  }
}

async function logout() {
  wsStore.disconnect()
  await authStore.logout()
  router.push({ name: 'Welcome', query: { redirect: '/workspace' } })
}

async function refreshHistory() {
  if (historyRefreshing.value) return
  historyRefreshing.value = true
  try {
    await sessionStore.fetchSessions({ force: true })
  } finally {
    historyRefreshing.value = false
  }
}

function retryConnection() {
  wsStore.connect()
}

watch(
  () => wsStore.state,
  (state) => {
    ready.value = state === ConnectionState.CONNECTED
  }
)

onMounted(() => {
  if (alertAnalysisDraft.value) {
    const query = { ...route.query }
    delete query.alertAnalysis
    void router.replace({ query })
  }
  if (wsStore.state !== ConnectionState.CONNECTED) wsStore.connect()
  unsubscribeState = wsStore.subscribe('stateChange', (state: unknown) => {
    ready.value = state === ConnectionState.CONNECTED
  })
})

onUnmounted(() => {
  unsubscribeState?.()
  wsStore.disconnect()
})
</script>

<template>
  <main class="workspace-page">
    <aside class="workspace-sidebar">
      <div class="workspace-brand">
        <span class="brand-logo"><span>Net</span>Inside</span>
        <span class="brand-divider"></span>
        <strong>{{ t('pages.gaiop.workspace.brand') }}</strong>
      </div>

      <NButton
        class="new-chat-button"
        block
        size="large"
        :loading="creatingSession"
        :disabled="!canUseFunctions"
        :title="!canUseFunctions ? chatReadOnlyHint : undefined"
        @click="startNewConversation"
      >
        <template #icon><NIcon :component="AddOutline" /></template>
        {{ t('pages.gaiop.workspace.newChat') }}
      </NButton>

      <section class="history-section">
        <div class="history-heading">
          <span>{{ t('pages.gaiop.workspace.history') }}</span>
          <button
            type="button"
            :title="t('pages.gaiop.workspace.refreshHistory')"
            :aria-label="t('pages.gaiop.workspace.refreshHistory')"
            :disabled="historyRefreshing"
            @click="refreshHistory"
          >
            <NIcon :component="ChatbubbleEllipsesOutline" :class="{ 'is-spinning': historyRefreshing }" />
          </button>
        </div>

        <div v-if="sessionStore.loading && historySessions.length === 0" class="history-loading">
          <NSpin size="small" />
        </div>
        <div v-else-if="historySessions.length" class="history-list">
          <div
            v-for="session in historySessions"
            :key="session.key"
            class="history-row"
            :class="{ 'is-active': selectedSession === session.key }"
          >
            <button type="button" class="history-item" :title="sessionTitle(session)" @click="openSession(session.key)">
              <NIcon :component="ChatbubbleEllipsesOutline" />
              <span>{{ sessionTitle(session) }}</span>
            </button>
            <NPopconfirm
              v-if="canDeleteSessions"
              :positive-text="t('pages.gaiop.workspace.delete')"
              :negative-text="t('pages.gaiop.workspace.cancel')"
              @positive-click="deleteSession(session.key)"
            >
              <template #trigger>
                <button type="button" class="history-delete" :title="t('pages.gaiop.workspace.deleteSession')" :aria-label="t('pages.gaiop.workspace.deleteSession')">
                  <NIcon :component="TrashOutline" />
                </button>
              </template>
              {{ t('pages.gaiop.workspace.deleteConfirm') }}
            </NPopconfirm>
          </div>
        </div>
        <NEmpty v-else :description="t('pages.gaiop.workspace.noHistory')" size="small" class="history-empty" />
      </section>

      <div class="workspace-user">
        <button type="button" class="workspace-user-trigger" @click="userMenuOpen = !userMenuOpen">
          <NAvatar round size="small" color="#0b7552">{{ authStore.currentUser?.username?.slice(0, 1).toUpperCase() || 'G' }}</NAvatar>
          <span>{{ authStore.currentUser?.username || t('pages.gaiop.workspace.userFallback') }}</span>
        </button>
        <div v-if="userMenuOpen" class="workspace-user-menu">
          <button type="button" @click="router.push({ name: 'PasswordChange' })">
            <NIcon :component="LockClosedOutline" /> {{ t('pages.gaiop.workspace.changePassword') }}
          </button>
          <button type="button" @click="openAdminConsole">
            <NIcon :component="GridOutline" /> {{ t('pages.gaiop.workspace.adminConsole') }}
          </button>
          <button type="button" class="danger" @click="logout">
            <NIcon :component="LogOutOutline" /> {{ t('pages.gaiop.workspace.logout') }}
          </button>
        </div>
      </div>
    </aside>

    <section class="workspace-main">
      <header class="workspace-header">
        <div>
          <span class="workspace-caption">{{ t('pages.gaiop.workspace.caption') }}</span>
          <span v-if="!ready" class="workspace-status">{{ t('pages.gaiop.workspace.connecting') }}</span>
        </div>
        <div class="workspace-header-actions">
          <NButton v-if="alertReturnAvailable" secondary @click="returnToAlertNotifications">
            <template #icon><NIcon :component="ArrowBackOutline" /></template>
            {{ t('pages.gaiop.workspace.backToAlerts') }}
          </NButton>
          <NTooltip>
            <template #trigger>
              <NButton secondary type="primary" @click="openAdminConsole">
                <template #icon><NIcon :component="GridOutline" /></template>
                {{ t('pages.gaiop.workspace.adminConsole') }}
              </NButton>
            </template>
            {{ t('pages.gaiop.workspace.adminConsoleHint') }}
          </NTooltip>
        </div>
      </header>

      <div v-if="ready" class="workspace-chat-host">
        <ChatPage workspace :initial-draft="alertAnalysisDraft" />
      </div>
      <div v-else class="workspace-connecting">
        <NSpin size="medium" />
        <p>{{ connectionText }}</p>
        <NButton v-if="canRetryConnection" type="primary" secondary @click="retryConnection">{{ t('pages.gaiop.workspace.reconnect') }}</NButton>
      </div>
    </section>

    <NModal v-model:show="showManagementAccessDenied" preset="card" :style="{ width: 'min(420px, calc(100vw - 32px))' }">
      <NSpace vertical align="center" :size="10" class="management-access-denied-dialog">
        <h2 class="management-access-denied-title">{{ t('pages.gaiop.accessDenied.title') }}</h2>
        <span class="management-access-denied-icon"><NIcon :component="LockClosedOutline" /></span>
        <NText depth="3">{{ t('pages.gaiop.workspace.managementAccessDenied') }}</NText>
        <NButton type="primary" @click="showManagementAccessDenied = false">
          {{ t('pages.gaiop.workspace.managementAccessDeniedConfirm') }}
        </NButton>
      </NSpace>
    </NModal>
  </main>
</template>

<style scoped>
.workspace-page {
  display: grid;
  grid-template-columns: 260px minmax(0, 1fr);
  height: 100vh;
  overflow: hidden;
  background: #f8fbf9;
  color: #173e31;
}

.management-access-denied-dialog {
  padding: 4px 6px 10px;
  text-align: center;
}

.management-access-denied-title {
  margin: 0 0 2px;
  color: var(--text-primary);
  font-size: 23px;
  font-weight: 650;
  line-height: 1.3;
}

.management-access-denied-icon {
  display: grid;
  width: 54px;
  height: 54px;
  place-items: center;
  border-radius: 17px;
  background: color-mix(in srgb, var(--primary-color) 12%, transparent);
  color: var(--primary-color);
  font-size: 27px;
}

.workspace-sidebar {
  position: relative;
  display: flex;
  min-height: 0;
  flex-direction: column;
  padding: 22px 14px 14px;
  border-right: 1px solid #e3eee7;
  background: #f5faf7;
}

.workspace-brand {
  display: flex;
  align-items: center;
  min-height: 30px;
  padding: 0 9px;
  gap: 9px;
  white-space: nowrap;
}

.brand-logo { color: #1a211d; font-size: 16px; font-weight: 600; letter-spacing: -0.045em; }
.brand-logo span { color: #50ae65; }
.brand-divider { width: 1px; height: 18px; background: #c6d9cd; }
.workspace-brand strong { color: #174d38; font-size: 15px; }

.new-chat-button {
  --n-color: #ffffff !important;
  --n-color-hover: #fafffc !important;
  --n-color-pressed: #f1fbf5 !important;
  --n-border: 1px solid #cfe4d6 !important;
  --n-border-hover: 1px solid #78bd94 !important;
  --n-text-color: #0b6c47 !important;
  --n-text-color-hover: #075b3b !important;
  margin: 28px 0 19px;
  border-radius: 12px;
  font-weight: 600;
  box-shadow: 0 2px 7px rgba(36, 104, 68, 0.05);
}

.history-section { display: flex; min-height: 0; flex: 1; flex-direction: column; }
.history-heading { display: flex; align-items: center; justify-content: space-between; padding: 0 10px 10px; color: #789184; font-size: 12px; }
.history-heading button { display: grid; width: 25px; height: 25px; padding: 0; place-items: center; border: 0; border-radius: 7px; background: transparent; color: #6c9180; cursor: pointer; }
.history-heading button:hover { background: #e7f4ec; color: #0b7552; }
.history-heading button:disabled { cursor: wait; opacity: .7; }
.history-heading .is-spinning { animation: history-refresh-spin .8s linear infinite; }
@keyframes history-refresh-spin { to { transform: rotate(360deg); } }
.history-list { min-height: 0; overflow: auto; padding-right: 2px; }
.history-row { display: flex; align-items: center; border-radius: 9px; }
.history-item { display: flex; width: 100%; min-width: 0; align-items: center; gap: 9px; overflow: hidden; padding: 10px; border: 0; border-radius: 9px; background: transparent; color: #4b6c5c; cursor: pointer; font: inherit; font-size: 13px; text-align: left; }
.history-item span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.history-row:hover { background: #eaf5ee; color: #0b7552; }
.history-row.is-active { background: #ddf2e5; color: #087249; font-weight: 600; }
.history-delete { display: grid; width: 30px; height: 30px; margin-right: 5px; flex: 0 0 auto; place-items: center; border: 0; border-radius: 7px; background: transparent; color: #86a092; cursor: pointer; opacity: 0; }
.history-row:hover .history-delete, .history-row.is-active .history-delete { opacity: 1; }
.history-delete:hover { background: #fff0f0; color: #d85656; }
.history-loading, .history-empty { padding: 30px 0; text-align: center; }

.workspace-user { position: relative; margin-top: 12px; border-top: 1px solid #e2ede6; padding-top: 12px; }
.workspace-user-trigger { display: flex; width: 100%; align-items: center; gap: 9px; padding: 8px; border: 0; border-radius: 10px; background: transparent; color: #426856; cursor: pointer; font: inherit; font-size: 13px; text-align: left; }
.workspace-user-trigger:hover { background: #eaf5ee; }
.workspace-user-menu { position: absolute; z-index: 10; bottom: calc(100% + 8px); left: 0; width: 210px; padding: 6px; border: 1px solid #d9e9df; border-radius: 12px; background: #fff; box-shadow: 0 15px 35px rgba(30, 83, 53, 0.15); }
.workspace-user-menu button { display: flex; width: 100%; align-items: center; gap: 8px; padding: 9px 10px; border: 0; border-radius: 8px; background: transparent; color: #365b49; cursor: pointer; font: inherit; font-size: 13px; text-align: left; }
.workspace-user-menu button:hover { background: #edf8f1; color: #087249; }
.workspace-user-menu .danger:hover { background: #fff2f2; color: #cf4b4b; }

.workspace-main { display: flex; min-width: 0; min-height: 0; flex-direction: column; }
.workspace-header { display: flex; height: 64px; flex: 0 0 64px; align-items: center; justify-content: space-between; padding: 0 27px; border-bottom: 1px solid #e5eee8; background: rgba(255, 255, 255, 0.88); }
.workspace-header-actions { display: flex; align-items: center; gap: 10px; }
.workspace-caption { color: #254c3a; font-size: 14px; font-weight: 600; }
.workspace-status { margin-left: 10px; color: #83a293; font-size: 12px; }
.workspace-chat-host { min-height: 0; flex: 1; padding: 16px 24px 22px; overflow: hidden; }
.workspace-connecting { display: grid; flex: 1; place-content: center; justify-items: center; gap: 12px; color: #638674; font-size: 14px; }
.workspace-connecting p { margin: 0; }

:global([data-theme='dark'] .workspace-page) {
  background: #101412;
  color: #e7f0ea;
}

:global([data-theme='dark'] .workspace-sidebar) {
  border-right-color: #29352f;
  background: #151b18;
}

:global([data-theme='dark'] .brand-logo) { color: #e8f1eb; }
:global([data-theme='dark'] .brand-divider) { background: #3b4a42; }
:global([data-theme='dark'] .workspace-brand strong) { color: #b9dec9; }

:global([data-theme='dark'] .new-chat-button) {
  --n-color: #1b2420 !important;
  --n-color-hover: #223029 !important;
  --n-color-pressed: #15211b !important;
  --n-border: 1px solid #3a5044 !important;
  --n-border-hover: 1px solid #5f9c78 !important;
  --n-text-color: #8de0b0 !important;
  --n-text-color-hover: #a9ecc4 !important;
  box-shadow: none;
}

:global([data-theme='dark'] .history-heading) { color: #8da398; }
:global([data-theme='dark'] .history-heading button) { color: #8da398; }
:global([data-theme='dark'] .history-heading button:hover),
:global([data-theme='dark'] .history-row:hover),
:global([data-theme='dark'] .workspace-user-trigger:hover) { background: #223029; color: #8de0b0; }
:global([data-theme='dark'] .history-item) { color: #b7c7be; }
:global([data-theme='dark'] .history-row.is-active) { background: #233a2e; color: #8de0b0; }
:global([data-theme='dark'] .history-delete) { color: #8da398; }
:global([data-theme='dark'] .history-delete:hover) { background: #442727; color: #ff9a9a; }

:global([data-theme='dark'] .workspace-user) { border-top-color: #29352f; }
:global([data-theme='dark'] .workspace-user-trigger) { color: #b7c7be; }
:global([data-theme='dark'] .workspace-user-menu) {
  border-color: #33433a;
  background: #1c2420;
  box-shadow: 0 15px 35px rgba(0, 0, 0, .35);
}
:global([data-theme='dark'] .workspace-user-menu button) { color: #c7d5cd; }
:global([data-theme='dark'] .workspace-user-menu button:hover) { background: #26362d; color: #8de0b0; }
:global([data-theme='dark'] .workspace-user-menu .danger:hover) { background: #442727; color: #ff9a9a; }

:global([data-theme='dark'] .workspace-header) {
  border-bottom-color: #29352f;
  background: rgba(21, 27, 24, .94);
}
:global([data-theme='dark'] .workspace-caption) { color: #d6e6dc; }
:global([data-theme='dark'] .workspace-status),
:global([data-theme='dark'] .workspace-connecting) { color: #94aa9e; }

@media (max-width: 760px) {
  .workspace-page { grid-template-columns: 1fr; }
  .workspace-sidebar { display: none; }
  .workspace-header { padding: 0 16px; }
  .workspace-chat-host { padding: 10px; }
}
</style>
