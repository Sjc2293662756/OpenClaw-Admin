import { Router } from 'express'
import { sendError, sendOk } from '../lib/api-response.js'

export function createDataSourcesRouter({
  db,
  authMiddleware,
  adminMiddleware,
  recordAudit,
  createId,
  decryptDataSourcePassword,
  encryptDataSourcePassword,
  isDataSourceEncryptionReady,
  testNapmDataSource,
  toPublicDataSource,
  validateDataSourceInput,
  getDataSourceRuntimeStatus,
  writeActiveDataSourceRuntime,
}) {
  const router = Router()
  const encryptionReady = (_req, res, next) => {
    if (!isDataSourceEncryptionReady()) {
      return sendError(res, {
        status: 503,
        code: 'DATA_SOURCE_ENCRYPTION_KEY_MISSING',
        message: '数据源加密密钥未配置，请在服务端环境变量中设置 DATA_SOURCE_ENCRYPTION_KEY',
      })
    }
    next()
  }

  router.get('/', authMiddleware, encryptionReady, (_req, res) => {
    const rows = db.prepare(`SELECT id, ip, description, type, username, password_encrypted, status, tls_mode, is_active,
      last_tested_at, last_test_message, created_at, updated_at FROM data_sources ORDER BY updated_at DESC`).all()
    sendOk(res, { dataSources: rows.map(toPublicDataSource), runtime: getDataSourceRuntimeStatus() })
  })

  router.post('/', adminMiddleware, encryptionReady, (req, res) => {
    const validated = validateDataSourceInput(req.body, { passwordRequired: true })
    if (!validated.ok) return sendError(res, { status: 400, code: 'INVALID_DATA_SOURCE_INPUT', message: validated.error })
    try {
      const now = Date.now()
      const source = {
        id: createId(), ...validated.value,
        passwordEncrypted: encryptDataSourcePassword(validated.value.password),
        createdAt: now, updatedAt: now,
      }
      db.prepare(`INSERT INTO data_sources (id, ip, description, type, username, password_encrypted, status, tls_mode, is_active, created_at, updated_at)
        VALUES (@id, @ip, @description, @type, @username, @passwordEncrypted, @status, 'strict', 0, @createdAt, @updatedAt)`).run(source)
      const row = db.prepare('SELECT * FROM data_sources WHERE id = ?').get(source.id)
      recordAudit(req.user, '添加数据源', source.ip, `类型：${source.type}`)
      sendOk(res, { dataSource: toPublicDataSource(row) }, 201)
    } catch (_error) {
      sendError(res, { code: 'DATA_SOURCE_CREATE_FAILED', message: '添加数据源失败' })
    }
  })

  router.put('/:id', adminMiddleware, encryptionReady, (req, res) => {
    const existing = db.prepare('SELECT * FROM data_sources WHERE id = ?').get(req.params.id)
    if (!existing) return sendError(res, { status: 404, code: 'DATA_SOURCE_NOT_FOUND', message: '数据源不存在' })
    const validated = validateDataSourceInput(req.body, { passwordRequired: false })
    if (!validated.ok) return sendError(res, { status: 400, code: 'INVALID_DATA_SOURCE_INPUT', message: validated.error })
    if (existing.is_active && validated.value.status === 'disabled') {
      return sendError(res, {
        status: 400,
        code: 'ACTIVE_DATA_SOURCE_CANNOT_DISABLE',
        message: '当前运行数据源不能直接停用，请先启用其他数据源',
      })
    }
    try {
      const value = validated.value
      const passwordEncrypted = value.password ? encryptDataSourcePassword(value.password) : existing.password_encrypted
      const now = Date.now()
      let row = null
      const update = db.transaction(() => {
        db.prepare(`UPDATE data_sources SET ip = ?, description = ?, type = ?, username = ?, password_encrypted = ?, status = ?, updated_at = ? WHERE id = ?`)
          .run(value.ip, value.description, value.type, value.username, passwordEncrypted, value.status, now, existing.id)
        row = db.prepare('SELECT * FROM data_sources WHERE id = ?').get(existing.id)
        // 运行中数据源的账号、地址或密码发生变化时，必须同步刷新运行时桥接文件。
        if (existing.is_active) {
          writeActiveDataSourceRuntime({ ...row, password: decryptDataSourcePassword(row.password_encrypted) })
        }
      })
      update()
      recordAudit(req.user, '编辑数据源', value.ip, `类型：${value.type}`)
      sendOk(res, { dataSource: toPublicDataSource(row) })
    } catch (_error) {
      sendError(res, { code: 'DATA_SOURCE_UPDATE_FAILED', message: '更新数据源失败' })
    }
  })

  router.delete('/:id', adminMiddleware, encryptionReady, (req, res) => {
    const source = db.prepare('SELECT * FROM data_sources WHERE id = ?').get(req.params.id)
    if (!source) return sendError(res, { status: 404, code: 'DATA_SOURCE_NOT_FOUND', message: '数据源不存在' })
    if (source.is_active) {
      return sendError(res, {
        status: 400,
        code: 'ACTIVE_DATA_SOURCE_CANNOT_DELETE',
        message: '当前运行数据源不能删除，请先启用其他数据源',
      })
    }
    db.prepare('DELETE FROM data_sources WHERE id = ?').run(source.id)
    recordAudit(req.user, '删除数据源', source.ip, `类型：${source.type}`)
    sendOk(res)
  })

  router.post('/:id/test', adminMiddleware, encryptionReady, async (req, res) => {
    const source = db.prepare('SELECT * FROM data_sources WHERE id = ?').get(req.params.id)
    if (!source) return sendError(res, { status: 404, code: 'DATA_SOURCE_NOT_FOUND', message: '数据源不存在' })
    if (source.status === 'disabled') {
      return sendError(res, { status: 400, code: 'DATA_SOURCE_DISABLED', message: '已停用的数据源不能执行连接测试' })
    }
    try {
      const result = await testNapmDataSource({
        ip: source.ip,
        username: source.username,
        password: decryptDataSourcePassword(source.password_encrypted),
        tlsMode: source.tls_mode,
      })
      const now = Date.now()
      const nextTlsMode = result.ok ? result.tlsMode : source.tls_mode
      db.prepare('UPDATE data_sources SET status = ?, tls_mode = ?, last_tested_at = ?, last_test_message = ?, updated_at = ? WHERE id = ?')
        .run(result.ok ? 'success' : 'failed', nextTlsMode, now, result.message, now, source.id)
      if (result.ok && source.is_active) {
        const activeSource = db.prepare('SELECT * FROM data_sources WHERE id = ?').get(source.id)
        writeActiveDataSourceRuntime({ ...activeSource, password: decryptDataSourcePassword(activeSource.password_encrypted) })
      }
      recordAudit(req.user, '测试数据源连接', source.ip, result.ok
        ? (result.compatibilityMode ? '连接成功（NAPM 自签名证书兼容模式）' : '连接成功')
        : '连接失败')
      sendOk(res, { result: { ...result, testedAt: now } })
    } catch (_error) {
      sendError(res, {
        code: 'DATA_SOURCE_TEST_FAILED',
        message: '数据源测试失败，请检查加密密钥和 NAPM 配置',
      })
    }
  })

  router.post('/:id/activate', adminMiddleware, encryptionReady, (req, res) => {
    const source = db.prepare('SELECT * FROM data_sources WHERE id = ?').get(req.params.id)
    if (!source) return sendError(res, { status: 404, code: 'DATA_SOURCE_NOT_FOUND', message: '数据源不存在' })
    if (source.status === 'disabled') {
      return sendError(res, { status: 400, code: 'DATA_SOURCE_DISABLED', message: '已停用的数据源不能设为运行数据源' })
    }

    try {
      const password = decryptDataSourcePassword(source.password_encrypted)
      const now = Date.now()
      let runtime = null
      const activate = db.transaction(() => {
        db.prepare('UPDATE data_sources SET is_active = 0, updated_at = ? WHERE is_active = 1').run(now)
        db.prepare('UPDATE data_sources SET is_active = 1, updated_at = ? WHERE id = ?').run(now, source.id)
        runtime = writeActiveDataSourceRuntime({ ...source, password })
      })
      activate()
      const active = db.prepare('SELECT * FROM data_sources WHERE id = ?').get(source.id)
      recordAudit(req.user, '启用运行数据源', source.ip, `运行时桥接：${runtime.mode}`)
      sendOk(res, { dataSource: toPublicDataSource(active), runtime: getDataSourceRuntimeStatus() })
    } catch (error) {
      const code = error?.code === 'DATA_SOURCE_RUNTIME_TARGET_MISSING'
        ? 'DATA_SOURCE_RUNTIME_TARGET_MISSING'
        : 'DATA_SOURCE_ACTIVATION_FAILED'
      sendError(res, { status: code === 'DATA_SOURCE_RUNTIME_TARGET_MISSING' ? 503 : 500, code, message: error?.message || '启用运行数据源失败' })
    }
  })

  return router
}
