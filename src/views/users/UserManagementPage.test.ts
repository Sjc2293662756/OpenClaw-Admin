// @vitest-environment happy-dom

import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, Transition, type Component as VueComponent } from 'vue'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'
import { NConfigProvider, NDialogProvider, NMessageProvider } from 'naive-ui'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAuthStore } from '@/stores/auth'
import UserCreatePage from './UserCreatePage.vue'
import UserManagementPage from './UserManagementPage.vue'

describe('user management page routing', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('leaves the user list transition and renders the create form without a reload', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      users: [{
        id: 'initial-admin',
        username: 'admin',
        role: 'admin',
        description: '',
        status: 'active',
        isInitialAdmin: true,
        mustChangePassword: false,
        updatedAt: Date.now(),
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })))

    const pinia = createPinia()
    setActivePinia(pinia)
    const authStore = useAuthStore()
    authStore.token = 'test-token'
    authStore.currentUser = {
      id: 'initial-admin',
      username: 'admin',
      role: 'admin',
      isInitialAdmin: true,
      mustChangePassword: false,
    }

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/users', name: 'UserManagement', component: UserManagementPage },
        { path: '/users/create', name: 'UserCreate', component: UserCreatePage },
        { path: '/users/password', name: 'PasswordChange', component: { template: '<div>password</div>' } },
      ],
    })

    const Harness = defineComponent({
      setup() {
        return () => h(NConfigProvider, null, {
          default: () => h(NDialogProvider, null, {
            default: () => h(NMessageProvider, null, {
              default: () => h(RouterView, null, {
                default: ({ Component }: { Component: VueComponent }) => h(Transition, { mode: 'out-in' }, () => h(Component)),
              }),
            }),
          }),
        })
      },
    })

    await router.push('/users')
    await router.isReady()
    const wrapper = mount(Harness, { global: { plugins: [pinia, router] } })
    await flushPromises()

    await router.push('/users/create')
    await nextTick()
    await flushPromises()

    expect(wrapper.text()).toContain('添加用户')
    expect(wrapper.find('input[placeholder="请输入用户名"]').exists()).toBe(true)
    wrapper.unmount()
  })
})
