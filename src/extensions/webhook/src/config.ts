import type { PluginConfigSchema } from '../../../plugin-sdk/index.js'
import { z } from 'zod'
import { hasNoUrlCredentials, isHttpsOrLoopbackHttp } from '../../../utils/url.js'

export const INBOUND_COMMANDS = ['status', 'history', 'run'] as const
export type InboundCommand = (typeof INBOUND_COMMANDS)[number]

const outboundUrlSchema = z
  .string()
  .min(1)
  .max(2_000)
  .refine(isHttpsOrLoopbackHttp, 'must use HTTPS unless the host is loopback')
  .refine(hasNoUrlCredentials, 'must not contain credentials')

const endpointSchema = z.object({
  url: outboundUrlSchema,
  secret: z.string().min(1).max(4_096).optional(),
  headers: z.record(z.string().max(200)).optional(),
})

const inboundSchema = z.object({
  path: z
    .string()
    .min(1)
    .max(500)
    .refine(value => value.startsWith('/'), 'must start with "/"'),
  secret: z.string().min(1).max(4_096),
  commands: z
    .array(z.enum(INBOUND_COMMANDS))
    .min(1)
    .max(INBOUND_COMMANDS.length)
    .default([...INBOUND_COMMANDS]),
  maxBodyBytes: z.number().int().min(1).max(1_048_576).default(65_536),
})

export const webhookConfigSchema = z.object({
  endpoints: z.record(endpointSchema).default({}),
  defaultEndpoint: z.string().min(1).max(100).optional(),
  inbound: inboundSchema.optional(),
})

export type WebhookEndpoint = z.infer<typeof endpointSchema>
export type WebhookInboundConfig = z.infer<typeof inboundSchema>
export type WebhookConfig = z.infer<typeof webhookConfigSchema>

export const webhookPluginConfig: PluginConfigSchema<WebhookConfig> = {
  parse: input => webhookConfigSchema.parse(input ?? {}),
}

/** Pick the endpoint for a notification route: explicit target, default, then first. */
export function resolveEndpoint(config: WebhookConfig, target?: string): WebhookEndpoint | undefined {
  if (target !== undefined && Object.hasOwn(config.endpoints, target))
    return config.endpoints[target]
  if (config.defaultEndpoint !== undefined && Object.hasOwn(config.endpoints, config.defaultEndpoint))
    return config.endpoints[config.defaultEndpoint]
  return Object.values(config.endpoints)[0]
}
