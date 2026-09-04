<script setup lang="ts">
import { computed, onMounted, onUnmounted, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  NConfigProvider,
  NMessageProvider,
  NDialogProvider,
  NNotificationProvider,
  zhCN,
  enUS,
  dateZhCN,
  dateEnUS,
} from "naive-ui";
import { useI18n } from "vue-i18n";
import { useTheme } from "@/composables/useTheme";
import { useLocaleStore } from "@/stores/locale";
import { useAuthStore } from '@/stores/auth'
import { useWebSocketStore } from '@/stores/websocket'
import { LOCAL_ALERT_SOUND_DEMO, useAlertRealtimeStore } from '@/stores/alert-realtime'
import { useChatDisplayPreferencesStore } from '@/stores/chat-display-preferences'
import { createGlobalSseLifecycle } from '@/realtime/global-sse-lifecycle'
import AlertNotificationHost from '@/components/alerts/AlertNotificationHost.vue'
import { primeAlertNotificationSound } from '@/alerts/notification-sound'
import { canAccessPage, canAccessRoute, getPageAccess } from '@/permissions/access-control'

const { theme, mode } = useTheme();
const route = useRoute();
const router = useRouter();
const localeStore = useLocaleStore();
const { t } = useI18n();
const authStore = useAuthStore()
const websocketStore = useWebSocketStore()
const alertRealtimeStore = useAlertRealtimeStore()
const chatDisplayPreferences = useChatDisplayPreferencesStore()
const globalSseLifecycle = createGlobalSseLifecycle(websocketStore, alertRealtimeStore)
const appTitle = computed(() => t('app.title'));
const lightOnlyRoute = computed(() => route.meta.lightOnly === true);
const activeTheme = computed(() => (lightOnlyRoute.value ? null : theme.value));
const canReceiveAlertNotifications = computed(() => LOCAL_ALERT_SOUND_DEMO || canAccessPage(
  authStore.currentUser?.effectiveModules,
  'alerts.notifications',
))
let permissionRefresh: Promise<void> | null = null

const unsubscribePermissionsChanged = websocketStore.subscribe('permissionsChanged', (payload: unknown) => {
  const event = payload as { userId?: string; permissionVersion?: number }
  if (String(event.userId || '') !== String(authStore.currentUser?.id || '')) return
  if (permissionRefresh) return
  permissionRefresh = (async () => {
    const valid = await authStore.checkAuth()
    if (!valid) {
      await router.replace({ name: 'Welcome', query: { redirect: route.fullPath } })
      return
    }
    if (route.name !== 'AccessDenied' && !canAccessRoute(authStore.currentUser?.effectiveModules, route.name)) {
      const access = getPageAccess(route.name)
      await router.replace({
        name: 'AccessDenied',
        query: { module: access?.moduleName || '当前模块', returnTo: '/workspace' },
      })
    }
  })().finally(() => { permissionRefresh = null })
})

const naiveLocale = computed(() =>
  localeStore.locale === "zh-CN" ? zhCN : enUS,
);
const naiveDateLocale = computed(() =>
  localeStore.locale === "zh-CN" ? dateZhCN : dateEnUS,
);

watch(
  () =>
    [route.meta.titleKey as string | undefined, localeStore.locale] as const,
  ([titleKey]) => {
    if (typeof document === "undefined") return;
    if (!titleKey) {
      document.title = appTitle.value;
      return;
    }
    const title = t(titleKey);
    document.title = `${title} - ${appTitle.value}`;
  },
  { immediate: true },
);

// The application shell owns the single authenticated browser SSE lifecycle.
// Route layouts and workspaces only observe the shared connection.
watch(
  () => [authStore.token, authStore.currentUser] as const,
  ([token, user]) => {
    globalSseLifecycle.sync(token, user)
    void chatDisplayPreferences.syncAccount(token ? user : null)
  },
  { immediate: true },
)

onMounted(() => {
  window.addEventListener('beforeunload', websocketStore.disconnect)
  window.addEventListener('pointerdown', primeAlertNotificationSound)
  window.addEventListener('keydown', primeAlertNotificationSound)
})

onUnmounted(() => {
  window.removeEventListener('beforeunload', websocketStore.disconnect)
  window.removeEventListener('pointerdown', primeAlertNotificationSound)
  window.removeEventListener('keydown', primeAlertNotificationSound)
  globalSseLifecycle.dispose()
  unsubscribePermissionsChanged()
})

watch(
  [lightOnlyRoute, mode],
  ([forceLight, selectedMode]) => {
    if (typeof document === "undefined") return;
    const effectiveMode = forceLight ? "light" : selectedMode;
    document.documentElement.setAttribute("data-theme", effectiveMode);
    document.documentElement.style.colorScheme = effectiveMode;
  },
  { immediate: true },
);
</script>

<template>
  <NConfigProvider
    :theme="activeTheme"
    :locale="naiveLocale"
    :date-locale="naiveDateLocale"
  >
    <NNotificationProvider :max="3">
      <NMessageProvider>
        <NDialogProvider>
          <AlertNotificationHost v-if="canReceiveAlertNotifications" />
          <RouterView />
        </NDialogProvider>
      </NMessageProvider>
    </NNotificationProvider>
  </NConfigProvider>
</template>

<style>
/* Keep alerts below each workspace header rule instead of covering its actions. */
.n-notification-container {
  top: calc(var(--header-height, 64px) + 12px) !important;
}
</style>
