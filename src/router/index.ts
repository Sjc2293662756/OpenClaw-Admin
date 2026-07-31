import { createRouter, createWebHistory } from 'vue-router'
import { routes } from './routes'
import { useAuthStore } from '@/stores/auth'
import { installChunkLoadRecovery } from './chunk-recovery'
import { canAccessRoute, getPageAccess } from '@/permissions/access-control'

const router = createRouter({
  history: createWebHistory(),
  routes,
})

installChunkLoadRecovery(router)

router.beforeEach(async (to, _from, next) => {
  const authStore = useAuthStore()

  let authEnabled = false
  try {
    authEnabled = await authStore.checkAuthConfig()
  } catch (error) {
    console.error('[Router] checkAuthConfig failed:', error)
    // 认证配置检查失败时，假设认证已禁用，允许访问
    authEnabled = false
  }

  if (!authEnabled) {
    if (to.name === 'Login') {
      next({ name: 'ChatWorkspace' })
      return
    }
    next()
    return
  }

  if (to.meta.public) {
    if (to.name === 'Login' && authStore.isAuthenticated) {
      try {
        const valid = await authStore.checkAuth()
        if (valid) {
          if (authStore.currentUser?.mustChangePassword) {
            next({ name: 'PasswordChange' })
          } else {
            const redirect = typeof to.query.redirect === 'string' ? to.query.redirect : '/workspace'
            next(redirect)
          }
          return
        }
      } catch (error) {
        console.error('[Router] checkAuth failed:', error)
      }
    }
    next()
    return
  }

  if (!authStore.isAuthenticated) {
    next({ name: 'Welcome', query: { redirect: to.fullPath } })
    return
  }

  try {
    const valid = await authStore.checkAuth()
    if (!valid) {
      next({ name: 'Welcome', query: { redirect: to.fullPath } })
      return
    }
  } catch (error) {
    console.error('[Router] checkAuth failed:', error)
    next({ name: 'Welcome', query: { redirect: to.fullPath } })
    return
  }

  if (authStore.currentUser?.mustChangePassword && to.name !== 'PasswordChange') {
    next({ name: 'PasswordChange' })
    return
  }

  const role = authStore.currentUser?.role
  if (to.name !== 'AccessDenied' && !canAccessRoute(role, to.name)) {
    const access = getPageAccess(to.name)
    next({
      name: 'AccessDenied',
      query: {
        module: access?.moduleName || '当前模块',
        from: to.fullPath,
      },
      replace: true,
    })
    return
  }

  next()
})

export default router
