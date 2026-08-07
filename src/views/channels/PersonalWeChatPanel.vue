<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
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
  NSwitch,
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
  active: boolean
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
const launchEnabled = ref<boolean | null>(null)
const launchDraft = ref(false)
const launchSaving = ref(false)
let onboardingTimer: ReturnType<typeof setInterval> | null = null
let statusTimer: ReturnType<typeof setInterval> | null = null

const qrSource = computed(() => normalizePersonalWechatQrSource(store.onboarding?.qrDataUrl))
const onboardingActive = computed(() => {
  const status = store.onboarding?.status
  return !!status && !isPersonalWechatOnboardingTerminal(status)
})

function stopPolling(): void {
  if (onboardingTimer) clearInterval(onboardingTimer)
  onboardingTimer = null
}

function stopStatusPolling(): void {
  if (statusTimer) clearInterval(statusTimer)
  statusTimer = null
}

function startStatusPolling(): void {
  stopStatusPolling()
  if (!props.active) return
  statusTimer = setInterval(() => {
    if (store.loading || store.mutating) return
    void store.refresh().catch(() => {})
  }, 20_000)
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

async function handleSaveLaunch(): Promise<void> {
  if (launchSaving.value || launchEnabled.value === null) return
  const previous = launchEnabled.value
  const target = launchDraft.value
  launchSaving.value = true
  try {
    await store.setChannelEnabled(target)
    launchEnabled.value = target
    message.success(target
      ? t('pages.channels.personalWechat.messages.launchEnabled')
      : t('pages.channels.personalWechat.messages.launchDisabled'))
  } catch {
    launchDraft.value = previous
    message.error(t('pages.channels.personalWechat.messages.launchFailed'))
  } finally {
    launchSaving.value = false
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

watch(
  () => store.channel.enabled,
  (enabled) => {
    if (enabled === null || launchSaving.value) return
    launchEnabled.value = enabled
    launchDraft.value = enabled
  },
  { immediate: true },
)

watch(
  () => props.active,
  (active) => {
    if (active) startStatusPolling()
    else stopStatusPolling()
  },
  { immediate: true },
)

onUnmounted(() => { stopStatusPolling(); stopPolling() })
</script>

<template>
  <NSpace vertical :size="10">
          <div class="channel-desc-panel">
            <span>{{ t('pages.channels.personalWechat.subtitle') }}</span>
          </div>

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

          <NCard size="small" :title="t('pages.channels.basicConfigTitle')" embedded>
            <template #header-extra>
              <NButton
                size="small"
                type="primary"
                :loading="launchSaving"
                :disabled="!canManage || launchEnabled === null"
                :title="!canManage ? readOnlyHint : undefined"
                @click="handleSaveLaunch"
              >
                {{ t('common.save') }}
              </NButton>
            </template>
            <NForm label-placement="left" label-width="140" class="channel-config-form">
              <NFormItem :label="t('pages.channels.personalWechat.launchChannel')">
                <NSwitch
                  :value="launchDraft"
                  :disabled="!canManage || launchEnabled === null"
                  :title="!canManage ? readOnlyHint : undefined"
                  @update:value="(value) => { launchDraft = value }"
                />
              </NFormItem>
            </NForm>
            <NAlert type="info" :bordered="false" style="margin-top: 12px;">
              {{ t('pages.channels.personalWechat.privateChatScopeHint') }}
            </NAlert>
          </NCard>

          <NCard size="small" :title="t('pages.channels.personalWechat.manageTitle')" embedded>
            <template #header-extra>
              <NButton size="small" :loading="store.loading" @click="handleRefresh">
                <template #icon><NIcon :component="RefreshOutline" /></template>
                {{ t('common.refresh') }}
              </NButton>
              <NButton
                v-if="canManage"
                size="small"
                type="primary"
                :disabled="!store.pluginReady || onboardingActive"
                :title="!canManage ? readOnlyHint : undefined"
                @click="openOnboarding"
              >
                <template #icon><NIcon :component="AddOutline" /></template>
                {{ t('pages.channels.personalWechat.add') }}
              </NButton>
            </template>

            <NAlert type="info" :bordered="false" style="margin-bottom: 12px;">
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
          </NCard>
  </NSpace>

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
              v-if="!isPersonalWechatOnboardingTerminal(store.onboarding.status)"
              @click="handleCancelOnboarding"
            >
              {{ t('pages.channels.personalWechat.onboarding.cancelSession') }}
            </NButton>
            <NButton
              v-else
              type="primary"
              @click="closeTerminalOnboarding"
            >
              {{ t('common.close') }}
            </NButton>
          </NSpace>
        </template>
      </NSpace>
    </NCard>
  </NModal>
</template>

<style scoped>
:deep(.n-card.n-card--embedded) {
  background: var(--bg-secondary);
  color: var(--text-primary);
  border-color: var(--border-color);
}

:deep(.channel-config-form .n-form-item) {
  margin-bottom: 10px;
}

:deep(.channel-config-form .n-form-item:last-child) {
  margin-bottom: 0;
}

:deep(code) {
  border-radius: 6px;
  border: 1px solid var(--border-color);
  background: var(--bg-primary);
  color: var(--text-primary);
  padding: 2px 6px;
}

.channel-desc-panel {
  border: 1px solid rgba(32, 128, 240, 0.24);
  border-radius: 10px;
  background:
    linear-gradient(135deg, rgba(32, 128, 240, 0.11), rgba(32, 128, 240, 0.05)),
    var(--bg-secondary);
  color: var(--text-primary);
  padding: 10px 12px;
  display: flex;
  align-items: center;
  gap: 12px;
  justify-content: space-between;
  flex-wrap: wrap;
}

.personal-wechat-account-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.personal-wechat-account-main {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.personal-wechat-account-info {
  min-width: 0;
}

.personal-wechat-account-heading {
  flex-wrap: wrap;
}

.personal-wechat-account-meta {
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin-top: 6px;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.5;
}

.personal-wechat-error-code {
  color: #d03050;
}

.personal-wechat-account-actions {
  flex-shrink: 0;
  flex-wrap: wrap;
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
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: white;
  padding: 8px;
}

@media (max-width: 640px) {
  .channel-desc-panel {
    align-items: flex-start;
    flex-direction: column;
  }

}
</style>
