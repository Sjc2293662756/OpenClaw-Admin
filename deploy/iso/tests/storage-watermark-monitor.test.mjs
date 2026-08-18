import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const service = readFileSync(new URL('../../systemd/gaiop-storage-watermark-monitor.service', import.meta.url), 'utf8')
const timer = readFileSync(new URL('../../systemd/gaiop-storage-watermark-monitor.timer', import.meta.url), 'utf8')
const config = JSON.parse(readFileSync(new URL('../storage-watermark/managed-roots.json', import.meta.url), 'utf8'))

test('storage watermark timer runs every five minutes and persists missed checks', () => {
  assert.match(timer, /^OnCalendar=\*-\*-\* \*:0\/5:00 UTC$/m)
  assert.match(timer, /^Persistent=true$/m)
  assert.match(timer, /^Unit=gaiop-storage-watermark-monitor\.service$/m)
})

test('storage watermark service is a hardened Node one-shot with monitor-only filesystem access', () => {
  assert.match(service, /^Type=oneshot$/m)
  assert.match(service, /^ExecStart=\/usr\/local\/bin\/node \/opt\/gaiop\/admin\/server\/storage-watermark-monitor\.js$/m)
  assert.match(service, /^Environment=GAIOP_ADMIN_DATA_DIR=\/var\/lib\/gaiop\/admin$/m)
  assert.match(service, /^Environment=GAIOP_STORAGE_WATERMARK_CONFIG=\/etc\/gaiop\/storage-watermark-roots\.json$/m)
  assert.match(service, /^ProtectSystem=strict$/m)
  assert.match(service, /^NoNewPrivileges=true$/m)
  assert.match(service, /^ReadWritePaths=\/var\/lib\/gaiop\/admin$/m)
  assert.doesNotMatch(service, /^EnvironmentFile=/m)
  assert.doesNotMatch(service, /\/home\/netinside\/\.openclaw|\/var\/backups\/gaiop|upgrade-upload-staging|\/var\/log\/netinside|\/var\/log\/caddy/)
  assert.doesNotMatch(service, /admin-retention|upgrade-retention|clean(?:er|up)|\brm\b|unlink|find\s|sh\s+-c|bash\s+-c/i)
})

test('managed root template uses one safe probe for the single production data filesystem', () => {
  assert.equal(config.version, 'gaiop_storage_watermark_roots.v1')
  assert.deepEqual(config.managedRoots, [
    { label: 'admin_state', path: '/var/lib/gaiop/admin' },
  ])
  assert.equal(config.managedRoots.every((item) => typeof item.path === 'string' && item.path.startsWith('/') && item.path !== '/'), true)
  assert.equal(new Set(config.managedRoots.map((item) => item.path)).size, config.managedRoots.length)
})
