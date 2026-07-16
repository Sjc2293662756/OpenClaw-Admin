<script setup lang="ts">
import { reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { NButton, NCard, NForm, NFormItem, NInput, NSpace, useMessage, type FormInst, type FormRules } from 'naive-ui'
import { useAuthStore } from '@/stores/auth'

const router = useRouter()
const authStore = useAuthStore()
const message = useMessage()
const formRef = ref<FormInst | null>(null)
const saving = ref(false)
const form = reactive({ currentPassword: '', newPassword: '', confirmPassword: '' })
const rules: FormRules = {
  currentPassword: [{ required: true, message: '请输入当前密码', trigger: ['input', 'blur'] }],
  newPassword: [{ required: true, message: '请输入新密码', trigger: ['input', 'blur'] }, { min: 6, message: '密码至少 6 位', trigger: ['input', 'blur'] }],
  confirmPassword: [{ required: true, message: '请再次输入新密码', trigger: ['input', 'blur'] }, { validator: () => form.newPassword === form.confirmPassword, message: '两次输入的密码不一致', trigger: ['input', 'blur'] }],
}
async function submit() {
  try { await formRef.value?.validate() } catch { return }
  if (!authStore.currentUser?.id) { message.error('当前用户信息失效，请重新登录'); return }
  saving.value = true
  try {
    const response = await fetch(`/api/users/${authStore.currentUser.id}/password`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authStore.getToken()}` }, body: JSON.stringify(form) })
    const data = await response.json()
    if (!response.ok || !data.ok) throw new Error(data.error || '修改密码失败')
    message.success('密码已修改')
    router.push({ name: 'UserManagement' })
  } catch (error) { message.error(error instanceof Error ? error.message : '修改密码失败') } finally { saving.value = false }
}
</script>

<template>
  <NCard title="修改我的密码" :bordered="false" class="password-card">
    <NForm ref="formRef" :model="form" :rules="rules" label-placement="left" label-width="100" class="password-form">
      <NFormItem label="当前密码" path="currentPassword" required><NInput v-model:value="form.currentPassword" type="password" show-password-on="click" placeholder="请输入当前密码" /></NFormItem>
      <NFormItem label="新密码" path="newPassword" required><NInput v-model:value="form.newPassword" type="password" show-password-on="click" placeholder="请输入新密码" /></NFormItem>
      <NFormItem label="确认新密码" path="confirmPassword" required><NInput v-model:value="form.confirmPassword" type="password" show-password-on="click" placeholder="请再次输入新密码" /></NFormItem>
      <NFormItem label=""><NSpace><NButton @click="router.push({ name: 'UserManagement' })">返回</NButton><NButton type="primary" :loading="saving" @click="submit">提交</NButton></NSpace></NFormItem>
    </NForm>
  </NCard>
</template>

<style scoped>
.password-card { min-height: 420px; }
.password-form { max-width: 620px; padding: 22px 8px; }
</style>
