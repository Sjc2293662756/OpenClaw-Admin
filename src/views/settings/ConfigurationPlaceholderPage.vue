<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { NButton, NCard, NTag, NText } from 'naive-ui'

const router = useRouter()
const props = defineProps<{ module?: string }>()

const modules: Record<string, { title: string; description: string }> = {
  environment: { title: '环境与敏感配置', description: '运行参数、证书、令牌和其他敏感信息将按管理员权限集中维护。' },
  alert: { title: '告警接入与转发配置', description: 'Syslog 告警接入、解析和消息转发规则将在此配置。' },
}

const info = computed(() => modules[props.module || ''] || modules.environment!)
</script>

<template>
  <NCard class="placeholder-card" :bordered="false">
    <div class="placeholder-content">
      <NTag type="success" round :bordered="false">配置框架已建立</NTag>
      <h1>{{ info.title }}</h1>
      <NText depth="3">{{ info.description }}</NText>
      <NText depth="3" class="placeholder-note">具体字段、权限、保存方式和连通性验证规则将在该模块进入实施阶段时确认。</NText>
      <NButton type="primary" @click="router.push({ name: 'SystemConfiguration' })">返回系统配置</NButton>
    </div>
  </NCard>
</template>

<style scoped>
.placeholder-card { min-height: 390px; display: grid; place-items: center; background: radial-gradient(circle at 82% 20%, rgba(55,169,107,.14), transparent 30%), linear-gradient(135deg, var(--bg-card), rgba(232,247,238,.72)); }
.placeholder-content { max-width: 500px; padding: 28px; text-align: center; }
.placeholder-content h1 { margin: 18px 0 12px; color: #174d38; font-size: 26px; }
.placeholder-note { display: block; margin: 14px 0 26px; font-size: 13px; line-height: 1.7; }
</style>
