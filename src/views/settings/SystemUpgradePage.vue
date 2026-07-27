<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { NAlert, NButton, NCard, NDescriptions, NDescriptionsItem, NEmpty, NGrid, NGridItem, NIcon, NInput, NModal, NProgress, NSpin, NTable, NTag, useMessage } from 'naive-ui'
import { RefreshOutline } from '@vicons/ionicons5'
import { useAuthStore } from '@/stores/auth'

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
const runtimeLabel = computed(() => ({ 'not-configured': '待部署', reachable: '服务可用', unavailable: '服务不可用' }[overview.value?.runtime.state || 'not-configured']))
const runtimeType = computed(() => ({ 'not-configured': 'warning', reachable: 'success', unavailable: 'error' }[overview.value?.runtime.state || 'not-configured'] as 'warning' | 'success' | 'error'))
const skillEntries = computed(() => Object.entries(overview.value?.status?.skills || {}))

function headers() {
  return { Authorization: 'Bearer ' + (authStore.getToken() || '') }
}
function formatTime(value?: string) {
  if (!value) return '未记录'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}
function componentLabel(component?: ComponentInfo | null) {
  if (!component) return '未发现'
  return (component.version || '未知版本') + ' · ' + (component.status || '未知状态')
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
    message.warning('请先选择 ZIP 格式升级包')
    return
  }
  validating.value = true
  try {
    const form = new FormData()
    form.append('file', selectedFile.value)
    const response = await fetch('/api/system-upgrade/validate', { method: 'POST', headers: headers(), body: form })
    const result = await response.json()
    if (!response.ok || !result.ok) throw new Error(result.error || '升级包校验失败')
    const validationResult = result.validation as ValidationResult | null
    if (!validationResult) throw new Error('升级服务未返回校验结果')
    validation.value = validationResult
    message[validationResult.valid ? 'success' : 'warning'](validationResult.valid ? '升级包校验通过，请确认后执行' : '升级包未通过校验')
    await loadOverview()
  } catch (error) {
    message.error(error instanceof Error ? error.message : '升级包校验失败')
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
    if (!response.ok || !result.ok) throw new Error(result.error || '备份操作失败')
    showBackupConfirm.value = false
    if (backupAction.value === 'rollback' && result.taskId) {
      message.success('回滚任务已提交')
      await loadOverview()
      await loadTaskDetail(result.taskId)
    } else {
      message.success('备份已删除')
      await loadOverview()
    }
  } catch (error) {
    message.error(error instanceof Error ? error.message : '备份操作失败')
  } finally {
    backupActionLoading.value = false
  }
}
function taskStepLabel(value: string | null) {
  return ({
    pre_check: '预检',
    backup: '创建备份',
    replace: '替换文件',
    reload: '重载服务',
    smoke_test: '健康检查',
    finalize: '收尾',
  } as Record<string, string>)[value || ''] || value || '等待开始'
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
    if (!response.ok || !result.ok) throw new Error(result.error || '读取升级任务详情失败')
    taskDetail.value = result.task as TaskDetail
    if (!isTaskActive(taskDetail.value.status)) await loadOverview()
  } catch (error) {
    stopTaskPolling()
    if (!silent) message.error(error instanceof Error ? error.message : '读取升级任务详情失败')
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
    if (!response.ok || !result.ok) throw new Error(result.error || '升级任务无法执行')
    showExecutionConfirm.value = false
    message.success('升级任务已提交，页面将显示最新状态')
    await loadOverview()
    await loadTaskDetail(validation.value.taskId)
  } catch (error) {
    message.error(error instanceof Error ? error.message : '升级任务无法执行')
  } finally {
    executing.value = false
  }
}
async function loadOverview() {
  loading.value = true
  try {
    const response = await fetch('/api/system-upgrade/overview', { headers: headers() })
    const result = await response.json()
    if (!response.ok || !result.ok) throw new Error(result.error || '读取系统升级状态失败')
    overview.value = result
  } catch (error) {
    message.error(error instanceof Error ? error.message : '读取系统升级状态失败')
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
      <div><h1>系统升级</h1><p>统一查看 GAIOP 核心、管理端与 Skill 的升级服务状态。</p></div>
      <NButton :loading="loading" @click="loadOverview"><template #icon><NIcon><RefreshOutline /></NIcon></template>刷新</NButton>
    </div>
    <NSpin :show="loading">
      <NAlert :type="runtimeType" :bordered="false" class="runtime-alert">
        <template #header>升级服务：{{ runtimeLabel }}</template>
        <template v-if="overview?.runtime.state === 'reachable'">当前通过 Admin BFF 受控访问，服务版本 {{ overview.runtime.serviceVersion || '未记录' }}。</template>
        <template v-else-if="overview?.runtime.state === 'not-configured'">当前环境尚未配置升级服务。ISO 部署阶段将设置内部地址、服务身份令牌、受控目录和 systemd 服务；此页面不会直接连接服务器。</template>
        <template v-else>BFF 无法连接升级服务。请在部署阶段检查升级服务与内部网络；页面未尝试执行升级。</template>
      </NAlert>
      <NGrid :cols="1" :x-gap="16" :y-gap="16" responsive="screen" item-responsive>
        <NGridItem v-if="taskDetail" span="1">
          <NCard title="升级任务进度">
            <NSpin :show="taskDetailLoading">
              <NDescriptions :column="1" bordered label-placement="left">
                <NDescriptionsItem label="任务">{{ taskDetail.id }}</NDescriptionsItem>
                <NDescriptionsItem label="状态"><NTag :bordered="false">{{ taskDetail.status }}</NTag></NDescriptionsItem>
                <NDescriptionsItem label="当前步骤">{{ taskStepLabel(taskDetail.currentStep) }}</NDescriptionsItem>
                <NDescriptionsItem label="预计剩余">{{ taskDetail.estimatedRemainingSeconds === null ? '未估算' : taskDetail.estimatedRemainingSeconds + ' 秒' }}</NDescriptionsItem>
              </NDescriptions>
              <NProgress type="line" :percentage="taskDetail.progressPercent" :indicator-placement="'inside'" processing class="task-progress" />
              <NAlert v-if="taskDetail.error" type="error" class="task-progress">{{ taskDetail.error }}</NAlert>
              <NTable :single-line="false" size="small" class="task-progress">
                <thead><tr><th>步骤</th><th>状态</th><th>说明</th></tr></thead>
                <tbody><tr v-for="step in taskDetail.steps" :key="step.step"><td>{{ taskStepLabel(step.step) }}</td><td><NTag size="small" :bordered="false">{{ step.status }}</NTag></td><td>{{ step.message || '-' }}</td></tr></tbody>
              </NTable>
            </NSpin>
          </NCard>
        </NGridItem>
        <NGridItem span="1">
          <NCard title="升级包校验与执行">
            <NAlert type="warning" :bordered="false" class="read-only-tip">
              仅接受已签名的 ZIP 升级包（最大 500MB）。校验通过不等于立即升级；执行前必须再次确认，执行后由任务记录跟踪。
            </NAlert>
            <input ref="fileInput" type="file" accept=".zip,application/zip" class="hidden-input" @change="onPackageSelected">
            <div class="action-row">
              <span>{{ selectedFile ? selectedFile.name : '尚未选择升级包' }}</span>
              <NButton @click="choosePackage">选择 ZIP 包</NButton>
              <NButton type="primary" :disabled="!selectedFile || overview?.runtime.state !== 'reachable'" :loading="validating" @click="validatePackage">校验升级包</NButton>
            </div>
            <NDescriptions v-if="validation" :column="1" bordered class="validation-result">
              <NDescriptionsItem label="校验结果"><NTag :type="validation.valid ? 'success' : 'error'">{{ validation.valid ? '通过' : '未通过' }}</NTag></NDescriptionsItem>
              <NDescriptionsItem label="组件">{{ validation.displayName || validation.component || '-' }}</NDescriptionsItem>
              <NDescriptionsItem label="版本">{{ validation.currentVersion || '-' }} → {{ validation.newVersion || '-' }}</NDescriptionsItem>
              <NDescriptionsItem label="影响">{{ validation.impact?.requiresRestart ? '需要重启相关服务' : '无需重启' }}</NDescriptionsItem>
            </NDescriptions>
            <NAlert v-if="validation && !validation.valid" type="error" class="validation-result">
              <div v-for="item in validation.errors" :key="item.field + item.message">{{ item.field || '校验' }}：{{ item.message }}</div>
            </NAlert>
            <div v-if="validation?.valid" class="execute-row">
              <NButton type="error" @click="openExecutionConfirm">确认并执行升级</NButton>
            </div>
          </NCard>
        </NGridItem>
        <NGridItem span="1 m:1 l:2">
          <NCard title="组件状态">
            <NDescriptions v-if="overview?.status" :column="1" bordered label-placement="left">
              <NDescriptionsItem label="GAIOP 核心">{{ componentLabel(overview.status.openclaw) }}</NDescriptionsItem>
              <NDescriptionsItem label="GAIOP-Admin">{{ componentLabel(overview.status.frontend) }}</NDescriptionsItem>
              <NDescriptionsItem label="维护模式">{{ overview.status.maintenance_mode ? '已启用' : '未启用' }}</NDescriptionsItem>
            </NDescriptions>
            <NEmpty v-else description="升级服务未返回组件状态" />
          </NCard>
        </NGridItem>
        <NGridItem span="1 m:1 l:2">
          <NCard title="已登记 Skill">
            <NTable v-if="skillEntries.length" :single-line="false" size="small">
              <thead><tr><th>Skill</th><th>版本</th><th>状态</th></tr></thead>
              <tbody><tr v-for="[name, skill] in skillEntries" :key="name"><td>{{ name }}</td><td>{{ skill.version || '未知' }}</td><td>{{ skill.status || '未知' }}</td></tr></tbody>
            </NTable>
            <NEmpty v-else description="暂无已登记的 Skill" />
          </NCard>
        </NGridItem>
        <NGridItem span="1">
          <NCard title="最近任务与备份">
            <NAlert type="info" :bordered="false" class="read-only-tip">升级、Skill 回滚和备份删除均通过 Admin BFF 执行，并要求独立确认和审计；当前人工回滚仅支持 Skill 备份。</NAlert>
            <NTable v-if="overview?.tasks?.length" :single-line="false" size="small">
              <thead><tr><th>任务</th><th>类型</th><th>组件</th><th>状态</th><th>创建时间</th></tr></thead>
              <tbody><tr v-for="task in overview.tasks" :key="task.id"><td>{{ task.id }}</td><td>{{ task.type }}</td><td>{{ task.component || '-' }}</td><td><NTag size="small" :bordered="false">{{ task.status }}</NTag></td><td>{{ formatTime(task.created_at) }}</td><td><NButton text type="primary" size="small" @click="loadTaskDetail(task.id)">详情</NButton></td></tr></tbody>
            </NTable>
            <NEmpty v-else description="暂无升级任务记录" />
            <NTable v-if="overview?.backups?.length" :single-line="false" size="small" class="backup-table">
              <thead><tr><th>备份组件</th><th>版本</th><th>创建时间</th></tr></thead>
              <tbody><tr v-for="backup in overview.backups" :key="backup.id"><td>{{ backup.component }}</td><td>{{ backup.version }}</td><td>{{ formatTime(backup.createdAt || undefined) }}</td><td><NButton text type="warning" size="small" @click="openBackupConfirm(backup, 'rollback')">回滚</NButton><NButton text type="error" size="small" @click="openBackupConfirm(backup, 'delete')">删除</NButton></td></tr></tbody>
            </NTable>
          </NCard>
        </NGridItem>
      </NGrid>
    </NSpin>
    <NModal v-model:show="showExecutionConfirm" preset="dialog" title="确认执行系统升级" positive-text="执行升级" negative-text="取消" :positive-button-props="{ disabled: executionConfirmation !== 'EXECUTE', loading: executing }" @positive-click="executeValidatedTask">
      <p>将执行已校验的升级任务。请输入 <strong>EXECUTE</strong> 确认；此操作可能重启相关服务。</p>
      <NInput v-model:value="executionConfirmation" placeholder="请输入 EXECUTE" />
    </NModal>
    <NModal v-model:show="showBackupConfirm" preset="dialog" :title="backupAction === 'rollback' ? '确认回滚 Skill' : '确认删除备份'" :positive-text="backupAction === 'rollback' ? '执行回滚' : '删除备份'" negative-text="取消" :positive-button-props="{ disabled: backupConfirmation !== (backupAction === 'rollback' ? 'ROLLBACK' : 'DELETE'), loading: backupActionLoading }" @positive-click="confirmBackupAction">
      <p v-if="backupAction === 'rollback'">将把 {{ selectedBackup?.component }} 恢复到 {{ selectedBackup?.version }}。当前仅支持 Skill 备份人工回滚；请输入 <strong>ROLLBACK</strong> 确认。</p>
      <p v-else>将永久删除 {{ selectedBackup?.component }} 的 {{ selectedBackup?.version }} 备份。请输入 <strong>DELETE</strong> 确认。</p>
      <NInput v-model:value="backupConfirmation" :placeholder="backupAction === 'rollback' ? '请输入 ROLLBACK' : '请输入 DELETE'" />
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
