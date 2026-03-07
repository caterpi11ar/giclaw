import type { RunResult } from '../../tasks/task-runner.js'
import { Box, Text } from 'ink'

interface TaskResultsProps {
  lastResult: RunResult | null
}

export function TaskResults({ lastResult }: TaskResultsProps) {
  if (!lastResult) {
    return (
      <Box marginTop={1}>
        <Text dimColor>No runs yet</Text>
      </Box>
    )
  }

  const succeeded = lastResult.results.filter(r => r.success).length
  const total = lastResult.results.length

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text bold>Last Run</Text>
        <Text> </Text>
        <Text dimColor>
          {succeeded}
          /
          {total}
          {' '}
          succeeded ·
          {' '}
          {lastResult.startedAt.toLocaleString()}
        </Text>
      </Box>
      {lastResult.results.map(r => (
        <Box key={r.taskId}>
          <Text color={r.success ? 'green' : 'red'}>
            {r.success ? ' ✓ ' : ' ✗ '}
          </Text>
          <Text>{r.taskId.padEnd(24)}</Text>
          <Text dimColor>
            {(r.durationMs / 1000).toFixed(1).padStart(6)}
            s
            {' '}
          </Text>
          <Text color={r.success ? 'green' : 'red'}>
            {r.success ? r.message : (r.error?.message ?? r.message)}
          </Text>
        </Box>
      ))}
    </Box>
  )
}
