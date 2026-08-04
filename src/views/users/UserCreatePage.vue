<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { NAlert, NButton, NCard, NForm, NFormItem, NInput, NRadio, NRadioGroup, NSelect, NSpace, useMessage, type FormInst, type FormRules } from 'naive-ui'
import { useAuthStore } from '@/stores/auth'
import { isValidPassword, passwordPolicyMessage } from '@/utils/password-policy'
import { localizeApiError } from '@/utils/api-error'
import { useI18n } from 'vue-i18n'
import type { AppLocale } from '@/i18n/locale'

const router = useRouter()
const authStore = useAuthStore()
const message = useMessage()
const { t, locale } = useI18n()
const passwordHint = computed(() => passwordPolicyMessage(locale.value as AppLocale))
const formRef = ref<FormInst | null>(null)
const saving = ref(false)
const isAdmin = computed(() => authStore.isAdmin)
const isInitialAdmin = computed(() => Boolean(authStore.currentUser?.isInitialAdmin))
const form = reactive({ username: '', description: '', role: 'basic', password: '', confirmPassword: '', status: 'active' })

const roleOptions = computed(() => [
  { label: t('pages.gaiop.users.basic'), value: 'basic' }, { label: t('pages.gaiop.users.auditor'), value: 'auditor' },
  { label: t('pages.gaiop.users.standard'), value: 'standard' }, { label: t('pages.gaiop.users.admin'), value: 'admin' },
].filter(option => !['admin', 'auditor'].includes(option.value) || isInitialAdmin.value))
const rules = computed<FormRules>(() => ({
  username: [{ required: true, message: locale.value === 'zh-CN' ? '请输入用户名' : 'Enter a username', trigger: ['input', 'blur'] }],
  role: [{ required: true, message: locale.value === 'zh-CN' ? '请选择用户类型' : 'Select a user type', trigger: ['change', 'blur'] }],
  password: [
    { required: true, message: locale.value === 'zh-CN' ? '请输入密码' : 'Enter a password', trigger: ['input', 'blur'] },
    { validator: () => isValidPassword(form.password), message: passwordHint.value, trigger: ['input', 'blur'] },
  ],
  confirmPassword: [{ required: true, message: locale.value === 'zh-CN' ? '请再次输入密码' : 'Re-enter the password', trigger: ['input', 'blur'] }, { validator: () => form.password === form.confirmPassword, message: locale.value === 'zh-CN' ? '两次输入的密码不一致' : 'Passwords do not match', trigger: ['input', 'blur'] }],
}))

async function submit() {
  if (!isAdmin.value) { message.error(t('pages.gaiop.users.createAdminOnly')); return }
  try { await formRef.value?.validate() } catch { return }
  saving.value = true
  try {
    const response = await fetch('/api/users', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authStore.getToken()}` }, body: JSON.stringify(form) })
    const data = await response.json()
    if (!response.ok || !data.ok) throw new Error(localizeApiError(data, t('pages.gaiop.users.createFailed')))
    message.success(t('pages.gaiop.users.createSuccess'))
    router.push({ name: 'UserManagement' })
  } catch (error) {
    message.error(error instanceof Error ? error.message : t('pages.gaiop.users.createFailed'))
  } finally { saving.value = false }
}
</script>

<template>
  <NCard :title="t('pages.gaiop.users.create')" :bordered="false" class="create-card">
    <NAlert v-if="!isAdmin" type="warning" :bordered="false" class="page-alert">{{ t('pages.gaiop.users.createAdminOnly') }}</NAlert>
    <NForm v-else ref="formRef" :model="form" :rules="rules" label-placement="left" label-width="100" class="user-form">
      <NFormItem :label="t('pages.gaiop.users.definition')"><span class="static-value">{{ t('pages.gaiop.users.user') }}</span></NFormItem>
      <NFormItem :label="t('pages.gaiop.users.formName')" path="username" required><NInput v-model:value="form.username" :placeholder="t('pages.gaiop.users.usernamePlaceholder')" maxlength="64" /></NFormItem>
      <NFormItem :label="t('pages.gaiop.users.description')" path="description"><NInput v-model:value="form.description" type="textarea" :placeholder="t('pages.gaiop.users.optionalDescription')" maxlength="500" :autosize="{ minRows: 3, maxRows: 5 }" /></NFormItem>
      <NFormItem :label="t('pages.gaiop.users.userType')" path="role" required><NSelect v-model:value="form.role" :options="roleOptions" /></NFormItem>
      <NFormItem :label="t('pages.gaiop.users.password')" path="password" required><NInput v-model:value="form.password" type="password" show-password-on="click" :placeholder="t('pages.gaiop.users.passwordPlaceholder')" /></NFormItem>
      <NFormItem :label="t('pages.gaiop.users.confirmPassword')" path="confirmPassword" required><NInput v-model:value="form.confirmPassword" type="password" show-password-on="click" :placeholder="t('pages.gaiop.users.confirmPasswordPlaceholder')" /></NFormItem>
      <NFormItem label=""><span class="password-hint">{{ passwordHint }}</span></NFormItem>
      <NFormItem :label="t('pages.gaiop.users.status')"><NRadioGroup v-model:value="form.status"><NSpace><NRadio value="active">{{ t('pages.gaiop.users.activate') }}</NRadio><NRadio value="inactive">{{ t('pages.gaiop.users.deactivate') }}</NRadio></NSpace></NRadioGroup></NFormItem>
      <NFormItem label=""><NSpace><NButton @click="router.push({ name: 'UserManagement' })">{{ t('pages.gaiop.users.back') }}</NButton><NButton type="primary" :loading="saving" @click="submit">{{ t('pages.gaiop.users.submit') }}</NButton></NSpace></NFormItem>
    </NForm>
  </NCard>
</template>

<style scoped>
.create-card { min-height: 500px; }
.page-alert { margin-bottom: 18px; }
.user-form { max-width: 680px; padding: 18px 8px; }
.static-value { color: var(--text-color-2); }
.password-hint { color: var(--text-secondary); font-size: 13px; }
</style>
