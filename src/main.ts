import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { loadPlatformBranding } from '@/branding/platform'
import './assets/styles/main.css'
import 'katex/dist/katex.min.css'
import 'highlight.js/styles/github-dark.css'

await loadPlatformBranding()

const [{ default: App }, { default: router }, { i18n }] = await Promise.all([
  import('./App.vue'),
  import('./router'),
  import('@/i18n'),
])

const app = createApp(App)
app.use(createPinia())
app.use(i18n)
app.use(router)
app.mount('#app')
