import type { NotificationMessage } from '../../../plugin-sdk/index.js'
import { describe, expect, it } from 'vitest'
import { buildFeishuCard, buildFeishuText } from './card.js'

function message(level: NotificationMessage['level']): NotificationMessage {
  return {
    level,
    title: 'Giclaw 运行成功 (2/2)',
    body: 'runId: run-1\ntrigger: cron\n✓ welkin-moon',
    runId: 'run-1',
    trigger: 'cron',
    occurredAt: '2026-01-01T00:00:00.000Z',
    results: [],
  }
}

describe('buildFeishuCard', () => {
  it.each([['success', 'green'], ['error', 'red'], ['info', 'blue']] as const)(
    'maps level %s to template %s',
    (level, template) => {
      const card = buildFeishuCard(message(level))

      expect(card.header.template).toBe(template)
      expect(card.header.title).toEqual({ tag: 'plain_text', content: 'Giclaw 运行成功 (2/2)' })
      expect(card.config).toEqual({ wide_screen_mode: true })
      expect(card.elements[0]).toEqual({ tag: 'markdown', content: message(level).body })
      expect(card.elements[2]).toEqual({
        tag: 'note',
        elements: [{
          tag: 'plain_text',
          content: 'runId run-1 · trigger cron · 2026-01-01T00:00:00.000Z',
        }],
      })
    },
  )
})

describe('buildFeishuText', () => {
  it('joins the title and body', () => {
    expect(buildFeishuText(message('success'))).toBe(
      'Giclaw 运行成功 (2/2)\nrunId: run-1\ntrigger: cron\n✓ welkin-moon',
    )
  })
})
