import type { Gateway } from '../gateway/gateway.js'
import { render } from 'ink'
import { logger } from '../utils/logger.js'
import { Dashboard } from './Dashboard.js'

export function renderDashboard(gateway: Gateway): void {
  logger.mute()
  render(<Dashboard gateway={gateway} />)
}
