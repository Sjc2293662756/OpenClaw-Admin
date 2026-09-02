<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { NAlert, NButton, NFormItem, NSelect } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useChatDisplayPreferencesStore } from '@/stores/chat-display-preferences'

const displayPreferences = useChatDisplayPreferencesStore()
const { locale } = useI18n()
const text = (zhCN: string, enUS: string) => locale.value === 'zh-CN' ? zhCN : enUS

const preferenceOptions = computed(() => ([
  { label: text('显示过程与结果', 'Show process and results'), value: 'process-and-results' },
  { label: text('仅显示对话结果', 'Show conversation results only'), value: 'results-only' },
]))

const selectedPreference = computed(() => (
  displayPreferences.preferences.showThinkingProcess ? 'process-and-results' : 'results-only'
))

async function updatePreference(value: string | number | null) {
  const showThinkingProcess = value === 'process-and-results'
    ? true
    : value === 'results-only'
      ? false
      : null
  if (showThinkingProcess === null) return
  try {
    await displayPreferences.savePreferences(showThinkingProcess)
  } catch {
    // The store keeps the last persisted value and exposes a retryable error.
  }
}

onMounted(() => {
  if (displayPreferences.activeAccount && !displayPreferences.preferencesReady) {
    void displayPreferences.loadPreferences()
  }
})
</script>

<template>
  <NAlert v-if="displayPreferences.preferencesLoadError" type="warning" :bordered="false" class="chat-display-preferences__message">
    {{ text('暂时无法读取已保存设置，当前按默认开启显示；请重试。', 'Saved settings could not be loaded. Process display remains on by default; please retry.') }}
  </NAlert>
  <NButton
    v-if="displayPreferences.preferencesLoadError"
    size="small"
    class="chat-display-preferences__retry"
    :loading="displayPreferences.preferencesLoading"
    @click="displayPreferences.retryPreferences()"
  >
    {{ text('重试', 'Retry') }}
  </NButton>
  <NAlert v-if="displayPreferences.preferencesSaveError" type="error" :bordered="false" class="chat-display-preferences__message">
    {{ text('设置未保存，仍保留上一次已保存的选择。', 'The setting was not saved. The last saved choice is still active.') }}
  </NAlert>
  <NFormItem :label="text('显示思考过程', 'Show thinking process')">
    <NSelect
      :value="selectedPreference"
      :options="preferenceOptions"
      :loading="displayPreferences.preferencesSaving"
      :disabled="displayPreferences.preferencesLoading || !displayPreferences.activeAccount"
      :aria-label="text('显示思考过程', 'Show thinking process')"
      @update:value="updatePreference"
    />
  </NFormItem>
</template>

<style scoped>
.chat-display-preferences__message { margin-bottom: 12px; }
.chat-display-preferences__retry { margin: -4px 0 12px; }
</style>
