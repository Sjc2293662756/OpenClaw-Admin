import assert from 'node:assert/strict'
import test from 'node:test'
import {
  projectSafeChannelsPayload,
  projectSafePluginsPayload,
  projectSafeSkillsPayload,
  projectStandardGatewayConfig,
} from './role-projections.js'

test('standard configuration projection contains only model selection data', () => {
  const projected = projectStandardGatewayConfig({
    raw: JSON.stringify({
      models: {
        primary: 'provider-a/model-a',
        providers: {
          'provider-a': {
            baseUrl: 'https://private.example',
            apiKey: 'secret',
            models: [{ id: 'model-a', name: 'Model A', endpoint: '/private' }],
          },
        },
      },
      agents: { defaults: { model: { primary: 'provider-a/model-a' }, workspace: '/secret/path' } },
      channels: { wecom: { secret: 'secret' } },
    }),
  })

  assert.equal(projected.models.primary, 'provider-a/model-a')
  assert.deepEqual(projected.models.providers['provider-a'].models, [{ id: 'model-a', name: 'Model A' }])
  assert.equal(JSON.stringify(projected).includes('private.example'), false)
  assert.equal(JSON.stringify(projected).includes('/secret/path'), false)
  assert.equal(JSON.stringify(projected).includes('secret'), false)
})

test('safe skill, channel and plugin projections omit configuration fields', () => {
  const skills = projectSafeSkillsPayload({
    skills: [{ name: 'query', description: 'Query data', version: '1.0.0', eligible: true, path: '/private', config: { token: 'secret' } }],
  })
  const channels = projectSafeChannelsPayload({
    channels: [{ id: 'wecom:default', channelKey: 'wecom', status: 'connected', accountId: 'private-account', dmPolicy: 'open' }],
  })
  const plugins = projectSafePluginsPayload({
    plugins: [{ name: 'wecom-plugin', version: '1.0.0', installed: true, config: { token: 'secret' } }],
  })

  assert.deepEqual(skills, [{ name: 'query', description: 'Query data', version: '1.0.0', eligible: true }])
  assert.deepEqual(channels, [{ id: 'wecom:default', channelKey: 'wecom', platform: 'wecom', enabled: true, status: 'connected' }])
  assert.deepEqual(plugins, [{ name: 'wecom-plugin', version: '1.0.0', installed: true }])
})
