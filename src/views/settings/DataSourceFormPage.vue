<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NAlert, NButton, NCard, NForm, NFormItem, NInput, NRadio, NRadioGroup, NSelect, NSpace, useMessage, type FormInst, type FormRules } from 'naive-ui'
import { useAuthStore } from '@/stores/auth'
import { type DataSourceType } from './dataSources'

const router = useRouter()
const route = useRoute()
const authStore = useAuthStore()
const message = useMessage()
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

const typeOptions = [{ label: '本机', value: 'local' }, { label: '远程', value: 'remote' }]
const rules: FormRules = {
  ip: [{ required: true, message: '请输入 NAPM 的 IP 地址', trigger: ['input', 'blur'] }],
  type: [{ required: true, message: '请选择类型', trigger: ['change', 'blur'] }],
  username: [{ required: true, message: '请输入账号', trigger: ['input', 'blur'] }],
  password: [{ required: !editingId.value, message: '请输入密码', trigger: ['input', 'blur'] }],
}

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
    if (!response.ok || !data.ok || !source) throw new Error(data.error || '数据源不存在')
    form.ip = source.ip
    form.description = source.description || ''
    form.type = source.type
    form.username = source.username
    form.status = source.status === 'disabled' ? 'disabled' : 'untested'
  } catch (error) {
    message.error(error instanceof Error ? error.message : '获取数据源失败')
    returnToSystemConfiguration()
  } finally {
    loading.value = false
  }
}

async function submit() {
  if (!authStore.isAdmin) { message.error('仅管理员可维护数据源'); return }
  try { await formRef.value?.validate() } catch { return }
  loading.value = true
  try {
    const response = await fetch(editingId.value ? `/api/data-sources/${editingId.value}` : '/api/data-sources', {
      method: editingId.value ? 'PUT' : 'POST', headers: headers(), body: JSON.stringify(form),
    })
    const data = await response.json()
    if (!response.ok || !data.ok) throw new Error(data.error || '保存数据源失败')
    message.success(editingId.value ? '数据源已更新' : '数据源已添加')
    returnToSystemConfiguration()
  } catch (error) {
    message.error(error instanceof Error ? error.message : '保存数据源失败')
  } finally {
    loading.value = false
  }
}

loadExisting()
</script>

<template>
  <NCard :title="editingId ? '编辑数据源' : '添加新的数据源'" :bordered="false" class="form-card">
    <NAlert type="info" :bordered="false" class="form-note">
      密码将加密保存于服务端，编辑时留空表示不修改。新增后可在列表中发起真实连接测试。
    </NAlert>
    <NForm ref="formRef" :model="form" :rules="rules" label-placement="left" label-width="104" class="data-source-form">
      <NFormItem label="IP" path="ip" required><NInput v-model:value="form.ip" placeholder="请输入 NAPM IP，例如 10.0.0.10" /></NFormItem>
      <NFormItem label="描述" path="description"><NInput v-model:value="form.description" type="textarea" placeholder="可选，用于说明该 NAPM 数据源用途" :autosize="{ minRows: 3, maxRows: 5 }" maxlength="300" /></NFormItem>
      <NFormItem label="类型" path="type" required><NSelect v-model:value="form.type" :options="typeOptions" /></NFormItem>
      <NFormItem label="账号" path="username" required><NInput v-model:value="form.username" placeholder="请输入 NAPM 访问账号" /></NFormItem>
      <NFormItem label="密码" path="password" :required="!editingId"><NInput v-model:value="form.password" type="password" show-password-on="click" :placeholder="editingId ? '留空表示不修改' : '请输入 NAPM 访问密码'" /></NFormItem>
      <NFormItem label="状态"><NRadioGroup v-model:value="form.status"><NSpace><NRadio value="untested">未测试</NRadio><NRadio value="disabled">停用</NRadio></NSpace></NRadioGroup></NFormItem>
      <NFormItem label=""><NSpace><NButton :disabled="loading" @click="returnToSystemConfiguration">返回系统配置</NButton><NButton type="primary" :loading="loading" @click="submit">提交</NButton></NSpace></NFormItem>
    </NForm>
  </NCard>
</template>

<style scoped>
.form-card { min-height: 500px; }
.form-note { max-width: 760px; margin: 0 0 18px; line-height: 1.65; }
.data-source-form { max-width: 760px; padding: 6px 8px 20px; }
</style>
