<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NAlert, NButton, NCard, NForm, NFormItem, NInput, NSpace, useMessage, type FormInst, type FormRules } from 'naive-ui'
import { useAuthStore } from '@/stores/auth'
import { isValidPassword, passwordPolicyMessage } from '@/utils/password-policy'
import { localizeApiError } from '@/utils/api-error'
import { resolvePasswordChangeReturn } from '@/permissions/access-control'
import { useI18n } from 'vue-i18n'
import type { AppLocale } from '@/i18n/locale'

const router = useRouter()
const route = useRoute()
const authStore = useAuthStore()
const message = useMessage()
const { t, locale } = useI18n()
const formRef = ref<FormInst | null>(null)
const saving = ref(false)
const form = reactive({ currentPassword: '', newPassword: '', confirmPassword: '' })
const passwordHint = computed(() => passwordPolicyMessage(locale.value as AppLocale))
const rules = computed<FormRules>(() => ({
  currentPassword: [{ required: true, message: locale.value === 'zh-CN' ? '请输入当前密码' : 'Enter the current password', trigger: ['input', 'blur'] }],
  newPassword: [
    { required: true, message: locale.value === 'zh-CN' ? '请输入新密码' : 'Enter a new password', trigger: ['input', 'blur'] },
    { validator: () => isValidPassword(form.newPassword), message: passwordHint.value, trigger: ['input', 'blur'] },
  ],
  confirmPassword: [{ required: true, message: locale.value === 'zh-CN' ? '请再次输入新密码' : 'Re-enter the new password', trigger: ['input', 'blur'] }, { validator: () => form.newPassword === form.confirmPassword, message: locale.value === 'zh-CN' ? '两次输入的密码不一致' : 'Passwords do not match', trigger: ['input', 'blur'] }],
}))
async function submit() {
  try { await formRef.value?.validate() } catch { return }
  if (!authStore.currentUser?.id) { message.error(locale.value === 'zh-CN' ? '当前用户信息失效，请重新登录' : 'Current user information is invalid. Please sign in again.'); return }
  saving.value = true
  try {
    const response = await fetch(`/api/users/${authStore.currentUser.id}/password`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authStore.getToken()}` }, body: JSON.stringify(form) })
    const data = await response.json()
    if (!response.ok || !data.ok) throw new Error(localizeApiError(data, t('pages.gaiop.users.passwordFailed')))
    message.success(t('pages.gaiop.users.passwordSuccess'))
    await authStore.logout()
    router.replace({ name: 'Welcome' })
  } catch (error) { message.error(error instanceof Error ? error.message : t('pages.gaiop.users.passwordFailed')) } finally { saving.value = false }
}

function returnFromPasswordChange() {
  const returnTo = typeof route.query.returnTo === 'string' ? route.query.returnTo : undefined
  void router.push(resolvePasswordChangeReturn(authStore.currentUser?.effectiveModules, returnTo))
}
</script>

<template>
  <NCard :title="t('pages.gaiop.users.password')" :bordered="false" class="password-card">
    <NAlert v-if="authStore.currentUser?.mustChangePassword" type="warning" :bordered="false" class="password-alert">
      {{ t('pages.gaiop.users.forcedChange') }}
    </NAlert>
    <NForm ref="formRef" :model="form" :rules="rules" label-placement="left" label-width="100" class="password-form">
      <NFormItem :label="t('pages.gaiop.users.currentPassword')" path="currentPassword" required><NInput v-model:value="form.currentPassword" type="password" show-password-on="click" :placeholder="t('pages.gaiop.users.passwordPlaceholder')" /></NFormItem>
      <NFormItem :label="t('pages.gaiop.users.newPassword')" path="newPassword" required><NInput v-model:value="form.newPassword" type="password" show-password-on="click" :placeholder="t('pages.gaiop.users.passwordPlaceholder')" /></NFormItem>
      <NFormItem :label="t('pages.gaiop.users.confirmPassword')" path="confirmPassword" required><NInput v-model:value="form.confirmPassword" type="password" show-password-on="click" :placeholder="t('pages.gaiop.users.confirmPasswordPlaceholder')" /></NFormItem>
      <NFormItem label=""><span class="password-hint">{{ passwordHint }}</span></NFormItem>
      <NFormItem label=""><NSpace><NButton v-if="!authStore.currentUser?.mustChangePassword" @click="returnFromPasswordChange">{{ t('pages.gaiop.users.back') }}</NButton><NButton type="primary" :loading="saving" @click="submit">{{ t('pages.gaiop.users.submit') }}</NButton></NSpace></NFormItem>
    </NForm>
  </NCard>
</template>

<style scoped>
.password-card { min-height: 420px; }
.password-alert { margin-bottom: 18px; }
.password-form { max-width: 620px; padding: 22px 8px; }
.password-hint { color: var(--text-secondary); font-size: 13px; }
</style>
