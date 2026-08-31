import { describe, expect, test } from "vite-plus/test";
import type { Thread, ThreadItem, Turn } from "@nodex/codex-app-server-protocol/v2";
import {
  createCodexCanonicalConversationState,
  type CodexCanonicalTurnParams,
} from "./codex-conversation-state";
import {
  listCodexBackgroundTerminalTurnIds,
  reduceCodexBackgroundTerminalCleanup,
} from "./codex-background-terminal-cleanup";

const command = (id: string): Extract<ThreadItem, { type: "commandExecution" }> => ({
  type: "commandExecution",
  id,
  command: id,
  cwd: "/repo",
  processId: null,
  pluginId: null,
  scriptPath: null,
  source: "agent",
  status: "inProgress",
  commandActions: [],
  aggregatedOutput: null,
  exitCode: null,
  durationMs: null,
});

const params = (threadId: string): CodexCanonicalTurnParams => ({
  threadId,
  input: [],
  approvalPolicy: "on-request",
  approvalsReviewer: "user",
  sandboxPolicy: {
    type: "workspaceWrite",
    writableRoots: ["/repo"],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  },
  model: "gpt-test",
  cwd: "/repo",
  attachments: [],
  effort: null,
  summary: null,
  personality: null,
  outputSchema: null,
  collaborationMode: null,
});

const state = (turns: readonly Turn[]) => {
  const threadId = "thread-background";
  const thread: Thread = {
    id: threadId,
    extra: null,
    sessionId: "session-background",
    forkedFromId: null,
    parentThreadId: null,
    preview: "background terminals",
    ephemeral: false,
    section: null,
    sectionEnteredAt: null,
    projectId: null,
    historyMode: "paginated",
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 2,
    recencyAt: 2,
    status: { type: "active", activeFlags: [] },
    path: null,
    cwd: "/repo",
    cliVersion: "test",
    source: "unknown",
    canAcceptDirectInput: true,
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: "background terminals",
    turns: [...turns],
  };
  return createCodexCanonicalConversationState(thread, {
    turnParamsById: Object.fromEntries(turns.map((turn) => [turn.id, params(threadId)])),
  });
};

const turn = (id: string, status: Turn["status"]): Turn => ({
  id,
  items: [command(`command-${id}`)],
  itemsView: "full",
  status,
  error: null,
  startedAt: 1,
  completedAt: status === "inProgress" ? null : 2,
  durationMs: status === "inProgress" ? null : 1,
});

describe("background terminal canonical semantics", () => {
  test("excludes only the latest foreground Turn", () => {
    const before = state([turn("older", "inProgress"), turn("latest", "inProgress")]);

    expect(listCodexBackgroundTerminalTurnIds(before)).toEqual(["older"]);
    const after = reduceCodexBackgroundTerminalCleanup(before);
    expect(after.turns[0]?.sidecar.interruptedCommandExecutionItemIds).toEqual(["command-older"]);
    expect(after.turns[1]?.sidecar.interruptedCommandExecutionItemIds).toBeUndefined();
  });

  test("includes a detached command on the latest completed Turn", () => {
    const before = state([turn("completed", "completed")]);

    expect(listCodexBackgroundTerminalTurnIds(before)).toEqual(["completed"]);
    expect(
      reduceCodexBackgroundTerminalCleanup(before).turns[0]?.sidecar
        .interruptedCommandExecutionItemIds,
    ).toEqual(["command-completed"]);
  });

  test("does not list a command already recorded as interrupted", () => {
    const before = state([turn("completed", "completed")]);
    const recorded = {
      ...before,
      turns: before.turns.map((entry) => ({
        ...entry,
        sidecar: {
          ...entry.sidecar,
          interruptedCommandExecutionItemIds: ["command-completed"],
        },
      })),
    };

    expect(listCodexBackgroundTerminalTurnIds(recorded)).toEqual([]);
    expect(reduceCodexBackgroundTerminalCleanup(recorded)).toBe(recorded);
  });
});
