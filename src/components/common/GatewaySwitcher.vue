<script setup lang="ts">
import { NSelect, NSpace } from 'naive-ui'
import { useHermesConnectionStore } from '@/stores/hermes/connection'

const connStore = useHermesConnectionStore()

const options = [
  { label: 'GAIOP 智能引擎', value: 'openclaw' },
  { label: 'GAIOP 扩展引擎', value: 'hermes' },
]

async function handleChange(val: string) {
  await connStore.switchGateway(val as 'openclaw' | 'hermes')
}
</script>

<template>
  <NSpace align="center" :size="8">
    <NSelect
      :value="connStore.currentGateway"
      :options="options"
      size="small"
      style="width: 150px"
      @update:value="handleChange"
    />
  </NSpace>
</template>
