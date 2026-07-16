<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { NAlert, NButton, NCard, NForm, NFormItem, NInput, NSelect, NSpace, useMessage, type FormInst, type FormRules } from 'naive-ui'
import { useAuthStore } from '@/stores/auth'

const router = useRouter()
const authStore = useAuthStore()
const message = useMessage()
const formRef = ref<FormInst | null>(null)
const loading = ref(false)
const saving = ref(false)
const updatedAt = ref<number | null>(null)

const form = reactive({
  hostname: '',
  domain: '',
  ipAddress: '',
  subnetMask: '',
  gateway: '',
  dnsServers: [] as string[],
  internalAddressRanges: [] as string[],
  timezone: 'Asia/Shanghai',
  ntpServers: [] as string[],
  locale: 'zh-CN',
})

const timezoneOptions = [
  { label: '(GMT+8:00) China east China - Beijing, Guangdong, Shanghai, etc.', value: 'Asia/Shanghai' },
  { label: '(GMT+0:00) Coordinated Universal Time', value: 'UTC' },
]
const localeOptions = [
  { label: 'Simplified Chinese (简体中文)', value: 'zh-CN' },
  { label: 'English', value: 'en-US' },
]
const ipv4Pattern = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/

const rules: FormRules = {
  hostname: [{ required: true, message: '请输入主机名', trigger: ['input', 'blur'] }],
  ipAddress: [{ required: true, message: '请输入 IP 地址', trigger: ['input', 'blur'] }, { validator: (_rule, value) => ipv4Pattern.test(String(value || '').trim()), message: '请输入有效的 IPv4 地址', trigger: ['input', 'blur'] }],
  subnetMask: [{ required: true, message: '请输入子网掩码', trigger: ['input', 'blur'] }, { validator: (_rule, value) => ipv4Pattern.test(String(value || '').trim()), message: '请输入有效的子网掩码', trigger: ['input', 'blur'] }],
  gateway: [{ required: true, message: '请输入网关地址', trigger: ['input', 'blur'] }, { validator: (_rule, value) => ipv4Pattern.test(String(value || '').trim()), message: '请输入有效的网关地址', trigger: ['input', 'blur'] }],
}

function headers() { return { Authorization: `Bearer ${authStore.getToken()}` } }

function splitLines(value: string) {
  return value.split(/[\n,]/).map(item => item.trim()).filter(Boolean)
}

function joinLines(value: string[]) { return value.join('\n') }

async function loadConfig(showMessage = false) {
  loading.value = true
  try {
    const response = await fetch('/api/host-network-config', { headers: headers() })
    const data = await response.json()
    if (!response.ok || !data.ok) throw new Error(data.error || '获取主机配置失败')
    const config = data.config
    Object.assign(form, {
      hostname: config.hostname || '', domain: config.domain || '', ipAddress: config.ipAddress || '',
      subnetMask: config.subnetMask || '', gateway: config.gateway || '', dnsServers: config.dnsServers || [],
      internalAddressRanges: config.internalAddressRanges || [], timezone: config.timezone || 'Asia/Shanghai',
      ntpServers: config.ntpServers || [], locale: config.locale || 'zh-CN',
    })
    updatedAt.value = config.updatedAt || null
    if (showMessage) message.success('配置已刷新')
  } catch (error) {
    message.error(error instanceof Error ? error.message : '获取主机配置失败')
  } finally {
    loading.value = false
  }
}

async function save() {
  if (!authStore.isAdmin) { message.error('仅管理员可以保存主机与网络配置'); return }
  try { await formRef.value?.validate() } catch { return }
  saving.value = true
  try {
    const response = await fetch('/api/host-network-config', {
      method: 'PUT', headers: { ...headers(), 'Content-Type': 'application/json' }, body: JSON.stringify(form),
    })
    const data = await response.json()
    if (!response.ok || !data.ok) throw new Error(data.error || '保存主机配置失败')
    updatedAt.value = data.config.updatedAt
    message.success('主机与网络配置已保存')
  } catch (error) {
    message.error(error instanceof Error ? error.message : '保存主机配置失败')
  } finally {
    saving.value = false
  }
}

function formatTime(value: number | null) {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚未保存'
}

onMounted(() => loadConfig())
</script>

<template>
  <section class="host-network-page">
    <NAlert type="info" :bordered="false">
      当前为平台主机信息的本地管理配置。保存不会修改本机或麒麟服务器的网卡、DNS、网关、时区和 NTP 服务。
    </NAlert>
    <NCard title="主机与网络配置" :bordered="false" class="host-network-card">
      <template #header-extra>
        <span class="updated-at">最近更新：{{ formatTime(updatedAt) }}</span>
      </template>
      <NForm ref="formRef" :model="form" :rules="rules" label-placement="left" label-width="112" class="host-network-form">
        <h2>主机配置</h2>
        <NFormItem label="主机名" path="hostname" required><NInput v-model:value="form.hostname" placeholder="请输入主机名" maxlength="128" /></NFormItem>
        <NFormItem label="域名"><NInput v-model:value="form.domain" placeholder="例如 gaiop.netinside.com.cn（可选）" maxlength="255" /></NFormItem>
        <NFormItem label="IP 地址" path="ipAddress" required><NInput v-model:value="form.ipAddress" placeholder="例如 192.168.1.10" /></NFormItem>
        <NFormItem label="子网掩码" path="subnetMask" required><NInput v-model:value="form.subnetMask" placeholder="例如 255.255.255.0" /></NFormItem>
        <NFormItem label="网关" path="gateway" required><NInput v-model:value="form.gateway" placeholder="例如 192.168.1.1" /></NFormItem>

        <h2>域名服务器</h2>
        <NFormItem label="域名服务器"><NInput :value="joinLines(form.dnsServers)" type="textarea" placeholder="每行一个 DNS 服务器 IP" :autosize="{ minRows: 3, maxRows: 5 }" @update:value="value => form.dnsServers = splitLines(value)" /></NFormItem>

        <h2>内部地址</h2>
        <NFormItem label="内部地址列表"><NInput :value="joinLines(form.internalAddressRanges)" type="textarea" placeholder="每行一个内部 IP 或 IP 范围，例如 10.0.0.1-10.0.0.254" :autosize="{ minRows: 3, maxRows: 5 }" @update:value="value => form.internalAddressRanges = splitLines(value)" /></NFormItem>

        <h2>时间设置</h2>
        <NFormItem label="时区"><NSelect v-model:value="form.timezone" :options="timezoneOptions" /></NFormItem>
        <NFormItem label="NTP 服务器"><NInput :value="joinLines(form.ntpServers)" type="textarea" placeholder="每行一个 NTP 服务器（可选）" :autosize="{ minRows: 2, maxRows: 4 }" @update:value="value => form.ntpServers = splitLines(value)" /></NFormItem>

        <h2>语言设置</h2>
        <NFormItem label="本地语言"><NSelect v-model:value="form.locale" :options="localeOptions" /></NFormItem>
        <NFormItem label=""><NSpace><NButton :loading="loading" @click="loadConfig(true)">刷新</NButton><NButton type="primary" :disabled="!authStore.isAdmin" :loading="saving" @click="save">保存配置</NButton><NButton @click="router.push({ name: 'SystemConfiguration' })">返回系统配置</NButton></NSpace></NFormItem>
      </NForm>
    </NCard>
  </section>
</template>

<style scoped>
.host-network-page { display: grid; gap: 16px; }
.host-network-card { min-height: 580px; }
.updated-at { color: var(--text-color-3); font-size: 12px; }
.host-network-form { max-width: 790px; padding: 4px 8px 20px; }
.host-network-form h2 { margin: 22px 0 16px; padding: 9px 13px; border-left: 3px solid #1d9a62; background: rgba(29, 154, 98, .06); color: #174d38; font-size: 15px; }
.host-network-form h2:first-child { margin-top: 2px; }
</style>
