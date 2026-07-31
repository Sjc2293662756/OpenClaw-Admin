<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NButton, NCard, NIcon, NSpace, NText } from 'naive-ui'
import { ArrowBackOutline, GridOutline, LockClosedOutline } from '@vicons/ionicons5'
import { ROLE_LABELS, type UserRole } from '@/permissions/access-control'
import { useAuthStore } from '@/stores/auth'

const route = useRoute()
const router = useRouter()
const authStore = useAuthStore()

const moduleName = computed(() => {
  const value = route.query.module
  return (typeof value === 'string' ? value : '') || '当前模块'
})

const roleLabel = computed(() => {
  const role = authStore.currentUser?.role as UserRole | undefined
  return role ? ROLE_LABELS[role] : '未知角色'
})

function goBack() {
  const value = route.query.returnTo
  const returnTo = typeof value === 'string' ? value.trim() : ''
  if (returnTo.startsWith('/') && !returnTo.startsWith('//')) {
    void router.push(returnTo)
    return
  }
  void router.push({ name: 'Dashboard' })
}
</script>

<template>
  <div class="access-denied-page">
    <NCard :bordered="false" class="access-denied-card">
      <NSpace vertical align="center" :size="18">
        <span class="access-denied-icon">
          <NIcon :component="LockClosedOutline" />
        </span>
        <div class="access-denied-copy">
          <h1>无访问权限</h1>
          <NText depth="3">当前访问模块：{{ moduleName }}</NText>
          <NText depth="3">当前用户角色：{{ roleLabel }}</NText>
          <p>当前账户无权访问此功能，如需使用请联系管理员。</p>
        </div>
        <NSpace :size="10">
          <NButton secondary @click="goBack">
            <template #icon><NIcon :component="ArrowBackOutline" /></template>
            返回上一页
          </NButton>
          <NButton type="primary" @click="router.push({ name: 'Dashboard' })">
            <template #icon><NIcon :component="GridOutline" /></template>
            返回仪表盘
          </NButton>
        </NSpace>
      </NSpace>
    </NCard>
  </div>
</template>

<style scoped>
.access-denied-page {
  display: grid;
  min-height: calc(100vh - var(--header-height) - 48px);
  place-items: center;
}

.access-denied-card {
  width: min(560px, 100%);
  padding: 34px 24px;
  border: 1px solid var(--border-color);
  border-radius: 18px;
  box-shadow: var(--shadow-sm);
}

.access-denied-icon {
  display: grid;
  width: 70px;
  height: 70px;
  place-items: center;
  border-radius: 22px;
  background: color-mix(in srgb, var(--primary-color) 12%, transparent);
  color: var(--primary-color);
  font-size: 34px;
}

.access-denied-copy {
  display: grid;
  justify-items: center;
  gap: 7px;
  text-align: center;
}

.access-denied-copy h1 {
  margin: 0 0 4px;
  color: var(--text-primary);
  font-size: 26px;
}

.access-denied-copy p {
  margin: 10px 0 0;
  color: var(--text-secondary);
  line-height: 1.7;
}
</style>
