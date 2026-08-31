import { describe, expect, test } from "vite-plus/test";
import type { Thread, ThreadItem } from "@nodex/codex-app-server-protocol/v2";
import {
  createCodexCanonicalConversationState,
  type CodexCanonicalConversationState,
  type CodexCanonicalTurnParams,
} from "./codex-conversation-state";
import {
  groupCodexCommandOutputUpdatesByConversation,
  CODEX_TERMINAL_COMMAND_ACTION_MAX_COUNT,
  CODEX_TERMINAL_COMMAND_ACTION_MAX_UTF8_BYTES,
  reduceCodexCommandOutputRawTurns,
  reduceCodexConversationCommandOutput,
  reduceCodexConversationTerminalCommands,
  reduceCodexTerminalCommandsRawTurns,
} from "./codex-command-execution-stream";
import { CODEX_COMMAND_OUTPUT_TRUNCATION_PREFIX } from "./codex-command-output-queue";

const THREAD_ID = "thread_c05";
const TURN_ID = "turn_c05";

type CommandExecutionItem = Extract<ThreadItem, { type: "commandExecution" }>;

function buildCommand(
  id: string,
  overrides: Partial<CommandExecutionItem> = {},
): CommandExecutionItem {
  return {
    type: "commandExecution",
    id,
    command: `printf ${id}`,
    cwd: "/workspace/project",
    processId: null,
    pluginId: null,
    scriptPath: null,
    source: "agent",
    status: "inProgress",
    commandActions: [],
    aggregatedOutput: null,
    exitCode: null,
    durationMs: null,
    ...overrides,
  };
}

function buildTurnParams(): CodexCanonicalTurnParams {
  return {
    threadId: THREAD_ID,
    input: [],
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: [],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    },
    model: "fixture-model",
    cwd: "/workspace/project",
    attachments: [],
    effort: "high",
    summary: "none",
    personality: null,
    outputSchema: null,
    collaborationMode: null,
  };
}

function buildState(items: ThreadItem[] = []): CodexCanonicalConversationState {
  const thread: Thread = {
    id: THREAD_ID,
    extra: null,
    sessionId: "session_c05",
    forkedFromId: null,
    parentThreadId: null,
    preview: "C-05 command stream fixture",
    ephemeral: false,
    section: null,
    sectionEnteredAt: null,
    historyMode: "paginated",
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 2,
    recencyAt: 2,
    status: { type: "active", activeFlags: [] },
    path: null,
    cwd: "/workspace/project",
    cliVersion: "fixture",
    source: "unknown",
    canAcceptDirectInput: true,
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: "C-05 command stream fixture",
    turns: [
      {
        id: TURN_ID,
        items,
        itemsView: "full",
        status: "inProgress",
        error: null,
        startedAt: 1,
        completedAt: null,
        durationMs: null,
      },
    ],
  };

  return createCodexCanonicalConversationState(thread, {
    turnParamsById: { [TURN_ID]: buildTurnParams() },
  });
}

describe("canonical command-execution stream reduction", () => {
  test("targets the reverse-last exact command in the newest turn and ignores turnId", () => {
    const old = buildCommand("shared", { aggregatedOutput: "old" });
    const newestFirst = buildCommand("shared", {
      aggregatedOutput: "new-first",
    });
    const newestLast = buildCommand("shared", {
      aggregatedOutput: "new-last",
    });
    const wrongTypeAfterTarget = {
      type: "agentMessage",
      id: "shared",
      text: "must not mask the command",
      phase: null,
      memoryCitation: null,
    };
    const turns = [{ items: [old] }, { items: [newestFirst, newestLast, wrongTypeAfterTarget] }];

    const result = reduceCodexCommandOutputRawTurns(turns, {
      conversationId: THREAD_ID,
      turnId: "deliberately-stale-turn",
      itemId: "shared",
      delta: "+delta",
    });

    expect(result.disposition).toBe("applied");
    expect(result.turnIndex).toBe(1);
    expect(result.itemIndex).toBe(1);
    expect(result.rawItem?.aggregatedOutput).toBe("new-last+delta");
    expect(result.stateChanged).toBe(true);
    expect(old.aggregatedOutput).toBe("old");
    expect(newestFirst.aggregatedOutput).toBe("new-first");
    expect(newestLast.aggregatedOutput).toBe("new-last");
  });

  test("keeps foreign, empty-turn, and missing-item states referentially unchanged", () => {
    const state = buildState([buildCommand("exec")]);
    const foreign = reduceCodexConversationCommandOutput(state, {
      conversationId: "another-thread",
      turnId: null,
      itemId: "exec",
      delta: "ignored",
    });
    const noTurnsState: CodexCanonicalConversationState = {
      ...state,
      turns: [],
    };
    const noTurns = reduceCodexConversationCommandOutput(noTurnsState, {
      conversationId: THREAD_ID,
      turnId: null,
      itemId: "exec",
      delta: "ignored",
    });
    const missing = reduceCodexConversationCommandOutput(state, {
      conversationId: THREAD_ID,
      turnId: null,
      itemId: "missing",
      delta: "ignored",
    });

    expect(foreign.disposition).toBe("foreignConversation");
    expect(foreign.state).toBe(state);
    expect(foreign.stateChanged).toBe(false);
    expect(noTurns.disposition).toBe("noTurns");
    expect(noTurns.state).toBe(noTurnsState);
    expect(noTurns.stateChanged).toBe(false);
    expect(missing.disposition).toBe("missingItem");
    expect(missing.state).toBe(state);
    expect(missing.stateChanged).toBe(false);
  });

  test("retains the exact sticky prefix and a 20,000 UTF-16-unit tail", () => {
    const command = buildCommand("exec", { aggregatedOutput: "seed" });
    const emojiDelta = "🙂".repeat(10_001);
    const truncated = reduceCodexCommandOutputRawTurns([{ items: [command] }], {
      conversationId: THREAD_ID,
      turnId: null,
      itemId: "exec",
      delta: emojiDelta,
    });
    const expectedPayload = "🙂".repeat(10_000);
    const expectedOutput = `${CODEX_COMMAND_OUTPUT_TRUNCATION_PREFIX}${expectedPayload}`;

    expect(truncated.rawItem?.aggregatedOutput).toBe(expectedOutput);
    expect(
      truncated.rawItem?.aggregatedOutput?.slice(CODEX_COMMAND_OUTPUT_TRUNCATION_PREFIX.length)
        .length,
    ).toBe(20_000);

    const empty = reduceCodexCommandOutputRawTurns([{ items: [truncated.rawItem] }], {
      conversationId: THREAD_ID,
      turnId: "ignored",
      itemId: "exec",
      delta: "",
    });

    expect(empty.rawItem).toBe(truncated.rawItem);
    expect(empty.rawItem?.aggregatedOutput).toBe(expectedOutput);
    expect(empty.stateChanged).toBe(false);

    const prefixedAppend = reduceCodexCommandOutputRawTurns(
      [
        {
          items: [
            buildCommand("prefixed", {
              aggregatedOutput: `${CODEX_COMMAND_OUTPUT_TRUNCATION_PREFIX}tail`,
            }),
          ],
        },
      ],
      {
        conversationId: THREAD_ID,
        turnId: null,
        itemId: "prefixed",
        delta: "+next",
      },
    );
    expect(prefixedAppend.rawItem?.aggregatedOutput).toBe(
      `${CODEX_COMMAND_OUTPUT_TRUNCATION_PREFIX}tail+next`,
    );

    const nullToEmpty = reduceCodexCommandOutputRawTurns(
      [{ items: [buildCommand("empty", { aggregatedOutput: null })] }],
      {
        conversationId: THREAD_ID,
        turnId: null,
        itemId: "empty",
        delta: "",
      },
    );
    expect(nullToEmpty.rawItem?.aggregatedOutput).toBe("");
    expect(nullToEmpty.stateChanged).toBe(true);
  });

  test("appends ordered unknown terminal commands and treats an empty batch as a no-op", () => {
    const command = buildCommand("exec", {
      commandActions: [{ type: "unknown", command: "existing" }],
    });
    const appended = reduceCodexTerminalCommandsRawTurns([{ items: [command] }], {
      conversationId: THREAD_ID,
      turnId: "unrelated-turn",
      itemId: "exec",
      commands: ["pwd", "ls -la"],
    });

    expect(JSON.stringify(appended.rawItem?.commandActions)).toBe(
      JSON.stringify([
        { type: "unknown", command: "existing" },
        { type: "unknown", command: "pwd" },
        { type: "unknown", command: "ls -la" },
      ]),
    );
    expect(appended.stateChanged).toBe(true);
    expect(JSON.stringify(command.commandActions)).toBe(
      JSON.stringify([{ type: "unknown", command: "existing" }]),
    );

    const empty = reduceCodexTerminalCommandsRawTurns([{ items: [appended.rawItem] }], {
      conversationId: THREAD_ID,
      turnId: null,
      itemId: "exec",
      commands: [],
    });
    expect(empty.rawItem).toBe(appended.rawItem);
    expect(empty.stateChanged).toBe(false);
  });

  test("keeps terminal command actions to a bounded recent tail", () => {
    const command = buildCommand("exec", {
      commandActions: Array.from(
        { length: CODEX_TERMINAL_COMMAND_ACTION_MAX_COUNT },
        (_, index) => ({ type: "unknown" as const, command: `existing-${index}` }),
      ),
    });
    const result = reduceCodexTerminalCommandsRawTurns([{ items: [command] }], {
      conversationId: THREAD_ID,
      turnId: TURN_ID,
      itemId: "exec",
      commands: Array.from(
        { length: CODEX_TERMINAL_COMMAND_ACTION_MAX_COUNT * 4 },
        (_, index) => `incoming-${index}`,
      ),
    });
    const actions = result.rawItem?.commandActions ?? [];
    const oversized = reduceCodexTerminalCommandsRawTurns([{ items: [command] }], {
      conversationId: THREAD_ID,
      turnId: TURN_ID,
      itemId: "exec",
      commands: ["x".repeat(CODEX_TERMINAL_COMMAND_ACTION_MAX_UTF8_BYTES + 1)],
    });

    expect(actions.length).toBe(CODEX_TERMINAL_COMMAND_ACTION_MAX_COUNT);
    expect(actions[0]?.command).toBe(
      `incoming-${CODEX_TERMINAL_COMMAND_ACTION_MAX_COUNT * 4 - CODEX_TERMINAL_COMMAND_ACTION_MAX_COUNT}`,
    );
    expect(actions.at(-1)?.command).toBe(
      `incoming-${CODEX_TERMINAL_COMMAND_ACTION_MAX_COUNT * 4 - 1}`,
    );
    expect(oversized.rawItem?.commandActions.length).toBe(CODEX_TERMINAL_COMMAND_ACTION_MAX_COUNT);
  });

  test("clones only the targeted canonical path without changing lifecycle sidecars", () => {
    const untouched = buildCommand("untouched", { aggregatedOutput: "stable" });
    const target = buildCommand("target", {
      status: "completed",
      aggregatedOutput: "before",
      exitCode: 7,
      durationMs: 345,
    });
    const state = buildState([untouched, target]);
    const originalTurn = state.turns[0];
    const originalUntouched = originalTurn?.items[0];
    const originalTarget = originalTurn?.items[1];
    const originalSidecar = originalTurn?.sidecar;
    const originalProtocol = originalTurn?.protocol;

    const result = reduceCodexConversationCommandOutput(state, {
      conversationId: THREAD_ID,
      turnId: "not-the-real-turn",
      itemId: "target",
      delta: "+after",
    });
    const nextTurn = result.state.turns[0];
    const nextTarget = nextTurn?.items[1] as CommandExecutionItem;

    expect(result.stateChanged).toBe(true);
    expect(result.state === state).toBe(false);
    expect(nextTurn === originalTurn).toBe(false);
    expect(nextTurn?.items[0]).toBe(originalUntouched);
    expect(nextTurn?.sidecar).toBe(originalSidecar);
    expect(nextTurn?.protocol).toBe(originalProtocol);
    expect(result.state.protocol).toBe(state.protocol);
    expect(result.state.requests).toBe(state.requests);
    expect(nextTarget.aggregatedOutput).toBe("before+after");
    expect(nextTarget.status).toBe("completed");
    expect(nextTarget.exitCode).toBe(7);
    expect(nextTarget.durationMs).toBe(345);
    expect((originalTarget as CommandExecutionItem).aggregatedOutput).toBe("before");
  });

  test("canonical terminal reduction preserves lifecycle state while appending actions", () => {
    const state = buildState([buildCommand("exec", { status: "completed" })]);
    const result = reduceCodexConversationTerminalCommands(state, {
      conversationId: THREAD_ID,
      turnId: null,
      itemId: "exec",
      commands: ["echo done"],
    });
    const item = result.state.turns[0]?.items[0] as CommandExecutionItem;

    expect(result.disposition).toBe("applied");
    expect(item.status).toBe("completed");
    expect(JSON.stringify(item.commandActions)).toBe(
      JSON.stringify([{ type: "unknown", command: "echo done" }]),
    );
  });

  test("groups updates without reordering", () => {
    const first = { conversationId: "a", turnId: null, itemId: "one", delta: "1" };
    const second = { conversationId: "b", turnId: "turn-b", itemId: "two", delta: "2" };
    const third = { conversationId: "a", turnId: null, itemId: "three", delta: "3" };

    const grouped = groupCodexCommandOutputUpdatesByConversation([first, second, third]);
    expect([...grouped.keys()].join(",")).toBe("a,b");
    expect(
      grouped
        .get("a")
        ?.map((entry) => entry.itemId)
        .join(","),
    ).toBe("one,three");
    expect(grouped.get("b")?.[0]).toBe(second);
  });
});
