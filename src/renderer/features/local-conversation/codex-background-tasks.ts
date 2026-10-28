import type { CodexBackgroundTerminalRow } from "../../../shared/types";
import type { ConversationBackgroundTasks, ThreadStageActions } from "./thread-stage-types";

/**
 * A Codex conversation's background terminals in the shared background-work model: each one
 * with a process stops alone, Stop all cleans every terminal, and output opens in the Process
 * output surface.
 */
export function createCodexBackgroundTerminalTasks(
  threadId: string | null,
  rows: readonly CodexBackgroundTerminalRow[],
  actions: Pick<
    ThreadStageActions,
    "onStopBackgroundTerminals" | "onOpenBackgroundTerminalOutput" | "onOpenProcessManager"
  >,
): ConversationBackgroundTasks | null {
  if (threadId === null || rows.length === 0) return null;
  const processIdOf = (row: CodexBackgroundTerminalRow) =>
    row.processId === null || row.processId === undefined ? null : String(row.processId);
  const { onOpenBackgroundTerminalOutput, onOpenProcessManager } = actions;
  return {
    tasks: rows.map((row) => {
      const command = row.command.trim();
      return {
        id: row.id,
        kind: "command",
        label: command || "Background terminal",
        command: command || null,
        owner: null,
        startedAtMs: null,
        stoppable: processIdOf(row) !== null,
        stopping: false,
      };
    }),
    stop: async (taskId) => {
      if (taskId === undefined) {
        await actions.onStopBackgroundTerminals(threadId);
        return;
      }
      const row = rows.find((candidate) => candidate.id === taskId);
      const processId = row ? processIdOf(row) : null;
      if (processId === null) throw new Error("This terminal can only be stopped with Stop all");
      await actions.onStopBackgroundTerminals(threadId, [processId]);
    },
    ...(onOpenBackgroundTerminalOutput
      ? {
          openOutput: (taskId: string) => {
            const row = rows.find((candidate) => candidate.id === taskId);
            if (row) void onOpenBackgroundTerminalOutput(row);
          },
        }
      : {}),
    ...(onOpenProcessManager ? { openAll: () => void onOpenProcessManager() } : {}),
  };
}
