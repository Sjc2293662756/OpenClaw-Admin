<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, h } from 'vue'
import {
  NCard, NGrid, NGridItem, NSpace, NText, NButton, NTag, NSpin,
  NDataTable, NUpload, NModal, NProgress, NAlert, NEmpty,
  NTabs, NTabPane, NSelect, NPopconfirm, NInput, NDivider,
  NDescriptions, NDescriptionsItem, NIcon, NBadge, NThing,
  useMessage, type DataTableColumns, type UploadFileInfo,
} from 'naive-ui'
import {
  CloudUploadOutline, CheckmarkCircleOutline, CloseCircleOutline,
  RefreshOutline, InformationCircleOutline, ArchiveOutline,
  TimeOutline, ArrowBackOutline, ServerOutline, CubeOutline,
} from '@vicons/ionicons5'
import { useUpgradeStore } from '@/stores/upgrade'
import type { UpgradeTask, ValidationError, ComponentInfo } from '@/api/types/upgrade'

const store = useUpgradeStore()
const message = useMessage()

// ── Tab ──
const activeTab = ref('dashboard')

// ── 上传 ──
const uploadRef = ref<any>(null)
const uploading = ref(false)

// ── 弹窗 ──
const showValidateDialog = ref(false)
const showProgressDialog = ref(false)
const showRollbackDialog = ref(false)
const rollbackComponent = ref('')
const rollbackVersion = ref<string | null>(null)

// ── 筛选 ──
const historyFilter = ref<{ status?: string; component?: string }>({})

// ════════════════════════════════════════════════════════
// 生命周期
// ════════════════════════════════════════════════════════
onMounted(() => {
  store.initialize()
})

onUnmounted(() => {
  store.stopPolling()
})

// ════════════════════════════════════════════════════════
// Dashboard 数据
// ════════════════════════════════════════════════════════
const openclawStatus = computed(() => store.systemStatus?.openclaw)
const frontendStatus = computed(() => store.systemStatus?.frontend)
const skillsStatus = computed(() => store.systemStatus?.skills || {})
const maintenanceMode = computed(() => store.systemStatus?.maintenance_mode ?? false)

const skillRows = computed(() =>
  Object.entries(skillsStatus.value).map(([name, info]) => ({
    name,
    version: info.version,
    status: info.status,
  }))
)

const skillColumns: DataTableColumns = [
  { title: 'Skill', key: 'name', width: 200 },
  { title: '版本', key: 'version', width: 120 },
  {
    title: '状态', key: 'status', width: 100,
    render: (row: any) => h(NTag, { type: row.status === 'active' ? 'success' : 'warning', size: 'small' }, () => row.status),
  },
]

// ════════════════════════════════════════════════════════
// 上传处理
// ════════════════════════════════════════════════════════
async function handleUpload({ file }: { file: UploadFileInfo }) {
  if (!file.file) return
  uploading.value = true
  try {
    const result = await store.validatePackage(file.file)
    if (result.valid) {
      showValidateDialog.value = true
    }
  } catch (err: any) {
    message.error(err.message || '校验失败')
  } finally {
    uploading.value = false
  }
}

async function handleExecute() {
  if (!store.validateResult?.task_id) return
  showValidateDialog.value = false
  showProgressDialog.value = true
  try {
    await store.executeUpgrade(store.validateResult.task_id)
  } catch (err: any) {
    message.error(err.message || '执行失败')
    showProgressDialog.value = false
  }
}

function closeProgressDialog() {
  showProgressDialog.value = false
  store.stopPolling()
  store.fetchStatus()
  store.fetchTasks({ limit: 20 })
}

// ════════════════════════════════════════════════════════
// 回滚
// ════════════════════════════════════════════════════════
async function openRollback(component: string) {
  rollbackComponent.value = component
  try {
    await store.fetchBackups(component)
  } catch (_) {}
  showRollbackDialog.value = true
}

async function confirmRollback() {
  try {
    await store.rollback(rollbackComponent.value, rollbackVersion.value || undefined)
    message.success(`回滚 ${rollbackComponent.value} 已提交`)
    showRollbackDialog.value = false
    store.fetchStatus()
  } catch (err: any) {
    message.error(err.message || '回滚失败')
  }
}

// ════════════════════════════════════════════════════════
// 任务历史表格
// ════════════════════════════════════════════════════════
const statusTag = (status: string) => {
  const map: Record<string, { type: any; label: string }> = {
    pending:    { type: 'default', label: '待执行' },
    running:    { type: 'info',    label: '执行中' },
    success:    { type: 'success', label: '成功' },
    failed:     { type: 'error',   label: '失败' },
    rolling_back: { type: 'warning', label: '回滚中' },
    rolled_back:  { type: 'warning', label: '已回滚' },
  }
  const m = map[status] || { type: 'default', label: status }
  return h(NTag, { type: m.type, size: 'small' }, () => m.label)
}

const taskColumns: DataTableColumns = [
  { title: '时间', key: 'created_at', width: 160, render: (r: any) => r.created_at?.slice(0, 19)?.replace('T', ' ') },
  { title: '类型', key: 'type', width: 110 },
  { title: '组件', key: 'component', width: 130 },
  { title: '版本', key: 'version_change', width: 140, render: (r: any) => `${r.old_version || '-'} → ${r.new_version || '-'}` },
  { title: '状态', key: 'status', width: 90, render: (r: any) => statusTag(r.status) },
  { title: '操作人', key: 'operator', width: 90 },
  {
    title: '', key: 'actions', width: 60,
    render: (r: any) => h(NButton, { size: 'tiny', quaternary: true, onClick: () => viewTaskDetail(r.id) }, () => '详情'),
  },
]

const filteredTasks = computed(() => {
  let list = store.tasks
  if (historyFilter.value.status) list = list.filter((t) => t.status === historyFilter.value.status)
  if (historyFilter.value.component) list = list.filter((t) => t.component === historyFilter.value.component)
  return list.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
})

async function viewTaskDetail(taskId: string) {
  try {
    await store.fetchTask(taskId)
  } catch (_) {}
}
</script>

<template>
  <NCard :bordered="false">
    <NTabs v-model:value="activeTab" type="line" animated>
      <!-- ══════════════════════════════════════════════ -->
      <NTabPane name="dashboard" tab="Dashboard">
      <!-- ══════════════════════════════════════════════ -->
        <NSpin :show="!store.systemStatus && store.initializing">
          <!-- 维护模式 Banner -->
          <NAlert v-if="maintenanceMode" type="warning" :bordered="false" class="mb-4">
            <template #header>⚠ 系统升级维护中</template>
            部分功能可能暂时不可用。升级完成后请刷新页面。
          </NAlert>

          <!-- 核心组件状态卡片 -->
          <NGrid :cols="3" :x-gap="12" class="mb-4">
            <NGridItem>
              <NCard size="small" :bordered="true">
                <template #header>
                  <NSpace align="center"><NIcon :component="ServerOutline" /><NText strong>OpenClaw</NText></NSpace>
                </template>
                <NThing v-if="openclawStatus">
                  <template #header>
                    <NBadge :type="openclawStatus.status === 'active' ? 'success' : 'warning'" dot />
                    {{ openclawStatus.version }}
                  </template>
                </NThing>
                <NEmpty v-else description="未注册" size="small" />
              </NCard>
            </NGridItem>
            <NGridItem>
              <NCard size="small" :bordered="true">
                <template #header>
                  <NSpace align="center"><NIcon :component="CubeOutline" /><NText strong>前端</NText></NSpace>
                </template>
                <NThing v-if="frontendStatus">
                  <template #header>
                    <NBadge :type="frontendStatus.status === 'active' ? 'success' : 'warning'" dot />
                    {{ frontendStatus.version }}
                  </template>
                </NThing>
                <NEmpty v-else description="未注册" size="small" />
              </NCard>
            </NGridItem>
            <NGridItem>
              <NCard size="small" :bordered="true">
                <template #header>
                  <NSpace align="center"><NIcon :component="ArchiveOutline" /><NText strong>Skills</NText></NSpace>
                </template>
                <NText>{{ Object.keys(skillsStatus).length }} 个已注册</NText>
              </NCard>
            </NGridItem>
          </NGrid>

          <!-- Skills 列表 -->
          <NCard v-if="skillRows.length > 0" size="small" title="Skills 详情" class="mb-4">
            <NDataTable :columns="skillColumns" :data="skillRows" :bordered="false" size="small" max-height="400" />
          </NCard>
        </NSpin>
      </NTabPane>

      <!-- ══════════════════════════════════════════════ -->
      <NTabPane name="center" tab="升级中心">
      <!-- ══════════════════════════════════════════════ -->
        <NSpace vertical :size="16">
          <NText depth="3">上传升级包（ZIP），系统将自动校验签名、兼容性并评估影响范围。</NText>

          <!-- 上传区域 -->
          <NUpload
            ref="uploadRef"
            :max="1"
            accept=".zip"
            :show-file-list="true"
            :default-upload="false"
            @change="handleUpload"
          >
            <NButton :loading="uploading" size="large">
              <template #icon><NIcon :component="CloudUploadOutline" /></template>
              选择升级包 (.zip)
            </NButton>
          </NUpload>

          <!-- 校验结果弹窗 -->
          <NModal v-model:show="showValidateDialog" title="升级包校验结果" preset="card" style="width: 640px">
            <template v-if="store.validateResult">
              <NDescriptions :column="1" label-placement="left" size="small" bordered>
                <NDescriptionsItem label="组件">{{ store.validateResult.component || '-' }}</NDescriptionsItem>
                <NDescriptionsItem label="当前版本">{{ store.validateResult.current_version || '-' }}</NDescriptionsItem>
                <NDescriptionsItem label="新版本">
                  <NTag type="info" size="small">{{ store.validateResult.new_version }}</NTag>
                </NDescriptionsItem>
                <NDescriptionsItem label="影响">
                  <NSpace>
                    <NTag v-if="store.validateResult.impact?.requires_restart" type="warning" size="small">需重启</NTag>
                    <NTag v-if="store.validateResult.impact?.requires_maintenance" type="warning" size="small">维护模式</NTag>
                    <NText depth="3">预计停机 {{ store.validateResult.impact?.estimated_downtime_seconds ?? 0 }}s</NText>
                  </NSpace>
                </NDescriptionsItem>
              </NDescriptions>

              <!-- 兼容性检查 -->
              <NDivider>兼容性检查</NDivider>
              <template v-if="store.validateResult.compatibility_check">
                <div v-for="(check, key) in store.validateResult.compatibility_check" :key="key" class="mb-2">
                  <template v-if="key !== 'dependencies' && check">
                    <NSpace align="center">
                      <NIcon v-if="check.ok" :component="CheckmarkCircleOutline" color="green" />
                      <NIcon v-else :component="CloseCircleOutline" color="red" />
                      <NText>{{ key }}: {{ check.current }} {{ check.ok ? '≥' : '✗' }} {{ check.required }}</NText>
                    </NSpace>
                  </template>
                </div>
                <template v-if="store.validateResult.compatibility_check.dependencies">
                  <div v-for="(dep, depKey) in store.validateResult.compatibility_check.dependencies" :key="depKey">
                    <NSpace align="center">
                      <NIcon v-if="dep.ok" :component="CheckmarkCircleOutline" color="green" />
                      <NIcon v-else :component="CloseCircleOutline" color="red" />
                      <NText>{{ depKey }}: {{ dep.current || '缺失' }} {{ dep.ok ? '✓' : '✗' }} {{ dep.required }}</NText>
                    </NSpace>
                  </div>
                </template>
              </template>

              <!-- Changelog -->
              <NDivider v-if="store.validateResult.changelog">Changelog</NDivider>
              <NText v-if="store.validateResult.changelog" depth="3" class="pre-wrap">{{ store.validateResult.changelog }}</NText>
            </template>
            <template #footer>
              <NSpace justify="end">
                <NButton @click="showValidateDialog = false">取消</NButton>
                <NButton type="primary" @click="handleExecute">开始升级</NButton>
              </NSpace>
            </template>
          </NModal>

          <!-- 升级进度弹窗 -->
          <NModal v-model:show="showProgressDialog" :mask-closable="false" title="升级进度" preset="card" style="width: 560px">
            <template v-if="store.currentTask">
              <div v-for="step in store.currentTask.steps" :key="step.step" class="mb-3">
                <NSpace align="center">
                  <NIcon v-if="step.status === 'completed'" :component="CheckmarkCircleOutline" color="green" />
                  <NSpin v-else-if="step.status === 'running'" :size="14" />
                  <NIcon v-else-if="step.status === 'failed'" :component="CloseCircleOutline" color="red" />
                  <NIcon v-else :component="TimeOutline" color="#ccc" />
                  <NText>{{ step.step }}</NText>
                  <NText depth="3" class="text-sm">{{ step.message }}</NText>
                </NSpace>
              </div>
              <NProgress
                :percentage="store.currentTask.progress_percent || 0"
                :status="store.currentTask.status === 'failed' ? 'error' : store.currentTask.status === 'success' ? 'success' : 'default'"
              />
              <NText v-if="store.currentTask.error" type="error" class="mt-2">{{ store.currentTask.error }}</NText>
            </template>
            <template #footer>
              <NButton v-if="['success', 'failed', 'rolled_back'].includes(store.currentTask?.status || '')" @click="closeProgressDialog">
                关闭
              </NButton>
            </template>
          </NModal>
        </NSpace>
      </NTabPane>

      <!-- ══════════════════════════════════════════════ -->
      <NTabPane name="history" tab="升级历史">
      <!-- ══════════════════════════════════════════════ -->
        <NSpace class="mb-3">
          <NSelect
            v-model:value="historyFilter.status"
            :options="[
              { label: '全部状态', value: '' },
              { label: '成功', value: 'success' },
              { label: '失败', value: 'failed' },
              { label: '已回滚', value: 'rolled_back' },
            ]"
            style="width: 140px"
            placeholder="状态"
            clearable
            size="small"
          />
          <NButton size="small" @click="store.fetchTasks({ limit: 50 })">
            <template #icon><NIcon :component="RefreshOutline" /></template>
          </NButton>
        </NSpace>

        <NDataTable
          :columns="taskColumns"
          :data="filteredTasks"
          :bordered="false"
          size="small"
          max-height="500"
        />

        <!-- 任务详情 -->
        <NCard v-if="store.currentTask" title="任务详情" size="small" class="mt-4">
          <template #header-extra>
            <NButton size="tiny" @click="store.currentTask = null">关闭</NButton>
          </template>
          <template v-for="step in store.currentTask.steps" :key="step.step">
            <div class="mb-2">
              <NSpace align="center">
                <NBadge :type="step.status === 'completed' ? 'success' : step.status === 'failed' ? 'error' : step.status === 'running' ? 'info' : 'default'" dot />
                <NText strong>{{ step.step }}</NText>
                <NText depth="3">{{ step.message }}</NText>
                <NText v-if="step.started_at" depth="3" class="text-xs">{{ step.started_at?.slice(11, 19) }}</NText>
              </NSpace>
            </div>
          </template>
        </NCard>
      </NTabPane>

      <!-- ══════════════════════════════════════════════ -->
      <NTabPane name="rollback" tab="回滚中心">
      <!-- ══════════════════════════════════════════════ -->
        <NText depth="3" class="mb-3">选择组件查看可回滚的历史版本。</NText>

        <NSelect
          v-model:value="rollbackComponent"
          :options="[
            { label: 'OpenClaw', value: 'openclaw' },
            { label: 'Frontend', value: 'frontend' },
            ...Object.keys(skillsStatus).map((k) => ({ label: k, value: k })),
          ]"
          placeholder="选择组件"
          style="width: 240px"
          class="mb-3"
          @update:value="(v: string) => openRollback(v)"
        />

        <!-- 回滚弹窗 -->
        <NModal v-model:show="showRollbackDialog" preset="card" title="选择回滚版本" style="width: 520px">
          <NSpin :show="!store.backups.length">
            <template v-if="store.backups.length === 0 && !store.loading">
              <NEmpty description="无可用备份" />
            </template>
            <div v-for="b in store.backups" :key="b.id" class="mb-2 p-2" style="border:1px solid #eee;border-radius:4px;cursor:pointer"
              :style="{ borderColor: rollbackVersion === b.version ? '#2080f0' : '#eee' }"
              @click="rollbackVersion = b.version">
              <NSpace justify="space-between">
                <NSpace>
                  <NIcon :component="ArchiveOutline" />
                  <NText strong>{{ b.version }}</NText>
                </NSpace>
                <NSpace>
                  <NText depth="3">{{ formatBytes(b.size_bytes) }}</NText>
                  <NText depth="3">{{ b.created_at?.slice(0, 10) }}</NText>
                </NSpace>
              </NSpace>
            </div>
          </NSpin>
          <template #footer>
            <NSpace justify="end">
              <NButton @click="showRollbackDialog = false">取消</NButton>
              <NButton type="warning" :disabled="!rollbackVersion" @click="confirmRollback">
                <template #icon><NIcon :component="ArrowBackOutline" /></template>
                回滚到 {{ rollbackVersion }}
              </NButton>
            </NSpace>
          </template>
        </NModal>
      </NTabPane>
    </NTabs>
  </NCard>
</template>

<script lang="ts">
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}
</script>

<style scoped>
.pre-wrap { white-space: pre-wrap; }
.text-sm { font-size: 12px; }
.text-xs { font-size: 11px; }
.mb-2 { margin-bottom: 8px; }
.mb-3 { margin-bottom: 12px; }
.mb-4 { margin-bottom: 16px; }
.mt-2 { margin-top: 8px; }
.mt-4 { margin-top: 16px; }
.p-2 { padding: 8px; }
</style>
