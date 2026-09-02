<script setup lang="ts">
import { onMounted } from 'vue'
import { NAlert, NButton, NSwitch, NText } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useChatDisplayPreferencesStore } from '@/stores/chat-display-preferences'

const displayPreferences = useChatDisplayPreferencesStore()
const { locale } = useI18n()
const text = (zhCN: string, enUS: string) => locale.value === 'zh-CN' ? zhCN : enUS

async function updatePreference(value: boolean) {
  try {
    await displayPreferences.savePreferences(value)
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
  <section class="chat-display-preferences">
    <NAlert v-if="displayPreferences.preferencesLoadError" type="warning" :bordered="false">
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
    <NAlert v-if="displayPreferences.preferencesSaveError" type="error" :bordered="false">
      {{ text('设置未保存，仍保留上一次已保存的选择。', 'The setting was not saved. The last saved choice is still active.') }}
    </NAlert>

    <div class="chat-display-preferences__row">
      <div>
        <NText strong>{{ text('显示思考过程', 'Show thinking process') }}</NText>
        <NText depth="3">
          {{ text('显示思考、工具执行和回复状态；关闭后仅显示对话结果。流式输出始终开启。', 'Show thinking, tool execution, and reply status. When off, only conversation results are shown. Streaming always remains enabled.') }}
        </NText>
      </div>
      <NSwitch
        :value="displayPreferences.preferences.showThinkingProcess"
        :loading="displayPreferences.preferencesSaving"
        :disabled="displayPreferences.preferencesLoading || !displayPreferences.activeAccount"
        :aria-label="text('显示思考过程', 'Show thinking process')"
        @update:value="updatePreference"
      />
    </div>
  </section>
</template>

<style scoped>
.chat-display-preferences { display: grid; gap: 12px; }
.chat-display-preferences__retry { justify-self: start; margin-top: -4px; }
.chat-display-preferences__row { display: flex; align-items: center; justify-content: space-between; gap: 24px; padding: 8px 0; }
.chat-display-preferences__row :deep(.n-text--depth-3) { display: block; max-width: 620px; margin-top: 5px; line-height: 1.55; }
@media (max-width: 560px) {
  .chat-display-preferences__row { align-items: flex-start; gap: 14px; }
}
</style>
