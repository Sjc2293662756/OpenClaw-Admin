<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NAlert, NButton, NCard, NForm, NFormItem, NInput, NRadio, NRadioGroup, NSelect, NSpace, NSpin, useMessage, type FormInst, type FormRules } from 'naive-ui'
import { useAuthStore } from '@/stores/auth'

type UserRole = 'basic' | 'auditor' | 'standard' | 'admin'
type UserStatus = 'active' | 'inactive'
type ManagedUser = { id: string; username: string; role: UserRole; description: string; status: UserStatus }

const route = useRoute()
const router = useRouter()
const authStore = useAuthStore()
const message = useMessage()
const formRef = ref<FormInst | null>(null)
const loading = ref(true)
const saving = ref(false)
const loadError = ref('')
const userId = computed(() => String(route.params.id || ''))
const isAdmin = computed(() => authStore.isAdmin)
const isCurrentUser = computed(() => authStore.currentUser?.id === userId.value)
const form = reactive({ username: '', description: '', role: 'basic' as UserRole, status: 'active' as UserStatus })

const roleOptions = [
  { label: '基础用户', value: 'basic' },
  { label: '审计用户', value: 'auditor' },
  { label: '标准用户', value: 'standard' },
  { label: '管理员', value: 'admin' },
]
const rules: FormRules = {
  role: [{ required: true, message: '请选择用户类型', trigger: ['change', 'blur'] }],
  description: [{ max: 500, message: '描述不能超过 500 个字符', trigger: ['input', 'blur'] }],
}

function headers(contentType = false) {
  return {
    ...(contentType ? { 'Content-Type': 'application/json' } : {}),
    Authorization: `Bearer ${authStore.getToken()}`,
  }
}

async function loadUser() {
  loading.value = true
  loadError.value = ''
  try {
    if (!isAdmin.value) throw new Error('仅管理员可以编辑用户')
    const response = await fetch('/api/users', { headers: headers() })
    const data = await response.json()
    if (!response.ok || !data.ok) throw new Error(data.error || '获取用户信息失败')
    const user = (data.users as ManagedUser[]).find(item => item.id === userId.value)
    if (!user) throw new Error('用户不存在或已被删除')
    form.username = user.username
    form.description = user.description || ''
    form.role = user.role
    form.status = user.status
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : '获取用户信息失败'
  } finally {
    loading.value = false
  }
}

async function submit() {
  try { await formRef.value?.validate() } catch { return }
  saving.value = true
  try {
    const response = await fetch(`/api/users/${userId.value}`, {
      method: 'PUT',
      headers: headers(true),
      body: JSON.stringify({ role: form.role, description: form.description, status: form.status }),
    })
    const data = await response.json()
    if (!response.ok || !data.ok) throw new Error(data.error || '保存用户失败')
    message.success('用户信息已更新')
    router.push({ name: 'UserManagement' })
  } catch (error) {
    message.error(error instanceof Error ? error.message : '保存用户失败')
  } finally {
    saving.value = false
  }
}

onMounted(loadUser)
</script>

<template>
  <NCard title="编辑用户" :bordered="false" class="edit-card">
    <NSpin :show="loading">
      <div v-if="loadError" class="load-error">
        <NAlert type="error" :bordered="false">{{ loadError }}</NAlert>
        <NButton size="small" @click="loadUser">重试</NButton>
      </div>
      <template v-else>
        <NAlert v-if="isCurrentUser" type="info" :bordered="false" class="page-alert">
          当前登录账户可以修改描述，但不能修改自身角色或将账户停用。
        </NAlert>
        <NForm ref="formRef" :model="form" :rules="rules" label-placement="left" label-width="100" class="user-form">
          <NFormItem label="用户名"><NInput v-model:value="form.username" disabled /></NFormItem>
          <NFormItem label="描述" path="description"><NInput v-model:value="form.description" type="textarea" placeholder="可选，用于说明该账户用途" maxlength="500" show-count :autosize="{ minRows: 3, maxRows: 5 }" /></NFormItem>
          <NFormItem label="用户类型" path="role" required><NSelect v-model:value="form.role" :disabled="isCurrentUser" :options="roleOptions" /></NFormItem>
          <NFormItem label="状态"><NRadioGroup v-model:value="form.status" :disabled="isCurrentUser"><NSpace><NRadio value="active">激活</NRadio><NRadio value="inactive">非激活</NRadio></NSpace></NRadioGroup></NFormItem>
          <NFormItem label=""><NSpace><NButton @click="router.push({ name: 'UserManagement' })">返回</NButton><NButton type="primary" :loading="saving" @click="submit">保存</NButton></NSpace></NFormItem>
        </NForm>
      </template>
    </NSpin>
  </NCard>
</template>

<style scoped>
.edit-card { min-height: 500px; }
.page-alert { margin-bottom: 18px; }
.load-error { display: flex; align-items: center; gap: 12px; margin-bottom: 18px; }
.load-error :deep(.n-alert) { flex: 1; }
.user-form { max-width: 680px; padding: 18px 8px; }
</style>
