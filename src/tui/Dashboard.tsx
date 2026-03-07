import type { Gateway } from '../gateway/gateway.js'
import type { GatewaySnapshot } from '../gateway/types.js'
import type { RunResult } from '../tasks/task-runner.js'
import type { LogEntry } from '../utils/logger.js'
import process from 'node:process'
import { Box, Text, useApp, useInput } from 'ink'
import { useCallback, useEffect, useState } from 'react'
import { logger } from '../utils/logger.js'
import { LOG_VISIBLE_COUNT, LogPanel } from './components/LogPanel.js'
import { StatusBar } from './components/StatusBar.js'
import { TaskResults } from './components/TaskResults.js'

interface DashboardProps {
  gateway: Gateway
}

export function Dashboard({ gateway }: DashboardProps) {
  const { exit } = useApp()
  const [snapshot, setSnapshot] = useState<GatewaySnapshot>(
    gateway.getSnapshot(),
  )
  const [lastResult, setLastResult] = useState<RunResult | null>(null)
  const [logs, setLogs] = useState<LogEntry[]>([])

  // Subscribe to gateway state changes
  useEffect(() => {
    const onChange = (s: GatewaySnapshot) => {
      setSnapshot(s)
    }
    gateway.state.on('change', onChange)
    return () => {
      gateway.state.off('change', onChange)
    }
  }, [gateway])

  // Subscribe to task runner events for last result
  useEffect(() => {
    const runner = gateway.getTaskRunner()
    const onRunComplete = (result: RunResult) => {
      setLastResult(result)
    }
    runner.on('run:complete', onRunComplete)
    return () => {
      runner.off('run:complete', onRunComplete)
    }
  }, [gateway])

  // Subscribe to logger events
  useEffect(() => {
    const onLog = (entry: LogEntry) => {
      setLogs((prev) => {
        const next = [...prev, entry]
        return next.length > 200 ? next.slice(-200) : next
      })
    }
    logger.on('log', onLog)
    return () => {
      logger.off('log', onLog)
    }
  }, [])

  // Track pipeline start time for live elapsed calculation
  const [pipelineStartedAt, setPipelineStartedAt] = useState<number | null>(null)
  const [liveElapsed, setLiveElapsed] = useState(0)

  useEffect(() => {
    if (snapshot.running && !pipelineStartedAt) {
      setPipelineStartedAt(Date.now() - snapshot.elapsed)
    }
    else if (!snapshot.running) {
      setPipelineStartedAt(null)
    }
  }, [snapshot.running, snapshot.elapsed, pipelineStartedAt])

  // Tick elapsed timer every second while running
  useEffect(() => {
    if (!snapshot.running || !pipelineStartedAt) {
      setLiveElapsed(snapshot.elapsed)
      return
    }
    setLiveElapsed(Date.now() - pipelineStartedAt)
    const timer = setInterval(() => setLiveElapsed(Date.now() - pipelineStartedAt), 1000)
    return () => clearInterval(timer)
  }, [snapshot.running, pipelineStartedAt, snapshot.elapsed])

  const handleRunNow = useCallback(() => {
    if (!snapshot.running) {
      gateway.enqueueRun('manual').catch(() => {})
    }
  }, [snapshot.running, gateway])

  // Log scroll state: 0 = auto-scroll (bottom), >0 = lines scrolled up from bottom
  const [logScroll, setLogScroll] = useState(0)

  const clearLogs = useCallback(() => {
    setLogs([])
    setLogScroll(0)
  }, [])

  useInput((_input, key) => {
    if (key.upArrow) {
      setLogScroll(prev => Math.min(prev + 1, Math.max(0, logs.length - LOG_VISIBLE_COUNT)))
    }
    else if (key.downArrow) {
      setLogScroll(prev => Math.max(0, prev - 1))
    }
    else if (_input === 'r') {
      handleRunNow()
    }
    else if (_input === 'c') {
      clearLogs()
    }
    else if (_input === 'q') {
      logger.unmute()
      gateway.shutdown().then(() => {
        exit()
        process.exit(0)
      }).catch(() => {
        exit()
        process.exit(1)
      })
    }
  })

  return (
    <Box flexDirection="column" padding={1}>
      {/* Header */}
      <Box>
        <Text bold color="cyan">
          Genshin Impact Claw
        </Text>
        <Box flexGrow={1} />
        <Text dimColor>
          Schedule:
          {' '}
          {gateway.config.schedule.cron}
          {' '}
          (
          {gateway.config.schedule.timezone}
          )
        </Text>
      </Box>

      <StatusBar
        phase={snapshot.phase}
        currentTask={snapshot.currentTask}
        taskIndex={snapshot.taskIndex}
        taskTotal={snapshot.taskTotal}
        currentStep={snapshot.currentStep}
        elapsed={liveElapsed}
        currentAction={snapshot.currentAction}
        currentReason={snapshot.currentReason}
      />
      <TaskResults lastResult={lastResult} />
      <LogPanel logs={logs} scrollOffset={logScroll} />

      {/* Key hints */}
      <Box marginTop={1}>
        <Text dimColor>
          [↑↓] Scroll Logs [r] Run Now [c] Clear Logs [q] Quit
          {logScroll > 0 && ` | Scroll: +${logScroll}`}
          {snapshot.queueDepth > 0 && ` | Queue: ${snapshot.queueDepth}`}
        </Text>
      </Box>
    </Box>
  )
}
