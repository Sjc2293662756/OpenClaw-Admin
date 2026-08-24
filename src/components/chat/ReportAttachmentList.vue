<script setup lang="ts">
import { NIcon, NSpin } from 'naive-ui'
import { DocumentTextOutline, DownloadOutline } from '@vicons/ionicons5'
import { useI18n } from 'vue-i18n'
import type { ChatReportFile } from '@/utils/chat-report-attachments'

defineProps<{
  reports: ChatReportFile[]
  downloadingId?: string
}>()

const emit = defineEmits<{
  download: [report: ChatReportFile]
}>()

const { t } = useI18n()

function formatFileSize(size: number): string {
  const bytes = Math.max(0, Number(size) || 0)
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
</script>

<template>
  <div class="report-attachment-list">
    <button
      v-for="report in reports"
      :key="report.id"
      type="button"
      class="report-attachment-card"
      :disabled="report.status !== 'ready' || Boolean(downloadingId)"
      :title="report.status === 'ready' ? t('pages.chat.reportAttachment.download') : t('pages.chat.reportAttachment.unavailable')"
      @click="emit('download', report)"
    >
      <span class="report-attachment-card__file-icon">
        <NIcon :component="DocumentTextOutline" />
      </span>
      <span class="report-attachment-card__body">
        <span class="report-attachment-card__name">{{ report.name }}</span>
        <span class="report-attachment-card__meta">
          {{ t('pages.chat.reportAttachment.wordDocument') }} · {{ formatFileSize(report.size) }}
        </span>
      </span>
      <NSpin v-if="downloadingId === report.id" :size="18" />
      <NIcon v-else class="report-attachment-card__download" :component="DownloadOutline" />
    </button>
  </div>
</template>

<style scoped>
.report-attachment-list {
  display: grid;
  gap: 8px;
  margin-top: 10px;
  max-width: 420px;
}

.report-attachment-card {
  align-items: center;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  color: var(--text-primary);
  cursor: pointer;
  display: grid;
  font: inherit;
  gap: 10px;
  grid-template-columns: 38px minmax(0, 1fr) 24px;
  padding: 10px 12px;
  text-align: left;
  transition: border-color 0.15s ease, background-color 0.15s ease;
  width: 100%;
}

.report-attachment-card:hover:not(:disabled) {
  background: color-mix(in srgb, var(--primary-color, #2080f0) 5%, var(--bg-secondary));
  border-color: var(--primary-color, #2080f0);
}

.report-attachment-card:focus-visible {
  outline: 2px solid var(--primary-color, #2080f0);
  outline-offset: 2px;
}

.report-attachment-card:disabled {
  cursor: not-allowed;
  opacity: 0.62;
}

.report-attachment-card__file-icon {
  align-items: center;
  background: color-mix(in srgb, var(--primary-color, #2080f0) 14%, transparent);
  border-radius: 8px;
  color: var(--primary-color, #2080f0);
  display: flex;
  font-size: 22px;
  height: 38px;
  justify-content: center;
  width: 38px;
}

.report-attachment-card__body {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
}

.report-attachment-card__name {
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.report-attachment-card__meta {
  color: var(--text-secondary);
  font-size: 12px;
}

.report-attachment-card__download {
  color: var(--text-secondary);
  font-size: 19px;
}
</style>
