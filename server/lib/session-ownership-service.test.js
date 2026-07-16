import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import {
  canAccessWorkspaceSession,
  createWorkspaceSession,
  ensureWorkspaceSessionAccess,
  extractSessionKeyFromEvent,
  filterSessionListPayload,
  listOwnedWorkspaceSessionKeys,
  markWorkspaceSessionDeleted,
} from './session-ownership-service.js'

function createTestDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE workspace_sessions (
      session_key TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    );
  `)
  return db
}

const alice = { id: 'user-alice', username: 'alice', role: 'standard' }
const bob = { id: 'user-bob', username: 'bob', role: 'standard' }
const admin = { id: 'user-admin', username: 'admin', role: 'admin' }

describe('workspace session ownership service', () => {
  it('creates a BFF-issued session that only its owner and an administrator can access', () => {
    const db = createTestDb()
    const sessionKey = createWorkspaceSession(db, alice, 1)

    expect(sessionKey).toMatch(/^agent:main:main:dm:webchat-[a-z0-9]{32}$/)
    expect(canAccessWorkspaceSession(db, alice, sessionKey)).toBe(true)
    expect(canAccessWorkspaceSession(db, bob, sessionKey)).toBe(false)
    expect(canAccessWorkspaceSession(db, admin, sessionKey)).toBe(true)
  })

  it('does not allow a standard user to claim a session that was not registered by the BFF', () => {
    const db = createTestDb()
    const unregistered = 'agent:main:main:dm:webchat-123456789012'

    expect(ensureWorkspaceSessionAccess(db, alice, unregistered)).toMatchObject({
      ok: false,
      code: 'SESSION_NOT_FOUND',
    })
    expect(ensureWorkspaceSessionAccess(db, admin, unregistered)).toMatchObject({ ok: true })
  })

  it('filters session lists and permanently hides a soft-deleted owned session', () => {
    const db = createTestDb()
    const aliceSession = createWorkspaceSession(db, alice, 1)
    const bobSession = createWorkspaceSession(db, bob, 2)
    const allowed = listOwnedWorkspaceSessionKeys(db, alice)

    expect(filterSessionListPayload({ sessions: [{ key: aliceSession }, { key: bobSession }] }, allowed)).toEqual({
      sessions: [{ key: aliceSession }],
    })

    markWorkspaceSessionDeleted(db, aliceSession, 3)
    expect(ensureWorkspaceSessionAccess(db, alice, aliceSession)).toMatchObject({ ok: false })
    expect(listOwnedWorkspaceSessionKeys(db, alice)).toEqual(new Set())
  })

  it('finds a nested Gateway event session key before event delivery is authorized', () => {
    expect(extractSessionKeyFromEvent({
      payload: { message: { sessionKey: 'agent:main:main:dm:webchat-123456789012' } },
    })).toBe('agent:main:main:dm:webchat-123456789012')
  })
})
