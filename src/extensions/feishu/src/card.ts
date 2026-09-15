import type { NotificationMessage } from '../../../plugin-sdk/index.js'

/** Header colour per notification level. */
const LEVEL_TEMPLATE = {
  success: 'green',
  error: 'red',
  info: 'blue',
} as const

export interface FeishuCard {
  config: { wide_screen_mode: boolean }
  header: { template: string, title: { tag: 'plain_text', content: string } }
  elements: Array<Record<string, unknown>>
}

/** Render a notification as a Feishu interactive card (schema 1.0, wide screen). */
export function buildFeishuCard(message: NotificationMessage): FeishuCard {
  return {
    config: { wide_screen_mode: true },
    header: {
      template: LEVEL_TEMPLATE[message.level],
      title: { tag: 'plain_text', content: message.title },
    },
    elements: [
      { tag: 'markdown', content: message.body },
      { tag: 'hr' },
      {
        tag: 'note',
        elements: [
          {
            tag: 'plain_text',
            content: `runId ${message.runId} · trigger ${message.trigger} · ${message.occurredAt}`,
          },
        ],
      },
    ],
  }
}

/** Plain-text fallback used when cards are disabled or the card is rejected. */
export function buildFeishuText(message: NotificationMessage): string {
  return `${message.title}\n${message.body}`
}
