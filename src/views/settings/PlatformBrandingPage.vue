<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { NButton, NCard, NForm, NFormItem, NIcon, NInput, NPopconfirm, useMessage } from 'naive-ui'
import { RefreshOutline, SaveOutline } from '@vicons/ionicons5'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import {
  DEFAULT_PLATFORM_BRANDING,
  loadPlatformBranding,
  resetPlatformBranding,
  savePlatformBranding,
  type PlatformBranding,
} from '@/branding/platform'

const authStore = useAuthStore()
const { locale } = useI18n()
const message = useMessage()
const text = (zhCN: string, enUS: string) => locale.value === 'zh-CN' ? zhCN : enUS
const loading = ref(false)
const saving = ref(false)
const resetting = ref(false)
const form = reactive<PlatformBranding>({ ...DEFAULT_PLATFORM_BRANDING })

const fields: Array<{ key: keyof PlatformBranding; zh: string; en: string }> = [
  { key: 'companyShortZh', zh: '公司简称', en: 'Company short name' },
  { key: 'companyLegalZh', zh: '公司法定全称', en: 'Company legal name' },
  { key: 'companyEnglish', zh: '公司英文名', en: 'Company English name' },
  { key: 'companyBrandEn', zh: '公司品牌（英文简称）', en: 'Company brand' },
  { key: 'productCode', zh: '产品代号', en: 'Product code' },
  { key: 'productShortZh', zh: '产品中文简称', en: 'Product Chinese short name' },
  { key: 'productFullZh', zh: '产品中文全称', en: 'Product Chinese full name' },
  { key: 'productFullEn', zh: '产品英文全称', en: 'Product English full name' },
]

function token() {
  return authStore.getToken() || ''
}

async function load() {
  loading.value = true
  try {
    Object.assign(form, await loadPlatformBranding())
  } catch (error) {
    message.error(error instanceof Error ? error.message : text('加载品牌名称失败', 'Failed to load branding'))
  } finally {
    loading.value = false
  }
}

async function save() {
  saving.value = true
  try {
    await savePlatformBranding({ ...form }, token())
    message.success(text('品牌名称已保存', 'Branding saved'))
    window.setTimeout(() => window.location.reload(), 300)
  } catch (error) {
    message.error(error instanceof Error ? error.message : text('保存品牌名称失败', 'Failed to save branding'))
  } finally {
    saving.value = false
  }
}

async function reset() {
  resetting.value = true
  try {
    await resetPlatformBranding(token())
    Object.assign(form, DEFAULT_PLATFORM_BRANDING)
    message.success(text('已恢复默认品牌名称', 'Default branding restored'))
    window.setTimeout(() => window.location.reload(), 300)
  } catch (error) {
    message.error(error instanceof Error ? error.message : text('恢复默认名称失败', 'Failed to restore defaults'))
  } finally {
    resetting.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="branding-page">
    <header class="page-heading">
      <div>
        <h1>{{ text('平台品牌配置', 'Platform Branding') }}</h1>
      </div>
    </header>

    <NCard class="branding-editor" :bordered="false" :loading="loading">
      <NForm label-placement="left" label-width="220" :show-feedback="false">
        <NFormItem v-for="field in fields" :key="field.key" :label="text(field.zh, field.en)">
          <NInput v-model:value="form[field.key]" maxlength="200" show-count />
        </NFormItem>
      </NForm>

      <div class="actions">
        <NPopconfirm
          :positive-text="text('恢复默认', 'Restore')"
          :negative-text="text('取消', 'Cancel')"
          @positive-click="reset"
        >
          <template #trigger>
            <NButton secondary :loading="resetting" :disabled="saving">
              <template #icon><NIcon :component="RefreshOutline" /></template>
              {{ text('一键恢复默认名称', 'Restore defaults') }}
            </NButton>
          </template>
          {{ text('确认恢复默认的八项名称？', 'Restore the eight default names?') }}
        </NPopconfirm>
        <NButton type="primary" :loading="saving" :disabled="resetting" @click="save">
          <template #icon><NIcon :component="SaveOutline" /></template>
          {{ text('保存全部名称', 'Save all names') }}
        </NButton>
      </div>
    </NCard>
  </div>
</template>

<style scoped>
.branding-page { width: min(920px, 100%); margin: 0 auto; }
.page-heading { display: flex; align-items: flex-end; justify-content: space-between; margin-bottom: 18px; }
.page-heading h1 { margin: 0 0 6px; color: var(--text-primary); font-size: 26px; letter-spacing: 0; }
.branding-editor { border: 1px solid var(--border-color); border-radius: 8px; }
.branding-editor :deep(.n-form-item) { margin-bottom: 18px; }
.actions { display: flex; justify-content: flex-end; gap: 12px; padding-top: 18px; border-top: 1px solid var(--border-color); }
@media (max-width: 720px) {
  .branding-editor :deep(.n-form-item) { display: block; }
  .branding-editor :deep(.n-form-item-label) { width: auto !important; padding-bottom: 8px; text-align: left; }
  .actions { align-items: stretch; flex-direction: column-reverse; }
  .actions :deep(.n-button) { width: 100%; }
}
</style>
