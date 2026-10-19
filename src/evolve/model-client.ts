import type { DiagnosisCall } from './diagnose.js'
import { EvolveError, toError } from '../utils/errors.js'
import { sanitizeBoundedText } from '../utils/logger.js'

/**
 * Real chat-completions client for diagnosis and patch proposal.
 *
 * giclaw's model config is always an OpenAI-compatible endpoint (Gemini, OpenAI,
 * Doubao, Qwen), so a plain `fetch` to `<baseUrl>/chat/completions` is enough and
 * avoids adding a vendor SDK dependency. Text-only on purpose: screenshots are
 * for humans, not for the diagnosis model.
 */

export interface ChatModelConfig {
  name: string
  baseUrl: string
  apiKey: string
  timeoutMs?: number
}

export interface HttpResponseLike {
  ok: boolean
  status: number
  text: () => Promise<string>
  json: () => Promise<unknown>
}

export type FetchLike = (url: string, init: RequestInit) => Promise<HttpResponseLike>

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_RESPONSE_CHARS = 200_000

function extractContent(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null)
    return null
  const choices = (payload as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0)
    return null
  const message = (choices[0] as { message?: unknown }).message
  if (typeof message !== 'object' || message === null)
    return null
  const content = (message as { content?: unknown }).content
  return typeof content === 'string' ? content : null
}

export function createChatCall(
  config: ChatModelConfig,
  fetchImpl: FetchLike = (url, init) => fetch(url, init),
): DiagnosisCall {
  const { name, baseUrl, apiKey } = config
  if (!name || !baseUrl || !apiKey)
    throw new EvolveError('模型未配置（需要 model.name / model.baseUrl / model.apiKey）')

  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return async (prompt) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    // Split transport from response handling so the timeout timer can be
    // cleared without a try/finally control-flow edge (which v8 reports as an
    // uncoverable branch).
    let response: HttpResponseLike
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: name,
          temperature: 0,
          messages: [
            { role: 'system', content: prompt.system },
            { role: 'user', content: prompt.user },
          ],
        }),
        signal: controller.signal,
      })
    }
    catch (error) {
      clearTimeout(timer)
      if (controller.signal.aborted)
        throw new EvolveError(`模型请求超时（${timeoutMs}ms）`)
      throw new EvolveError(`模型请求失败: ${toError(error).message}`)
    }
    clearTimeout(timer)

    try {
      if (!response.ok) {
        const body = sanitizeBoundedText(await response.text().catch(() => ''), 500)
        throw new EvolveError(`模型请求失败: HTTP ${response.status}${body ? ` ${body}` : ''}`)
      }
      const content = extractContent(await response.json())
      if (!content || !content.trim())
        throw new EvolveError('模型返回了空内容')
      return content.slice(0, MAX_RESPONSE_CHARS)
    }
    catch (error) {
      if (error instanceof EvolveError)
        throw error
      throw new EvolveError(`模型请求失败: ${toError(error).message}`)
    }
  }
}
