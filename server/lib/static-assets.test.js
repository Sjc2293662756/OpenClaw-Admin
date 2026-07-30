import assert from 'node:assert/strict'
import test from 'node:test'
import { missingStaticAssetMiddleware } from './static-assets.js'

function createResponse() {
  return {
    headers: {},
    statusCode: null,
    contentType: null,
    body: null,
    set(name, value) {
      this.headers[name] = value
      return this
    },
    status(value) {
      this.statusCode = value
      return this
    },
    type(value) {
      this.contentType = value
      return this
    },
    send(value) {
      this.body = value
      return this
    },
  }
}

test('missing hashed assets return a real non-cacheable 404 instead of the SPA document', () => {
  const response = createResponse()
  let nextCalled = false

  missingStaticAssetMiddleware(
    { path: '/assets/UserCreatePage-old.js' },
    response,
    () => { nextCalled = true },
  )

  assert.equal(nextCalled, false)
  assert.equal(response.statusCode, 404)
  assert.equal(response.contentType, 'text/plain')
  assert.equal(response.headers['Cache-Control'], 'no-store')
  assert.equal(response.body, 'Static asset not found')
})

test('non-asset routes continue to the SPA fallback', () => {
  const response = createResponse()
  let nextCalled = false

  missingStaticAssetMiddleware(
    { path: '/users/create' },
    response,
    () => { nextCalled = true },
  )

  assert.equal(nextCalled, true)
  assert.equal(response.statusCode, null)
})
