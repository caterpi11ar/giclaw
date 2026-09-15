/** A single address atom: no whitespace, angle brackets, separators or quoting. */
const MAIL_ATOM_PATTERN = /^[^\s@<>,;"\\]+$/u

/**
 * Bare `local@domain.tld` addresses only; display names are intentionally
 * unsupported, so a configured recipient can never smuggle a second one in.
 */
export function isMailAddress(value: string): boolean {
  const parts = value.split('@')
  if (parts.length !== 2)
    return false
  const [local, domain] = parts as [string, string]
  if (!MAIL_ATOM_PATTERN.test(local))
    return false
  const labels = domain.split('.')
  return labels.length > 1 && labels.every(label => MAIL_ATOM_PATTERN.test(label))
}

/**
 * Pull the address out of a header value that may carry a display name.
 *
 * `Ops <ops@example.com>` and `ops@example.com` both yield `ops@example.com`;
 * anything without a valid address yields `null`, which callers treat as a
 * rejected message rather than as an unknown sender.
 */
export function extractMailAddress(value: string): string | null {
  const angled = /<([^<>]*)>/u.exec(value)?.[1]
  const candidate = (angled ?? value).trim().replace(/^"(.*)"$/u, '$1').trim()
  return isMailAddress(candidate) ? candidate : null
}
