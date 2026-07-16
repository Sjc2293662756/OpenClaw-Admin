<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NAlert, NCard, NForm, NFormItem, NInput, NSelect, NSpace, NText, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { useLocaleStore } from '@/stores/locale'
import { useThemeStore, type ThemeMode } from '@/stores/theme'
import type { AppLocale } from '@/i18n/locale'
import SessionManagementPage from './SessionManagementPage.vue'

const authStore = useAuthStore()
const localeStore = useLocaleStore()
const themeStore = useThemeStore()
const { t } = useI18n()
const message = useMessage()
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

async function loadReportStorageRoot() {
  if (!authStore.isAdmin) return
  reportStorageLoading.value = true
  reportStorageError.value = false
  try {
    const response = await fetch('/api/system-settings/report-storage', {
      headers: { Authorization: `Bearer ${authStore.getToken() || ''}` },
    })
    const contentType = response.headers.get('content-type') || ''
    if (!contentType.includes('application/json')) {
      throw new Error('Admin BFF 尚未加载报告存储目录接口，请重启本地 Admin BFF 后重试')
    }
    const data = await response.json()
    if (!response.ok || !data.ok || typeof data.reportStorageRoot !== 'string') {
      throw new Error(data.error?.message || data.error || '读取报告存储目录失败')
    }
    reportStorageRoot.value = data.reportStorageRoot
  } catch (error) {
    reportStorageError.value = true
    message.error(error instanceof Error ? error.message : '读取报告存储目录失败')
  } finally {
    reportStorageLoading.value = false
  }
}

onMounted(loadReportStorageRoot)
</script>

<template>
  <NSpace vertical :size="16">
    <NCard title="基本信息" class="app-card">
      <NText strong style="font-size: 18px;">观枢 GAIOP</NText>
      <NText depth="3" style="display: block; margin-top: 8px;">当前产品版本：v1</NText>
      <NText depth="3" style="display: block; margin-top: 12px;">系统设置仅维护平台使用策略；NAPM 连接信息请在数据源管理中维护。</NText>
    </NCard>

    <section id="session-settings">
      <SessionManagementPage />
    </section>

    <NCard title="报告存储目录" class="app-card">
      <NAlert type="info" :bordered="false">此处仅显示部署配置的报告存储根目录，不能在网页修改。报告由会话中的 GAIOP AI 自动生成；查看、筛选、下载与删除请在“报告文件管理”页面进行。</NAlert>
      <NForm v-if="authStore.isAdmin" label-placement="left" label-width="150" style="max-width: 760px; margin-top: 16px;">
        <NFormItem label="报告存储根目录">
          <NInput
            :value="reportStorageRoot"
            readonly
            :placeholder="reportStorageLoading ? '正在读取…' : '未配置'"
          />
        </NFormItem>
      </NForm>
      <NAlert v-else type="warning" :bordered="false" style="margin-top: 16px;">仅管理员可查看服务器报告存储目录。</NAlert>
      <NAlert v-if="reportStorageError && authStore.isAdmin" type="warning" :bordered="false" style="margin-top: 12px;">暂时无法读取报告存储目录，请确认 Admin BFF 已启动并完成部署配置。</NAlert>
    </NCard>

    <NCard title="界面偏好" class="app-card">
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
