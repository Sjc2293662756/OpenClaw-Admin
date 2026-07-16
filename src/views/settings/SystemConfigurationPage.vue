<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { NCard, NIcon, NTag, NText } from 'naive-ui'
import {
  AlertCircleOutline,
  CloudOutline,
  ServerOutline,
} from '@vicons/ionicons5'

const router = useRouter()

const modules = [
  {
    name: 'HostNetworkConfiguration',
    title: '主机与网络配置',
    description: '维护主机名、IP、网关、DNS、内部地址、时区和 NTP 信息。',
    icon: ServerOutline,
    tone: 'green',
  },
  {
    name: 'DataSourceManagement',
    title: '数据源管理',
    description: '添加和维护 NAPM 数据源，并预留连通性测试入口。',
    icon: CloudOutline,
    tone: 'blue',
  },
  {
    name: 'AlertForwardingConfiguration',
    title: '告警接入与转发配置',
    description: '预留 Syslog 告警接入、解析和转发规则。',
    icon: AlertCircleOutline,
    tone: 'red',
  },
]

const moduleCount = computed(() => modules.length)
</script>

<template>
  <section class="configuration-page">
    <NCard class="app-card configuration-intro">
      <div class="configuration-intro__content">
        <div>
          <NTag type="success" round :bordered="false">系统配置</NTag>
          <h1>GAIOP 部署与数据接入配置</h1>
          <NText depth="3">
            此处用于维护主机网络、NAPM 数据源、告警接入及运行安全配置。具体字段与保存规则将在对应模块实施时确定。
          </NText>
        </div>
        <span class="configuration-intro__count">{{ moduleCount }} 个配置分区</span>
      </div>
    </NCard>

    <div class="configuration-grid">
      <button
        v-for="item in modules"
        :key="item.name"
        type="button"
        class="configuration-card"
        :class="`configuration-card--${item.tone}`"
        @click="router.push({ name: item.name })"
      >
        <span class="configuration-card__icon"><NIcon :component="item.icon" /></span>
        <span class="configuration-card__body">
          <strong>{{ item.title }}</strong>
          <small>{{ item.description }}</small>
        </span>
        <span class="configuration-card__arrow">→</span>
      </button>
    </div>
  </section>
</template>

<style scoped>
.configuration-page { display: grid; gap: 16px; }
.configuration-intro { overflow: hidden; background: linear-gradient(118deg, #fff, #edf9f1); }
.configuration-intro__content { display: flex; align-items: end; justify-content: space-between; gap: 24px; padding: 4px; }
.configuration-intro h1 { margin: 13px 0 8px; color: #174d38; font-size: 24px; }
.configuration-intro__count { flex: 0 0 auto; border: 1px solid #cce6d5; border-radius: 999px; padding: 7px 11px; color: #19704b; font-size: 12px; }
.configuration-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.configuration-card { display: flex; min-height: 128px; align-items: flex-start; gap: 13px; padding: 18px; border: 1px solid #e1ece5; border-radius: 14px; background: var(--bg-card); color: #264d3b; cursor: pointer; font: inherit; text-align: left; transition: transform .16s ease, box-shadow .16s ease, border-color .16s ease; }
.configuration-card:hover { transform: translateY(-2px); border-color: #9bcdb0; box-shadow: 0 10px 25px rgba(30, 92, 57, .08); }
.configuration-card__icon { display: grid; width: 36px; height: 36px; flex: 0 0 auto; place-items: center; border-radius: 10px; font-size: 19px; }
.configuration-card__body { display: grid; gap: 7px; min-width: 0; }
.configuration-card__body strong { font-size: 16px; }
.configuration-card__body small { color: #6d8b7c; font-size: 13px; line-height: 1.6; }
.configuration-card__arrow { margin-left: auto; color: #80a390; font-size: 19px; }
.configuration-card--green .configuration-card__icon { background: #e7f6ec; color: #168257; }
.configuration-card--blue .configuration-card__icon { background: #e9f3ff; color: #367bdc; }
.configuration-card--orange .configuration-card__icon { background: #fff3e5; color: #d77a1e; }
.configuration-card--red .configuration-card__icon { background: #fff0f0; color: #cf5b5b; }
@media (max-width: 760px) { .configuration-intro__content { align-items: flex-start; flex-direction: column; } .configuration-grid { grid-template-columns: 1fr; } }
</style>
