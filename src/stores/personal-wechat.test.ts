import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePersonalWechatStore } from './personal-wechat'

vi.mock('./auth', () => ({
  useAuthStore: () => ({ getToken: () => 'isolated-test-token' }),
}))

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('personal WeChat account store', () => {
  it('loads multiple isolated accounts and retains only management-safe fields', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({
      ok: true,
      plugin: { installed: true, available: true, version: '2.4.6' },
      channel: { configured: true, enabled: true },
      accounts: [
        {
          accountId: 'account-a', displayName: '杨硕微信', note: '本人', nickname: '杨硕',
          userId: 'wx-user-a', enabled: true, status: 'connected', token: 'must-not-retain',
        },
        {
          accountId: 'account-b', displayName: '售后微信', wechatId: 'wx-user-b',
          enabled: false, status: 'online', credential: 'must-not-retain',
        },
      ],
    }))
    const store = usePersonalWechatStore()

    await store.refresh()

    expect(store.plugin).toEqual({ installed: true, available: true, version: '2.4.6', reasonCode: undefined })
    expect(store.channel).toEqual({ configured: true, enabled: true })
    expect(store.channelConfigured).toBe(true)
    expect(store.accounts).toEqual([
      {
        accountId: 'account-a', displayName: '杨硕微信', note: '本人', nickname: '杨硕',
        wechatIdentifier: 'wx-user-a', enabled: true, status: 'online', errorCode: undefined,
      },
      {
        accountId: 'account-b', displayName: '售后微信', note: undefined, nickname: undefined,
        wechatIdentifier: 'wx-user-b', enabled: false, status: 'disabled', errorCode: undefined,
      },
    ])
    expect(store.accounts[0]).not.toHaveProperty('token')
    expect(store.accounts[1]).not.toHaveProperty('credential')
    expect(fetch).toHaveBeenCalledWith('/api/channels/personal-wechat', {
      headers: { Authorization: 'Bearer isolated-test-token' },
    })
  })

  it('starts onboarding with only the administrator metadata and normalizes verification states', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({
      ok: true,
      session: {
        id: 'session-a', status: 'need_verify', qrDataUrl: 'data:image/png;base64,QUJDRA==',
        token: 'must-not-retain',
      },
    }))
    const store = usePersonalWechatStore()

    const session = await store.startOnboarding({ displayName: '  测试微信  ', note: '  二号机  ' })

    const [, init] = vi.mocked(fetch).mock.calls[0]!
    expect(fetch).toHaveBeenCalledWith('/api/channels/personal-wechat/onboarding', expect.objectContaining({
      method: 'POST',
      headers: {
        Authorization: 'Bearer isolated-test-token',
        'Content-Type': 'application/json',
      },
    }))
    expect(JSON.parse(String(init?.body))).toEqual({ displayName: '测试微信', note: '二号机' })
    expect(session).toMatchObject({
      id: 'session-a',
      status: 'verification_required',
      displayName: '测试微信',
      note: '二号机',
    })
    expect(session).not.toHaveProperty('token')
  })

  it('submits verification to the session-specific endpoint', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({
        ok: true,
        session: { id: 'session/id', status: 'verification_required', displayName: '测试微信' },
      }))
      .mockResolvedValueOnce(jsonResponse({
        ok: true,
        session: { id: 'session/id', status: 'connected', accountId: 'account-a', userId: 'wx-user-a' },
      }))
    const store = usePersonalWechatStore()
    await store.startOnboarding({ displayName: '测试微信' })

    const result = await store.verifyOnboarding(' 123456 ')

    expect(fetch).toHaveBeenLastCalledWith(
      '/api/channels/personal-wechat/onboarding/session%2Fid/verify',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ code: '123456' }) }),
    )
    expect(result).toMatchObject({
      status: 'success', accountId: 'account-a', wechatIdentifier: 'wx-user-a', displayName: '测试微信',
    })
  })

  it('enables and deletes only the selected account', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({
        ok: true,
        plugin: { installed: true, available: true },
        accounts: [
          { accountId: 'account/a', displayName: 'A', enabled: false, status: 'disabled' },
          { accountId: 'account-b', displayName: 'B', enabled: true, status: 'online' },
        ],
      }))
      .mockResolvedValueOnce(jsonResponse({
        ok: true,
        account: { accountId: 'account/a', displayName: 'A', enabled: true, status: 'connected' },
      }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
    const store = usePersonalWechatStore()
    await store.refresh()

    await store.setAccountEnabled('account/a', true)
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      '/api/channels/personal-wechat/accounts/account%2Fa/enabled',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ enabled: true }) }),
    )
    expect(store.accounts.map((account) => [account.accountId, account.enabled])).toEqual([
      ['account/a', true],
      ['account-b', true],
    ])

    await store.deleteAccount('account/a')
    expect(fetch).toHaveBeenLastCalledWith(
      '/api/channels/personal-wechat/accounts/account%2Fa',
      expect.objectContaining({ method: 'DELETE' }),
    )
    expect(store.accounts.map((account) => account.accountId)).toEqual(['account-b'])
  })

  it('does not surface arbitrary backend error text', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({
      ok: false,
      error: 'token=must-not-surface',
      errorCode: 'WEIXIN_UNAVAILABLE',
    }, 503))
    const store = usePersonalWechatStore()

    await expect(store.refresh()).rejects.toThrow('WEIXIN_UNAVAILABLE')
    expect(store.lastError).not.toContain('must-not-surface')
  })

  it('keeps channel state unknown when the unified status response cannot provide it', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({
      ok: true,
      plugin: { installed: true, available: true },
      accounts: [],
    }))
    const store = usePersonalWechatStore()

    await store.refresh()

    expect(store.channel).toEqual({ configured: false, enabled: null })
  })

  it('updates the channel through the personal WeChat status boundary', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ ok: true, enabled: false }))
      .mockResolvedValueOnce(jsonResponse({
        ok: true,
        plugin: { installed: true, available: true },
        channel: { configured: true, enabled: false },
        accounts: [{ accountId: 'account-a', displayName: 'A', enabled: false, status: 'disabled' }],
      }))
    const store = usePersonalWechatStore()

    await store.setChannelEnabled(false)

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      '/api/channels/personal-wechat/channel-enabled',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ enabled: false }) }),
    )
    expect(store.channel.enabled).toBe(false)
    expect(store.accounts[0]?.status).toBe('disabled')
  })
})
