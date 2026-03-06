import { Box, Text } from "ink";
import type { Phase } from "../../utils/progress.js";

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}m ${sec.toString().padStart(2, "0")}s`;
}

interface StatusBarProps {
  phase: Phase;
  currentTask: string | null;
  taskIndex: number;
  taskTotal: number;
  currentStep: number;
  elapsed: number;
  currentAction: string | null;
  currentReason: string | null;
}

export function StatusBar({
  phase,
  currentTask,
  taskIndex,
  taskTotal,
  currentStep,
  elapsed,
  currentAction,
  currentReason,
}: StatusBarProps) {
  if (phase === "login") {
    return (
      <Box marginTop={1}>
        <Text color="yellow" bold>● Login</Text>
        <Text dimColor> — Authenticating... ({formatElapsed(elapsed)})</Text>
      </Box>
    );
  }

  if (phase === "running") {
    const taskInfo = taskTotal > 0
      ? ` Task ${taskIndex}/${taskTotal}:${currentTask ? ` ${currentTask}` : ""}`
      : "";
    const stepInfo = currentStep > 0
      ? ` [Step ${currentStep}]${currentAction ? ` ${currentAction}` : ""}`
      : "";
    const reasonInfo = currentReason ? ` — "${currentReason}"` : "";

    return (
      <Box marginTop={1}>
        <Text color="blue" bold>● Running</Text>
        <Text dimColor>
          {" —"}{taskInfo}{stepInfo}{reasonInfo} ({formatElapsed(elapsed)})
        </Text>
      </Box>
    );
  }

  if (phase === "done") {
    return (
      <Box marginTop={1}>
        <Text color="green" bold>● Done</Text>
        <Text dimColor> ({formatElapsed(elapsed)})</Text>
      </Box>
    );
  }

  if (phase === "error") {
    return (
      <Box marginTop={1}>
        <Text color="red" bold>● Error</Text>
        {currentReason && <Text dimColor> — {currentReason}</Text>}
      </Box>
    );
  }

  // idle
  return (
    <Box marginTop={1}>
      <Text color="gray">○ Idle</Text>
    </Box>
  );
}
