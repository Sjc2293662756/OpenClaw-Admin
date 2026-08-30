<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NAlert, NButton, NCheckbox, NInput, NSpace, NSpin, NSwitch, NTag, useDialog, useMessage } from 'naive-ui'
import { useAuthStore } from '@/stores/auth'
import { localizeApiError } from '@/utils/api-error'
import type { ModulePermissionKey } from '@/permissions/access-control'

type OverrideEffect = 'allow' | 'deny' | null
type Risk = 'low' | 'medium' | 'high' | 'critical'
type ModuleRow = {
  moduleKey: ModulePermissionKey
  name: string
  group: '业务管理' | '系统运维' | '高级管理'
  risk: Risk
  dependencies: ModulePermissionKey[]
  dataScope: string
  defaultAllowed: boolean
  override: OverrideEffect
  effectiveAllowed: boolean
  locked: boolean
  lockReason: string | null
}
type Projection = {
  user: { id: string; username: string; role: string; status: string; isInitialAdmin: boolean }
  permissionVersion: number
  modules: ModuleRow[]
}

const props = defineProps<{ userId: string }>()
const authStore = useAuthStore()
const message = useMessage()
const dialog = useDialog()
const loading = ref(true)
const saving = ref(false)
const error = ref('')
const projection = ref<Projection | null>(null)
const draft = ref<Partial<Record<ModulePermissionKey, OverrideEffect>>>({})
const search = ref('')
const adjustedOnly = ref(false)
const groups: ModuleRow['group'][] = ['业务管理', '系统运维', '高级管理']
const riskType: Record<Risk, 'success' | 'info' | 'warning' | 'error'> = {
  low: 'success', medium: 'info', high: 'warning', critical: 'error',
}
const riskLabel: Record<Risk, string> = { low: '低', medium: '中', high: '高', critical: '严重' }

function headers(json = false) {
  return {
    ...(json ? { 'Content-Type': 'application/json' } : {}),
    Authorization: `Bearer ${authStore.getToken() || ''}`,
  }
}

function resetDraft(next: Projection) {
  draft.value = Object.fromEntries(next.modules.map((row) => [row.moduleKey, row.override]))
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const response = await fetch(`/api/users/${encodeURIComponent(props.userId)}/module-permissions`, { headers: headers() })
    const body = await response.json().catch(() => null)
    if (!response.ok || !body?.ok || !Array.isArray(body.modules)) {
      throw new Error(localizeApiError(body, '读取模块权限失败'))
    }
    projection.value = body as Projection
    resetDraft(projection.value)
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '读取模块权限失败'
  } finally {
    loading.value = false
  }
}

function rowByKey(key: ModulePermissionKey) {
  return projection.value?.modules.find((row) => row.moduleKey === key)
}

function draftEffect(row: ModuleRow): OverrideEffect {
  return draft.value[row.moduleKey] ?? null
}

function draftAllowed(row: ModuleRow): boolean {
  if (row.locked) return row.effectiveAllowed
  const effect = draftEffect(row)
  return effect === 'allow' ? true : effect === 'deny' ? false : row.defaultAllowed
}

function setRawAllowed(row: ModuleRow, allowed: boolean) {
  if (row.locked) return
  draft.value = {
    ...draft.value,
    [row.moduleKey]: allowed === row.defaultAllowed ? null : allowed ? 'allow' : 'deny',
  }
}

function setAllowed(row: ModuleRow, allowed: boolean) {
  setRawAllowed(row, allowed)
  if (allowed) {
    for (const dependency of row.dependencies) {
      const dependencyRow = rowByKey(dependency)
      if (dependencyRow) setRawAllowed(dependencyRow, true)
    }
  } else {
    for (const dependent of projection.value?.modules || []) {
      if (dependent.dependencies.includes(row.moduleKey) && draftAllowed(dependent)) setRawAllowed(dependent, false)
    }
  }
}

function restoreRow(row: ModuleRow) {
  if (row.locked) return
  draft.value = { ...draft.value, [row.moduleKey]: null }
}

function statusText(row: ModuleRow) {
  const effect = draftEffect(row)
  if (effect === 'allow') return '个人增加'
  if (effect === 'deny') return '个人削减'
  return '跟随角色'
}

function statusType(row: ModuleRow): 'success' | 'error' | 'default' {
  const effect = draftEffect(row)
  return effect === 'allow' ? 'success' : effect === 'deny' ? 'error' : 'default'
}

const visibleByGroup = computed(() => {
  const needle = search.value.trim().toLowerCase()
  return Object.fromEntries(groups.map((group) => [group, (projection.value?.modules || []).filter((row) => {
    if (row.group !== group) return false
    if (adjustedOnly.value && !draftEffect(row)) return false
    if (!needle) return true
    return `${row.name} ${row.moduleKey} ${row.dataScope}`.toLowerCase().includes(needle)
  })])) as Record<ModuleRow['group'], ModuleRow[]>
})

const changes = computed(() => (projection.value?.modules || []).filter((row) => draftEffect(row) !== row.override))
const stagedOverrides = computed(() => (projection.value?.modules || [])
  .map((row) => ({ moduleKey: row.moduleKey, effect: draftEffect(row) }))
  .filter((item): item is { moduleKey: ModulePermissionKey; effect: Exclude<OverrideEffect, null> } => item.effect !== null))
const counts = computed(() => ({
  allow: stagedOverrides.value.filter((item) => item.effect === 'allow').length,
  deny: stagedOverrides.value.filter((item) => item.effect === 'deny').length,
  changed: changes.value.length,
}))
const dependencyConflicts = computed(() => (projection.value?.modules || []).flatMap((row) => {
  if (!draftAllowed(row)) return []
  const missing = row.dependencies.filter((key) => {
    const dependency = rowByKey(key)
    return !dependency || !draftAllowed(dependency)
  })
  return missing.length ? [{ moduleKey: row.moduleKey, missing }] : []
}))

function changeLines() {
  const added = changes.value.filter((row) => !row.effectiveAllowed && draftAllowed(row)).map((row) => row.name)
  const denied = changes.value.filter((row) => row.effectiveAllowed && !draftAllowed(row)).map((row) => row.name)
  const overrideChanges = changes.value.filter((row) => row.effectiveAllowed === draftAllowed(row)).map((row) => `${row.name}（${statusText(row)}）`)
  return [
    `增加：${added.join('、') || '无'}`,
    `削减：${denied.join('、') || '无'}`,
    `其他覆盖变化：${overrideChanges.join('、') || '无'}`,
  ].join('\n')
}

async function persist(overrides = stagedOverrides.value, method: 'PUT' | 'DELETE' = 'PUT') {
  if (!projection.value) return
  saving.value = true
  try {
    const payload = method === 'PUT'
      ? { expectedVersion: projection.value.permissionVersion, overrides }
      : { expectedVersion: projection.value.permissionVersion }
    const response = await fetch(`/api/users/${encodeURIComponent(props.userId)}/module-permissions`, {
      method,
      headers: headers(true),
      body: JSON.stringify(payload),
    })
    const body = await response.json().catch(() => null)
    if (!response.ok || !body?.ok) {
      if (response.status === 409) await load()
      throw new Error(localizeApiError(body, response.status === 409 ? '权限版本冲突，已刷新最新数据' : '保存模块权限失败'))
    }
    projection.value = body as Projection
    resetDraft(projection.value)
    message.success(method === 'DELETE' ? '已恢复角色默认权限' : '模块权限已保存')
  } catch (reason) {
    message.error(reason instanceof Error ? reason.message : '保存模块权限失败')
  } finally {
    saving.value = false
  }
}

function confirmSave() {
  if (!changes.value.length || dependencyConflicts.value.length) return
  const hasHighRisk = changes.value.some((row) => row.risk === 'high' || row.risk === 'critical')
  dialog.warning({
    title: '核对模块权限差异',
    content: changeLines(),
    positiveText: hasHighRisk ? '差异无误，继续' : '确认保存',
    negativeText: '取消',
    onPositiveClick: () => {
      if (!hasHighRisk) return persist()
      const highRiskNames = changes.value
        .filter((row) => row.risk === 'high' || row.risk === 'critical')
        .map((row) => row.name)
        .join('、')
      dialog.error({
        title: '二次确认高风险模块变更',
        content: `以下高风险模块将立即影响目标用户在线权限：${highRiskNames}。请再次确认。`,
        positiveText: '确认高风险变更并保存',
        negativeText: '取消',
        onPositiveClick: () => persist(),
      })
    },
  })
}

function confirmRestoreAll() {
  if (!stagedOverrides.value.length) return
  dialog.warning({
    title: '恢复全部角色默认权限',
    content: '将删除该用户的全部个人模块覆盖，且立即影响其在线会话。',
    positiveText: '确认恢复',
    negativeText: '取消',
    onPositiveClick: () => persist([], 'DELETE'),
  })
}

onMounted(load)
</script>

<template>
  <section class="permission-panel">
    <div class="permission-heading">
      <div>
        <h3>模块权限</h3>
        <p>未调整时跟随角色默认；勾选表示最终允许。对话工作台不在此目录中。</p>
      </div>
      <NButton :loading="loading" @click="load">刷新</NButton>
    </div>
    <NSpin :show="loading">
      <NAlert v-if="error" type="error" :bordered="false">{{ error }}</NAlert>
      <template v-else-if="projection">
        <div class="permission-toolbar">
          <NInput v-model:value="search" clearable placeholder="搜索模块、key 或数据范围" />
          <label class="adjusted-filter"><NSwitch v-model:value="adjustedOnly" size="small" /> 只看个人调整</label>
        </div>
        <NAlert v-if="dependencyConflicts.length" type="error" :bordered="false" class="dependency-alert">
          依赖冲突：{{ dependencyConflicts.map(item => `${item.moduleKey} 需要 ${item.missing.join('、')}`).join('；') }}
        </NAlert>
        <div v-for="group in groups" :key="group" class="permission-group">
          <h4 v-if="visibleByGroup[group].length">{{ group }}</h4>
          <div v-if="visibleByGroup[group].length" class="permission-table">
            <div class="permission-row permission-row--head">
              <span>模块</span><span>角色默认</span><span>最终允许</span><span>状态</span><span>风险 / 数据范围</span><span></span>
            </div>
            <div v-for="row in visibleByGroup[group]" :key="row.moduleKey" class="permission-row">
              <span class="module-name"><strong>{{ row.name }}</strong><code>{{ row.moduleKey }}</code></span>
              <span>{{ row.defaultAllowed ? '允许' : '不允许' }}</span>
              <span><NCheckbox :checked="draftAllowed(row)" :disabled="row.locked" @update:checked="value => setAllowed(row, value)" /></span>
              <span><NTag :type="statusType(row)" :bordered="false">{{ statusText(row) }}</NTag></span>
              <span class="scope"><NTag :type="riskType[row.risk]" size="small" :bordered="false">{{ riskLabel[row.risk] }}</NTag>{{ row.dataScope }}<small v-if="row.dependencies.length">依赖：{{ row.dependencies.join('、') }}</small><small v-if="row.lockReason">{{ row.lockReason }}</small></span>
              <span><NButton text size="small" :disabled="row.locked || !draftEffect(row)" @click="restoreRow(row)">恢复默认</NButton></span>
            </div>
          </div>
        </div>
        <div class="permission-footer">
          <span>个人增加 {{ counts.allow }} 项 · 个人削减 {{ counts.deny }} 项 · 待保存 {{ counts.changed }} 项</span>
          <NSpace>
            <NButton :disabled="!stagedOverrides.length" :loading="saving" @click="confirmRestoreAll">全部恢复默认</NButton>
            <NButton type="primary" :disabled="!changes.length || Boolean(dependencyConflicts.length)" :loading="saving" @click="confirmSave">统一保存权限</NButton>
          </NSpace>
        </div>
      </template>
    </NSpin>
  </section>
</template>

<style scoped>
.permission-panel { margin-top: 28px; border-top: 1px solid var(--border-color); padding-top: 22px; }
.permission-heading, .permission-toolbar, .permission-footer { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.permission-heading h3 { margin: 0 0 5px; }
.permission-heading p { margin: 0; color: var(--text-color-3); }
.permission-toolbar { margin: 18px 0; }
.permission-toolbar :deep(.n-input) { max-width: 430px; }
.adjusted-filter { display: flex; align-items: center; gap: 8px; white-space: nowrap; }
.dependency-alert { margin-bottom: 14px; }
.permission-group h4 { margin: 20px 0 8px; }
.permission-table { overflow-x: auto; border: 1px solid var(--border-color); border-radius: 8px; }
.permission-row { display: grid; grid-template-columns: minmax(180px, 1.2fr) 90px 80px 105px minmax(280px, 2fr) 88px; align-items: center; min-width: 950px; border-top: 1px solid var(--border-color); }
.permission-row:first-child { border-top: 0; }
.permission-row > span { padding: 11px 12px; }
.permission-row--head { background: var(--table-header-color); color: var(--text-color-2); font-size: 13px; font-weight: 600; }
.module-name, .scope { display: grid; gap: 4px; }
.module-name code { color: var(--text-color-3); font-size: 12px; }
.scope { color: var(--text-color-2); font-size: 13px; }
.scope :deep(.n-tag) { width: max-content; }
.scope small { color: var(--text-color-3); }
.permission-footer { position: sticky; bottom: 0; z-index: 2; margin-top: 18px; padding: 14px 0; background: var(--card-color); }
@media (max-width: 760px) { .permission-heading, .permission-toolbar, .permission-footer { align-items: stretch; flex-direction: column; } }
</style>
