<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { NAlert, NButton, NButtonGroup, NCollapse, NCollapseItem, NInput, NSpace, NSpin, NSwitch, NTag, useDialog, useMessage } from 'naive-ui'
import { useAuthStore } from '@/stores/auth'
import { localizeApiError } from '@/utils/api-error'
import type { ModulePermissionKey } from '@/permissions/access-control'

type OverrideEffect = 'allow' | 'deny' | null
type Risk = 'low' | 'medium' | 'high' | 'critical'
type ModuleRow = {
  moduleKey: ModulePermissionKey
  name: string
  group: '数据范围' | '业务管理' | '系统运维' | '高级管理'
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
const emit = defineEmits<{
  (event: 'dirty-change', value: boolean): void
  (event: 'saving-change', value: boolean): void
}>()
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
const groups: ModuleRow['group'][] = ['数据范围', '业务管理', '系统运维', '高级管理']
const hiddenModuleKeys = new Set<string>(['alerts.export', 'users', 'userAdministration', 'platformBranding'])
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

function normalizeModuleRow(row: ModuleRow, user: Projection['user']): ModuleRow {
  if (user.isInitialAdmin) {
    return {
      ...row,
      override: null,
      effectiveAllowed: true,
      locked: true,
      lockReason: '初始管理员为最高权限账户，模块权限固定允许',
    }
  }
  return row
}

function applyProjection(next: Projection) {
  const normalized = {
    ...next,
    modules: next.modules
      .filter((row) => !hiddenModuleKeys.has(String(row.moduleKey)))
      .map((row) => normalizeModuleRow(row, next.user)),
  }
  projection.value = normalized
  resetDraft(normalized)
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
    applyProjection(body as Projection)
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : '读取模块权限失败'
  } finally {
    loading.value = false
  }
}

function rowByKey(key: ModulePermissionKey) {
  return projection.value?.modules.find((row) => row.moduleKey === key)
}

function dependencyText(row: ModuleRow) {
  return row.dependencies.map((key) => rowByKey(key)?.name || key).join('、')
}

function draftEffect(row: ModuleRow): OverrideEffect {
  return draft.value[row.moduleKey] ?? null
}

function draftAllowed(row: ModuleRow): boolean {
  if (row.locked) return row.effectiveAllowed
  const effect = draftEffect(row)
  return effect === 'allow' ? true : effect === 'deny' ? false : row.defaultAllowed
}

function setRawEffect(row: ModuleRow, effect: OverrideEffect) {
  if (row.locked) return
  draft.value = {
    ...draft.value,
    [row.moduleKey]: effect,
  }
}

function setEffect(row: ModuleRow, effect: OverrideEffect) {
  setRawEffect(row, effect)
  if (effect === 'allow') {
    for (const dependency of row.dependencies) {
      const dependencyRow = rowByKey(dependency)
      if (dependencyRow && !draftAllowed(dependencyRow)) setRawEffect(dependencyRow, 'allow')
    }
  } else if (effect === 'deny') {
    for (const dependent of projection.value?.modules || []) {
      if (dependent.dependencies.includes(row.moduleKey) && draftAllowed(dependent)) setRawEffect(dependent, 'deny')
    }
  }
}

function restoreRow(row: ModuleRow) {
  if (row.locked) return
  setRawEffect(row, null)
}

function statusText(row: ModuleRow) {
  const effect = draftEffect(row)
  if (effect === 'allow') return '个人允许'
  if (effect === 'deny') return '个人拒绝'
  return '跟随角色'
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
watch(changes, (value) => emit('dirty-change', value.length > 0), { immediate: true })
watch(saving, (value) => emit('saving-change', value), { immediate: true })

function adjustedCount(group: ModuleRow['group']) {
  return (projection.value?.modules || []).filter((row) => row.group === group && draftEffect(row)).length
}
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
    applyProjection(body as Projection)
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
        <h3>模块访问与数据范围</h3>
        <p v-if="projection?.user.isInitialAdmin">初始管理员权限固定允许，仅供查看。</p>
        <p v-else>个人设置覆盖角色默认；数据范围只在已开放的对应模块内生效。</p>
      </div>
      <NButton :loading="loading" @click="load">刷新</NButton>
    </div>
    <NSpin :show="loading">
      <NAlert v-if="error" type="error" :bordered="false">{{ error }}</NAlert>
      <template v-else-if="projection">
        <div class="permission-toolbar">
          <NInput v-model:value="search" clearable placeholder="搜索模块或数据范围" />
          <label class="adjusted-filter"><NSwitch v-model:value="adjustedOnly" size="small" /> 只看个人调整</label>
        </div>
        <NAlert v-if="dependencyConflicts.length" type="error" :bordered="false" class="dependency-alert">
          依赖冲突：{{ dependencyConflicts.map(item => `${item.moduleKey} 需要 ${item.missing.join('、')}`).join('；') }}
        </NAlert>
        <NCollapse :default-expanded-names="groups" class="permission-groups">
          <NCollapseItem v-for="group in groups" v-show="visibleByGroup[group].length" :key="group" :name="group">
            <template #header>
              <span class="group-title">{{ group }}<NTag size="small" :bordered="false">{{ visibleByGroup[group].length }} 项</NTag></span>
            </template>
            <template #header-extra>
              <span class="group-adjusted">{{ adjustedCount(group) }} 项个人调整</span>
            </template>
            <div class="permission-table">
              <div class="permission-columns" aria-hidden="true">
                <span>模块 / 数据范围</span>
                <span>角色默认</span>
                <span>个人设置</span>
                <span>操作</span>
              </div>
              <article v-for="row in visibleByGroup[group]" :key="row.moduleKey" class="permission-row">
                <div class="module-copy">
                  <div class="module-title" :title="row.moduleKey">
                    <strong>{{ row.name }}</strong>
                    <NTag v-if="row.risk === 'high' || row.risk === 'critical'" :type="riskType[row.risk]" size="small" :bordered="false">
                      {{ riskLabel[row.risk] }}风险
                    </NTag>
                  </div>
                  <p>{{ row.dataScope }}</p>
                  <small v-if="row.dependencies.length">依赖：{{ dependencyText(row) }}</small>
                  <small v-if="row.lockReason">{{ row.lockReason }}</small>
                </div>
                <div class="default-cell">
                  <NTag :type="row.defaultAllowed ? 'success' : 'default'" size="small" :bordered="false">
                    {{ row.defaultAllowed ? '允许' : '不允许' }}
                  </NTag>
                </div>
                <NButtonGroup class="effect-switch">
                  <NButton size="small" :type="draftEffect(row) === null ? 'primary' : 'default'" :secondary="draftEffect(row) === null" :disabled="row.locked" @click="setEffect(row, null)">角色默认</NButton>
                  <NButton size="small" :type="draftEffect(row) === 'allow' ? 'success' : 'default'" :secondary="draftEffect(row) === 'allow'" :disabled="row.locked" @click="setEffect(row, 'allow')">允许</NButton>
                  <NButton size="small" :type="draftEffect(row) === 'deny' ? 'error' : 'default'" :secondary="draftEffect(row) === 'deny'" :disabled="row.locked" @click="setEffect(row, 'deny')">拒绝</NButton>
                </NButtonGroup>
                <div class="action-cell">
                  <NButton
                    size="small"
                    secondary
                    :disabled="row.locked || !draftEffect(row)"
                    :title="row.locked ? (row.lockReason || '该权限已锁定') : (!draftEffect(row) ? '当前已是角色默认' : '恢复为角色默认')"
                    @click="restoreRow(row)"
                  >恢复默认</NButton>
                </div>
              </article>
            </div>
          </NCollapseItem>
        </NCollapse>
        <div class="permission-footer">
          <span v-if="projection.user.isInitialAdmin">初始管理员权限固定，无个人覆盖</span>
          <span v-else-if="!stagedOverrides.length && !changes.length">尚无个人调整</span>
          <span v-else>个人增加 {{ counts.allow }} 项 · 个人削减 {{ counts.deny }} 项 · 待保存 {{ counts.changed }} 项</span>
          <NSpace>
            <NButton
              :disabled="projection.user.isInitialAdmin || !stagedOverrides.length"
              :loading="saving"
              :title="projection.user.isInitialAdmin ? '初始管理员权限固定' : (!stagedOverrides.length ? '当前全部跟随角色默认' : '恢复全部角色默认权限')"
              @click="confirmRestoreAll"
            >全部恢复默认</NButton>
            <NButton type="primary" :disabled="projection.user.isInitialAdmin || !changes.length || Boolean(dependencyConflicts.length)" :loading="saving" @click="confirmSave">保存权限</NButton>
          </NSpace>
        </div>
      </template>
    </NSpin>
  </section>
</template>

<style scoped>
.permission-panel { min-width: 0; }
.permission-heading, .permission-toolbar, .permission-footer { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.permission-heading h3 { margin: 0 0 5px; }
.permission-heading p { margin: 0; color: var(--text-color-3); }
.permission-toolbar { margin: 18px 0; }
.permission-toolbar :deep(.n-input) { max-width: 430px; }
.adjusted-filter { display: flex; align-items: center; gap: 8px; white-space: nowrap; }
.dependency-alert { margin-bottom: 14px; }
.permission-groups { margin-top: 4px; }
.group-title { display: inline-flex; align-items: center; gap: 8px; font-weight: 600; }
.group-adjusted { color: var(--text-color-3); font-size: 13px; }
.permission-table { border-top: 1px solid var(--border-color); }
.permission-columns, .permission-row { display: grid; grid-template-columns: minmax(240px, 1fr) 82px minmax(270px, 320px) 92px; align-items: center; gap: 16px; }
.permission-columns { padding: 8px 2px; border-bottom: 1px solid var(--border-color); color: var(--text-color-3); font-size: 12px; font-weight: 600; }
.permission-row { min-height: 76px; padding: 11px 2px; border-bottom: 1px solid var(--border-color); }
.module-copy { display: grid; align-content: center; gap: 4px; min-width: 0; }
.module-title { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; }
.module-copy p { margin: 0; color: var(--text-color-2); font-size: 13px; line-height: 1.45; }
.module-copy small { color: var(--text-color-3); }
.default-cell, .action-cell { display: flex; align-items: center; gap: 8px; min-width: 0; }
.effect-switch { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); }
.effect-switch :deep(.n-button) { width: 100%; }
.permission-footer { position: sticky; bottom: 0; z-index: 2; margin-top: 18px; padding: 14px 0; border-top: 1px solid var(--border-color); background: var(--bg-card, #fff); }
@media (max-width: 760px) {
  .permission-heading, .permission-toolbar, .permission-footer { align-items: stretch; flex-direction: column; }
  .permission-columns { display: none; }
  .permission-row { grid-template-columns: 1fr; gap: 10px; padding: 14px 2px; }
  .default-cell::before { content: '角色默认'; min-width: 64px; color: var(--text-color-3); font-size: 12px; }
  .action-cell::before { content: '操作'; min-width: 64px; color: var(--text-color-3); font-size: 12px; }
  .permission-footer :deep(.n-space) { justify-content: flex-end; }
}
@media (max-width: 460px) {
  .permission-footer :deep(.n-space) { display: grid !important; grid-template-columns: 1fr 1fr; }
  .permission-footer :deep(.n-button) { width: 100%; }
}
</style>
