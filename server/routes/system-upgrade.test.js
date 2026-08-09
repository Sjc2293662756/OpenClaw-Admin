import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import { cleanupExpiredUpgradeUploadStaging, createSystemUpgradeRouter } from './system-upgrade.js'

async function startTestServer({ readOverview, validatePackage, executeTask, readTask, rollbackBackup, deleteBackup } = {}) {
  const app = express()
  app.use(express.json())
  const audits = []
  app.use('/upgrade', createSystemUpgradeRouter({
    adminMiddleware: (req, _res, next) => {
      req.user = { username: 'admin' }
      next()
    },
    getUpgradeConfig: () => ({ serviceUrl: 'http://127.0.0.1:18900', internalToken: 'test-token' }),
    readOverview: readOverview || (async () => ({ runtime: { state: 'not-configured' }, status: null, tasks: [], backups: [] })),
    validatePackage,
    executeTask,
    readTask,
    rollbackBackup,
    deleteBackup,
    recordAudit: (_user, action, target, detail) => audits.push({ action, target, detail }),
  }))
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { server, audits, baseUrl: 'http://127.0.0.1:' + server.address().port + '/upgrade' }
}

test('system upgrade overview is served through the Admin BFF', async () => {
  let received = null
  const context = await startTestServer({ readOverview: async (input) => {
    received = input
    return {
      runtime: { state: 'reachable', serviceVersion: '1.0.0', lastErrorCode: null },
      status: { maintenance_mode: false, skills: {} },
      tasks: [],
      backups: [],
    }
  } })
  try {
    const response = await fetch(context.baseUrl + '/overview')
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.equal(body.runtime.state, 'reachable')
    assert.equal(received.actor, 'admin')
    assert.equal(Object.hasOwn(body, 'internalToken'), false)
  } finally {
    context.server.close()
  }
})

test('package validation is mediated by the BFF and returns a safe validation summary', async () => {
  let received = null
  const context = await startTestServer({
    validatePackage: async (input) => {
      received = input
      return {
        state: 'reachable',
        status: 200,
        payload: {
          valid: true,
          task_id: '00000000-0000-4000-8000-000000000001',
          type: 'skill-single',
          component: 'example-skill',
          new_version: '1.2.3',
          impact: { requires_restart: false, requires_maintenance: false },
        },
      }
    },
  })
  try {
    const form = new FormData()
    form.append('file', new Blob(['not-a-real-zip']), 'upgrade.zip')
    const response = await fetch(context.baseUrl + '/validate', { method: 'POST', body: form })
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.equal(body.validation.valid, true)
    assert.equal(body.validation.taskId, '00000000-0000-4000-8000-000000000001')
    assert.equal(received.actor, 'admin')
    assert.equal(context.audits.length, 1)
  } finally {
    context.server.close()
  }
})

test('execution requires an explicit confirmation before the BFF calls the service', async () => {
  let calls = 0
  const context = await startTestServer({
    executeTask: async () => {
      calls += 1
      return { state: 'reachable', status: 202, payload: { status: 'accepted' } }
    },
  })
  const taskId = '00000000-0000-4000-8000-000000000001'
  try {
    const rejected = await fetch(context.baseUrl + '/tasks/' + taskId + '/execute', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmation: 'NO' }),
    })
    assert.equal(rejected.status, 400)
    assert.equal(calls, 0)

    const accepted = await fetch(context.baseUrl + '/tasks/' + taskId + '/execute', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmation: 'EXECUTE' }),
    })
    assert.equal(accepted.status, 202)
    assert.equal(calls, 1)
    assert.equal(context.audits.length, 1)
  } finally {
    context.server.close()
  }
})

test('task details expose progress and steps without server paths', async () => {
  const taskId = '00000000-0000-4000-8000-000000000001'
  const context = await startTestServer({
    readTask: async () => ({
      state: 'reachable',
      status: 200,
      payload: {
        id: taskId,
        type: 'skill-single',
        component: 'example-skill',
        status: 'running',
        progress_percent: 42,
        current_step: 'replace',
        estimated_remaining_seconds: 18,
        backup_path: '/private/backup-path',
        steps: [
          { step: 'pre_check', status: 'completed', message: 'ok' },
          { step: 'replace', status: 'running', message: 'working' },
        ],
      },
    }),
  })
  try {
    const response = await fetch(context.baseUrl + '/tasks/' + taskId)
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.equal(body.task.progressPercent, 42)
    assert.equal(body.task.currentStep, 'replace')
    assert.equal(Object.hasOwn(body.task, 'backup_path'), false)
    assert.equal(body.task.steps.length, 2)
  } finally {
    context.server.close()
  }
})

test('overview and backup actions keep backup paths inside the upgrade service boundary', async () => {
  const backup = {
    id: 7,
    component: 'example-skill',
    version: '1.0.0',
    backup_path: '/private/backups/example-skill',
    size_bytes: 1024,
    created_at: '2026-07-17T10:00:00Z',
  }
  let rollbackCalls = 0
  let deleteCalls = 0
  const overview = async () => ({
    runtime: { state: 'reachable', serviceVersion: '1.0.0', lastErrorCode: null },
    status: { skills: {} },
    tasks: [],
    backups: [backup],
  })
  const context = await startTestServer({
    readOverview: overview,
    rollbackBackup: async () => {
      rollbackCalls += 1
      return { state: 'reachable', status: 202, payload: { task_id: '00000000-0000-4000-8000-000000000001' } }
    },
    deleteBackup: async () => {
      deleteCalls += 1
      return { state: 'reachable', status: 200, payload: { ok: true } }
    },
  })
  try {
    const list = await fetch(context.baseUrl + '/overview')
    const listBody = await list.json()
    assert.equal(Object.hasOwn(listBody.backups[0], 'backup_path'), false)

    const noConfirm = await fetch(context.baseUrl + '/backups/7/rollback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmation: 'NO' }),
    })
    assert.equal(noConfirm.status, 400)
    assert.equal(rollbackCalls, 0)

    const rollback = await fetch(context.baseUrl + '/backups/7/rollback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmation: 'ROLLBACK' }),
    })
    assert.equal(rollback.status, 202)
    assert.equal(rollbackCalls, 1)

    const remove = await fetch(context.baseUrl + '/backups/7', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmation: 'DELETE' }),
    })
    assert.equal(remove.status, 200)
    assert.equal(deleteCalls, 1)
    assert.equal(context.audits.length, 2)
  } finally {
    context.server.close()
  }
})

test('Admin upgrade staging cleanup deletes only expired strict UUID zip files in oldest-first batches', () => {
  const parent = mkdtempSync(join(tmpdir(), 'gaiop-admin-upgrade-cleanup-'))
  const directory = join(parent, 'upgrade-upload-staging')
  mkdirSync(directory)
  const now = Date.UTC(2026, 7, 9, 12)
  const old = join(directory, '00000000-0000-4000-8000-000000000001.zip')
  const boundary = join(directory, '00000000-0000-4000-8000-000000000002.zip')
  const fresh = join(directory, '00000000-0000-4000-8000-000000000003.zip')
  try {
    for (const target of [old, boundary, fresh]) writeFileSync(target, 'zip')
    utimesSync(old, (now - 48 * 60 * 60 * 1000) / 1000, (now - 48 * 60 * 60 * 1000) / 1000)
    utimesSync(boundary, (now - 24 * 60 * 60 * 1000) / 1000, (now - 24 * 60 * 60 * 1000) / 1000)
    utimesSync(fresh, (now - 24 * 60 * 60 * 1000 + 1) / 1000, (now - 24 * 60 * 60 * 1000 + 1) / 1000)

    const first = cleanupExpiredUpgradeUploadStaging({ stagingDirectory: directory, now, maxItems: 1 })
    assert.equal(first.success, 1)
    assert.equal(first.reasons.batch_limit, 1)
    assert.equal(first.reasons.not_expired, 1)
    assert.equal(lstatSync(old, { throwIfNoEntry: false }), undefined)

    const second = cleanupExpiredUpgradeUploadStaging({ stagingDirectory: directory, now, maxItems: 10 })
    assert.equal(second.success, 1)
    assert.equal(lstatSync(boundary, { throwIfNoEntry: false }), undefined)
    assert.equal(lstatSync(fresh).isFile(), true)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('Admin upgrade staging cleanup refuses unknown entries, symlinks, abnormal times and failed deletions', () => {
  const parent = mkdtempSync(join(tmpdir(), 'gaiop-admin-upgrade-safety-'))
  const directory = join(parent, 'upgrade-upload-staging')
  const outside = join(parent, 'outside')
  mkdirSync(directory)
  mkdirSync(outside)
  const now = Date.UTC(2026, 7, 9, 12)
  const retryable = join(directory, '00000000-0000-4000-8000-000000000010.zip')
  const abnormal = join(directory, '00000000-0000-4000-8000-000000000011.zip')
  try {
    writeFileSync(retryable, 'retry')
    writeFileSync(abnormal, 'abnormal')
    utimesSync(retryable, (now - 48 * 60 * 60 * 1000) / 1000, (now - 48 * 60 * 60 * 1000) / 1000)
    utimesSync(abnormal, (now - 48 * 60 * 60 * 1000) / 1000, (now - 48 * 60 * 60 * 1000) / 1000)
    writeFileSync(join(directory, 'wizard.db'), 'protected')
    writeFileSync(join(directory, '00000000-0000-4000-8000-000000000012.bak'), 'protected')
    mkdirSync(join(directory, 'unknown-directory'))
    symlinkSync(outside, join(directory, '00000000-0000-4000-8000-000000000013.zip'), 'junction')

    const failed = cleanupExpiredUpgradeUploadStaging({
      stagingDirectory: directory,
      now,
      fs: {
        lstatSync: (target) => target === abnormal
          ? new Proxy(lstatSync(target), { get: (stat, property) => property === 'mtimeMs' ? Number.NaN : Reflect.get(stat, property, stat) })
          : lstatSync(target),
        unlinkSync: () => { throw new Error('simulated') },
      },
    })
    assert.equal(failed.success, 0)
    assert.equal(failed.failed, 1)
    assert.equal(failed.reasons.invalid_timestamp, 1)
    assert.equal(failed.reasons.unknown_filename, 2)
    assert.equal(failed.reasons.unknown_directory, 1)
    assert.equal(failed.reasons.symbolic_link, 1)
    assert.equal(readdirSync(directory).length, 6)

    const retried = cleanupExpiredUpgradeUploadStaging({ stagingDirectory: directory, now })
    assert.equal(retried.success, 2)
    assert.equal(lstatSync(retryable, { throwIfNoEntry: false }), undefined)
    assert.equal(lstatSync(join(directory, 'wizard.db')).isFile(), true)
    assert.equal(lstatSync(join(directory, '00000000-0000-4000-8000-000000000012.bak')).isFile(), true)

    const refused = cleanupExpiredUpgradeUploadStaging({ stagingDirectory: parent, now })
    assert.equal(refused.failed, 1)
    assert.equal(refused.reasons.unexpected_root_name, 1)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})
