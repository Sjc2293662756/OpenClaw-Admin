<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { NAlert, NButton, NCard, NForm, NFormItem, NInput, NRadio, NRadioGroup, NSelect, NSpace, useMessage, type FormInst, type FormRules } from 'naive-ui'
import { useAuthStore } from '@/stores/auth'

const router = useRouter()
const authStore = useAuthStore()
const message = useMessage()
const formRef = ref<FormInst | null>(null)
const saving = ref(false)
const isAdmin = computed(() => authStore.isAdmin)
const form = reactive({ username: '', description: '', role: 'basic', password: '', confirmPassword: '', status: 'active' })

const roleOptions = [
  { label: '基础用户', value: 'basic' }, { label: '审计用户', value: 'auditor' },
  { label: '标准用户', value: 'standard' }, { label: '管理员', value: 'admin' },
]
const rules: FormRules = {
  username: [{ required: true, message: '请输入用户名', trigger: ['input', 'blur'] }],
  role: [{ required: true, message: '请选择用户类型', trigger: ['change', 'blur'] }],
  password: [{ required: true, message: '请输入密码', trigger: ['input', 'blur'] }, { min: 6, message: '密码至少 6 位', trigger: ['input', 'blur'] }],
  confirmPassword: [{ required: true, message: '请再次输入密码', trigger: ['input', 'blur'] }, { validator: () => form.password === form.confirmPassword, message: '两次输入的密码不一致', trigger: ['input', 'blur'] }],
}

async function submit() {
  if (!isAdmin.value) { message.error('仅管理员可以添加用户'); return }
  try { await formRef.value?.validate() } catch { return }
  saving.value = true
  try {
    const response = await fetch('/api/users', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authStore.getToken()}` }, body: JSON.stringify(form) })
    const data = await response.json()
    if (!response.ok || !data.ok) throw new Error(data.error || '添加用户失败')
    message.success('用户已添加')
    router.push({ name: 'UserManagement' })
  } catch (error) {
    message.error(error instanceof Error ? error.message : '添加用户失败')
  } finally { saving.value = false }
}
</script>

<template>
  <NCard title="添加用户" :bordered="false" class="create-card">
    <NAlert v-if="!isAdmin" type="warning" :bordered="false" class="page-alert">仅管理员可以添加用户。</NAlert>
    <NForm v-else ref="formRef" :model="form" :rules="rules" label-placement="left" label-width="100" class="user-form">
      <NFormItem label="定义内容"><span class="static-value">用户</span></NFormItem>
      <NFormItem label="名称" path="username" required><NInput v-model:value="form.username" placeholder="请输入用户名" maxlength="64" /></NFormItem>
      <NFormItem label="描述" path="description"><NInput v-model:value="form.description" type="textarea" placeholder="可选，用于说明该账户用途" maxlength="500" :autosize="{ minRows: 3, maxRows: 5 }" /></NFormItem>
      <NFormItem label="用户类型" path="role" required><NSelect v-model:value="form.role" :options="roleOptions" /></NFormItem>
      <NFormItem label="输入密码" path="password" required><NInput v-model:value="form.password" type="password" show-password-on="click" placeholder="请输入密码" /></NFormItem>
      <NFormItem label="确认密码" path="confirmPassword" required><NInput v-model:value="form.confirmPassword" type="password" show-password-on="click" placeholder="请再次输入密码" /></NFormItem>
      <NFormItem label="状态"><NRadioGroup v-model:value="form.status"><NSpace><NRadio value="active">激活</NRadio><NRadio value="inactive">非激活</NRadio></NSpace></NRadioGroup></NFormItem>
      <NFormItem label=""><NSpace><NButton @click="router.push({ name: 'UserManagement' })">返回</NButton><NButton type="primary" :loading="saving" @click="submit">提交</NButton></NSpace></NFormItem>
    </NForm>
  </NCard>
</template>

<style scoped>
.create-card { min-height: 500px; }
.page-alert { margin-bottom: 18px; }
.user-form { max-width: 680px; padding: 18px 8px; }
.static-value { color: var(--text-color-2); }
</style>
