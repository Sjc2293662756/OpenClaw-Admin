<script setup lang="ts">
import { computed } from 'vue'
import { NBadge, NButton, NIcon, NTooltip } from 'naive-ui'
import { NotificationsOutline } from '@vicons/ionicons5'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { useAlertRealtimeStore } from '@/stores/alert-realtime'
import { canAccessPage } from '@/permissions/access-control'

const { t } = useI18n()
const authStore = useAuthStore()
const alerts = useAlertRealtimeStore()
const visible = computed(() => canAccessPage(authStore.currentUser?.role, 'alerts'))
const badgeValue = computed<string | number | undefined>(() => alerts.unreadCount > 99 ? '99+' : alerts.unreadCount || undefined)
</script>

<template>
  <NTooltip v-if="visible">
    <template #trigger>
      <NBadge :value="badgeValue" :show-zero="false" :max="99">
        <NButton quaternary circle :aria-label="t('pages.gaiop.alertCenter.open')" @click="alerts.openMessageCenter">
          <template #icon><NIcon :component="NotificationsOutline" /></template>
        </NButton>
      </NBadge>
    </template>
    {{ t('pages.gaiop.alertCenter.open') }}
  </NTooltip>
</template>
