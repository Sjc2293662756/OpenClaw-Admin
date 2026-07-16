<script setup lang="ts">
import { useRouter } from 'vue-router'
import { NCard, NText } from 'naive-ui'

const router = useRouter()

const modules = [
  { name: 'IpManagement', title: 'IP 地址管理', description: '访问白名单、黑名单及网段规则', accent: 'green' },
  { name: 'SessionManagement', title: '会话时长管理', description: '登录时长、空闲超时及会话策略', accent: 'blue' },
]
</script>

<template>
  <NCard title="访问控制" class="app-card">
    <NText depth="3" style="display: block; margin-bottom: 16px;">
      管理平台访问范围和登录会话策略。具体配置将在后续确认后启用。
    </NText>
    <div class="access-module-grid">
      <button
        v-for="module in modules"
        :key="module.name"
        type="button"
        class="access-module"
        :class="`access-module--${module.accent}`"
        @click="router.push({ name: module.name })"
      >
        <span class="access-module-title">{{ module.title }}</span>
        <span class="access-module-description">{{ module.description }}</span>
        <span class="access-module-arrow">→</span>
      </button>
    </div>
  </NCard>
</template>

<style scoped>
.access-module-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

.access-module {
  position: relative;
  min-height: 132px;
  padding: 21px;
  border: 1px solid var(--border-color);
  border-radius: 12px;
  background: var(--bg-card);
  color: var(--text-primary);
  cursor: pointer;
  text-align: left;
  transition: transform 180ms ease, border-color 180ms ease, box-shadow 180ms ease;
}

.access-module:hover {
  transform: translateY(-3px);
  border-color: rgba(24, 160, 88, 0.42);
  box-shadow: 0 12px 26px rgba(33, 115, 72, 0.11);
}

.access-module--blue:hover { border-color: rgba(42, 127, 255, 0.38); }

.access-module-title,
.access-module-description { display: block; }

.access-module-title {
  color: #174d38;
  font-size: 17px;
  font-weight: 600;
}

.access-module-description {
  margin-top: 9px;
  color: var(--text-secondary);
  font-size: 13px;
}

.access-module-arrow {
  position: absolute;
  right: 19px;
  bottom: 16px;
  color: #18a058;
  font-size: 19px;
}

.access-module--blue .access-module-arrow { color: #2a7fff; }

@media (max-width: 560px) {
  .access-module-grid { grid-template-columns: 1fr; }
}
</style>
