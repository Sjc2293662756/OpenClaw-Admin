<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { CalendarOutline, ChevronDownOutline } from '@vicons/ionicons5'
import { NButton, NDatePicker, NIcon, NPopover, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import {
  formatTimeRange,
  rangeForPreset,
  validateTimeRange,
  type TimeRange,
  type TimeRangePreset,
} from '@/utils/time-range'

const props = withDefaults(defineProps<{
  modelValue: TimeRange
  preset?: TimeRangePreset
  serverNow?: number
  disabled?: boolean
  compact?: boolean
  placement?: 'bottom-start' | 'bottom-end'
  presets?: readonly TimeRangePreset[]
}>(), {
  preset: 'custom',
  serverNow: () => Date.now(),
  disabled: false,
  compact: false,
  placement: 'bottom-start',
  presets: () => ['lastHour', 'today', 'yesterday', 'last7days', 'last30days', 'thisMonth', 'custom'],
})

const emit = defineEmits<{
  'update:modelValue': [range: TimeRange]
  apply: [range: TimeRange, preset: TimeRangePreset]
}>()

const { t } = useI18n()
const message = useMessage()
const popoverVisible = ref(false)
const customVisible = ref(false)
const draftRange = ref<TimeRange | null>(null)
const serverNowReceivedAt = ref(Date.now())

const optionLabels: Record<TimeRangePreset, string> = {
  lastHour: 'pages.dashboard.range.lastHour',
  today: 'pages.dashboard.range.today',
  yesterday: 'pages.dashboard.range.yesterday',
  last7days: 'pages.dashboard.range.last7days',
  last30days: 'pages.dashboard.range.last30days',
  thisMonth: 'pages.dashboard.range.thisMonth',
  custom: 'pages.dashboard.range.custom',
}
const options = computed<Array<{ label: string; value: TimeRangePreset }>>(() =>
  props.presets.map((value) => ({ label: t(optionLabels[value]), value }))
)

const rangeLabel = computed(() => formatTimeRange(props.modelValue))

watch(popoverVisible, (visible) => {
  if (!visible) {
    customVisible.value = false
    draftRange.value = null
  }
})

watch(() => props.serverNow, () => {
  serverNowReceivedAt.value = Date.now()
})

function currentServerNow(): number {
  return props.serverNow + Math.max(0, Date.now() - serverNowReceivedAt.value)
}

function selectPreset(preset: TimeRangePreset) {
  if (preset === 'custom') {
    draftRange.value = [...props.modelValue] as TimeRange
    customVisible.value = true
    return
  }

  const range = rangeForPreset(preset, currentServerNow())
  emit('update:modelValue', range)
  emit('apply', range, preset)
  popoverVisible.value = false
}

function confirmCustom() {
  const error = validateTimeRange(draftRange.value, currentServerNow())
  if (error) {
    message.warning(t(`pages.dashboard.range.validation.${error}`))
    return
  }

  const range = [...draftRange.value!] as TimeRange
  emit('update:modelValue', range)
  emit('apply', range, 'custom')
  popoverVisible.value = false
}

function cancelCustom() {
  customVisible.value = false
  draftRange.value = null
}

function handleDatePanelClick(event: MouseEvent) {
  const target = event.target
  if (!(target instanceof Element)) return

  const item = target.closest<HTMLElement>('[data-n-date]')
  const quickPanel = item?.closest<HTMLElement>('.n-date-panel--month')
  const calendar = item?.closest<HTMLElement>('.n-date-panel-month-calendar')
  const clickedColumn = item?.closest<HTMLElement>('.n-date-panel-month-calendar__picker-col')
  if (!item || !quickPanel || !calendar || !clickedColumn) return

  const columns = [...calendar.children].filter((child) =>
    child.classList.contains('n-date-panel-month-calendar__picker-col')
  )
  if (columns.indexOf(clickedColumn) !== 1) return

  const quickJump = quickPanel.closest<HTMLElement>('.n-date-panel-month__month-year')
  const activeHeader = quickJump?.querySelector<HTMLElement>('.n-date-panel-month__text--active')
  if (!activeHeader) return

  void nextTick(() => activeHeader.click())
}
</script>

<template>
  <NPopover
    v-model:show="popoverVisible"
    trigger="click"
    :placement="placement"
    :show-arrow="false"
    :style="{ padding: '0', overflow: 'visible' }"
  >
    <template #trigger>
      <NButton
        :disabled="disabled"
        :size="compact ? 'small' : 'medium'"
        class="time-range-trigger"
        :class="{ 'time-range-trigger--compact': compact }"
      >
        <template #icon><NIcon :component="CalendarOutline" /></template>
        <span class="time-range-label">{{ rangeLabel }}</span>
        <NIcon :component="ChevronDownOutline" />
      </NButton>
    </template>

    <div class="time-range-popover" :class="{ 'time-range-popover--custom': customVisible }">
      <NDatePicker
        v-if="customVisible"
        v-model:value="draftRange"
        type="datetimerange"
        panel
        clearable
        :actions="[]"
        class="time-range-panel"
        @click.capture="handleDatePanelClick"
      />
      <div class="time-range-menu">
        <button
          v-for="option in options"
          :key="option.value"
          type="button"
          class="time-range-option"
          :class="{ active: option.value === preset || (option.value === 'custom' && customVisible) }"
          @click="selectPreset(option.value)"
        >
          {{ option.label }}
        </button>
        <div v-if="customVisible" class="time-range-actions">
          <NButton size="small" @click="cancelCustom">{{ t('common.cancel') }}</NButton>
          <NButton size="small" type="primary" @click="confirmCustom">
            {{ t('common.confirm') }}
          </NButton>
        </div>
      </div>
    </div>
  </NPopover>
</template>

<style scoped>
.time-range-trigger {
  max-width: 360px;
}

.time-range-trigger--compact {
  width: 292px;
  max-width: min(292px, calc(100vw - 112px));
}

.time-range-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.time-range-popover {
  min-width: 180px;
  display: flex;
  background: var(--bg-card);
}

.time-range-popover--custom {
  min-width: 760px;
}

.time-range-panel {
  border-right: 1px solid var(--border-color);
}

.time-range-menu {
  min-width: 180px;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.time-range-option {
  border: 0;
  border-radius: 7px;
  padding: 8px 10px;
  background: transparent;
  color: var(--text-primary);
  text-align: left;
  cursor: pointer;
}

.time-range-option:hover {
  background: var(--bg-secondary);
}

.time-range-option.active {
  background: rgba(42, 127, 255, 0.14);
  color: #2a7fff;
}

.time-range-actions {
  margin-top: 4px;
  padding-top: 8px;
  border-top: 1px solid var(--border-color);
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

@media (max-width: 820px) {
  .time-range-popover--custom {
    min-width: 0;
    max-width: calc(100vw - 24px);
    flex-direction: column;
  }

  .time-range-panel {
    border-right: 0;
    border-bottom: 1px solid var(--border-color);
  }
}
</style>
