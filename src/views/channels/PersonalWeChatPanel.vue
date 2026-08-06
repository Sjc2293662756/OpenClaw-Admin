<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import {
  NAlert,
  NButton,
  NCard,
  NEmpty,
  NForm,
  NFormItem,
  NIcon,
  NInput,
  NModal,
  NPopconfirm,
  NSpace,
  NSpin,
  NTag,
  NText,
  useMessage,
} from 'naive-ui'
import {
  AddOutline,
  PauseOutline,
  PlayOutline,
  RefreshOutline,
  TrashOutline,
} from '@vicons/ionicons5'
import { FontAwesomeIcon } from '@fortawesome/vue-fontawesome'
import { faWeixin } from '@fortawesome/free-brands-svg-icons'
import { useI18n } from 'vue-i18n'
import {
  usePersonalWechatStore,
  type PersonalWechatAccount,
  type PersonalWechatAccountStatus,
  type PersonalWechatOnboardingSession,
} from '@/stores/personal-wechat'
import {
  isPersonalWechatOnboardingTerminal,
  normalizePersonalWechatQrSource,
} from '@/utils/personal-wechat'

const props = defineProps<{
  canManage: boolean
  readOnlyHint?: string
}>()

const store = usePersonalWechatStore()
const message = useMessage()
const { t } = useI18n()

const modalVisible = ref(false)
const displayName = ref('')
const note = ref('')
const verificationCode = ref('')
const polling = ref(false)
const notifiedTerminalSessionId = ref<string | null>(null)
let onboardingTimer: ReturnType<typeof setInterval> | null = null

const qrSource = computed(() => normalizePersonalWechatQrSource(store.onboarding?.qrDataUrl))
const onboardingActive = computed(() => {
  const status = store.onboarding?.status
  return !!status && !isPersonalWechatOnboardingTerminal(status)
})

const pluginTagType = computed<'success' | 'warning' | 'error'>(() => {
  if (store.pluginReady) return 'success'
  return store.plugin.installed ? 'warning' : 'error'
})

const pluginStatusLabel = computed(() => {
  if (store.pluginReady) return t('pages.channels.personalWechat.plugin.ready')
  if (store.plugin.installed) return t('pages.channels.personalWechat.plugin.unavailable')
  return t('pages.channels.personalWechat.plugin.notInstalled')
})

function stopPolling(): void {
  if (onboardingTimer) clearInterval(onboardingTimer)
  onboardingTimer = null
}

async function handleTerminalStatus(session: PersonalWechatOnboardingSession): Promise<void> {
  if (!isPersonalWechatOnboardingTerminal(session.status)) return
  stopPolling()
  if (notifiedTerminalSessionId.value === session.id) return
  notifiedTerminalSessionId.value = session.id

  if (session.status === 'success') {
    await store.refresh()
    message.success(t('pages.channels.personalWechat.messages.added'))
  } else if (session.status === 'expired') {
    message.warning(t('pages.channels.personalWechat.messages.expired'))
  } else if (session.status === 'failed') {
    message.error(t('pages.channels.personalWechat.messages.failed'))
  }
}

async function pollOnboarding(): Promise<void> {
  if (polling.value || !store.onboarding || isPersonalWechatOnboardingTerminal(store.onboarding.status)) return
  polling.value = true
  try {
    const session = await store.refreshOnboarding()
    if (!session) return
    if (session.status === 'verification_required') stopPolling()
    await handleTerminalStatus(session)
  } catch {
    stopPolling()
    message.error(t('pages.channels.personalWechat.messages.statusFailed'))
  } finally {
    polling.value = false
  }
}

function startPolling(): void {
  stopPolling()
  onboardingTimer = setInterval(() => { void pollOnboarding() }, 2_000)
}

async function handleRefresh(): Promise<void> {
  try {
    await store.refresh()
  } catch {
    message.error(t('pages.channels.personalWechat.messages.loadFailed'))
  }
}

function openOnboarding(): void {
  if (!props.canManage || !store.pluginReady) return
  if (store.onboarding && isPersonalWechatOnboardingTerminal(store.onboarding.status)) store.clearOnboarding()
  verificationCode.value = ''
  notifiedTerminalSessionId.value = null
  modalVisible.value = true
}

async function handleStartOnboarding(): Promise<void> {
  if (!displayName.value.trim()) {
    message.warning(t('pages.channels.personalWechat.form.nameRequired'))
    return
  }
  try {
    const session = await store.startOnboarding({
      displayName: displayName.value,
      note: note.value,
    })
    if (isPersonalWechatOnboardingTerminal(session.status)) await handleTerminalStatus(session)
    else startPolling()
  } catch {
    message.error(t('pages.channels.personalWechat.messages.startFailed'))
  }
}

async function handleVerify(): Promise<void> {
  if (!verificationCode.value.trim()) {
    message.warning(t('pages.channels.personalWechat.verification.required'))
    return
  }
  try {
    const session = await store.verifyOnboarding(verificationCode.value)
    verificationCode.value = ''
    if (isPersonalWechatOnboardingTerminal(session.status)) await handleTerminalStatus(session)
    else startPolling()
  } catch {
    message.error(t('pages.channels.personalWechat.messages.verifyFailed'))
  }
}

async function handleCancelOnboarding(): Promise<void> {
  try {
    if (onboardingActive.value) await store.cancelOnboarding()
    else store.clearOnboarding()
    stopPolling()
    modalVisible.value = false
    message.info(t('pages.channels.personalWechat.messages.cancelled'))
  } catch {
    message.error(t('pages.channels.personalWechat.messages.cancelFailed'))
  }
}

function resetOnboardingForm(): void {
  stopPolling()
  store.clearOnboarding()
  displayName.value = ''
  note.value = ''
  verificationCode.value = ''
  notifiedTerminalSessionId.value = null
}

function closeTerminalOnboarding(): void {
  resetOnboardingForm()
  modalVisible.value = false
}

async function handleSetEnabled(account: PersonalWechatAccount, enabled: boolean): Promise<void> {
  try {
    await store.setAccountEnabled(account.accountId, enabled)
    message.success(enabled
      ? t('pages.channels.personalWechat.messages.enabled', { name: account.displayName })
      : t('pages.channels.personalWechat.messages.disabled', { name: account.displayName }))
  } catch {
    message.error(t('pages.channels.personalWechat.messages.updateFailed'))
  }
}

async function handleDelete(account: PersonalWechatAccount): Promise<void> {
  try {
    await store.deleteAccount(account.accountId)
    message.success(t('pages.channels.personalWechat.messages.deleted', { name: account.displayName }))
  } catch {
    message.error(t('pages.channels.personalWechat.messages.deleteFailed'))
  }
}

function accountStatusType(status: PersonalWechatAccountStatus): 'success' | 'warning' | 'error' | 'default' {
  if (status === 'online') return 'success'
  if (status === 'offline' || status === 'disabled') return 'warning'
  if (status === 'error') return 'error'
  return 'default'
}

function onboardingAlertType(): 'success' | 'warning' | 'error' | 'info' {
  const status = store.onboarding?.status
  if (status === 'success') return 'success'
  if (status === 'expired' || status === 'verification_required') return 'warning'
  if (status === 'failed') return 'error'
  return 'info'
}

function formatExpiry(value?: number): string {
  if (!value) return ''
  return new Date(value).toLocaleTimeString()
}

onMounted(() => { void handleRefresh() })
onUnmounted(stopPolling)
</script>

<template>
  <NCard class="personal-wechat-card">
    <template #header>
      <div class="personal-wechat-header">
        <span class="personal-wechat-brand"><FontAwesomeIcon :icon="faWeixin" /></span>
        <div>
          <div class="personal-wechat-title">{{ t('pages.channels.personalWechat.title') }}</div>
          <NText depth="3" class="personal-wechat-subtitle">
            {{ t('pages.channels.personalWechat.subtitle') }}
          </NText>
        </div>
      </div>
    </template>
    <template #header-extra>
      <NSpace :size="8">
        <NTag :type="pluginTagType" :bordered="false">{{ pluginStatusLabel }}</NTag>
        <NButton size="small" :loading="store.loading" @click="handleRefresh">
          <template #icon><NIcon :component="RefreshOutline" /></template>
          {{ t('common.refresh') }}
        </NButton>
        <NButton
          v-if="canManage"
          type="primary"
          size="small"
          :disabled="!store.pluginReady || onboardingActive"
          :title="!canManage ? readOnlyHint : undefined"
          @click="openOnboarding"
        >
          <template #icon><NIcon :component="AddOutline" /></template>
          {{ t('pages.channels.personalWechat.add') }}
        </NButton>
      </NSpace>
    </template>

    <NSpace vertical :size="12">
      <NAlert v-if="store.lastError" type="error" :bordered="false">
        {{ store.lastError }}
      </NAlert>
      <NAlert v-if="!store.plugin.installed" type="warning" :bordered="false">
        {{ t('pages.channels.personalWechat.plugin.notInstalledHint') }}
      </NAlert>
      <NAlert v-else-if="!store.plugin.available" type="warning" :bordered="false">
        {{ t('pages.channels.personalWechat.plugin.unavailableHint') }}
        <template v-if="store.plugin.reasonCode">（{{ store.plugin.reasonCode }}）</template>
      </NAlert>
      <NAlert v-else type="info" :bordered="false">
        {{ t('pages.channels.personalWechat.securityHint') }}
      </NAlert>

      <NSpin :show="store.loading">
        <NEmpty
          v-if="store.accounts.length === 0"
          :description="store.pluginReady
            ? t('pages.channels.personalWechat.empty.ready')
            : t('pages.channels.personalWechat.empty.unavailable')"
          class="personal-wechat-empty"
        />
        <div v-else class="personal-wechat-account-list">
          <NCard
            v-for="account in store.accounts"
            :key="account.accountId"
            size="small"
            embedded
            class="personal-wechat-account"
          >
            <div class="personal-wechat-account-main">
              <div class="personal-wechat-account-info">
                <NSpace align="center" :size="8" class="personal-wechat-account-heading">
                  <NText strong>{{ account.displayName }}</NText>
                  <NTag :type="accountStatusType(account.status)" size="small" :bordered="false">
                    {{ t(`pages.channels.personalWechat.accountStatus.${account.status}`) }}
                  </NTag>
                </NSpace>
                <div class="personal-wechat-account-meta">
                  <span v-if="account.nickname">
                    {{ t('pages.channels.personalWechat.labels.nickname') }}：{{ account.nickname }}
                  </span>
                  <span>
                    {{ t('pages.channels.personalWechat.labels.identifier') }}：<code>{{ account.wechatIdentifier }}</code>
                  </span>
                  <span v-if="account.note">
                    {{ t('pages.channels.personalWechat.labels.note') }}：{{ account.note }}
                  </span>
                  <span v-if="account.errorCode" class="personal-wechat-error-code">
                    {{ t('pages.channels.personalWechat.labels.errorCode') }}：{{ account.errorCode }}
                  </span>
                </div>
              </div>

              <NSpace v-if="canManage" :size="8" class="personal-wechat-account-actions">
                <NButton
                  v-if="account.enabled"
                  size="small"
                  :loading="store.operationAccountId === account.accountId"
                  @click="handleSetEnabled(account, false)"
                >
                  <template #icon><NIcon :component="PauseOutline" /></template>
                  {{ t('pages.channels.personalWechat.actions.disable') }}
                </NButton>
                <NButton
                  v-else
                  size="small"
                  type="primary"
                  :loading="store.operationAccountId === account.accountId"
                  @click="handleSetEnabled(account, true)"
                >
                  <template #icon><NIcon :component="PlayOutline" /></template>
                  {{ t('pages.channels.personalWechat.actions.enable') }}
                </NButton>
                <NPopconfirm @positive-click="handleDelete(account)">
                  <template #trigger>
                    <NButton
                      size="small"
                      type="error"
                      ghost
                      :loading="store.operationAccountId === account.accountId"
                    >
                      <template #icon><NIcon :component="TrashOutline" /></template>
                      {{ t('common.delete') }}
                    </NButton>
                  </template>
                  {{ t('pages.channels.personalWechat.deleteConfirm', { name: account.displayName }) }}
                </NPopconfirm>
              </NSpace>
            </div>
          </NCard>
        </div>
      </NSpin>
    </NSpace>
  </NCard>

  <NModal v-model:show="modalVisible" :mask-closable="false" :close-on-esc="false">
    <NCard
      class="personal-wechat-modal"
      :title="t('pages.channels.personalWechat.onboarding.title')"
      role="dialog"
      aria-modal="true"
    >
      <NSpace vertical :size="14">
        <NAlert type="info" :bordered="false">
          {{ t('pages.channels.personalWechat.onboarding.intro') }}
        </NAlert>

        <NForm v-if="!store.onboarding" label-placement="top">
          <NFormItem
            :label="t('pages.channels.personalWechat.form.displayName')"
            required
            :validation-status="displayName.trim() ? undefined : 'warning'"
          >
            <NInput
              v-model:value="displayName"
              :maxlength="64"
              :placeholder="t('pages.channels.personalWechat.form.displayNamePlaceholder')"
            />
          </NFormItem>
          <NFormItem :label="t('pages.channels.personalWechat.form.note')">
            <NInput
              v-model:value="note"
              type="textarea"
              :maxlength="500"
              :autosize="{ minRows: 2, maxRows: 5 }"
              :placeholder="t('pages.channels.personalWechat.form.notePlaceholder')"
            />
          </NFormItem>
          <NSpace justify="end">
            <NButton @click="modalVisible = false">{{ t('common.cancel') }}</NButton>
            <NButton
              type="primary"
              :loading="store.mutating"
              :disabled="!displayName.trim()"
              @click="handleStartOnboarding"
            >
              {{ t('pages.channels.personalWechat.onboarding.generateQr') }}
            </NButton>
          </NSpace>
        </NForm>

        <template v-else>
          <NAlert :type="onboardingAlertType()" :bordered="false">
            {{ t(`pages.channels.personalWechat.onboarding.status.${store.onboarding.status}`) }}
            <template v-if="store.onboarding.errorCode">（{{ store.onboarding.errorCode }}）</template>
          </NAlert>

          <div v-if="qrSource && ['waiting_for_scan', 'starting'].includes(store.onboarding.status)" class="personal-wechat-qr-wrap">
            <img
              class="personal-wechat-qr"
              :src="qrSource"
              :alt="t('pages.channels.personalWechat.onboarding.qrAlt')"
              referrerpolicy="no-referrer"
            />
            <NText v-if="store.onboarding.expiresAt" depth="3">
              {{ t('pages.channels.personalWechat.onboarding.expiresAt', { time: formatExpiry(store.onboarding.expiresAt) }) }}
            </NText>
          </div>
          <NAlert
            v-else-if="store.onboarding.qrDataUrl && ['waiting_for_scan', 'starting'].includes(store.onboarding.status)"
            type="error"
            :bordered="false"
          >
            {{ t('pages.channels.personalWechat.onboarding.unsafeQr') }}
          </NAlert>

          <NForm v-if="store.onboarding.status === 'verification_required'" label-placement="top">
            <NFormItem :label="t('pages.channels.personalWechat.verification.label')" required>
              <NInput
                v-model:value="verificationCode"
                :maxlength="12"
                inputmode="numeric"
                autocomplete="one-time-code"
                :placeholder="t('pages.channels.personalWechat.verification.placeholder')"
                @keyup.enter="handleVerify"
              />
            </NFormItem>
            <NButton type="primary" :loading="store.mutating" @click="handleVerify">
              {{ t('pages.channels.personalWechat.verification.submit') }}
            </NButton>
          </NForm>

          <NCard v-if="store.onboarding.status === 'success'" size="small" embedded>
            <NSpace vertical :size="6">
              <NText strong>{{ store.onboarding.displayName }}</NText>
              <NText v-if="store.onboarding.nickname" depth="3">
                {{ t('pages.channels.personalWechat.labels.nickname') }}：{{ store.onboarding.nickname }}
              </NText>
              <NText v-if="store.onboarding.wechatIdentifier || store.onboarding.accountId" depth="3">
                {{ t('pages.channels.personalWechat.labels.identifier') }}：{{ store.onboarding.wechatIdentifier || store.onboarding.accountId }}
              </NText>
            </NSpace>
          </NCard>

          <NSpace justify="end">
            <NButton
              v-if="onboardingActive"
              :loading="store.mutating"
              @click="handleCancelOnboarding"
            >
              {{ t('pages.channels.personalWechat.onboarding.cancelSession') }}
            </NButton>
            <template v-else>
              <NButton @click="closeTerminalOnboarding">{{ t('common.close') }}</NButton>
              <NButton
                v-if="store.onboarding.status !== 'success'"
                type="primary"
                @click="resetOnboardingForm"
              >
                {{ t('pages.channels.personalWechat.onboarding.tryAgain') }}
              </NButton>
            </template>
          </NSpace>
        </template>
      </NSpace>
    </NCard>
  </NModal>
</template>

<style scoped>
.personal-wechat-card {
  --wechat-card-border: var(--border-color);
  --wechat-card-bg: var(--bg-card);
  --wechat-soft-bg: var(--bg-secondary);
  --wechat-text: var(--text-primary);
  --wechat-muted: var(--text-secondary);
  border: 1px solid var(--wechat-card-border);
  border-radius: 18px;
  background: var(--wechat-card-bg);
  box-shadow: var(--shadow-sm);
}

.personal-wechat-header {
  display: flex;
  align-items: center;
  gap: 12px;
}

.personal-wechat-brand {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  flex: 0 0 38px;
  border-radius: 12px;
  color: #fff;
  font-size: 20px;
  background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%);
  box-shadow: 0 8px 16px rgba(22, 163, 74, 0.24);
}

.personal-wechat-title {
  color: var(--wechat-text);
  font-size: 18px;
  font-weight: 700;
  line-height: 1.35;
}

.personal-wechat-subtitle {
  display: block;
  margin-top: 2px;
}

.personal-wechat-empty {
  padding: 28px 12px;
  border: 1px dashed var(--wechat-card-border);
  border-radius: 12px;
  background: var(--wechat-soft-bg);
}

.personal-wechat-account-list {
  display: grid;
  gap: 10px;
}

.personal-wechat-account {
  border-color: var(--wechat-card-border);
  background: var(--wechat-soft-bg);
}

.personal-wechat-account-main {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.personal-wechat-account-info {
  min-width: 0;
}

.personal-wechat-account-heading {
  flex-wrap: wrap;
}

.personal-wechat-account-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 16px;
  margin-top: 8px;
  color: var(--wechat-muted);
  font-size: 13px;
  line-height: 1.6;
}

.personal-wechat-account-meta code {
  padding: 1px 5px;
  border: 1px solid var(--wechat-card-border);
  border-radius: 5px;
  background: var(--bg-primary);
  color: var(--wechat-text);
  overflow-wrap: anywhere;
}

.personal-wechat-error-code {
  color: #d03050;
}

.personal-wechat-account-actions {
  flex: 0 0 auto;
}

.personal-wechat-modal {
  width: min(520px, calc(100vw - 32px));
  max-height: calc(100vh - 48px);
  overflow: auto;
  border-radius: 16px;
}

.personal-wechat-qr-wrap {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.personal-wechat-qr {
  display: block;
  width: 280px;
  max-width: 100%;
  aspect-ratio: 1;
  object-fit: contain;
  border: 1px solid var(--wechat-card-border);
  border-radius: 10px;
  background: #fff;
  padding: 10px;
}

@media (max-width: 720px) {
  .personal-wechat-account-main {
    align-items: flex-start;
    flex-direction: column;
  }

  .personal-wechat-account-actions {
    width: 100%;
  }
}
</style>
