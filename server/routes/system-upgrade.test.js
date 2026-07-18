import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'
import express from 'express'
import { createSystemUpgradeRouter } from './system-upgrade.js'

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
