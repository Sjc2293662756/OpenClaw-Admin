const ROLE_SET = new Set(['basic', 'standard', 'auditor', 'admin'])
const EFFECT_SET = new Set(['allow', 'deny'])
const INITIAL_ADMIN_CORE = new Set(['users', 'userAdministration'])

const ALL = ['basic', 'standard', 'auditor', 'admin']
const NON_BASIC = ['standard', 'auditor', 'admin']
const STATUS_VIEWERS = ['standard', 'auditor', 'admin']
const AUDIT_ADMIN = ['auditor', 'admin']
const ADMIN = ['admin']

export const MODULE_PERMISSION_CATALOG = Object.freeze([
  { moduleKey: 'dashboard', name: '仪表盘', group: '业务管理', risk: 'low', defaultRoles: NON_BASIC, dependencies: [], routes: ['/'], rest: ['GET /api/dashboard/summary', 'GET /api/dashboard/usage'], sse: [], rpc: [], dataScope: '基础/标准用户仅本人会话聚合；审计/管理员全量只读' },
  { moduleKey: 'alerts.records', name: '告警记录', group: '业务管理', risk: 'medium', defaultRoles: ALL, dependencies: [], routes: ['/alerts'], rest: ['GET /api/alerts', 'GET /api/alerts/time'], sse: [], rpc: [], dataScope: '系统级脱敏告警记录' },
  { moduleKey: 'alerts.notifications', name: '告警通知/弹窗', group: '业务管理', risk: 'medium', defaultRoles: ALL, dependencies: [], routes: [], rest: ['GET /api/alerts/changes', 'GET /api/alerts/preferences', 'PUT /api/alerts/preferences'], sse: ['alert', 'alertStreamState'], rpc: [], dataScope: '系统级脱敏告警摘要；偏好仅当前账户' },
  { moduleKey: 'alerts.export', name: '告警导出', group: '业务管理', risk: 'medium', defaultRoles: ALL, dependencies: ['alerts.records'], routes: ['/alerts'], rest: ['POST /api/alerts/export'], sse: [], rpc: [], dataScope: '当前页六字段，最多100条' },
  { moduleKey: 'sessions', name: '会话管理', group: '业务管理', risk: 'high', defaultRoles: NON_BASIC, dependencies: [], routes: ['/sessions', '/sessions/:key'], rest: ['/api/session-retention*'], sse: ['event(session scoped)'], rpc: ['sessions.*', 'session.*'], dataScope: '本人/全量/只读范围保持；对话工作台共享能力固定' },
  { moduleKey: 'reports', name: '报告文件管理', group: '业务管理', risk: 'high', defaultRoles: ALL, dependencies: [], routes: ['/files'], rest: ['/api/reports*'], sse: [], rpc: [], dataScope: '基础/标准仅本人；审计全量只读；管理员全量' },
  { moduleKey: 'cron', name: '任务计划', group: '业务管理', risk: 'high', defaultRoles: AUDIT_ADMIN, dependencies: [], routes: ['/cron'], rest: [], sse: [], rpc: ['cron.*', 'crons.*', 'schedule.*', 'schedules.*'], dataScope: '系统级任务；危险写动作保留既有边界' },
  { moduleKey: 'memory', name: '记忆管理', group: '系统运维', risk: 'high', defaultRoles: ADMIN, dependencies: [], routes: ['/memory'], rest: [], sse: [], rpc: ['agents.files.list/get/set', 'agent.files.list/get/set'], dataScope: '正式智能体文件；不开放通用文件接口' },
  { moduleKey: 'models', name: '模型管理', group: '系统运维', risk: 'high', defaultRoles: ADMIN, dependencies: [], routes: ['/models'], rest: [], sse: [], rpc: ['models.list', 'model.list', 'config.get', 'agent.model.set'], dataScope: '非管理员安全投影；模型切换保留既有边界' },
  { moduleKey: 'channels', name: '频道管理', group: '系统运维', risk: 'high', defaultRoles: NON_BASIC, dependencies: [], routes: ['/channels'], rest: ['/api/channels*'], sse: [], rpc: ['channels.*', 'channel.*', 'plugins.*', 'plugin.*'], dataScope: '非管理员仅安全运行状态；凭据不回显' },
  { moduleKey: 'skills', name: 'Skills管理', group: '系统运维', risk: 'high', defaultRoles: STATUS_VIEWERS, dependencies: [], routes: ['/skills'], rest: [], sse: [], rpc: ['skills.*'], dataScope: '非管理员安全投影；安装更新保留既有边界' },
  { moduleKey: 'system', name: '系统监视器', group: '系统运维', risk: 'medium', defaultRoles: STATUS_VIEWERS, dependencies: [], routes: ['/system'], rest: ['GET /api/system/metrics', 'GET /api/system/storage-watermarks', 'GET /api/status'], sse: ['gatewayState'], rpc: ['system-presence', 'node.list', 'health', 'status'], dataScope: '安全系统摘要；无主机写入或清理' },
  { moduleKey: 'agents', name: '多智能体', group: '系统运维', risk: 'high', defaultRoles: ADMIN, dependencies: [], routes: ['/agents'], rest: [], sse: [], rpc: ['agents.*', 'agent.*'], dataScope: '正式智能体能力；危险写动作保留既有边界' },
  { moduleKey: 'office', name: '智能体工坊', group: '系统运维', risk: 'high', defaultRoles: ADMIN, dependencies: [], routes: ['/office'], rest: ['/api/wizard/scenarios*', '/api/wizard/tasks*'], sse: ['event(session scoped)'], rpc: [], dataScope: '场景和任务；不开放终端或桌面' },
  { moduleKey: 'users', name: '账户列表', group: '高级管理', risk: 'high', defaultRoles: AUDIT_ADMIN, dependencies: [], routes: ['/users'], rest: ['GET /api/users'], sse: [], rpc: [], dataScope: '账户安全投影；初始管理员本人锁定允许' },
  { moduleKey: 'userAdministration', name: '账户与模块权限管理', group: '高级管理', risk: 'critical', defaultRoles: ADMIN, dependencies: ['users'], routes: ['/users/create', '/users/:id/edit'], rest: ['/api/users* write', '/api/users/:id/module-permissions'], sse: ['permissionsChanged(target only)'], rpc: [], dataScope: '保留初始/最后管理员、自身账户和密码规则；初始管理员本人锁定允许' },
  { moduleKey: 'audit', name: '审计信息', group: '高级管理', risk: 'high', defaultRoles: AUDIT_ADMIN, dependencies: [], routes: ['/audit-logs'], rest: ['/api/audit-logs*'], sse: [], rpc: [], dataScope: '全量只读安全投影' },
  { moduleKey: 'settings', name: '系统设置', group: '系统运维', risk: 'medium', defaultRoles: NON_BASIC, dependencies: [], routes: ['/settings'], rest: ['/api/system-settings/sessions', '/api/system-settings/report-storage'], sse: [], rpc: [], dataScope: '各子项继续执行既有查看/管理边界' },
  { moduleKey: 'systemConfiguration', name: '高级配置', group: '高级管理', risk: 'critical', defaultRoles: ADMIN, dependencies: [], routes: ['/system-configuration', '/system-configuration/*'], rest: ['/api/system-config*', '/api/data-sources*'], sse: [], rpc: ['config.get/patch/apply/set'], dataScope: '敏感值只写不回显；独立正式父入口' },
  { moduleKey: 'systemUpgrade', name: '系统升级', group: '高级管理', risk: 'critical', defaultRoles: ADMIN, dependencies: [], routes: ['/system-upgrade'], rest: ['/api/system-upgrade*'], sse: ['upgrade progress'], rpc: ['update.run'], dataScope: '概览与高风险操作继续分层授权' },
  { moduleKey: 'platformBranding', name: '平台品牌配置', group: '高级管理', risk: 'high', defaultRoles: ADMIN, dependencies: [], routes: ['/platform-branding'], rest: ['/api/system-settings/branding'], sse: [], rpc: [], dataScope: '仅初始管理员；身份锁不可由覆盖绕过' },
].map((entry) => Object.freeze({ ...entry, defaultRoles: Object.freeze([...entry.defaultRoles]), dependencies: Object.freeze([...entry.dependencies]) })))

export const MODULE_PERMISSION_KEYS = Object.freeze(MODULE_PERMISSION_CATALOG.map((entry) => entry.moduleKey))
const CATALOG_BY_KEY = new Map(MODULE_PERMISSION_CATALOG.map((entry) => [entry.moduleKey, entry]))

export class ModulePermissionError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message)
    this.name = 'ModulePermissionError'
    this.status = status
    this.code = code
    this.extra = extra
  }
}

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((entry) => entry.name === column)
}

export function migrateModulePermissions(db) {
  db.transaction(() => {
    if (!hasColumn(db, 'users', 'permission_version')) {
      db.exec('ALTER TABLE users ADD COLUMN permission_version INTEGER NOT NULL DEFAULT 0')
    }
    db.exec(`
      UPDATE users SET permission_version = 0
      WHERE permission_version IS NULL OR permission_version < 0;
      CREATE TABLE IF NOT EXISTS user_module_permission_overrides (
        user_id TEXT NOT NULL,
        module_key TEXT NOT NULL,
        effect TEXT NOT NULL CHECK (effect IN ('allow', 'deny')),
        updated_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, module_key)
      );
      CREATE INDEX IF NOT EXISTS idx_user_module_permission_overrides_updated
      ON user_module_permission_overrides(updated_by, updated_at DESC);
    `)
  })()
}

function readOverrideMap(db, userId) {
  const rows = db.prepare(`
    SELECT module_key, effect
    FROM user_module_permission_overrides
    WHERE user_id = ?
    ORDER BY module_key
  `).all(userId)
  return new Map(rows.filter((row) => CATALOG_BY_KEY.has(row.module_key) && EFFECT_SET.has(row.effect)).map((row) => [row.module_key, row.effect]))
}

function lockFor(user, moduleKey) {
  const initial = Boolean(user?.is_initial_admin ?? user?.isInitialAdmin)
  if (moduleKey === 'platformBranding') {
    return {
      locked: true,
      forcedAllowed: initial,
      lockReason: initial ? '初始管理员专属能力，不能通过个人覆盖关闭' : '仅初始管理员可使用，个人覆盖不能提升初始管理员身份',
    }
  }
  if (initial && INITIAL_ADMIN_CORE.has(moduleKey)) {
    return { locked: true, forcedAllowed: true, lockReason: '初始管理员的账户与权限管理核心能力不可关闭' }
  }
  return { locked: false, forcedAllowed: null, lockReason: null }
}

export function resolveEffectiveModulePermissions(db, user, { overrideMap = null, strictDependencies = false } = {}) {
  if (!user || !ROLE_SET.has(user.role)) throw new ModulePermissionError(404, 'USER_NOT_FOUND', '用户不存在')
  const overrides = overrideMap || readOverrideMap(db, user.id)
  const modules = MODULE_PERMISSION_CATALOG.map((entry) => {
    const defaultAllowed = entry.defaultRoles.includes(user.role)
    const override = overrides.get(entry.moduleKey) || null
    const lock = lockFor(user, entry.moduleKey)
    const candidate = override === 'allow' ? true : override === 'deny' ? false : defaultAllowed
    return {
      moduleKey: entry.moduleKey,
      name: entry.name,
      group: entry.group,
      risk: entry.risk,
      dependencies: [...entry.dependencies],
      dataScope: entry.dataScope,
      defaultAllowed,
      override,
      effectiveAllowed: lock.locked ? lock.forcedAllowed : candidate,
      locked: lock.locked,
      lockReason: lock.lockReason,
    }
  })
  const byKey = new Map(modules.map((entry) => [entry.moduleKey, entry]))
  const conflicts = []
  for (const entry of modules) {
    if (!entry.effectiveAllowed) continue
    const missing = entry.dependencies.filter((key) => byKey.get(key)?.effectiveAllowed !== true)
    if (missing.length) conflicts.push({ moduleKey: entry.moduleKey, missing })
  }
  if (strictDependencies && conflicts.length) {
    throw new ModulePermissionError(409, 'MODULE_PERMISSION_DEPENDENCY_CONFLICT', '模块权限依赖不满足', { conflicts })
  }
  if (!strictDependencies) {
    for (const conflict of conflicts) byKey.get(conflict.moduleKey).effectiveAllowed = false
  }
  return {
    permissionVersion: Number(user.permission_version ?? user.permissionVersion ?? 0),
    modules,
    effectiveModules: Object.fromEntries(modules.map((entry) => [entry.moduleKey, entry.effectiveAllowed])),
    moduleOverrides: Object.fromEntries(modules.filter((entry) => entry.override).map((entry) => [entry.moduleKey, entry.override])),
    dependencyConflicts: conflicts,
  }
}

export function getUserModulePermissionProjection(db, userId) {
  const user = db.prepare(`
    SELECT id, username, role, status, is_initial_admin, permission_version
    FROM users WHERE id = ?
  `).get(userId)
  if (!user) throw new ModulePermissionError(404, 'USER_NOT_FOUND', '用户不存在')
  const projection = resolveEffectiveModulePermissions(db, user)
  return {
    user: { id: user.id, username: user.username, role: user.role, status: user.status, isInitialAdmin: Boolean(user.is_initial_admin) },
    ...projection,
  }
}

export function getModulePermissionCatalog() {
  return MODULE_PERMISSION_CATALOG.map(({ defaultRoles: _defaultRoles, ...entry }) => ({
    ...entry,
    dependencies: [...entry.dependencies],
    routes: [...entry.routes],
    rest: [...entry.rest],
    sse: [...entry.sse],
    rpc: [...entry.rpc],
  }))
}

export function validateModulePermissionOverrides(user, input) {
  if (!Array.isArray(input)) {
    throw new ModulePermissionError(400, 'INVALID_PERMISSION_PAYLOAD', 'overrides 必须是数组')
  }
  const seen = new Set()
  const overrideMap = new Map()
  for (const item of input) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new ModulePermissionError(400, 'INVALID_PERMISSION_PAYLOAD', '权限覆盖项格式无效')
    }
    const keys = Object.keys(item).sort()
    if (keys.length !== 2 || keys[0] !== 'effect' || keys[1] !== 'moduleKey') {
      throw new ModulePermissionError(400, 'INVALID_PERMISSION_PAYLOAD', '权限覆盖项只能包含 moduleKey 和 effect')
    }
    const moduleKey = String(item.moduleKey || '').trim()
    const effect = String(item.effect || '').trim()
    if (!CATALOG_BY_KEY.has(moduleKey)) {
      throw new ModulePermissionError(400, 'UNKNOWN_MODULE_PERMISSION_KEY', '模块权限 key 未登记')
    }
    if (!EFFECT_SET.has(effect)) {
      throw new ModulePermissionError(400, 'INVALID_MODULE_PERMISSION_EFFECT', '模块权限 effect 只能是 allow 或 deny')
    }
    if (seen.has(moduleKey)) {
      throw new ModulePermissionError(400, 'DUPLICATE_MODULE_PERMISSION_KEY', '同一模块权限不能重复提交')
    }
    seen.add(moduleKey)
    if (lockFor(user, moduleKey).locked) {
      throw new ModulePermissionError(400, 'MODULE_PERMISSION_LOCKED', '锁定模块不能设置个人覆盖', { moduleKey })
    }
    overrideMap.set(moduleKey, effect)
  }
  return overrideMap
}

function changeSummary(before, after) {
  const beforeByKey = new Map(before.modules.map((entry) => [entry.moduleKey, entry]))
  const changes = []
  for (const next of after.modules) {
    const previous = beforeByKey.get(next.moduleKey)
    if (previous.override === next.override && previous.effectiveAllowed === next.effectiveAllowed) continue
    changes.push({
      moduleKey: next.moduleKey,
      before: { defaultAllowed: previous.defaultAllowed, override: previous.override, effectiveAllowed: previous.effectiveAllowed },
      after: { defaultAllowed: next.defaultAllowed, override: next.override, effectiveAllowed: next.effectiveAllowed },
    })
  }
  return {
    allowed: changes.filter((entry) => !entry.before.effectiveAllowed && entry.after.effectiveAllowed).map((entry) => entry.moduleKey),
    denied: changes.filter((entry) => entry.before.effectiveAllowed && !entry.after.effectiveAllowed).map((entry) => entry.moduleKey),
    restored: changes.filter((entry) => entry.before.override && !entry.after.override).map((entry) => entry.moduleKey),
    changes,
  }
}

function auditDiffChunks(summary, maxLength = 260) {
  const encoded = summary.changes.map((entry) => {
    const beforeOverride = entry.before.override === 'allow' ? 'a' : entry.before.override === 'deny' ? 'd' : 'i'
    const afterOverride = entry.after.override === 'allow' ? 'a' : entry.after.override === 'deny' ? 'd' : 'i'
    return `${entry.moduleKey}:${beforeOverride}>${afterOverride}:${Number(entry.before.effectiveAllowed)}>${Number(entry.after.effectiveAllowed)}`
  })
  const chunks = []
  for (const item of encoded) {
    const current = chunks[chunks.length - 1]
    if (!current || `${current},${item}`.length > maxLength) chunks.push(item)
    else chunks[chunks.length - 1] = `${current},${item}`
  }
  return chunks
}

function validateExpectedVersion(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ModulePermissionError(400, 'INVALID_PERMISSION_PAYLOAD', 'expectedVersion 必须是非负安全整数')
  }
}

export function replaceUserModulePermissionOverrides(db, {
  actor,
  userId,
  expectedVersion,
  overrides,
  recordAudit,
  action = '更新用户模块权限',
  now = () => Date.now(),
}) {
  validateExpectedVersion(expectedVersion)
  return db.transaction(() => {
    const user = db.prepare(`
      SELECT id, username, role, status, is_initial_admin, permission_version
      FROM users WHERE id = ?
    `).get(userId)
    if (!user) throw new ModulePermissionError(404, 'USER_NOT_FOUND', '用户不存在')
    if (Number(user.permission_version || 0) !== expectedVersion) {
      throw new ModulePermissionError(409, 'PERMISSION_VERSION_CONFLICT', '模块权限已被其他操作更新，请刷新后重试', { currentVersion: Number(user.permission_version || 0) })
    }
    const overrideMap = validateModulePermissionOverrides(user, overrides)
    const before = resolveEffectiveModulePermissions(db, user)
    resolveEffectiveModulePermissions(db, user, { overrideMap, strictDependencies: true })
    const timestamp = now()
    db.prepare('DELETE FROM user_module_permission_overrides WHERE user_id = ?').run(user.id)
    const insert = db.prepare(`
      INSERT INTO user_module_permission_overrides (
        user_id, module_key, effect, updated_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `)
    for (const [moduleKey, effect] of overrideMap) insert.run(user.id, moduleKey, effect, actor.id, timestamp, timestamp)
    const nextVersion = expectedVersion + 1
    db.prepare('UPDATE users SET permission_version = ?, updated_at = ? WHERE id = ?').run(nextVersion, timestamp, user.id)
    const updatedUser = { ...user, permission_version: nextVersion }
    const after = resolveEffectiveModulePermissions(db, updatedUser)
    const summary = changeSummary(before, after)
    const audited = recordAudit?.(actor, action, user.username, JSON.stringify({
      targetUserId: user.id,
      beforeVersion: expectedVersion,
      afterVersion: nextVersion,
      allowedCount: summary.allowed.length,
      deniedCount: summary.denied.length,
      restoredCount: summary.restored.length,
      changeCount: summary.changes.length,
    }), { category: 'authorization', result: 'success', source: 'rest' })
    if (audited === false) throw new ModulePermissionError(500, 'MODULE_PERMISSION_AUDIT_FAILED', '模块权限审计写入失败')
    for (const diff of auditDiffChunks(summary)) {
      const diffAudited = recordAudit?.(actor, '用户模块权限前后差异', user.username, JSON.stringify({
        targetUserId: user.id,
        beforeVersion: expectedVersion,
        afterVersion: nextVersion,
        legend: 'i=inherit,a=allow,d=deny;0=forbidden,1=allowed',
        diff,
      }), { category: 'authorization', result: 'success', source: 'rest' })
      if (diffAudited === false) throw new ModulePermissionError(500, 'MODULE_PERMISSION_AUDIT_FAILED', '模块权限审计写入失败')
    }
    return {
      user: { id: user.id, username: user.username, role: user.role, status: user.status, isInitialAdmin: Boolean(user.is_initial_admin) },
      ...after,
      changeSummary: summary,
    }
  })()
}

export function canAccessEffectiveModule(user, moduleKey) {
  if (Object.hasOwn(user?.effectiveModules || {}, moduleKey)) {
    return user.effectiveModules[moduleKey] === true
  }
  const entry = CATALOG_BY_KEY.get(moduleKey)
  if (!entry || !ROLE_SET.has(user?.role)) return false
  const lock = lockFor(user, moduleKey)
  return lock.locked ? lock.forcedAllowed : entry.defaultRoles.includes(user.role)
}

export function createModuleAccessMiddleware(authMiddleware, moduleKey, message = '当前账户无权访问此模块') {
  if (!CATALOG_BY_KEY.has(moduleKey)) throw new Error(`Unknown module permission key: ${moduleKey}`)
  return (req, res, next) => {
    authMiddleware(req, res, () => {
      if (canAccessEffectiveModule(req.user, moduleKey)) return next()
      return res.status(403).json({ ok: false, error: message, code: 'MODULE_ACCESS_DENIED', moduleKey })
    })
  }
}

export function restModuleKeyFor(method, originalUrl) {
  const verb = String(method || 'GET').toUpperCase()
  const path = String(originalUrl || '').split('?')[0]
  if (path.startsWith('/api/dashboard/')) return 'dashboard'
  if (path === '/api/alerts/export' && verb === 'POST') return 'alerts.export'
  if (path === '/api/alerts/changes' || path === '/api/alerts/preferences') return 'alerts.notifications'
  if (path === '/api/alerts' || path === '/api/alerts/time') return 'alerts.records'
  if (path.startsWith('/api/session-retention')) return 'sessions'
  if (path.startsWith('/api/reports')) return 'reports'
  if (path.startsWith('/api/channels')) return 'channels'
  if (path === '/api/system/metrics' || path.startsWith('/api/system/storage-watermarks') || path === '/api/status') return 'system'
  if (path.startsWith('/api/audit-logs')) return 'audit'
  if (path.startsWith('/api/system-settings/branding')) return 'platformBranding'
  if (path.startsWith('/api/system-upgrade')) return 'systemUpgrade'
  if (path.startsWith('/api/system-config') || path.startsWith('/api/data-sources')) return 'systemConfiguration'
  if (path.startsWith('/api/system-settings/')) return 'settings'
  if (path.startsWith('/api/wizard/')) return 'office'
  if (/^\/api\/users\/[^/]+\/module-permissions$/u.test(path)) return 'userAdministration'
  if (path === '/api/users' && verb === 'GET') return 'users'
  if (path.startsWith('/api/users')) return 'userAdministration'
  return null
}

const RPC_MODULE_KEYS = new Map([
  ['usage.cost', ['dashboard']], ['cost.usage', ['dashboard']],
  ['channels.status', ['channels']], ['channels.list', ['channels']], ['channel.list', ['channels']], ['channel.status', ['channels']],
  ['plugins.list', ['channels']], ['plugin.list', ['channels']], ['plugins.status', ['channels']], ['plugin.status', ['channels']],
  ['channel.auth', ['channels']], ['channels.auth', ['channels']], ['web.login.start', ['channels']], ['channel.pair', ['channels']], ['channels.pair', ['channels']],
  ['skills.status', ['skills']], ['skills.list', ['skills']], ['skills.install', ['skills']], ['skills.update', ['skills']],
  ['status', ['system']], ['health', ['system']], ['system-presence', ['system']], ['node.list', ['system']],
  ['models.list', ['models', 'agents']], ['model.list', ['models', 'agents']], ['agent.model.set', ['models', 'agents']],
  ['tools.list', ['agents']], ['agents.list', ['agents', 'memory']], ['agent.list', ['agents', 'memory']],
  ['agents.files.list', ['memory', 'agents']], ['agent.files.list', ['memory', 'agents']],
  ['agents.files.get', ['memory', 'agents']], ['agent.files.get', ['memory', 'agents']],
  ['agents.files.set', ['memory', 'agents']], ['agent.files.set', ['memory', 'agents']],
  ['agents.create', ['agents']], ['agents.update', ['agents']], ['agents.delete', ['agents']],
  ['config.get', ['models', 'memory', 'agents', 'systemConfiguration']],
  ['config.patch', ['systemConfiguration', 'agents']], ['config.apply', ['systemConfiguration']], ['config.set', ['systemConfiguration']],
  ['update.run', ['systemUpgrade']],
  ['logs.tail', ['system']], ['exec.approvals.get', ['system']], ['exec.approvals.node.get', ['system']],
  ['exec.approvals.set', ['system']], ['exec.approvals.node.set', ['system']], ['node.invoke', ['system']],
  ['node.pair.request', ['system']], ['node.pair.approve', ['system']],
])

for (const method of [
  'cron.list', 'crons.list', 'schedule.list', 'schedules.list',
  'cron.status', 'crons.status', 'schedule.status', 'schedules.status',
  'cron.runs', 'crons.runs', 'cron.history', 'crons.history',
  'cron.add', 'cron.create', 'crons.add', 'crons.create',
  'cron.update', 'crons.update', 'schedule.update', 'schedules.update',
  'cron.remove', 'cron.delete', 'crons.remove', 'crons.delete', 'schedule.delete', 'schedules.delete',
  'cron.run', 'crons.run', 'cron.trigger', 'crons.trigger',
]) RPC_MODULE_KEYS.set(method, ['cron'])

export function rpcModuleKeysFor(method) {
  return [...(RPC_MODULE_KEYS.get(String(method || '').trim()) || [])]
}

export function hasAnyEffectiveModule(user, moduleKeys) {
  return moduleKeys.some((moduleKey) => canAccessEffectiveModule(user, moduleKey))
}

export const __test__ = { CATALOG_BY_KEY, INITIAL_ADMIN_CORE, lockFor, changeSummary, auditDiffChunks, RPC_MODULE_KEYS }
