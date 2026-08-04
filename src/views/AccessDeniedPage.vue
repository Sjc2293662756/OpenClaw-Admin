<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NButton, NCard, NIcon, NSpace, NText } from 'naive-ui'
import { ArrowBackOutline, GridOutline, LockClosedOutline } from '@vicons/ionicons5'
import { ROLE_LABELS, type UserRole } from '@/permissions/access-control'
import { useAuthStore } from '@/stores/auth'
import { useI18n } from 'vue-i18n'

const route = useRoute()
const router = useRouter()
const authStore = useAuthStore()
const { t } = useI18n()

const moduleName = computed(() => {
  const value = route.query.module
  return (typeof value === 'string' ? value : '') || t('pages.gaiop.accessDenied.currentModule')
})

const roleLabel = computed(() => {
  const role = authStore.currentUser?.role as UserRole | undefined
  if (!role) return t('pages.gaiop.accessDenied.unknownRole')
  const labels: Record<UserRole, string> = {
    basic: t('pages.gaiop.users.basic'),
    auditor: t('pages.gaiop.users.auditor'),
    standard: t('pages.gaiop.users.standard'),
    admin: t('pages.gaiop.users.admin'),
  }
  return labels[role] || ROLE_LABELS[role]
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
          <h1>{{ t('pages.gaiop.accessDenied.title') }}</h1>
          <NText depth="3">{{ t('pages.gaiop.accessDenied.module', { module: moduleName }) }}</NText>
          <NText depth="3">{{ t('pages.gaiop.accessDenied.role', { role: roleLabel }) }}</NText>
          <p>{{ t('pages.gaiop.accessDenied.description') }}</p>
        </div>
        <NSpace :size="10">
          <NButton secondary @click="goBack">
            <template #icon><NIcon :component="ArrowBackOutline" /></template>
            {{ t('pages.gaiop.accessDenied.back') }}
          </NButton>
          <NButton type="primary" @click="router.push({ name: 'Dashboard' })">
            <template #icon><NIcon :component="GridOutline" /></template>
            {{ t('pages.gaiop.accessDenied.dashboard') }}
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
