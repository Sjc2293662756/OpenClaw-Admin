<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { localizeApiError } from '@/utils/api-error'
import { useRoute, useRouter } from 'vue-router'
import { NAlert, NButton, NCard, NForm, NFormItem, NInput, NRadio, NRadioGroup, NSelect, NSpace, useMessage, type FormInst, type FormRules } from 'naive-ui'
import { useAuthStore } from '@/stores/auth'
import { type DataSourceType } from './dataSources'

const router = useRouter()
const route = useRoute()
const authStore = useAuthStore()
const { locale } = useI18n()
const message = useMessage()
const text = (zhCN: string, enUS: string) => locale.value === 'zh-CN' ? zhCN : enUS
const formRef = ref<FormInst | null>(null)
const loading = ref(false)
const editingId = computed(() => typeof route.params.id === 'string' ? route.params.id : '')
const form = reactive({
  ip: '',
  description: '',
  type: 'remote' as DataSourceType,
  username: '',
  password: '',
  status: 'untested',
})

const typeOptions = computed(() => [{ label: text('本机', 'Local'), value: 'local' }, { label: text('远程', 'Remote'), value: 'remote' }])
const rules = computed<FormRules>(() => ({
  ip: [{ required: true, message: text('请输入 NAPM 的 IP 地址', 'Enter the NAPM IP address'), trigger: ['input', 'blur'] }],
  type: [{ required: true, message: text('请选择类型', 'Select a type'), trigger: ['change', 'blur'] }],
  username: [{ required: true, message: text('请输入账号', 'Enter the account'), trigger: ['input', 'blur'] }],
  password: [{ required: !editingId.value, message: text('请输入密码', 'Enter the password'), trigger: ['input', 'blur'] }],
}))

function headers() { return { 'Content-Type': 'application/json', Authorization: `Bearer ${authStore.getToken()}` } }

function returnToSystemConfiguration() {
  router.push({ name: 'SystemConfiguration', hash: '#data-sources' })
}

function unwrapApiData<T extends Record<string, unknown>>(payload: T) {
  return payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)
    ? payload.data as T
    : payload
}

async function loadExisting() {
  if (!editingId.value) return
  loading.value = true
  try {
    const response = await fetch('/api/data-sources', { headers: { Authorization: `Bearer ${authStore.getToken()}` } })
    const data = await response.json()
    const payload = unwrapApiData(data)
    const source = Array.isArray(payload.dataSources)
      ? payload.dataSources.find((item: { id: string }) => item.id === editingId.value)
      : null
    if (!response.ok || !data.ok || !source) throw new Error(localizeApiError(data, text('数据源不存在', 'Data source does not exist')))
    form.ip = source.ip
    form.description = source.description || ''
    form.type = source.type
    form.username = source.username
    form.status = source.status === 'disabled' ? 'disabled' : 'untested'
  } catch (error) {
    message.error(error instanceof Error ? error.message : text('获取数据源失败', 'Failed to load data source'))
    returnToSystemConfiguration()
  } finally {
    loading.value = false
  }
}

async function submit() {
  if (!authStore.isAdmin) { message.error(text('仅管理员可维护数据源', 'Only administrators can manage data sources')); return }
  try { await formRef.value?.validate() } catch { return }
  loading.value = true
  try {
    const response = await fetch(editingId.value ? `/api/data-sources/${editingId.value}` : '/api/data-sources', {
      method: editingId.value ? 'PUT' : 'POST', headers: headers(), body: JSON.stringify(form),
    })
    const data = await response.json()
    if (!response.ok || !data.ok) throw new Error(localizeApiError(data, text('保存数据源失败', 'Failed to save data source')))
    message.success(editingId.value ? text('数据源已更新', 'Data source updated') : text('数据源已添加', 'Data source added'))
    returnToSystemConfiguration()
  } catch (error) {
    message.error(error instanceof Error ? error.message : text('保存数据源失败', 'Failed to save data source'))
  } finally {
    loading.value = false
  }
}

loadExisting()
</script>

<template>
  <NCard :title="editingId ? text('编辑数据源', 'Edit data source') : text('添加新的数据源', 'Add data source')" :bordered="false" class="form-card">
    <NAlert type="info" :bordered="false" class="form-note">
      {{ text('密码将加密保存于服务端，编辑时留空表示不修改。新增后可在列表中发起真实连接测试。', 'Passwords are encrypted on the server. Leave this blank when editing to keep the current password. A real connection test is available after creation.') }}
    </NAlert>
    <NForm ref="formRef" :model="form" :rules="rules" label-placement="left" label-width="104" class="data-source-form">
      <NFormItem label="IP" path="ip" required><NInput v-model:value="form.ip" :placeholder="text('请输入 NAPM IP，例如 10.0.0.10', 'Enter a NAPM IP, for example 10.0.0.10')" /></NFormItem>
      <NFormItem :label="text('描述', 'Description')" path="description"><NInput v-model:value="form.description" type="textarea" :placeholder="text('可选，用于说明该 NAPM 数据源用途', 'Optional: describe this NAPM data source')" :autosize="{ minRows: 3, maxRows: 5 }" maxlength="300" /></NFormItem>
      <NFormItem :label="text('类型', 'Type')" path="type" required><NSelect v-model:value="form.type" :options="typeOptions" /></NFormItem>
      <NFormItem :label="text('账号', 'Account')" path="username" required><NInput v-model:value="form.username" :placeholder="text('请输入 NAPM 访问账号', 'Enter the NAPM account')" /></NFormItem>
      <NFormItem :label="text('密码', 'Password')" path="password" :required="!editingId"><NInput v-model:value="form.password" type="password" show-password-on="click" :placeholder="editingId ? text('留空表示不修改', 'Leave blank to keep unchanged') : text('请输入 NAPM 访问密码', 'Enter the NAPM password')" /></NFormItem>
      <NFormItem :label="text('状态', 'Status')"><NRadioGroup v-model:value="form.status"><NSpace><NRadio value="untested">{{ text('未测试', 'Not tested') }}</NRadio><NRadio value="disabled">{{ text('停用', 'Disabled') }}</NRadio></NSpace></NRadioGroup></NFormItem>
      <NFormItem label=""><NSpace><NButton :disabled="loading" @click="returnToSystemConfiguration">{{ text('返回系统配置', 'Back to system configuration') }}</NButton><NButton type="primary" :loading="loading" @click="submit">{{ text('提交', 'Submit') }}</NButton></NSpace></NFormItem>
    </NForm>
  </NCard>
</template>

<style scoped>
.form-card { min-height: 500px; }
.form-note { max-width: 760px; margin: 0 0 18px; line-height: 1.65; }
.data-source-form { max-width: 760px; padding: 6px 8px 20px; }
</style>
