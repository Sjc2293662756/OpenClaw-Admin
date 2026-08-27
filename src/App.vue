<script setup lang="ts">
import { computed, onMounted, onUnmounted, watch } from "vue";
import { useRoute } from "vue-router";
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
import { useAlertRealtimeStore } from '@/stores/alert-realtime'
import { createGlobalSseLifecycle } from '@/realtime/global-sse-lifecycle'
import AlertNotificationHost from '@/components/alerts/AlertNotificationHost.vue'

const { theme, mode } = useTheme();
const route = useRoute();
const localeStore = useLocaleStore();
const { t } = useI18n();
const authStore = useAuthStore()
const websocketStore = useWebSocketStore()
const alertRealtimeStore = useAlertRealtimeStore()
const globalSseLifecycle = createGlobalSseLifecycle(websocketStore, alertRealtimeStore)
const appTitle = computed(() => t('app.title'));
const lightOnlyRoute = computed(() => route.meta.lightOnly === true);
const activeTheme = computed(() => (lightOnlyRoute.value ? null : theme.value));

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
  },
  { immediate: true },
)

onMounted(() => {
  window.addEventListener('beforeunload', websocketStore.disconnect)
})

onUnmounted(() => {
  window.removeEventListener('beforeunload', websocketStore.disconnect)
  globalSseLifecycle.dispose()
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
          <AlertNotificationHost />
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
