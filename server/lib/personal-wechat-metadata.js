const MAX_ACCOUNT_ID_LENGTH = 256
const MAX_DISPLAY_NAME_LENGTH = 64
const MAX_NOTE_LENGTH = 500
const MAX_WECHAT_ID_LENGTH = 256
const MAX_NICKNAME_LENGTH = 128

function cleanText(value, maxLength, { required = false, collapseWhitespace = false } = {}) {
  if (typeof value !== 'string') {
    return required ? null : ''
  }
  let normalized = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
  if (collapseWhitespace) normalized = normalized.replace(/\s+/g, ' ')
  if (required && !normalized) return null
  return normalized.slice(0, maxLength)
}

export function normalizePersonalWechatAccountId(value) {
  return cleanText(value, MAX_ACCOUNT_ID_LENGTH, { required: true, collapseWhitespace: true })
}

export function validatePersonalWechatRegistration(value) {
  const displayName = cleanText(value?.displayName, MAX_DISPLAY_NAME_LENGTH, {
    required: true,
    collapseWhitespace: true,
  })
  if (!displayName) {
    return { ok: false, error: '个人微信账户名称不能为空' }
  }
  const note = cleanText(value?.note, MAX_NOTE_LENGTH)
  return { ok: true, value: { displayName, note } }
}

function toPublicRow(row) {
  if (!row) return null
  return {
    accountId: row.account_id,
    displayName: row.display_name,
    note: row.note || '',
    wechatId: row.wechat_user_id || undefined,
    nickname: row.wechat_nickname || undefined,
    enabled: row.enabled === 1,
    createdByUserId: row.created_by_user_id || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function migratePersonalWechatMetadata(db) {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS personal_wechat_accounts (
        account_id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        wechat_user_id TEXT,
        wechat_nickname TEXT,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        created_by_user_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_personal_wechat_accounts_updated_at
        ON personal_wechat_accounts(updated_at DESC, account_id ASC);
    `)
  })()
}

export function createPersonalWechatMetadataStore(db, { now = () => Date.now() } = {}) {
  const selectOne = db.prepare(`
    SELECT account_id, display_name, note, wechat_user_id, wechat_nickname,
           enabled, created_by_user_id, created_at, updated_at
    FROM personal_wechat_accounts
    WHERE account_id = ?
  `)
  const selectAll = db.prepare(`
    SELECT account_id, display_name, note, wechat_user_id, wechat_nickname,
           enabled, created_by_user_id, created_at, updated_at
    FROM personal_wechat_accounts
    ORDER BY created_at ASC, account_id ASC
  `)
  const upsert = db.prepare(`
    INSERT INTO personal_wechat_accounts (
      account_id, display_name, note, wechat_user_id, wechat_nickname,
      enabled, created_by_user_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
    ON CONFLICT(account_id) DO UPDATE SET
      display_name = excluded.display_name,
      note = excluded.note,
      wechat_user_id = COALESCE(excluded.wechat_user_id, personal_wechat_accounts.wechat_user_id),
      wechat_nickname = COALESCE(excluded.wechat_nickname, personal_wechat_accounts.wechat_nickname),
      enabled = 1,
      updated_at = excluded.updated_at
  `)
  const updateEnabled = db.prepare(`
    UPDATE personal_wechat_accounts SET enabled = ?, updated_at = ? WHERE account_id = ?
  `)
  const remove = db.prepare('DELETE FROM personal_wechat_accounts WHERE account_id = ?')
  const restore = db.prepare(`
    INSERT INTO personal_wechat_accounts (
      account_id, display_name, note, wechat_user_id, wechat_nickname,
      enabled, created_by_user_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id) DO NOTHING
  `)

  function get(accountId) {
    const normalizedId = normalizePersonalWechatAccountId(accountId)
    if (!normalizedId) return null
    return toPublicRow(selectOne.get(normalizedId))
  }

  function list() {
    return selectAll.all().map(toPublicRow)
  }

  function saveLinkedAccount({ accountId, displayName, note, wechatId, nickname, actorId }) {
    const normalizedId = normalizePersonalWechatAccountId(accountId)
    const registration = validatePersonalWechatRegistration({ displayName, note })
    if (!normalizedId) {
      const error = new Error('个人微信账号标识无效')
      error.code = 'PERSONAL_WECHAT_ACCOUNT_ID_INVALID'
      throw error
    }
    if (!registration.ok) {
      const error = new Error(registration.error)
      error.code = 'PERSONAL_WECHAT_REGISTRATION_INVALID'
      throw error
    }
    const normalizedWechatId = cleanText(wechatId, MAX_WECHAT_ID_LENGTH, { collapseWhitespace: true }) || null
    const normalizedNickname = cleanText(nickname, MAX_NICKNAME_LENGTH, { collapseWhitespace: true }) || null
    const normalizedActorId = cleanText(actorId, 128, { collapseWhitespace: true }) || null
    const timestamp = now()
    upsert.run(
      normalizedId,
      registration.value.displayName,
      registration.value.note,
      normalizedWechatId,
      normalizedNickname,
      normalizedActorId,
      timestamp,
      timestamp,
    )
    return get(normalizedId)
  }

  function setEnabled(accountId, enabled) {
    const normalizedId = normalizePersonalWechatAccountId(accountId)
    if (!normalizedId || typeof enabled !== 'boolean') return null
    const result = updateEnabled.run(enabled ? 1 : 0, now(), normalizedId)
    return result.changes === 1 ? get(normalizedId) : null
  }

  function deleteAccount(accountId) {
    const existing = get(accountId)
    if (!existing) return null
    remove.run(existing.accountId)
    return existing
  }

  function restoreAccount(account) {
    const normalizedId = normalizePersonalWechatAccountId(account?.accountId)
    const registration = validatePersonalWechatRegistration(account)
    if (!normalizedId || !registration.ok) {
      const error = new Error('个人微信账号恢复信息无效')
      error.code = 'PERSONAL_WECHAT_METADATA_RESTORE_INVALID'
      throw error
    }
    const timestamp = now()
    const createdAt = Number.isFinite(account?.createdAt) && account.createdAt > 0 ? account.createdAt : timestamp
    const updatedAt = Number.isFinite(account?.updatedAt) && account.updatedAt > 0 ? account.updatedAt : timestamp
    restore.run(
      normalizedId,
      registration.value.displayName,
      registration.value.note,
      cleanText(account?.wechatId, MAX_WECHAT_ID_LENGTH, { collapseWhitespace: true }) || null,
      cleanText(account?.nickname, MAX_NICKNAME_LENGTH, { collapseWhitespace: true }) || null,
      account?.enabled === false ? 0 : 1,
      cleanText(account?.createdByUserId, 128, { collapseWhitespace: true }) || null,
      createdAt,
      updatedAt,
    )
    return get(normalizedId)
  }

  return { get, list, saveLinkedAccount, setEnabled, deleteAccount, restoreAccount }
}

export const __test__ = {
  MAX_ACCOUNT_ID_LENGTH,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_NOTE_LENGTH,
}
