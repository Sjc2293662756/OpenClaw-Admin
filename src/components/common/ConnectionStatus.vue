<script setup lang="ts">
import { computed } from 'vue'
import { NTag } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { ConnectionState } from '@/api/types'
import { useWebSocketStore } from '@/stores/websocket'

const { t } = useI18n()
const wsStore = useWebSocketStore()

const status = computed(() => {
  switch (wsStore.state) {
    case ConnectionState.CONNECTED:
      return { label: t('components.connectionStatus.connected'), type: 'success' as const }
    case ConnectionState.CONNECTING:
      return { label: t('components.connectionStatus.connecting'), type: 'info' as const }
    case ConnectionState.RECONNECTING:
      return { label: t('components.connectionStatus.reconnecting'), type: 'warning' as const }
    case ConnectionState.FAILED:
      return { label: t('components.connectionStatus.failed'), type: 'error' as const }
    default:
      return { label: t('components.connectionStatus.disconnected'), type: 'error' as const }
  }
})
</script>

<template>
  <NTag :type="status.type" round size="small" :bordered="false">
    <template #icon>
      <span
        class="status-dot"
        :class="`status-dot--${status.type}`"
      />
    </template>
    {{ status.label }}
  </NTag>
</template>

<style scoped>
.status-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  margin-right: 4px;
  border-radius: 50%;
  background: #8095a5;
}

.status-dot--success { background: #18a058; }
.status-dot--warning { background: #f0a020; }
.status-dot--error { background: #d03050; }
.status-dot--info { background: #2080f0; }
</style>
