import type { LogEntry } from '../../utils/logger.js'
import { Box, Text } from 'ink'

export const LOG_VISIBLE_COUNT = 15

interface LogPanelProps {
  logs: LogEntry[]
  scrollOffset?: number
}

type LogColor = 'gray' | 'white' | 'yellow' | 'red'

const levelColors: Record<string, LogColor> = {
  debug: 'gray',
  info: 'white',
  warn: 'yellow',
  error: 'red',
}

export function LogPanel({ logs, scrollOffset = 0 }: LogPanelProps) {
  const total = logs.length
  const endIndex = total - scrollOffset
  const startIndex = Math.max(0, endIndex - LOG_VISIBLE_COUNT)
  const visible = logs.slice(startIndex, endIndex)

  const canScrollUp = startIndex > 0
  const canScrollDown = scrollOffset > 0

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text bold>Logs</Text>
        {total > LOG_VISIBLE_COUNT && (
          <Text dimColor>
            {' '}
            (
            {startIndex + 1}
            -
            {Math.min(endIndex, total)}
            /
            {total}
            )
            {canScrollUp && ' ↑'}
            {canScrollDown && ' ↓'}
          </Text>
        )}
      </Box>
      {visible.length === 0
        ? (
            <Text dimColor> No logs</Text>
          )
        : (
            visible.map((entry, i) => {
              const time = new Date(entry.timestamp).toLocaleTimeString()
              const color = levelColors[entry.level] ?? 'white'
              return (
                <Text key={i} color={color}>
                  <Text dimColor>
                    {time}
                    {' '}
                  </Text>
                  <Text>
                    [
                    {entry.level.toUpperCase().padEnd(5)}
                    ]
                    {' '}
                  </Text>
                  <Text>{entry.message}</Text>
                </Text>
              )
            })
          )}
    </Box>
  )
}
