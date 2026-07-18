<script setup lang="ts">
import { NCard, NTag, NText } from 'naive-ui'
import GAIOPServiceConfigurationPage from './GAIOPServiceConfigurationPage.vue'
import DataSourceManagementPage from './DataSourceManagementPage.vue'
import AlertIngestionConfigurationPage from './AlertIngestionConfigurationPage.vue'
</script>

<template>
  <section class="configuration-page">
    <NCard class="app-card configuration-intro" :bordered="false">
      <div class="configuration-intro__content">
        <div>
          <NTag type="success" round :bordered="false">部署与数据接入</NTag>
          <h1>GAIOP 系统配置</h1>
          <NText depth="3">按实际部署顺序完成连接、告警接入和运行数据源配置；每一步独立保存与生效。</NText>
        </div>
        <span class="configuration-intro__hint">无需全页保存</span>
      </div>

    </NCard>

    <section id="gaiop-service" class="configuration-section configuration-section--service">
      <div class="configuration-section__heading">
        <NTag type="success" :bordered="false">1</NTag>
        <div><h2>GAIOP 服务连接</h2><p>先建立 Admin BFF 与 GAIOP Gateway 的受控连接。</p></div>
      </div>
      <div class="configuration-section__body"><GAIOPServiceConfigurationPage embedded /></div>
    </section>

    <section id="alert-ingestion" class="configuration-section configuration-section--alert">
      <div class="configuration-section__heading">
        <NTag type="error" :bordered="false">2</NTag>
        <div><h2>Syslog 告警接入</h2><p>维护 GAIOP 接收 NAPM Syslog 告警的运行目标。</p></div>
      </div>
      <div class="configuration-section__body"><AlertIngestionConfigurationPage embedded /></div>
    </section>

    <section id="data-sources" class="configuration-section configuration-section--source">
      <div class="configuration-section__heading">
        <NTag type="info" :bordered="false">3</NTag>
        <div><h2>运行数据源</h2><p>维护并启用当前 GAIOP 运行时使用的 NAPM 数据源。</p></div>
      </div>
      <div class="configuration-section__body configuration-section__body--source"><DataSourceManagementPage embedded /></div>
    </section>
  </section>
</template>

<style scoped>
.configuration-page { display: grid; gap: 20px; max-width: 1440px; margin: 0 auto; padding-bottom: 12px; }
.configuration-intro { overflow: hidden; background: linear-gradient(118deg, #fff 0%, #f1faf5 100%); }
.configuration-intro__content { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; }
.configuration-intro h1 { margin: 11px 0 7px; color: #174d38; font-size: 26px; letter-spacing: -.3px; }
.configuration-intro__hint { padding: 6px 10px; border-radius: 999px; color: #4e7663; background: #e4f3ea; font-size: 12px; white-space: nowrap; }
.configuration-section { display: grid; gap: 16px; padding: 18px; border: 1px solid #a9d7b8; border-radius: 12px; background: #fcfffd; box-shadow: 0 4px 14px rgba(44, 100, 69, .045); scroll-margin-top: 20px; }
.configuration-section__heading { display: flex; align-items: flex-start; gap: 10px; min-height: 30px; }
.configuration-section__heading :deep(.n-tag) { min-width: 22px; justify-content: center; }
.configuration-section__heading h2 { margin: 0 0 3px; color: #264d3b; font-size: 18px; letter-spacing: -.1px; }
.configuration-section__heading p { margin: 0; color: #6d8b7c; font-size: 13px; line-height: 1.55; }
.configuration-section__body { min-width: 0; }
.configuration-section__body--source { overflow: hidden; }
.configuration-section__body--source :deep(.n-card), .configuration-section__body--source :deep(.n-data-table) { max-width: 100%; }
@media (max-width: 760px) { .configuration-page { gap: 16px; } .configuration-intro__content { flex-direction: column; gap: 12px; } .configuration-section { padding: 14px; } }
</style>
