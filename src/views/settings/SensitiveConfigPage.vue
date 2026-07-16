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
import { AddOutline, CreateOutline, LockClosedOutline, RefreshOutline, TrashOutline } from '@vicons/ionicons5'
import { useAuthStore } from '@/stores/auth'

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
const dialog = useDialog()
const message = useMessage()
const formRef = ref<FormInst | null>(null)
const loading = ref(false)
const saving = ref(false)
const formVisible = ref(false)
const editingKey = ref('')
const configs = ref<SensitiveConfigItem[]>([])
const isAdmin = computed(() => authStore.isAdmin)

const categoryOptions = [
  { label: '运行参数', value: 'runtime' },
  { label: '集成配置', value: 'integration' },
  { label: '安全配置', value: 'security' },
  { label: '证书配置', value: 'certificate' },
]
const categoryText: Record<ConfigCategory, string> = {
  runtime: '运行参数',
  integration: '集成配置',
  security: '安全配置',
  certificate: '证书配置',
}
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

const rules: FormRules = {
  key: [
    { required: true, message: '请输入配置键', trigger: ['input', 'blur'] },
    { pattern: /^[A-Z][A-Z0-9_]{0,127}$/, message: '仅支持大写字母、数字和下划线，且必须以字母开头', trigger: ['input', 'blur'] },
  ],
  category: [{ required: true, message: '请选择配置分类', trigger: ['change', 'blur'] }],
  value: [{ required: true, message: '请输入配置值', trigger: ['input', 'blur'] }],
}

function headers(json = false): Record<string, string> {
  const result: Record<string, string> = { Authorization: `Bearer ${authStore.getToken()}` }
  if (json) result['Content-Type'] = 'application/json'
  return result
}

function formatTime(timestamp?: number) {
  if (!timestamp) return '—'
  return new Date(timestamp).toLocaleString('zh-CN', { hour12: false })
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
    if (!response.ok || !data.ok) throw new Error(data.error || '获取环境与敏感配置失败')
    configs.value = data.configs || []
    if (showMessage) message.success('配置已刷新')
  } catch (error) {
    message.error(error instanceof Error ? error.message : '获取环境与敏感配置失败')
  } finally {
    loading.value = false
  }
}

async function save() {
  if (!isAdmin.value) { message.error('仅管理员可维护环境与敏感配置'); return }
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
    if (!response.ok || !data.ok) throw new Error(data.error || '保存环境与敏感配置失败')
    message.success(editingKey.value ? '配置已更新' : '配置已添加')
    closeForm()
    await refresh(false)
  } catch (error) {
    message.error(error instanceof Error ? error.message : '保存环境与敏感配置失败')
  } finally {
    saving.value = false
  }
}

function remove(item: SensitiveConfigItem) {
  dialog.error({
    title: '删除配置项',
    content: `确定删除“${item.key}”吗？删除后无法从平台配置库恢复。`,
    positiveText: '确认删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        const response = await fetch(`/api/system-config/environment/${encodeURIComponent(item.key)}`, {
          method: 'DELETE', headers: headers(),
        })
        const data = await response.json()
        if (!response.ok || !data.ok) throw new Error(data.error || '删除配置项失败')
        message.success('配置项已删除')
        await refresh(false)
      } catch (error) {
        message.error(error instanceof Error ? error.message : '删除配置项失败')
      }
    },
  })
}

const columns: DataTableColumns<SensitiveConfigItem> = [
  { title: '配置键', key: 'key', minWidth: 210, render: row => h('code', { class: 'config-key' }, row.key) },
  { title: '分类', key: 'category', width: 118, render: row => h(NTag, { type: categoryTagType[row.category], bordered: false }, { default: () => categoryText[row.category] }) },
  { title: '类型', key: 'isSensitive', width: 112, render: row => h(NTag, { type: row.isSensitive ? 'warning' : 'default', bordered: false }, { default: () => row.isSensitive ? '敏感配置' : '普通参数' }) },
  { title: '配置状态', key: 'valueConfigured', width: 120, render: row => h(NTag, { type: row.valueConfigured ? 'success' : 'default', bordered: false }, { default: () => row.valueConfigured ? '已配置' : '未配置' }) },
  { title: '描述', key: 'description', minWidth: 210, ellipsis: { tooltip: true }, render: row => row.description || '—' },
  { title: '更新时间', key: 'updatedAt', width: 180, render: row => formatTime(row.updatedAt) },
  { title: '操作', key: 'actions', width: 174, fixed: 'right', render: row => h(NSpace, { size: 'small', wrap: false }, { default: () => [
    h(NButton, { size: 'small', disabled: !isAdmin.value, onClick: () => openEdit(row) }, { icon: () => h(NIcon, null, { default: () => h(CreateOutline) }), default: () => '编辑' }),
    h(NButton, { size: 'small', type: 'error', ghost: true, disabled: !isAdmin.value, onClick: () => remove(row) }, { icon: () => h(NIcon, null, { default: () => h(TrashOutline) }), default: () => '删除' }),
  ] }) },
]

onMounted(() => { refresh(false) })
</script>

<template>
  <section class="sensitive-config-page">
    <NResult v-if="!isAdmin" status="403" title="仅管理员可访问" description="环境与敏感配置属于系统安全配置，只有管理员可以查看和维护。">
      <template #footer><NButton @click="router.push({ name: 'SystemConfiguration' })">返回系统配置</NButton></template>
    </NResult>

    <template v-else>
      <NAlert type="warning" :bordered="false" class="stage-note">
        配置项保存于 GAIOP 管理配置库，不会直接修改服务器 `.env`、操作系统或正在运行的服务。敏感值采用加密存储，列表和编辑时均不会回显原值。
      </NAlert>
      <NCard title="环境与敏感配置" :bordered="false" class="sensitive-config-card">
        <template #header-extra>
          <NSpace>
            <NButton type="primary" @click="openCreate">
              <template #icon><NIcon><AddOutline /></NIcon></template>添加配置
            </NButton>
            <NButton :loading="loading" @click="refresh()">
              <template #icon><NIcon><RefreshOutline /></NIcon></template>刷新
            </NButton>
          </NSpace>
        </template>
        <NDataTable :columns="columns" :data="configs" :loading="loading" :bordered="false" :single-line="false" :scroll-x="1120" :pagination="{ pageSize: 10 }">
          <template #empty><NEmpty description="尚未添加环境或敏感配置" /></template>
        </NDataTable>
      </NCard>
    </template>

    <NModal v-model:show="formVisible" preset="card" :title="editingKey ? '编辑配置项' : '添加配置项'" style="width: min(680px, calc(100vw - 32px));" :mask-closable="false">
      <NAlert type="info" :bordered="false" class="form-note">
        <template #icon><NIcon><LockClosedOutline /></NIcon></template>
        敏感配置编辑时必须重新输入新值，平台不会回填或展示之前保存的内容。
      </NAlert>
      <NForm ref="formRef" :model="form" :rules="rules" label-placement="left" label-width="112" class="config-form">
        <NFormItem label="配置键" path="key" required>
          <NInput v-model:value="form.key" :disabled="!!editingKey" placeholder="例如 NAPM_CA_CERTIFICATE" maxlength="128" @update:value="value => { if (!editingKey) form.key = value.toUpperCase() }" />
        </NFormItem>
        <NFormItem label="配置分类" path="category" required><NSelect v-model:value="form.category" :options="categoryOptions" /></NFormItem>
        <NFormItem label="配置类型">
          <NRadioGroup v-model:value="form.isSensitive">
            <NSpace><NRadio :value="true">敏感配置</NRadio><NRadio :value="false">普通参数</NRadio></NSpace>
          </NRadioGroup>
        </NFormItem>
        <NFormItem label="描述" path="description"><NInput v-model:value="form.description" type="textarea" placeholder="可选，说明该配置项用途" :autosize="{ minRows: 2, maxRows: 4 }" maxlength="300" /></NFormItem>
        <NFormItem label="配置值" path="value" required>
          <NInput v-model:value="form.value" :type="form.isSensitive ? 'password' : 'textarea'" :show-password-on="form.isSensitive ? 'click' : undefined" :placeholder="form.isSensitive ? '请输入新的敏感值' : '请输入参数值'" :autosize="form.isSensitive ? undefined : { minRows: 3, maxRows: 8 }" />
        </NFormItem>
        <NFormItem label=""><NSpace><NButton :disabled="saving" @click="closeForm">取消</NButton><NButton type="primary" :loading="saving" @click="save">保存</NButton></NSpace></NFormItem>
      </NForm>
      <NText depth="3" class="form-footnote">配置是否立即生效取决于后续对应模块的运行时接入，不应将此页面作为服务器网络或服务重启工具。</NText>
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
