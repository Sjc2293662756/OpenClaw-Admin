<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NAlert, NCard, NForm, NFormItem, NSelect, NSpace, NText, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { useLocaleStore } from '@/stores/locale'
import { useThemeStore, type ThemeMode } from '@/stores/theme'
import type { AppLocale } from '@/i18n/locale'
import SessionManagementPage from './SessionManagementPage.vue'

const authStore = useAuthStore()
const localeStore = useLocaleStore()
const themeStore = useThemeStore()
const { t, locale } = useI18n()
const message = useMessage()
const text = (zhCN: string, enUS: string) => locale.value === 'zh-CN' ? zhCN : enUS
const reportStorageConfigured = ref(false)
const reportStorageRoot = ref('')
const reportStorageLoading = ref(false)
const reportStorageError = ref(false)

const themeOptions = computed(() => ([
  { label: t('pages.settings.themeLight'), value: 'light' },
  { label: t('pages.settings.themeDark'), value: 'dark' },
]))

const localeOptions = computed(() => ([
  { label: t('common.languageZh'), value: 'zh-CN' },
  { label: t('common.languageEn'), value: 'en-US' },
]))

function handleThemeChange(mode: ThemeMode) {
  themeStore.setMode(mode)
}

function handleLocaleChange(locale: string) {
  if (locale === 'zh-CN' || locale === 'en-US') {
    localeStore.setLocale(locale as AppLocale)
  }
}

async function loadReportStorageStatus() {
  if (!authStore.isAdmin) return
  reportStorageLoading.value = true
  reportStorageError.value = false
  try {
    const response = await fetch('/api/system-settings/report-storage', {
      headers: { Authorization: `Bearer ${authStore.getToken() || ''}` },
    })
    const contentType = response.headers.get('content-type') || ''
    if (!contentType.includes('application/json')) {
      throw new Error(text('Admin BFF 尚未加载报告存储状态接口，请重启本地 Admin BFF 后重试', 'The Admin BFF has not loaded the report-storage status API. Restart the local Admin BFF and try again.'))
    }
    const data = await response.json()
    if (
      !response.ok
      || !data.ok
      || typeof data.reportStorageConfigured !== 'boolean'
      || typeof data.reportStorageRoot !== 'string'
      || !data.reportStorageRoot.trim()
    ) {
      throw new Error(data.error?.message || data.error || text('读取报告存储状态失败', 'Failed to load report-storage status'))
    }
    reportStorageConfigured.value = data.reportStorageConfigured
    reportStorageRoot.value = data.reportStorageRoot
  } catch (error) {
    reportStorageError.value = true
    message.error(error instanceof Error ? error.message : text('读取报告存储状态失败', 'Failed to load report-storage status'))
  } finally {
    reportStorageLoading.value = false
  }
}

onMounted(loadReportStorageStatus)
</script>

<template>
  <NSpace vertical :size="16">
    <NCard :title="text('基本信息', 'Basic information')" class="app-card">
      <NText strong style="font-size: 18px;">观枢 GAIOP</NText>
      <NText depth="3" style="display: block; margin-top: 8px;">{{ text('当前产品版本：v1', 'Current product version: v1') }}</NText>
      <NText depth="3" style="display: block; margin-top: 12px;">{{ text('系统设置仅维护平台使用策略；NAPM 连接信息请在数据源管理中维护。', 'System settings maintain platform usage policies only. Maintain NAPM connection details in Data Source Management.') }}</NText>
    </NCard>

    <section id="session-settings">
      <SessionManagementPage />
    </section>

    <NCard :title="text('报告存储', 'Report storage')" class="app-card">
      <NAlert type="info" :bordered="false">{{ text('以下为正式报告的真实存储路径，由部署配置只读控制，不能在网页中修改。报告的查看、筛选、下载与删除请在“报告文件管理”页面进行。', 'The path below is the real storage location for formal reports. Deployment configuration controls it as read-only and it cannot be changed in the browser. View, filter, download, and delete reports in Report Management.') }}</NAlert>
      <NForm v-if="authStore.isAdmin" label-placement="left" label-width="150" style="max-width: 760px; margin-top: 16px;">
        <NFormItem :label="text('真实存储路径', 'Actual storage path')">
          <NText :type="reportStorageConfigured ? 'success' : 'warning'">{{ reportStorageLoading ? text('正在读取…', 'Loading…') : reportStorageRoot }}</NText>
        </NFormItem>
      </NForm>
      <NAlert v-else type="warning" :bordered="false" style="margin-top: 16px;">{{ text('仅管理员可查看报告真实存储路径。', 'Only administrators can view the actual report storage path.') }}</NAlert>
      <NAlert v-if="reportStorageError && authStore.isAdmin" type="warning" :bordered="false" style="margin-top: 12px;">{{ text('暂时无法读取报告存储状态，请确认 Admin BFF 已启动并完成部署配置。', 'Report-storage status is temporarily unavailable. Confirm that the Admin BFF is running and deployment configuration is complete.') }}</NAlert>
    </NCard>

    <NCard :title="text('界面偏好', 'Interface preferences')" class="app-card">
      <NForm label-placement="left" label-width="120" style="max-width: 500px;">
        <NFormItem :label="t('pages.settings.interfaceLanguage')">
          <NSelect
            :value="localeStore.locale"
            :options="localeOptions"
            @update:value="handleLocaleChange"
          />
        </NFormItem>
        <NFormItem :label="t('pages.settings.themeMode')">
          <NSelect
            :value="themeStore.mode"
            :options="themeOptions"
            @update:value="handleThemeChange"
          />
        </NFormItem>
      </NForm>
    </NCard>
  </NSpace>
</template>
