/**
 * Narrow a decoded JSON value to a plain object.
 *
 * Event envelopes arrive as parsed JSON, so every field read goes through here
 * rather than an unchecked cast.
 */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/** Read a non-empty string field; anything else (missing, wrong type, `''`) is absent. */
export function stringField(record: Record<string, unknown> | null, key: string): string | undefined {
  const value = record?.[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}
