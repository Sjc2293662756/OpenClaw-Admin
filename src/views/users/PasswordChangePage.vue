<script setup lang="ts">
import { reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { NAlert, NButton, NCard, NForm, NFormItem, NInput, NSpace, useMessage, type FormInst, type FormRules } from 'naive-ui'
import { useAuthStore } from '@/stores/auth'
import { isValidPassword, PASSWORD_POLICY_MESSAGE } from '@/utils/password-policy'

const router = useRouter()
const authStore = useAuthStore()
const message = useMessage()
const formRef = ref<FormInst | null>(null)
const saving = ref(false)
const form = reactive({ currentPassword: '', newPassword: '', confirmPassword: '' })
const rules: FormRules = {
  currentPassword: [{ required: true, message: '请输入当前密码', trigger: ['input', 'blur'] }],
  newPassword: [
    { required: true, message: '请输入新密码', trigger: ['input', 'blur'] },
    { validator: () => isValidPassword(form.newPassword), message: PASSWORD_POLICY_MESSAGE, trigger: ['input', 'blur'] },
  ],
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
    message.success('密码已修改，请使用新密码重新登录')
    await authStore.logout()
    router.replace({ name: 'Welcome' })
  } catch (error) { message.error(error instanceof Error ? error.message : '修改密码失败') } finally { saving.value = false }
}
</script>

<template>
  <NCard title="修改我的密码" :bordered="false" class="password-card">
    <NAlert v-if="authStore.currentUser?.mustChangePassword" type="warning" :bordered="false" class="password-alert">
      管理员已重置您的密码。完成密码修改并重新登录前，其他功能不可访问。
    </NAlert>
    <NForm ref="formRef" :model="form" :rules="rules" label-placement="left" label-width="100" class="password-form">
      <NFormItem label="当前密码" path="currentPassword" required><NInput v-model:value="form.currentPassword" type="password" show-password-on="click" placeholder="请输入当前密码" /></NFormItem>
      <NFormItem label="新密码" path="newPassword" required><NInput v-model:value="form.newPassword" type="password" show-password-on="click" placeholder="请输入新密码" /></NFormItem>
      <NFormItem label="确认新密码" path="confirmPassword" required><NInput v-model:value="form.confirmPassword" type="password" show-password-on="click" placeholder="请再次输入新密码" /></NFormItem>
      <NFormItem label=""><span class="password-hint">{{ PASSWORD_POLICY_MESSAGE }}</span></NFormItem>
      <NFormItem label=""><NSpace><NButton v-if="!authStore.currentUser?.mustChangePassword" @click="router.push({ name: 'UserManagement' })">返回</NButton><NButton type="primary" :loading="saving" @click="submit">提交</NButton></NSpace></NFormItem>
    </NForm>
  </NCard>
</template>

<style scoped>
.password-card { min-height: 420px; }
.password-alert { margin-bottom: 18px; }
.password-form { max-width: 620px; padding: 22px 8px; }
.password-hint { color: var(--text-secondary); font-size: 13px; }
</style>
