<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { NAlert, NButton, NCard, NDescriptions, NDescriptionsItem, NEmpty, NGrid, NGridItem, NIcon, NInput, NModal, NProgress, NSpin, NTable, NTag, useMessage } from 'naive-ui'
import { RefreshOutline } from '@vicons/ionicons5'
import { useAuthStore } from '@/stores/auth'
import { useI18n } from 'vue-i18n'
import { localizeApiError } from '@/utils/api-error'

type RuntimeState = 'not-configured' | 'reachable' | 'unavailable'
interface ComponentInfo { version: string; status: string }
interface UpgradeStatus { openclaw: ComponentInfo | null; frontend: ComponentInfo | null; skills: Record<string, ComponentInfo>; maintenance_mode: boolean }
interface UpgradeTask { id: string; type: string; component?: string; status: string; created_at?: string }
interface Backup { id: number; component: string; version: string; sizeBytes: number; createdAt?: string | null }
interface Overview {
  runtime: { state: RuntimeState; serviceVersion: string | null; lastErrorCode: string | null }
  status: UpgradeStatus | null
  tasks: UpgradeTask[]
  backups: Backup[]
}
interface ValidationResult {
  valid: boolean
  taskId: string | null
  type: string | null
  component: string | null
  currentVersion: string | null
  newVersion: string | null
  displayName: string | null
  changelog: string | null
  warnings: unknown[]
  errors: Array<{ field: string; message: string }>
  impact: { requiresRestart: boolean; requiresMaintenance: boolean; estimatedDowntimeSeconds: number | null } | null
}
interface TaskDetail {
  id: string | null
  type: string | null
  component: string | null
  oldVersion: string | null
  newVersion: string | null
  status: string
  progressPercent: number
  currentStep: string | null
  estimatedRemainingSeconds: number | null
  error: string | null
  startedAt: string | null
  finishedAt: string | null
  steps: Array<{ step: string; status: string; message: string | null }>
}

const authStore = useAuthStore()
const message = useMessage()
const { locale } = useI18n()
const text = (zhCN: string, enUS: string) => locale.value === 'zh-CN' ? zhCN : enUS
const loading = ref(false)
const overview = ref<Overview | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const selectedFile = ref<File | null>(null)
const validation = ref<ValidationResult | null>(null)
const validating = ref(false)
const executing = ref(false)
const showExecutionConfirm = ref(false)
const executionConfirmation = ref('')
const selectedBackup = ref<Backup | null>(null)
const backupAction = ref<'rollback' | 'delete'>('rollback')
const backupConfirmation = ref('')
const backupActionLoading = ref(false)
const showBackupConfirm = ref(false)
const activeTaskId = ref<string | null>(null)
const taskDetail = ref<TaskDetail | null>(null)
const taskDetailLoading = ref(false)
let taskPollTimer: number | null = null
const runtimeLabel = computed(() => ({ 'not-configured': text('待部署', 'Not configured'), reachable: text('服务可用', 'Available'), unavailable: text('服务不可用', 'Unavailable') }[overview.value?.runtime.state || 'not-configured']))
const runtimeType = computed(() => ({ 'not-configured': 'warning', reachable: 'success', unavailable: 'error' }[overview.value?.runtime.state || 'not-configured'] as 'warning' | 'success' | 'error'))
const skillEntries = computed(() => Object.entries(overview.value?.status?.skills || {}))

function headers() {
  return { Authorization: 'Bearer ' + (authStore.getToken() || '') }
}
function formatTime(value?: string) {
  if (!value) return text('未记录', 'Not recorded')
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(locale.value, { hour12: false })
}
function componentLabel(component?: ComponentInfo | null) {
  if (!component) return text('未发现', 'Not found')
  return (component.version || text('未知版本', 'Unknown version')) + ' · ' + (component.status || text('未知状态', 'Unknown status'))
}
function choosePackage() {
  fileInput.value?.click()
}
function onPackageSelected(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0] || null
  selectedFile.value = file
  validation.value = null
}
async function validatePackage() {
  if (!selectedFile.value) {
    message.warning(text('请先选择 ZIP 格式升级包', 'Select a ZIP upgrade package first'))
    return
  }
  validating.value = true
  try {
    const form = new FormData()
    form.append('file', selectedFile.value)
    const response = await fetch('/api/system-upgrade/validate', { method: 'POST', headers: headers(), body: form })
    const result = await response.json()
    if (!response.ok || !result.ok) throw new Error(localizeApiError(result, text('升级包校验失败', 'Upgrade package validation failed')))
    const validationResult = result.validation as ValidationResult | null
    if (!validationResult) throw new Error(text('升级服务未返回校验结果', 'The upgrade service returned no validation result'))
    validation.value = validationResult
    message[validationResult.valid ? 'success' : 'warning'](validationResult.valid ? text('升级包校验通过，请确认后执行', 'Package validation passed. Confirm to execute.') : text('升级包未通过校验', 'Package validation did not pass'))
    await loadOverview()
  } catch (error) {
    message.error(error instanceof Error ? error.message : text('升级包校验失败', 'Upgrade package validation failed'))
  } finally {
    validating.value = false
  }
}
function openExecutionConfirm() {
  executionConfirmation.value = ''
  showExecutionConfirm.value = true
}
function openBackupConfirm(backup: Backup, action: 'rollback' | 'delete') {
  selectedBackup.value = backup
  backupAction.value = action
  backupConfirmation.value = ''
  showBackupConfirm.value = true
}
async function confirmBackupAction() {
  const backup = selectedBackup.value
  if (!backup) return
  backupActionLoading.value = true
  try {
    const response = await fetch(
      '/api/system-upgrade/backups/' + backup.id + (backupAction.value === 'rollback' ? '/rollback' : ''),
      {
        method: backupAction.value === 'rollback' ? 'POST' : 'DELETE',
        headers: { ...headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmation: backupConfirmation.value }),
      },
    )
    const result = await response.json()
    if (!response.ok || !result.ok) throw new Error(localizeApiError(result, text('备份操作失败', 'Backup operation failed')))
    showBackupConfirm.value = false
    if (backupAction.value === 'rollback' && result.taskId) {
      message.success(text('回滚任务已提交', 'Rollback task submitted'))
      await loadOverview()
      await loadTaskDetail(result.taskId)
    } else {
      message.success(text('备份已删除', 'Backup deleted'))
      await loadOverview()
    }
  } catch (error) {
    message.error(error instanceof Error ? error.message : text('备份操作失败', 'Backup operation failed'))
  } finally {
    backupActionLoading.value = false
  }
}
function taskStepLabel(value: string | null) {
  return ({
    pre_check: text('预检', 'Pre-check'),
    backup: text('创建备份', 'Create backup'),
    replace: text('替换文件', 'Replace files'),
    reload: text('重载服务', 'Reload service'),
    smoke_test: text('健康检查', 'Health check'),
    finalize: text('收尾', 'Finalize'),
  } as Record<string, string>)[value || ''] || value || text('等待开始', 'Waiting to start')
}
function stopTaskPolling() {
  if (taskPollTimer !== null) window.clearTimeout(taskPollTimer)
  taskPollTimer = null
}
function isTaskActive(status?: string) {
  return status === 'pending' || status === 'running' || status === 'rolling_back'
}
function scheduleTaskPolling() {
  stopTaskPolling()
  if (!activeTaskId.value || !isTaskActive(taskDetail.value?.status)) return
  taskPollTimer = window.setTimeout(async () => {
    await loadTaskDetail(activeTaskId.value || '', true)
  }, 3_000)
}
async function loadTaskDetail(taskId: string, silent = false) {
  if (!taskId) return
  activeTaskId.value = taskId
  taskDetailLoading.value = true
  try {
    const response = await fetch('/api/system-upgrade/tasks/' + taskId, { headers: headers() })
    const result = await response.json()
    if (!response.ok || !result.ok) throw new Error(localizeApiError(result, text('读取升级任务详情失败', 'Failed to load upgrade task details')))
    taskDetail.value = result.task as TaskDetail
    if (!isTaskActive(taskDetail.value.status)) await loadOverview()
  } catch (error) {
    stopTaskPolling()
    if (!silent) message.error(error instanceof Error ? error.message : text('读取升级任务详情失败', 'Failed to load upgrade task details'))
  } finally {
    taskDetailLoading.value = false
    scheduleTaskPolling()
  }
}
async function executeValidatedTask() {
  if (!validation.value?.taskId) return
  executing.value = true
  try {
    const response = await fetch('/api/system-upgrade/tasks/' + validation.value.taskId + '/execute', {
      method: 'POST',
      headers: { ...headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmation: executionConfirmation.value }),
    })
    const result = await response.json()
    if (!response.ok || !result.ok) throw new Error(localizeApiError(result, text('升级任务无法执行', 'Upgrade task cannot be executed')))
    showExecutionConfirm.value = false
    message.success(text('升级任务已提交，页面将显示最新状态', 'Upgrade task submitted. The page will show its latest status.'))
    await loadOverview()
    await loadTaskDetail(validation.value.taskId)
  } catch (error) {
    message.error(error instanceof Error ? error.message : text('升级任务无法执行', 'Upgrade task cannot be executed'))
  } finally {
    executing.value = false
  }
}
async function loadOverview() {
  loading.value = true
  try {
    const response = await fetch('/api/system-upgrade/overview', { headers: headers() })
    const result = await response.json()
    if (!response.ok || !result.ok) throw new Error(localizeApiError(result, text('读取系统升级状态失败', 'Failed to load system upgrade status')))
    overview.value = result
  } catch (error) {
    message.error(error instanceof Error ? error.message : text('读取系统升级状态失败', 'Failed to load system upgrade status'))
  } finally {
    loading.value = false
  }
}
onMounted(loadOverview)
onBeforeUnmount(stopTaskPolling)
</script>

<template>
  <div class="system-upgrade-page">
    <div class="page-header">
      <div><h1>{{ text('系统升级', 'System Upgrade') }}</h1><p>{{ text('统一查看 GAIOP 核心、管理端与 Skill 的升级服务状态。', 'View the upgrade-service status for the GAIOP core, administration UI, and Skills.') }}</p></div>
      <NButton :loading="loading" @click="loadOverview"><template #icon><NIcon><RefreshOutline /></NIcon></template>{{ text('刷新', 'Refresh') }}</NButton>
    </div>
    <NSpin :show="loading">
      <NAlert :type="runtimeType" :bordered="false" class="runtime-alert">
        <template #header>{{ text('升级服务：', 'Upgrade service: ') }}{{ runtimeLabel }}</template>
        <template v-if="overview?.runtime.state === 'reachable'">{{ text('当前通过 Admin BFF 受控访问，服务版本 ', 'Controlled through Admin BFF. Service version: ') }}{{ overview.runtime.serviceVersion || text('未记录', 'Not recorded') }}。</template>
        <template v-else-if="overview?.runtime.state === 'not-configured'">{{ text('当前环境尚未配置升级服务。ISO 部署阶段将设置内部地址、服务身份令牌、受控目录和 systemd 服务；此页面不会直接连接服务器。', 'The upgrade service is not configured in this environment. ISO deployment configures its internal address, service token, controlled directories, and systemd service; this page never connects directly to a server.') }}</template>
        <template v-else>{{ text('BFF 无法连接升级服务。请在部署阶段检查升级服务与内部网络；页面未尝试执行升级。', 'The BFF cannot reach the upgrade service. Check the service and internal network during deployment; this page has not attempted an upgrade.') }}</template>
      </NAlert>
      <NGrid :cols="1" :x-gap="16" :y-gap="16" responsive="screen" item-responsive>
        <NGridItem v-if="taskDetail" span="1">
          <NCard :title="text('升级任务进度', 'Upgrade task progress')">
            <NSpin :show="taskDetailLoading">
              <NDescriptions :column="1" bordered label-placement="left">
                <NDescriptionsItem :label="text('任务', 'Task')">{{ taskDetail.id }}</NDescriptionsItem>
                <NDescriptionsItem :label="text('状态', 'Status')"><NTag :bordered="false">{{ taskDetail.status }}</NTag></NDescriptionsItem>
                <NDescriptionsItem :label="text('当前步骤', 'Current step')">{{ taskStepLabel(taskDetail.currentStep) }}</NDescriptionsItem>
                <NDescriptionsItem :label="text('预计剩余', 'Estimated remaining')">{{ taskDetail.estimatedRemainingSeconds === null ? text('未估算', 'Not estimated') : taskDetail.estimatedRemainingSeconds + text(' 秒', ' seconds') }}</NDescriptionsItem>
              </NDescriptions>
              <NProgress type="line" :percentage="taskDetail.progressPercent" :indicator-placement="'inside'" processing class="task-progress" />
              <NAlert v-if="taskDetail.error" type="error" class="task-progress">{{ taskDetail.error }}</NAlert>
              <NTable :single-line="false" size="small" class="task-progress">
                <thead><tr><th>{{ text('步骤', 'Step') }}</th><th>{{ text('状态', 'Status') }}</th><th>{{ text('说明', 'Details') }}</th></tr></thead>
                <tbody><tr v-for="step in taskDetail.steps" :key="step.step"><td>{{ taskStepLabel(step.step) }}</td><td><NTag size="small" :bordered="false">{{ step.status }}</NTag></td><td>{{ step.message || '-' }}</td></tr></tbody>
              </NTable>
            </NSpin>
          </NCard>
        </NGridItem>
        <NGridItem span="1">
          <NCard :title="text('升级包校验与执行', 'Validate and execute upgrade package')">
            <NAlert type="warning" :bordered="false" class="read-only-tip">
              {{ text('仅接受已签名的 ZIP 升级包（最大 500MB）。校验通过不等于立即升级；执行前必须再次确认，执行后由任务记录跟踪。', 'Only signed ZIP upgrade packages are accepted (500 MB maximum). Passing validation does not upgrade immediately; execution needs a second confirmation and is then tracked by a task record.') }}
            </NAlert>
            <input ref="fileInput" type="file" accept=".zip,application/zip" class="hidden-input" @change="onPackageSelected">
            <div class="action-row">
              <span>{{ selectedFile ? selectedFile.name : text('尚未选择升级包', 'No upgrade package selected') }}</span>
              <NButton @click="choosePackage">{{ text('选择 ZIP 包', 'Choose ZIP package') }}</NButton>
              <NButton type="primary" :disabled="!selectedFile || overview?.runtime.state !== 'reachable'" :loading="validating" @click="validatePackage">{{ text('校验升级包', 'Validate package') }}</NButton>
            </div>
            <NDescriptions v-if="validation" :column="1" bordered class="validation-result">
              <NDescriptionsItem :label="text('校验结果', 'Validation')"><NTag :type="validation.valid ? 'success' : 'error'">{{ validation.valid ? text('通过', 'Passed') : text('未通过', 'Failed') }}</NTag></NDescriptionsItem>
              <NDescriptionsItem :label="text('组件', 'Component')">{{ validation.displayName || validation.component || '-' }}</NDescriptionsItem>
              <NDescriptionsItem :label="text('版本', 'Version')">{{ validation.currentVersion || '-' }} → {{ validation.newVersion || '-' }}</NDescriptionsItem>
              <NDescriptionsItem :label="text('影响', 'Impact')">{{ validation.impact?.requiresRestart ? text('需要重启相关服务', 'Restart of related service required') : text('无需重启', 'No restart required') }}</NDescriptionsItem>
            </NDescriptions>
            <NAlert v-if="validation && !validation.valid" type="error" class="validation-result">
              <div v-for="item in validation.errors" :key="item.field + item.message">{{ item.field || text('校验', 'Validation') }}: {{ item.message }}</div>
            </NAlert>
            <div v-if="validation?.valid" class="execute-row">
              <NButton type="error" @click="openExecutionConfirm">{{ text('确认并执行升级', 'Confirm and execute upgrade') }}</NButton>
            </div>
          </NCard>
        </NGridItem>
        <NGridItem span="1 m:1 l:2">
          <NCard :title="text('组件状态', 'Component status')">
            <NDescriptions v-if="overview?.status" :column="1" bordered label-placement="left">
              <NDescriptionsItem label="GAIOP Core">{{ componentLabel(overview.status.openclaw) }}</NDescriptionsItem>
              <NDescriptionsItem label="GAIOP-Admin">{{ componentLabel(overview.status.frontend) }}</NDescriptionsItem>
              <NDescriptionsItem :label="text('维护模式', 'Maintenance mode')">{{ overview.status.maintenance_mode ? text('已启用', 'Enabled') : text('未启用', 'Disabled') }}</NDescriptionsItem>
            </NDescriptions>
            <NEmpty v-else :description="text('升级服务未返回组件状态', 'The upgrade service returned no component status')" />
          </NCard>
        </NGridItem>
        <NGridItem span="1 m:1 l:2">
          <NCard :title="text('已登记 Skill', 'Registered Skills')">
            <NTable v-if="skillEntries.length" :single-line="false" size="small">
              <thead><tr><th>Skill</th><th>{{ text('版本', 'Version') }}</th><th>{{ text('状态', 'Status') }}</th></tr></thead>
              <tbody><tr v-for="[name, skill] in skillEntries" :key="name"><td>{{ name }}</td><td>{{ skill.version || text('未知', 'Unknown') }}</td><td>{{ skill.status || text('未知', 'Unknown') }}</td></tr></tbody>
            </NTable>
            <NEmpty v-else :description="text('暂无已登记的 Skill', 'No registered Skills')" />
          </NCard>
        </NGridItem>
        <NGridItem span="1">
          <NCard :title="text('最近任务与备份', 'Recent tasks and backups')">
            <NAlert type="info" :bordered="false" class="read-only-tip">{{ text('升级、Skill 回滚和备份删除均通过 Admin BFF 执行，并要求独立确认和审计；当前人工回滚仅支持 Skill 备份。', 'Upgrades, Skill rollbacks, and backup deletion are performed through Admin BFF and require independent confirmation and audit records. Manual rollback currently supports Skill backups only.') }}</NAlert>
            <NTable v-if="overview?.tasks?.length" :single-line="false" size="small">
              <thead><tr><th>{{ text('任务', 'Task') }}</th><th>{{ text('类型', 'Type') }}</th><th>{{ text('组件', 'Component') }}</th><th>{{ text('状态', 'Status') }}</th><th>{{ text('创建时间', 'Created') }}</th></tr></thead>
              <tbody><tr v-for="task in overview.tasks" :key="task.id"><td>{{ task.id }}</td><td>{{ task.type }}</td><td>{{ task.component || '-' }}</td><td><NTag size="small" :bordered="false">{{ task.status }}</NTag></td><td>{{ formatTime(task.created_at) }}</td><td><NButton text type="primary" size="small" @click="loadTaskDetail(task.id)">{{ text('详情', 'Details') }}</NButton></td></tr></tbody>
            </NTable>
            <NEmpty v-else :description="text('暂无升级任务记录', 'No upgrade task records')" />
            <NTable v-if="overview?.backups?.length" :single-line="false" size="small" class="backup-table">
              <thead><tr><th>{{ text('备份组件', 'Backed-up component') }}</th><th>{{ text('版本', 'Version') }}</th><th>{{ text('创建时间', 'Created') }}</th></tr></thead>
              <tbody><tr v-for="backup in overview.backups" :key="backup.id"><td>{{ backup.component }}</td><td>{{ backup.version }}</td><td>{{ formatTime(backup.createdAt || undefined) }}</td><td><NButton text type="warning" size="small" @click="openBackupConfirm(backup, 'rollback')">{{ text('回滚', 'Rollback') }}</NButton><NButton text type="error" size="small" @click="openBackupConfirm(backup, 'delete')">{{ text('删除', 'Delete') }}</NButton></td></tr></tbody>
            </NTable>
          </NCard>
        </NGridItem>
      </NGrid>
    </NSpin>
    <NModal v-model:show="showExecutionConfirm" preset="dialog" :title="text('确认执行系统升级', 'Confirm system upgrade')" :positive-text="text('执行升级', 'Execute upgrade')" :negative-text="text('取消', 'Cancel')" :positive-button-props="{ disabled: executionConfirmation !== 'EXECUTE', loading: executing }" @positive-click="executeValidatedTask">
      <p>{{ text('将执行已校验的升级任务。请输入 ', 'The validated upgrade task will run. Enter ') }}<strong>EXECUTE</strong>{{ text(' 确认；此操作可能重启相关服务。', ' to confirm; this may restart related services.') }}</p>
      <NInput v-model:value="executionConfirmation" :placeholder="text('请输入 EXECUTE', 'Enter EXECUTE')" />
    </NModal>
    <NModal v-model:show="showBackupConfirm" preset="dialog" :title="backupAction === 'rollback' ? text('确认回滚 Skill', 'Confirm Skill rollback') : text('确认删除备份', 'Confirm backup deletion')" :positive-text="backupAction === 'rollback' ? text('执行回滚', 'Execute rollback') : text('删除备份', 'Delete backup')" :negative-text="text('取消', 'Cancel')" :positive-button-props="{ disabled: backupConfirmation !== (backupAction === 'rollback' ? 'ROLLBACK' : 'DELETE'), loading: backupActionLoading }" @positive-click="confirmBackupAction">
      <p v-if="backupAction === 'rollback'">{{ text('将把 ', 'Restore ') }}{{ selectedBackup?.component }}{{ text(' 恢复到 ', ' to ') }}{{ selectedBackup?.version }}。{{ text('当前仅支持 Skill 备份人工回滚；请输入 ', 'Manual rollback currently supports Skill backups only. Enter ') }}<strong>ROLLBACK</strong>{{ text(' 确认。', ' to confirm.') }}</p>
      <p v-else>{{ text('将永久删除 ', 'Permanently delete the ') }}{{ selectedBackup?.component }}{{ text(' 的 ', ' backup at ') }}{{ selectedBackup?.version }}。{{ text('请输入 ', 'Enter ') }}<strong>DELETE</strong>{{ text(' 确认。', ' to confirm.') }}</p>
      <NInput v-model:value="backupConfirmation" :placeholder="backupAction === 'rollback' ? text('请输入 ROLLBACK', 'Enter ROLLBACK') : text('请输入 DELETE', 'Enter DELETE')" />
    </NModal>
  </div>
</template>
<style scoped>
.system-upgrade-page { max-width: 1280px; margin: 0 auto; }
.page-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 20px; }
.page-header h1 { margin: 0 0 8px; font-size: 24px; }
.page-header p { margin: 0; color: var(--n-text-color-3); }
.runtime-alert, .read-only-tip { margin-bottom: 16px; }
.backup-table { margin-top: 20px; }
.hidden-input { display: none; }
.action-row, .execute-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.action-row span { flex: 1; min-width: 220px; word-break: break-all; color: var(--n-text-color-2); }
.validation-result { margin-top: 16px; }
.execute-row { margin-top: 16px; }
.task-progress { margin-top: 16px; }
@media (max-width: 640px) { .page-header { flex-direction: column; } }
</style>
