<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NAlert, NButton, NForm, NInput, NSpin } from 'naive-ui'
import { ConnectionState } from '@/api/types'
import { useAuthStore } from '@/stores/auth'
import { useWebSocketStore } from '@/stores/websocket'
import { resolveConfigManagementRedirect } from '@/permissions/access-control'
import { useI18n } from 'vue-i18n'
import { platformBranding, usesDefaultPlatformBranding } from '@/branding/platform'
import { shouldLoginCreateUnauthenticatedConnection } from '@/realtime/global-sse-lifecycle'

const router = useRouter()
const route = useRoute()
const authStore = useAuthStore()
const websocketStore = useWebSocketStore()
const { t } = useI18n()

const loading = ref(true)
const checking = ref(true)
const error = ref('')
const username = ref('')
const password = ref('')
const showPassword = ref(false)

const connectionState = computed(() => websocketStore.state)
const useDefaultWordmark = computed(() => usesDefaultPlatformBranding())
const isConnected = computed(() => connectionState.value === ConnectionState.CONNECTED)
const isConnecting = computed(() =>
  connectionState.value === ConnectionState.CONNECTING ||
  connectionState.value === ConnectionState.RECONNECTING,
)

function redirectToPlatform() {
  if (authStore.currentUser?.mustChangePassword) {
    router.push({ name: 'PasswordChange' })
    return
  }
  const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/workspace'
  const entry = typeof route.query.entry === 'string' ? route.query.entry : ''
  router.push(entry === 'config'
    ? resolveConfigManagementRedirect(authStore.currentUser?.role, redirect)
    : redirect)
}

onMounted(async () => {
  const authEnabled = await authStore.checkAuthConfig()

  if (shouldLoginCreateUnauthenticatedConnection(authEnabled)) {
    websocketStore.connect()

    const checkConnection = () => {
      if (isConnected.value) {
        loading.value = false
        redirectToPlatform()
      } else if (websocketStore.lastError) {
        loading.value = false
        error.value = websocketStore.lastError
      }
    }

    const unsubscribe = websocketStore.subscribe('stateChange', checkConnection)
    setTimeout(() => {
      if (loading.value) {
        loading.value = false
        if (!isConnected.value) error.value = t('pages.gaiop.login.connectionTimeout')
      }
      unsubscribe()
    }, 10000)

    checkConnection()
    return
  }

  checking.value = false
  loading.value = false

  if (authStore.isAuthenticated && await authStore.checkAuth()) {
    redirectToPlatform()
  }
})

async function handleLogin() {
  if (!username.value || !password.value) {
    error.value = t('pages.gaiop.login.credentialsRequired')
    return
  }

  loading.value = true
  error.value = ''

  const success = await authStore.login(username.value, password.value)
  if (success) {
    redirectToPlatform()
    return
  }

  error.value = authStore.error || t('pages.gaiop.login.failed')
  loading.value = false
}

function handleRetry() {
  error.value = ''
  loading.value = true
  websocketStore.disconnect()
  websocketStore.connect()

  setTimeout(() => {
    if (loading.value && !isConnected.value) {
      loading.value = false
      error.value = t('pages.gaiop.login.connectionTimeout')
    }
  }, 10000)
}
</script>

<template>
  <main class="login-page">
    <div class="login-halo login-halo-top"></div>
    <div class="login-halo login-halo-bottom"></div>

    <div class="login-brand" :aria-label="t('pages.gaiop.login.title')">
      <span class="brand-logo" :aria-label="platformBranding.companyBrandEn">
        <template v-if="useDefaultWordmark">
          <span class="brand-net">Net</span><span class="brand-inside">Inside</span>
        </template>
        <template v-else>{{ platformBranding.companyBrandEn }}</template>
      </span>
      <span class="brand-divider"></span>
      <span class="brand-product">{{ t('pages.gaiop.login.brand') }}</span>
    </div>

    <section class="login-shell" aria-labelledby="login-title">
      <div class="login-heading">
        <h1 id="login-title">{{ t('pages.gaiop.login.title') }}</h1>
      </div>

      <div class="login-card">
        <div v-if="loading && !checking" class="login-state">
          <NSpin size="medium" />
          <span>{{ t('pages.gaiop.login.connecting') }}</span>
        </div>

        <template v-else-if="authStore.authEnabled || checking">
          <NAlert v-if="error" type="error" :bordered="false" class="login-alert">
            {{ error }}
          </NAlert>

          <NForm @submit.prevent="handleLogin">
            <label class="form-label" for="gaiop-username">{{ t('pages.gaiop.login.username') }}</label>
            <NInput
              id="gaiop-username"
              v-model:value="username"
              :placeholder="t('pages.gaiop.login.usernamePlaceholder')"
              size="large"
              class="login-input"
              @keydown.enter="handleLogin"
            />

            <label class="form-label password-label" for="gaiop-password">{{ t('pages.gaiop.login.password') }}</label>
            <div class="password-wrapper">
              <NInput
                id="gaiop-password"
                v-model:value="password"
                :type="showPassword ? 'text' : 'password'"
                :placeholder="t('pages.gaiop.login.passwordPlaceholder')"
                size="large"
                class="login-input"
                @keydown.enter="handleLogin"
              />
              <button
                type="button"
                class="password-toggle"
                :aria-label="showPassword ? t('pages.gaiop.login.hidePassword') : t('pages.gaiop.login.showPassword')"
                @click="showPassword = !showPassword"
              >
                <svg v-if="showPassword" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                  <path d="M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 4.2A10.7 10.7 0 0 1 12 4c6.3 0 10 8 10 8a18.2 18.2 0 0 1-3 4.2M6.2 6.2C4.1 7.8 2 12 2 12s3.7 8 10 8a10.7 10.7 0 0 0 4.1-.8" stroke-linecap="round" />
                </svg>
                <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                  <path d="M2 12s3.7-8 10-8 10 8 10 8-3.7 8-10 8S2 12 2 12Z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              </button>
            </div>

            <NButton
              type="primary"
              block
              size="large"
              class="login-button"
              :loading="loading"
              @click="handleLogin"
            >
              {{ t('pages.gaiop.login.login') }}
            </NButton>
          </NForm>
        </template>

        <template v-else>
          <div v-if="loading || isConnecting" class="login-state">
            <NSpin size="medium" />
            <span>{{ t('pages.gaiop.login.connecting') }}</span>
          </div>

          <NAlert v-if="error" type="error" :bordered="false" class="login-alert">
            {{ error }}
          </NAlert>

          <NButton
            v-if="!loading && !isConnected"
            type="primary"
            block
            size="large"
            class="login-button"
            @click="handleRetry"
          >
            {{ t('pages.gaiop.login.retry') }}
          </NButton>
        </template>
      </div>

      <p class="login-footer">© {{ new Date().getFullYear() }} {{ t('pages.gaiop.entrance.company') }}</p>
    </section>
  </main>
</template>

<style scoped>
.login-page {
  color-scheme: light;
  min-height: 100vh;
  overflow: hidden;
  position: relative;
  display: grid;
  place-items: center;
  box-sizing: border-box;
  padding: 32px 24px;
  background:
    radial-gradient(circle at 83% 14%, rgba(77, 192, 131, 0.17), transparent 24%),
    radial-gradient(circle at 12% 90%, rgba(84, 198, 139, 0.13), transparent 28%),
    linear-gradient(135deg, #fcfefc 0%, #f5fbf7 52%, #ecf9f1 100%);
  color: #173e31;
  font-family: Inter, 'PingFang SC', 'Microsoft YaHei', sans-serif;
}

.login-halo {
  position: absolute;
  border: 1px solid rgba(55, 169, 107, 0.12);
  border-radius: 50%;
  pointer-events: none;
}

.login-halo-top {
  top: -31vw;
  right: -20vw;
  width: 48vw;
  height: 48vw;
}

.login-halo-bottom {
  bottom: -32vw;
  left: -22vw;
  width: 47vw;
  height: 47vw;
}

.login-shell {
  position: relative;
  z-index: 1;
  width: min(100%, 650px);
  text-align: center;
}

.login-brand {
  position: absolute;
  z-index: 1;
  top: 28px;
  left: clamp(30px, 3.3vw, 64px);
  display: flex;
  align-items: center;
  gap: 13px;
}

.brand-logo {
  color: #171e1b;
  font-size: 16px;
  font-weight: 600;
  letter-spacing: -0.045em;
  line-height: 1;
  white-space: nowrap;
}

.brand-net { color: #50ae65; }
.brand-inside { color: #171e1b; }

.brand-divider {
  width: 1px;
  height: 23px;
  background: rgba(23, 62, 49, 0.2);
}

.brand-product {
  color: #174d38;
  font-size: 16px;
  font-weight: 650;
  letter-spacing: 0.02em;
}

.login-heading { margin: 0 0 27px; }

.login-heading h1 {
  margin: 0;
  font-size: 23px;
  font-weight: 600;
  letter-spacing: -0.025em;
  white-space: nowrap;
}

.title-net { color: #087249; }
.title-inside { color: #69ba77; }
.title-name,
.title-gaiop { color: #0b553a; }

.login-card {
  box-sizing: border-box;
  width: min(100%, 390px);
  min-height: 247px;
  margin-inline: auto;
  padding: 30px;
  border: 1px solid rgba(48, 139, 91, 0.14);
  border-radius: 20px;
  background: rgba(255, 255, 255, 0.8);
  box-shadow: 0 22px 46px rgba(45, 124, 78, 0.1);
  text-align: left;
}

.form-label {
  display: block;
  margin-bottom: 9px;
  color: #315f4b;
  font-size: 14px;
  font-weight: 500;
}

.password-label { margin-top: 19px; }

.login-input :deep(.n-input-wrapper) {
  border-radius: 10px;
}

.login-input {
  --n-color: #ffffff !important;
  --n-color-focus: #f8fffb !important;
  --n-text-color: #173e31 !important;
  --n-placeholder-color: #8aa397 !important;
  --n-caret-color: #087249 !important;
  --n-border: 1px solid #cfe2d7 !important;
  --n-border-hover: 1px solid #69bd8c !important;
  --n-border-focus: 1px solid #25a56d !important;
  --n-box-shadow-focus: 0 0 0 2px rgba(37, 165, 109, 0.14) !important;
}

.password-wrapper { position: relative; }

.password-toggle {
  position: absolute;
  z-index: 1;
  top: 50%;
  right: 11px;
  display: grid;
  width: 28px;
  height: 28px;
  padding: 0;
  place-items: center;
  transform: translateY(-50%);
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: #76978a;
  cursor: pointer;
}

.password-toggle:hover { color: #087249; background: #edf9f1; }
.password-toggle svg { width: 18px; height: 18px; }

.login-button {
  --n-color: #087249 !important;
  --n-color-hover: #0b8858 !important;
  --n-color-pressed: #075c3c !important;
  --n-color-focus: #087249 !important;
  --n-text-color: #fff !important;
  height: 46px;
  margin-top: 27px;
  border-radius: 11px;
  font-size: 15px;
  font-weight: 600;
}

.login-alert { margin-bottom: 18px; }

.login-state {
  display: grid;
  min-height: 185px;
  place-content: center;
  justify-items: center;
  gap: 16px;
  color: #6d8f80;
  font-size: 14px;
}

.login-footer {
  margin: 31px 0 0;
  color: rgba(67, 111, 87, 0.72);
  font-size: 12px;
}

@media (max-width: 480px) {
  .login-page { padding: 26px 20px; }
  .login-card { padding: 25px 21px; }
  .login-brand { top: 22px; left: 22px; }
  .brand-logo { font-size: 15px; }
  .brand-product { font-size: 15px; }
  .login-heading h1 { font-size: 16px; letter-spacing: -0.045em; }
}
</style>
