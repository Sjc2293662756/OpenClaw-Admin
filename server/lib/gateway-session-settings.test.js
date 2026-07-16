import { describe, expect, it, vi } from 'vitest'
import {
  applyGatewaySessionSettings,
  buildGatewayPatchRaw,
  buildGatewaySessionPatches,
  toPublicGatewaySessionState,
} from './gateway-session-settings.js'

const settings = {
  loginSessionHours: 24,
  idleTimeoutMinutes: 0,
  agentContextIdleMinutes: 30,
  historyRetentionDays: 180,
}

describe('gateway session settings adapter', () => {
  it('uses a stable three-field Gateway session policy', () => {
    const patches = buildGatewaySessionPatches(settings)
    expect(patches).toEqual([
      { path: 'session.dmScope', value: 'per-channel-peer' },
      { path: 'session.reset', value: { mode: 'idle', idleMinutes: 30 } },
      { path: 'session.resetByChannel.webchat', value: { mode: 'idle', idleMinutes: 5_256_000 } },
    ])
    expect(JSON.parse(buildGatewayPatchRaw(patches))).toEqual({
      session: {
        dmScope: 'per-channel-peer',
        reset: { mode: 'idle', idleMinutes: 30 },
        resetByChannel: { webchat: { mode: 'idle', idleMinutes: 5_256_000 } },
      },
    })
  })

  it('does not expose raw config when reporting runtime state', () => {
    const state = toPublicGatewaySessionState({
      config: {
        session: {
          dmScope: 'per-channel-peer',
          reset: { mode: 'idle', idleMinutes: 30 },
          resetByChannel: { webchat: { mode: 'idle', idleMinutes: 5_256_000 } },
        },
        gateway: { auth: { token: 'never-returned' } },
      },
    }, settings)
    expect(state).toEqual({
      status: 'applied',
      dmScope: 'per-channel-peer',
      resetMode: 'idle',
      agentContextIdleMinutes: 30,
      webchatResetMode: 'idle',
      webchatIdleMinutes: 5_256_000,
    })
  })

  it('uses raw patch first and falls back to legacy patches only for a compatible Gateway error', async () => {
    const call = vi.fn()
      .mockResolvedValueOnce({ exists: true, raw: '{"session":{}}' })
      .mockRejectedValueOnce(new Error("config.patch required property 'patches'"))
      .mockResolvedValueOnce({})
    const gateway = { isConnected: true, call }

    await expect(applyGatewaySessionSettings(gateway, settings)).resolves.toEqual({ mode: 'legacy' })
    expect(call).toHaveBeenNthCalledWith(1, 'config.get', {})
    expect(call).toHaveBeenNthCalledWith(2, 'config.patch', expect.objectContaining({ raw: expect.any(String), baseHash: expect.any(String) }))
    expect(call).toHaveBeenNthCalledWith(3, 'config.patch', { patches: buildGatewaySessionPatches(settings) })
  })
})
