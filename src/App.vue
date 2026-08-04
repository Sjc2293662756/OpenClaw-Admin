<script setup lang="ts">
import { computed, watch } from "vue";
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

const { theme, mode } = useTheme();
const route = useRoute();
const localeStore = useLocaleStore();
const { t } = useI18n();
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
    <NNotificationProvider>
      <NMessageProvider>
        <NDialogProvider>
          <RouterView />
        </NDialogProvider>
      </NMessageProvider>
    </NNotificationProvider>
  </NConfigProvider>
</template>
