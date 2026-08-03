<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'

const props = defineProps<{
  mediaPath: string
  sessionKey?: string
  alt?: string
}>()
const emit = defineEmits<{ preview: [url: string] }>()
const authStore = useAuthStore()
const objectUrl = ref('')
const failed = ref(false)
let generation = 0
let controller: AbortController | null = null

function clearObjectUrl() {
  if (objectUrl.value) URL.revokeObjectURL(objectUrl.value)
  objectUrl.value = ''
}

async function load() {
  const current = ++generation
  controller?.abort()
  controller = new AbortController()
  clearObjectUrl()
  failed.value = false
  const token = authStore.getToken()
  if (!token || !props.mediaPath) {
    failed.value = true
    return
  }
  try {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
    if (props.sessionKey) headers['X-GAIOP-Session-Key'] = props.sessionKey
    const response = await fetch(`/api/media?path=${encodeURIComponent(props.mediaPath)}`, {
      headers,
      cache: 'no-store',
      signal: controller.signal,
    })
    if (response.status === 401) authStore.expireSession()
    if (!response.ok) throw new Error('media unavailable')
    const url = URL.createObjectURL(await response.blob())
    if (current !== generation) URL.revokeObjectURL(url)
    else objectUrl.value = url
  } catch (error) {
    if (current === generation && !(error instanceof DOMException && error.name === 'AbortError')) failed.value = true
  }
}

watch(() => [props.mediaPath, props.sessionKey, authStore.token] as const, load, { immediate: true })
onBeforeUnmount(() => {
  generation++
  controller?.abort()
  clearObjectUrl()
})
</script>

<template>
  <img v-if="objectUrl" :src="objectUrl" :alt="alt || ''" loading="lazy" @click="emit('preview', objectUrl)" />
  <span v-else-if="failed"><slot>图片不可用</slot></span>
  <span v-else><slot>图片加载中</slot></span>
</template>
