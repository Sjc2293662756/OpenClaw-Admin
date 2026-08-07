<script setup lang="ts">
import { computed, h, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  NAlert,
  NButton,
  NCard,
  NDataTable,
  NEmpty,
  NForm,
  NFormItem,
  NIcon,
  NInput,
  NModal,
  NRadio,
  NRadioGroup,
  NResult,
  NSelect,
  NSpace,
  NTag,
  NText,
  useDialog,
  useMessage,
  type DataTableColumns,
  type FormInst,
  type FormRules,
} from 'naive-ui'
import { platformBranding } from '@/branding/platform'
import { AddOutline, CreateOutline, LockClosedOutline, RefreshOutline, TrashOutline } from '@vicons/ionicons5'
import { useAuthStore } from '@/stores/auth'
import { useI18n } from 'vue-i18n'
import { localizeApiError } from '@/utils/api-error'

type ConfigCategory = 'runtime' | 'integration' | 'security' | 'certificate'

interface SensitiveConfigItem {
  key: string
  category: ConfigCategory
  description: string
  isSensitive: boolean
  value?: string
  valueConfigured: boolean
  updatedAt: number
}

const router = useRouter()
const authStore = useAuthStore()
const { locale } = useI18n()
const dialog = useDialog()
const message = useMessage()
const text = (zhCN: string, enUS: string) => locale.value === 'zh-CN' ? zhCN : enUS
const formRef = ref<FormInst | null>(null)
const loading = ref(false)
const saving = ref(false)
const formVisible = ref(false)
const editingKey = ref('')
const configs = ref<SensitiveConfigItem[]>([])
const isAdmin = computed(() => authStore.isAdmin)

const categoryText = computed<Record<ConfigCategory, string>>(() => ({
  runtime: text('运行参数', 'Runtime parameter'),
  integration: text('集成配置', 'Integration configuration'),
  security: text('安全配置', 'Security configuration'),
  certificate: text('证书配置', 'Certificate configuration'),
}))
const categoryOptions = computed(() => Object.entries(categoryText.value).map(([value, label]) => ({ label, value })))
const categoryTagType: Record<ConfigCategory, 'success' | 'info' | 'warning' | 'error'> = {
  runtime: 'success', integration: 'info', security: 'warning', certificate: 'error',
}

const form = reactive({
  key: '',
  category: 'runtime' as ConfigCategory,
  description: '',
  isSensitive: true,
  value: '',
})

const rules = computed<FormRules>(() => ({
  key: [
    { required: true, message: text('请输入配置键', 'Enter a configuration key'), trigger: ['input', 'blur'] },
    { pattern: /^[A-Z][A-Z0-9_]{0,127}$/, message: text('仅支持大写字母、数字和下划线，且必须以字母开头', 'Use uppercase letters, numbers, and underscores only, beginning with a letter'), trigger: ['input', 'blur'] },
  ],
  category: [{ required: true, message: text('请选择配置分类', 'Select a configuration category'), trigger: ['change', 'blur'] }],
  value: [{ required: true, message: text('请输入配置值', 'Enter a configuration value'), trigger: ['input', 'blur'] }],
}))

function headers(json = false): Record<string, string> {
  const result: Record<string, string> = { Authorization: `Bearer ${authStore.getToken()}` }
  if (json) result['Content-Type'] = 'application/json'
  return result
}

function formatTime(timestamp?: number) {
  if (!timestamp) return '—'
  return new Date(timestamp).toLocaleString(locale.value, { hour12: false })
}

function resetForm() {
  Object.assign(form, { key: '', category: 'runtime', description: '', isSensitive: true, value: '' })
  editingKey.value = ''
}

function openCreate() {
  resetForm()
  formVisible.value = true
}

function openEdit(item: SensitiveConfigItem) {
  Object.assign(form, {
    key: item.key,
    category: item.category,
    description: item.description || '',
    isSensitive: item.isSensitive,
    value: item.isSensitive ? '' : (item.value || ''),
  })
  editingKey.value = item.key
  formVisible.value = true
}

function closeForm() {
  formVisible.value = false
  resetForm()
}

async function refresh(showMessage = true) {
  if (!isAdmin.value) return
  loading.value = true
  try {
    const response = await fetch('/api/system-config/environment', { headers: headers() })
    const data = await response.json()
    if (!response.ok || !data.ok) throw new Error(localizeApiError(data, text('获取环境与敏感配置失败', 'Failed to load environment and sensitive configuration')))
    configs.value = data.configs || []
    if (showMessage) message.success(text('配置已刷新', 'Configuration refreshed'))
  } catch (error) {
    message.error(error instanceof Error ? error.message : text('获取环境与敏感配置失败', 'Failed to load environment and sensitive configuration'))
  } finally {
    loading.value = false
  }
}

async function save() {
  if (!isAdmin.value) { message.error(text('仅管理员可维护环境与敏感配置', 'Only administrators can manage environment and sensitive configuration')); return }
  try { await formRef.value?.validate() } catch { return }
  saving.value = true
  try {
    const response = await fetch(`/api/system-config/environment/${encodeURIComponent(form.key)}`, {
      method: 'PUT',
      headers: headers(true),
      body: JSON.stringify({
        category: form.category,
        description: form.description,
        isSensitive: form.isSensitive,
        value: form.value,
      }),
    })
    const data = await response.json()
    if (!response.ok || !data.ok) throw new Error(localizeApiError(data, text('保存环境与敏感配置失败', 'Failed to save environment and sensitive configuration')))
    message.success(editingKey.value ? text('配置已更新', 'Configuration updated') : text('配置已添加', 'Configuration added'))
    closeForm()
    await refresh(false)
  } catch (error) {
    message.error(error instanceof Error ? error.message : text('保存环境与敏感配置失败', 'Failed to save environment and sensitive configuration'))
  } finally {
    saving.value = false
  }
}

function remove(item: SensitiveConfigItem) {
  dialog.error({
    title: text('删除配置项', 'Delete configuration item'),
    content: text(`确定删除“${item.key}”吗？删除后无法从平台配置库恢复。`, `Delete “${item.key}”? It cannot be restored from the platform configuration store.`),
    positiveText: text('确认删除', 'Delete'),
    negativeText: text('取消', 'Cancel'),
    onPositiveClick: async () => {
      try {
        const response = await fetch(`/api/system-config/environment/${encodeURIComponent(item.key)}`, {
          method: 'DELETE', headers: headers(),
        })
        const data = await response.json()
        if (!response.ok || !data.ok) throw new Error(localizeApiError(data, text('删除配置项失败', 'Failed to delete configuration item')))
        message.success(text('配置项已删除', 'Configuration item deleted'))
        await refresh(false)
      } catch (error) {
        message.error(error instanceof Error ? error.message : text('删除配置项失败', 'Failed to delete configuration item'))
      }
    },
  })
}

const columns = computed<DataTableColumns<SensitiveConfigItem>>(() => [
  { title: text('配置键', 'Configuration key'), key: 'key', minWidth: 210, render: row => h('code', { class: 'config-key' }, row.key) },
  { title: text('分类', 'Category'), key: 'category', width: 150, render: row => h(NTag, { type: categoryTagType[row.category], bordered: false }, { default: () => categoryText.value[row.category] }) },
  { title: text('类型', 'Type'), key: 'isSensitive', width: 132, render: row => h(NTag, { type: row.isSensitive ? 'warning' : 'default', bordered: false }, { default: () => row.isSensitive ? text('敏感配置', 'Sensitive') : text('普通参数', 'Standard') }) },
  { title: text('配置状态', 'Configuration status'), key: 'valueConfigured', width: 150, render: row => h(NTag, { type: row.valueConfigured ? 'success' : 'default', bordered: false }, { default: () => row.valueConfigured ? text('已配置', 'Configured') : text('未配置', 'Not configured') }) },
  { title: text('描述', 'Description'), key: 'description', minWidth: 210, ellipsis: { tooltip: true }, render: row => row.description || '—' },
  { title: text('更新时间', 'Updated at'), key: 'updatedAt', width: 180, render: row => formatTime(row.updatedAt) },
  { title: text('操作', 'Actions'), key: 'actions', width: 174, fixed: 'right', render: row => h(NSpace, { size: 'small', wrap: false }, { default: () => [
    h(NButton, { size: 'small', disabled: !isAdmin.value, onClick: () => openEdit(row) }, { icon: () => h(NIcon, null, { default: () => h(CreateOutline) }), default: () => text('编辑', 'Edit') }),
    h(NButton, { size: 'small', type: 'error', ghost: true, disabled: !isAdmin.value, onClick: () => remove(row) }, { icon: () => h(NIcon, null, { default: () => h(TrashOutline) }), default: () => text('删除', 'Delete') }),
  ] }) },
])

onMounted(() => { refresh(false) })
</script>

<template>
  <section class="sensitive-config-page">
    <NResult v-if="!isAdmin" status="403" :title="text('仅管理员可访问', 'Administrators only')" :description="text('环境与敏感配置属于系统安全配置，只有管理员可以查看和维护。', 'Environment and sensitive configuration is a system-security area that only administrators can view and manage.')">
<template #footer><NButton @click="router.push({ name: 'SystemConfiguration' })">{{ text('返回高级配置', 'Back to advanced configuration') }}</NButton></template>
    </NResult>

    <template v-else>
      <NAlert type="warning" :bordered="false" class="stage-note">
        {{ text(`配置项保存于 ${platformBranding.productCode} 管理配置库，不会直接修改服务器 \`.env\`、操作系统或正在运行的服务。敏感值采用加密存储，列表和编辑时均不会回显原值。`, `Configuration items are stored in the ${platformBranding.productCode} management configuration store and do not directly change the server \`.env\`, operating system, or running services. Sensitive values are encrypted and are never shown again in the list or editor.`) }}
      </NAlert>
      <NCard :title="text('环境与敏感配置', 'Environment and sensitive configuration')" :bordered="false" class="sensitive-config-card">
        <template #header-extra>
          <NSpace>
            <NButton type="primary" @click="openCreate">
              <template #icon><NIcon><AddOutline /></NIcon></template>{{ text('添加配置', 'Add configuration') }}
            </NButton>
            <NButton :loading="loading" @click="refresh()">
              <template #icon><NIcon><RefreshOutline /></NIcon></template>{{ text('刷新', 'Refresh') }}
            </NButton>
          </NSpace>
        </template>
        <NDataTable :columns="columns" :data="configs" :loading="loading" :bordered="false" :single-line="false" :scroll-x="1120" :pagination="{ pageSize: 10 }">
          <template #empty><NEmpty :description="text('尚未添加环境或敏感配置', 'No environment or sensitive configuration has been added')" /></template>
        </NDataTable>
      </NCard>
    </template>

    <NModal v-model:show="formVisible" preset="card" :title="editingKey ? text('编辑配置项', 'Edit configuration item') : text('添加配置项', 'Add configuration item')" style="width: min(680px, calc(100vw - 32px));" :mask-closable="false">
      <NAlert type="info" :bordered="false" class="form-note">
        <template #icon><NIcon><LockClosedOutline /></NIcon></template>
        {{ text('敏感配置编辑时必须重新输入新值，平台不会回填或展示之前保存的内容。', 'When editing sensitive configuration, enter a new value. The platform does not refill or show the previously saved value.') }}
      </NAlert>
      <NForm ref="formRef" :model="form" :rules="rules" label-placement="left" label-width="112" class="config-form">
        <NFormItem :label="text('配置键', 'Configuration key')" path="key" required>
          <NInput v-model:value="form.key" :disabled="!!editingKey" placeholder="例如 NAPM_CA_CERTIFICATE" maxlength="128" @update:value="value => { if (!editingKey) form.key = value.toUpperCase() }" />
        </NFormItem>
        <NFormItem :label="text('配置分类', 'Configuration category')" path="category" required><NSelect v-model:value="form.category" :options="categoryOptions" /></NFormItem>
        <NFormItem :label="text('配置类型', 'Configuration type')">
          <NRadioGroup v-model:value="form.isSensitive">
            <NSpace><NRadio :value="true">{{ text('敏感配置', 'Sensitive') }}</NRadio><NRadio :value="false">{{ text('普通参数', 'Standard') }}</NRadio></NSpace>
          </NRadioGroup>
        </NFormItem>
        <NFormItem :label="text('描述', 'Description')" path="description"><NInput v-model:value="form.description" type="textarea" :placeholder="text('可选，说明该配置项用途', 'Optional: describe this configuration item')" :autosize="{ minRows: 2, maxRows: 4 }" maxlength="300" /></NFormItem>
        <NFormItem :label="text('配置值', 'Configuration value')" path="value" required>
          <NInput v-model:value="form.value" :type="form.isSensitive ? 'password' : 'textarea'" :show-password-on="form.isSensitive ? 'click' : undefined" :placeholder="form.isSensitive ? text('请输入新的敏感值', 'Enter the new sensitive value') : text('请输入参数值', 'Enter a parameter value')" :autosize="form.isSensitive ? undefined : { minRows: 3, maxRows: 8 }" />
        </NFormItem>
        <NFormItem label=""><NSpace><NButton :disabled="saving" @click="closeForm">{{ text('取消', 'Cancel') }}</NButton><NButton type="primary" :loading="saving" @click="save">{{ text('保存', 'Save') }}</NButton></NSpace></NFormItem>
      </NForm>
      <NText depth="3" class="form-footnote">{{ text('配置是否立即生效取决于后续对应模块的运行时接入，不应将此页面作为服务器网络或服务重启工具。', 'Whether configuration takes effect immediately depends on later runtime integration of the relevant module. This page is not a tool for server networking or service restarts.') }}</NText>
    </NModal>
  </section>
</template>

<style scoped>
.sensitive-config-page { display: grid; gap: 16px; }
.stage-note { line-height: 1.7; }
.sensitive-config-card { min-height: 420px; }
:deep(.config-key) { color: #176d49; font-family: Consolas, 'Courier New', monospace; font-size: 12px; }
.form-note { margin-bottom: 18px; line-height: 1.65; }
.config-form { padding: 4px 8px 4px; }
.form-footnote { display: block; padding: 2px 8px 8px; font-size: 12px; line-height: 1.65; }
</style>
