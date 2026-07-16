<script setup lang="ts">
import { h, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NMenu, NText } from 'naive-ui'
import type { MenuOption } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import {
  GridOutline,
  ChatboxEllipsesOutline,
  ChatbubblesOutline,
  BookOutline,
  CalendarOutline,
  SparklesOutline,
  GitNetworkOutline,
  ExtensionPuzzleOutline,
  CogOutline,
  PulseOutline,
  FolderOutline,
  PeopleOutline,
  BusinessOutline,
  StorefrontOutline,
  ConstructOutline,
  TerminalOutline,
  DesktopOutline,
  ArchiveOutline,
  NotificationsOutline,
  ShieldCheckmarkOutline,
  SettingsOutline,
  CodeSlashOutline,
  DocumentTextOutline,
} from '@vicons/ionicons5'
import { NIcon } from 'naive-ui'
import { routes } from '@/router/routes'

defineProps<{ collapsed: boolean }>()

const route = useRoute()
const router = useRouter()
const { t } = useI18n()

const iconMap: Record<string, unknown> = {
  GridOutline,
  ChatboxEllipsesOutline,
  ChatbubblesOutline,
  BookOutline,
  CalendarOutline,
  SparklesOutline,
  GitNetworkOutline,
  ExtensionPuzzleOutline,
  CogOutline,
  PulseOutline,
  FolderOutline,
  PeopleOutline,
  BusinessOutline,
  StorefrontOutline,
  ConstructOutline,
  TerminalOutline,
  DesktopOutline,
  ArchiveOutline,
  NotificationsOutline,
  ShieldCheckmarkOutline,
  SettingsOutline,
  CodeSlashOutline,
  DocumentTextOutline,
}

function renderIcon(iconName: string) {
  const icon = iconMap[iconName]
  if (!icon) return undefined
  return () => h(NIcon, null, { default: () => h(icon as any) })
}

const menuOptions = computed<MenuOption[]>(() => {
  const mainRoute = routes.find((r) => r.path === '/')
  if (!mainRoute?.children) return []

  return mainRoute.children
    .filter((child) => {
      if (child.meta?.hidden) return false
      return true
    })
    .map((child) => ({
      label: child.meta?.titleKey ? t(child.meta.titleKey as string) : (child.meta?.title as string),
      key: child.name as string,
      icon: child.meta?.icon ? renderIcon(child.meta.icon as string) : undefined,
    }))
})

const activeKey = computed(() => {
  return route.name as string
})

function handleSelect(key: string) {
  router.push({ name: key })
}
</script>

<template>
  <div style="display: flex; flex-direction: column; height: 100%;">
    <div class="sidebar-brand">
      <span class="sidebar-brand-mark">G</span>
      <NText
        v-if="!collapsed"
        strong
        class="sidebar-brand-name"
      >
        观枢 GAIOP
      </NText>
    </div>

    <NMenu
      :value="activeKey"
      :collapsed="collapsed"
      :collapsed-width="64"
      :collapsed-icon-size="20"
      :options="menuOptions"
      :indent="24"
      @update:value="handleSelect"
    />
  </div>
</template>

<style scoped>
.sidebar-brand {
  display: flex;
  align-items: center;
  min-height: 64px;
  padding: 0 24px;
  gap: 10px;
}

.sidebar-brand-mark {
  display: grid;
  width: 26px;
  height: 26px;
  place-items: center;
  border-radius: 9px;
  background: linear-gradient(135deg, #0b7552, #31a66e);
  color: #fff;
  font-size: 15px;
  font-weight: 700;
}

.sidebar-brand-name {
  color: #174d38;
  font-size: 18px;
  letter-spacing: -0.5px;
  white-space: nowrap;
}
</style>
