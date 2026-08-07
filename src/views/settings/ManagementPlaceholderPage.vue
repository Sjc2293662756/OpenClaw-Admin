<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NButton, NCard, NTag, NText } from 'naive-ui'
import { platformBranding } from '@/branding/platform'

const route = useRoute()
const router = useRouter()
const props = defineProps<{ module?: string }>()

const defaultModule = {
  title: '账户管理',
  description: '用户账号、用户类型与操作权限将在此配置。',
}

const modules: Record<string, typeof defaultModule> = {
  users: {
    title: '账户管理',
    description: '用户账号、用户类型与操作权限将在此配置。',
  },
  basic: {
    title: '基本设置',
    description: '平台名称、外观、默认行为和基础策略将在此维护。',
  },
  audit: {
    title: '操作审计设置',
    description: '审计记录范围、保存期限、导出及相关策略将在此维护。',
  },
  ip: {
    title: 'IP 地址管理',
    description: '访问白名单、黑名单及网段规则将在此配置。',
  },
  session: {
    title: '会话时长管理',
    description: '登录会话时长、空闲超时和在线会话策略将在此配置。',
  },
  storage: {
    title: '报告存储位置',
    description: '报告与临时文件的存储目录、保留策略和容量限制将在此配置。',
  },
  environment: {
    title: '环境配置',
    description: `${platformBranding.productCode}、NAPM 与 AI 服务相关的环境参数将在此配置。`,
  },
  upgrade: {
    title: '系统升级',
    description: '升级包上传、版本检查、升级进度和回滚能力将在此配置。',
  },
}

const moduleInfo = computed(() => modules[props.module || String(route.params.module)] ?? defaultModule)
</script>

<template>
  <NCard class="placeholder-card" :bordered="false">
    <div class="placeholder-content">
      <NTag type="success" round :bordered="false">待配置</NTag>
      <h1>{{ moduleInfo.title }}</h1>
      <NText depth="3">{{ moduleInfo.description }}</NText>
      <NText depth="3" class="placeholder-note">
        当前仅保留页面入口。具体字段、权限和操作流程将在后续确认后实施。
      </NText>
      <NButton type="primary" @click="router.push({ name: 'Settings' })">返回系统设置</NButton>
    </div>
  </NCard>
</template>

<style scoped>
.placeholder-card {
  min-height: 390px;
  display: grid;
  place-items: center;
  background:
    radial-gradient(circle at 82% 20%, rgba(55, 169, 107, 0.14), transparent 30%),
    linear-gradient(135deg, var(--bg-card), rgba(232, 247, 238, 0.72));
}

.placeholder-content {
  max-width: 500px;
  padding: 28px;
  text-align: center;
}

.placeholder-content h1 {
  margin: 18px 0 12px;
  color: #174d38;
  font-size: 26px;
}

.placeholder-note {
  display: block;
  margin: 14px 0 26px;
  font-size: 13px;
  line-height: 1.7;
}
</style>
