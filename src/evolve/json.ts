import { EvolveError, toError } from '../utils/errors.js'

/**
 * Extract the first JSON object from a model response, tolerating fenced code
 * blocks and surrounding prose. Kept regex-free to avoid super-linear
 * backtracking on adversarial model output.
 */
export function extractJsonObject(raw: string): string {
  let candidate = raw.trim()
  const fence = candidate.indexOf('```')
  if (fence !== -1) {
    let rest = candidate.slice(fence + 3)
    if (rest.startsWith('json'))
      rest = rest.slice(4)
    const end = rest.indexOf('```')
    candidate = (end === -1 ? rest : rest.slice(0, end)).trim()
  }
  if (candidate.startsWith('{'))
    return candidate
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end <= start)
    throw new EvolveError('模型输出中没有 JSON 对象')
  return candidate.slice(start, end + 1)
}

export function parseJsonObject(raw: string): unknown {
  const object = extractJsonObject(raw)
  try {
    return JSON.parse(object)
  }
  catch (error) {
    throw new EvolveError(`模型输出不是合法 JSON: ${toError(error).message}`)
  }
}
