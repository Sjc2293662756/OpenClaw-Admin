<script setup lang="ts">
import { NCard, NTag, NText } from 'naive-ui'
import GAIOPServiceConfigurationPage from './GAIOPServiceConfigurationPage.vue'
import DataSourceManagementPage from './DataSourceManagementPage.vue'
import AlertIngestionConfigurationPage from './AlertIngestionConfigurationPage.vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
</script>

<template>
  <section class="configuration-page">
    <NCard class="app-card configuration-intro" :bordered="false">
      <div class="configuration-intro__content">
        <div>
          <NTag type="success" round :bordered="false">{{ t('pages.gaiop.systemConfig.introTag') }}</NTag>
          <h1>{{ t('pages.gaiop.systemConfig.title') }}</h1>
          <NText depth="3">{{ t('pages.gaiop.systemConfig.intro') }}</NText>
        </div>
        <span class="configuration-intro__hint">{{ t('pages.gaiop.systemConfig.noGlobalSave') }}</span>
      </div>

    </NCard>

    <section id="gaiop-service" class="configuration-section configuration-section--service">
      <div class="configuration-section__heading">
        <NTag type="success" :bordered="false">1</NTag>
        <div><h2>{{ t('pages.gaiop.systemConfig.serviceTitle') }}</h2><p>{{ t('pages.gaiop.systemConfig.serviceDescription') }}</p></div>
      </div>
      <div class="configuration-section__body"><GAIOPServiceConfigurationPage embedded /></div>
    </section>

    <section id="alert-ingestion" class="configuration-section configuration-section--alert">
      <div class="configuration-section__heading">
        <NTag type="error" :bordered="false">2</NTag>
        <div><h2>{{ t('pages.gaiop.systemConfig.alertTitle') }}</h2><p>{{ t('pages.gaiop.systemConfig.alertDescription') }}</p></div>
      </div>
      <div class="configuration-section__body"><AlertIngestionConfigurationPage embedded /></div>
    </section>

    <section id="data-sources" class="configuration-section configuration-section--source">
      <div class="configuration-section__heading">
        <NTag type="info" :bordered="false">3</NTag>
        <div><h2>{{ t('pages.gaiop.systemConfig.dataSourceTitle') }}</h2><p>{{ t('pages.gaiop.systemConfig.dataSourceDescription') }}</p></div>
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
:global([data-theme='dark'] .configuration-intro) { background: linear-gradient(118deg, #1d2421 0%, #17211c 100%); }
:global([data-theme='dark'] .configuration-intro h1) { color: #d5eadc; }
:global([data-theme='dark'] .configuration-intro__hint) { color: #a8c7b5; background: #26372e; }
:global([data-theme='dark'] .configuration-section) {
  border-color: #385044;
  background: #161c19;
  box-shadow: 0 4px 14px rgba(0, 0, 0, .18);
}
:global([data-theme='dark'] .configuration-section__heading h2) { color: #d8e7df; }
:global([data-theme='dark'] .configuration-section__heading p) { color: #91a79a; }
@media (max-width: 760px) { .configuration-page { gap: 16px; } .configuration-intro__content { flex-direction: column; gap: 12px; } .configuration-section { padding: 14px; } }
</style>
