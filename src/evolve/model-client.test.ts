import type { FetchLike, HttpResponseLike } from './model-client.js'
import { describe, expect, it, vi } from 'vitest'
import { createChatCall } from './model-client.js'

const prompt = { system: 'sys', user: 'usr' }

function response(body: unknown, ok = true, status = 200): HttpResponseLike {
  return {
    ok,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => body,
  }
}

describe('createChatCall', () => {
  it('throws when the model is not configured', () => {
    expect(() => createChatCall({ name: '', baseUrl: '', apiKey: '' })).toThrow('模型未配置')
  })

  it('posts to <baseUrl>/chat/completions and returns the message content', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => response({ choices: [{ message: { content: '{"ok":true}' } }] }))
    const call = createChatCall(
      { name: 'gpt-4o', baseUrl: 'https://example.com/v1/', apiKey: 'secret' },
      fetchImpl,
    )
    await expect(call(prompt)).resolves.toBe('{"ok":true}')

    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe('https://example.com/v1/chat/completions')
    expect(init.headers).toMatchObject({ authorization: 'Bearer secret' })
    expect(JSON.parse(String(init.body))).toMatchObject({ model: 'gpt-4o', temperature: 0 })
  })

  it('surfaces HTTP errors with a bounded body', async () => {
    const fetchImpl = async () => response('rate limited', false, 429)
    const call = createChatCall({ name: 'm', baseUrl: 'https://x/v1', apiKey: 'k' }, fetchImpl)
    await expect(call(prompt)).rejects.toThrow('HTTP 429')
  })

  it('rejects empty or malformed responses', async () => {
    const empty = createChatCall(
      { name: 'm', baseUrl: 'https://x/v1', apiKey: 'k' },
      async () => response({ choices: [] }),
    )
    await expect(empty(prompt)).rejects.toThrow('空内容')

    const malformed = createChatCall(
      { name: 'm', baseUrl: 'https://x/v1', apiKey: 'k' },
      async () => ({ ok: true, status: 200, text: async () => '', json: async () => { throw new Error('bad json') } }),
    )
    await expect(malformed(prompt)).rejects.toThrow('模型请求失败')
  })

  it('times out when the transport never settles', async () => {
    const call = createChatCall(
      { name: 'm', baseUrl: 'https://x/v1', apiKey: 'k', timeoutMs: 5 },
      (_url, init) => new Promise<HttpResponseLike>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      }),
    )
    await expect(call(prompt)).rejects.toThrow('超时')
  })
})

describe('createChatCall payload handling', () => {
  it('rejects payloads without a text message', async () => {
    const payloads = [null, {}, { choices: 'x' }, { choices: [{}] }, { choices: [{ message: { content: 42 } }] }]
    for (const payload of payloads) {
      const call = createChatCall(
        { name: 'm', baseUrl: 'https://x/v1', apiKey: 'k' },
        async () => response(payload),
      )
      await expect(call(prompt)).rejects.toThrow('空内容')
    }
  })

  it('omits the body when the error response cannot be read', async () => {
    const call = createChatCall(
      { name: 'm', baseUrl: 'https://x/v1', apiKey: 'k' },
      async () => ({
        ok: false,
        status: 500,
        text: async () => { throw new Error('unreadable') },
        json: async () => ({}),
      }),
    )
    await expect(call(prompt)).rejects.toThrow('HTTP 500')
  })

  it('uses the global fetch by default', async () => {
    const fetchMock = vi.fn(async () => response({ choices: [{ message: { content: '{"ok":true}' } }] }))
    vi.stubGlobal('fetch', fetchMock)
    const call = createChatCall({ name: 'm', baseUrl: 'https://x/v1', apiKey: 'k' })
    await expect(call(prompt)).resolves.toBe('{"ok":true}')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('wraps non-Error transport failures', async () => {
    const call = createChatCall(
      { name: 'm', baseUrl: 'https://x/v1', apiKey: 'k' },
      async () => {
        // eslint-disable-next-line no-throw-literal
        throw 'boom'
      },
    )
    await expect(call(prompt)).rejects.toThrow('模型请求失败: boom')
  })
})
