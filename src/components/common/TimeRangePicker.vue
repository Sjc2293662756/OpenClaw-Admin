<script setup lang="ts">
import { computed, ref, watch } from 'vue'
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
}>(), {
  preset: 'custom',
  serverNow: () => Date.now(),
  disabled: false,
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

const options = computed<Array<{ label: string; value: TimeRangePreset }>>(() => [
  { label: t('pages.dashboard.range.today'), value: 'today' },
  { label: t('pages.dashboard.range.last7days'), value: 'last7days' },
  { label: t('pages.dashboard.range.last30days'), value: 'last30days' },
  { label: t('pages.dashboard.range.thisMonth'), value: 'thisMonth' },
  { label: t('pages.dashboard.range.custom'), value: 'custom' },
])

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
</script>

<template>
  <NPopover
    v-model:show="popoverVisible"
    trigger="click"
    placement="bottom-start"
    :show-arrow="false"
    :style="{ padding: '0', overflow: 'visible' }"
  >
    <template #trigger>
      <NButton :disabled="disabled" class="time-range-trigger">
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
