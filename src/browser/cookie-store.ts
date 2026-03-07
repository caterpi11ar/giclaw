import { access, readFile, unlink, writeFile } from 'node:fs/promises'
import { logger } from '../utils/logger.js'

export interface Cookie {
  name: string
  value: string
  domain?: string
  path?: string
  expires?: number
  httpOnly?: boolean
  secure?: boolean
  sameSite?: 'Strict' | 'Lax' | 'None'
}

export async function loadCookies(path: string): Promise<Cookie[] | null> {
  try {
    await access(path)
    const raw = await readFile(path, 'utf-8')
    const cookies = JSON.parse(raw) as Cookie[]
    logger.info('Cookies loaded from file')
    return cookies
  }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    logger.warn('Failed to load cookies', err)
    return null
  }
}

export async function saveCookies(path: string, cookies: Cookie[]): Promise<void> {
  await writeFile(path, JSON.stringify(cookies, null, 2))
  logger.info('Cookies saved to file')
}

export async function deleteCookies(path: string): Promise<void> {
  try {
    await unlink(path)
    logger.info('Cookie file deleted')
  }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err
    }
  }
}
