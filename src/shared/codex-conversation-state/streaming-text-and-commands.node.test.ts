import { describe, expect, test } from "vite-plus/test";
import type {
  Thread,
  ThreadItem,
  Turn,
  FileUpdateChange,
} from "@nodex/codex-app-server-protocol/v2";
import {
  createCodexCanonicalConversationState,
  type CodexCanonicalTurnParams,
  type CodexCanonicalConversationState,
  type CodexCanonicalItem,
  type CodexCanonicalTurnState,
} from "./codex-conversation-state";
import {
  listCodexBackgroundTerminalTurnIds,
  reduceCodexBackgroundTerminalCleanup,
} from "./codex-background-terminal-cleanup";
import {
  groupCodexCommandOutputUpdatesByConversation,
  reduceCodexCommandOutputRawTurns,
  reduceCodexConversationCommandOutput,
  reduceCodexConversationTerminalCommands,
  reduceCodexTerminalCommandsRawTurns,
} from "./codex-command-execution-stream";
import {
  CODEX_COMMAND_OUTPUT_TRUNCATION_PREFIX,
  appendCodexCommandOutputTail,
  buildCodexCommandOutputKey,
  CodexCommandOutputQueue,
  type CodexCommandOutputScheduler,
  type CodexCommandOutputUpdate,
} from "./codex-command-output-queue";
import type { ServerNotification } from "@nodex/codex-app-server-protocol";
import {
  reduceCodexConversationEvent,
  reduceCodexConversationEventWithEffects,
} from "./codex-conversation-reducer";
import {
  isCodexFileChangeOutputDeltaNotification,
  isCodexFileChangePatchUpdatedNotification,
  isCodexMcpToolCallProgressNotification,
  reduceCodexConversationFileChangePatch,
  reduceCodexConversationMcpToolCallProgress,
  reduceCodexFileChangePatchRawTurns,
  reduceCodexMcpToolCallProgressRawTurns,
  toCodexFileChangePatchUpdate,
  toCodexMcpToolCallProgressUpdate,
  type CodexFileChangeRawTurn,
} from "./codex-file-change-stream";
import {
  buildCodexFrameTextDeltaKey,
  CodexFrameTextDeltaQueue,
  type CodexFrameTextDeltaScheduler,
  type CodexFrameTextDeltaUpdate,
} from "./codex-frame-text-delta-queue";
import { CodexFrameTextDeltaSequenceTracker } from "./codex-frame-text-delta-sequence-tracker";
import {
  reduceCodexConversationFrameTextDeltas,
  reduceCodexFrameTextDeltaItems,
  resolveCodexFrameTextDeltaTurn,
  toCodexFrameTextDelta,
} from "./codex-frame-text-delta";
import { canAppendCodexReasoningPartDelta } from "./codex-reasoning-parts";
import { replayCodexConversationEvents } from "./codex-conversation-replay";

describe("codex background terminal cleanup", () => {
  const command = (
    id: string,
  ): Extract<
    ThreadItem,
    {
      type: "commandExecution";
    }
  > => ({
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
      model: null,
      reasoningEffort: null,
      id: threadId,
      environments: null,
      extra: null,
      sessionId: "session-background",
      forkedFromId: null,
      attachedToThreadId: null,
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
      originator: null,
      source: "unknown",
      canAcceptDirectInput: true,
      threadSource: null,
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: "background terminals",
      daybreakEnabled: null,
      turns: [...turns],
    };
    return createCodexCanonicalConversationState(thread, {
      hostId: "local",
      ...{
        turnParamsById: Object.fromEntries(turns.map((turn) => [turn.id, params(threadId)])),
      },
    });
  };

  const turn = (id: string, status: Turn["status"]): Turn => ({
    rootTurnId: null,
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
    test("lists only background turns but records cleanup across all resident commands", () => {
      const before = state([turn("older", "inProgress"), turn("latest", "inProgress")]);

      expect(listCodexBackgroundTerminalTurnIds(before)).toEqual(["older"]);
      const after = reduceCodexBackgroundTerminalCleanup(before);
      expect(after.turns[0]?.interruptedCommandExecutionItemIds).toEqual(["command-older"]);
      expect(after.turns[1]?.interruptedCommandExecutionItemIds).toEqual(["command-latest"]);
    });

    test("includes a detached command on the latest completed Turn", () => {
      const before = state([turn("completed", "completed")]);

      expect(listCodexBackgroundTerminalTurnIds(before)).toEqual(["completed"]);
      expect(
        reduceCodexBackgroundTerminalCleanup(before).turns[0]?.interruptedCommandExecutionItemIds,
      ).toEqual(["command-completed"]);
    });

    test("does not list a command already recorded as interrupted", () => {
      const before = state([turn("completed", "completed")]);
      const recorded = {
        ...before,
        turns: before.turns.map((entry) => ({
          ...entry,
          interruptedCommandExecutionItemIds: ["command-completed"],
        })),
      };

      expect(listCodexBackgroundTerminalTurnIds(recorded)).toEqual([]);
      expect(reduceCodexBackgroundTerminalCleanup(recorded)).toBe(recorded);
    });
  });
});

describe("codex command execution stream", () => {
  const THREAD_ID = "thread_c05";
  const TURN_ID = "turn_c05";
  type CommandExecutionItem = Extract<
    ThreadItem,
    {
      type: "commandExecution";
    }
  >;
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
      model: null,
      reasoningEffort: null,
      id: THREAD_ID,
      environments: null,
      extra: null,
      sessionId: "session_c05",
      forkedFromId: null,
      attachedToThreadId: null,
      parentThreadId: null,
      preview: "C-05 command stream fixture",
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
      cwd: "/workspace/project",
      cliVersion: "fixture",
      originator: null,
      source: "unknown",
      canAcceptDirectInput: true,
      threadSource: null,
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: "C-05 command stream fixture",
      daybreakEnabled: null,
      turns: [
        {
          rootTurnId: null,
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
      hostId: "local",
      ...{
        turnParamsById: { [TURN_ID]: buildTurnParams() },
      },
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
        questions: null,
        type: "agentMessage",
        moderation: null,
        id: "shared",
        text: "must not mask the command",
        phase: null,
        memoryCitation: null,
        delivery: null,
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
      const emojiDelta = "🙂".repeat(10001);
      const truncated = reduceCodexCommandOutputRawTurns([{ items: [command] }], {
        conversationId: THREAD_ID,
        turnId: null,
        itemId: "exec",
        delta: emojiDelta,
      });
      const expectedPayload = "🙂".repeat(10000);
      const expectedOutput = `${CODEX_COMMAND_OUTPUT_TRUNCATION_PREFIX}${expectedPayload}`;

      expect(truncated.rawItem?.aggregatedOutput).toBe(expectedOutput);
      expect(
        truncated.rawItem?.aggregatedOutput?.slice(CODEX_COMMAND_OUTPUT_TRUNCATION_PREFIX.length)
          .length,
      ).toBe(20000);
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

    test("retains existing command actions and appends every new command in order", () => {
      const existing = Array.from({ length: 128 }, (_, index) => ({
        type: "unknown" as const,
        command: `existing-${index}`,
      }));
      const command = buildCommand("exec", { commandActions: existing });
      const commands = [
        ...Array.from({ length: 512 }, (_, index) => `incoming-${index}`),
        "x".repeat(300000),
      ];
      const result = reduceCodexTerminalCommandsRawTurns([{ items: [command] }], {
        conversationId: THREAD_ID,
        turnId: TURN_ID,
        itemId: "exec",
        commands,
      });
      expect(result.rawItem?.commandActions).toEqual([
        ...existing,
        ...commands.map((value) => ({ type: "unknown", command: value })),
      ]);
      expect(command.commandActions).toBe(existing);
    });
    test("clones only the targeted canonical path without changing lifecycle metadata", () => {
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
      expect(nextTurn?.params).toBe(originalTurn?.params);
      expect(nextTurn?.turnStartedAtMs).toBe(originalTurn?.turnStartedAtMs);
      expect(nextTurn?.hookRuns).toBe(originalTurn?.hookRuns);
      expect(nextTurn?.turnId).toBe(originalTurn?.turnId);
      expect(nextTurn?.status).toBe(originalTurn?.status);
      expect(nextTurn?.error).toBe(originalTurn?.error);
      expect(nextTurn?.durationMs).toBe(originalTurn?.durationMs);
      expect(result.state.threadRuntimeStatus).toBe(state.threadRuntimeStatus);
      expect(result.state.title).toBe(state.title);
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

    test("preserves separate identical output occurrences while a command is running", () => {
      const update = {
        conversationId: THREAD_ID,
        turnId: TURN_ID,
        itemId: "exec",
        delta: "same\n",
      };
      const first = reduceCodexConversationCommandOutput(
        buildState([buildCommand("exec")]),
        update,
      );
      const second = reduceCodexConversationCommandOutput(first.state, update);
      expect((second.state.turns[0]?.items[0] as CommandExecutionItem).aggregatedOutput).toBe(
        "same\nsame\n",
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
});

describe("codex command output queue", () => {
  class ManualCommandOutputScheduler implements CodexCommandOutputScheduler {
    private nextHandle = 1;
    private readonly timeouts = new Map<number, { callback: () => void; delayMs: number }>();

    readonly scheduleTimeout = (callback: () => void, delayMs: number): (() => void) => {
      const handle = this.nextHandle;
      this.nextHandle += 1;
      this.timeouts.set(handle, { callback, delayMs });
      return () => {
        this.timeouts.delete(handle);
      };
    };

    runNextTimeout(): void {
      const entry = this.timeouts.entries().next().value as
        | [number, { callback: () => void; delayMs: number }]
        | undefined;
      if (!entry) throw new Error("No command-output timeout is scheduled");
      this.timeouts.delete(entry[0]);
      entry[1].callback();
    }

    get timeoutCount(): number {
      return this.timeouts.size;
    }

    get nextDelayMs(): number | null {
      const entry = this.timeouts.values().next().value as
        | { callback: () => void; delayMs: number }
        | undefined;
      return entry?.delayMs ?? null;
    }
  }

  interface SequencedOutput extends CodexCommandOutputUpdate {
    readonly sequence: number;
    readonly sequences?: readonly number[];
  }

  function output(delta: string, overrides: Partial<SequencedOutput> = {}): SequencedOutput {
    return {
      conversationId: "conversation-a",
      turnId: "turn-a",
      itemId: "item-a",
      delta,
      sequence: 1,
      ...overrides,
    };
  }

  describe("appendCodexCommandOutputTail", () => {
    test("matches every exact maximum and empty-delta boundary", () => {
      const zeroEmpty = appendCodexCommandOutputTail({
        current: "",
        delta: "",
        maxChars: 0,
      });
      const zeroContent = appendCodexCommandOutputTail({
        current: "x",
        delta: "",
        maxChars: 0,
      });
      const emptyAtLimit = appendCodexCommandOutputTail({
        current: "12345",
        delta: "",
        maxChars: 5,
      });
      const emptyOverLimit = appendCodexCommandOutputTail({
        current: "123456",
        delta: "",
        maxChars: 5,
      });
      const exactDelta = appendCodexCommandOutputTail({
        current: "old",
        delta: "12345",
        maxChars: 5,
      });
      const exactCombined = appendCodexCommandOutputTail({
        current: "12",
        delta: "345",
        maxChars: 5,
      });
      const overflowing = appendCodexCommandOutputTail({
        current: "1234",
        delta: "567",
        maxChars: 5,
      });

      expect(`${zeroEmpty.next}:${zeroEmpty.didTruncate}`).toBe(":false");
      expect(`${zeroContent.next}:${zeroContent.didTruncate}`).toBe(":true");
      expect(`${emptyAtLimit.next}:${emptyAtLimit.didTruncate}`).toBe("12345:false");
      expect(`${emptyOverLimit.next}:${emptyOverLimit.didTruncate}`).toBe("123456:true");
      expect(`${exactDelta.next}:${exactDelta.didTruncate}`).toBe("12345:true");
      expect(`${exactCombined.next}:${exactCombined.didTruncate}`).toBe("12345:false");
      expect(`${overflowing.next}:${overflowing.didTruncate}`).toBe("34567:true");
    });

    test("counts and slices JavaScript UTF-16 code units", () => {
      const result = appendCodexCommandOutputTail({
        current: "😀",
        delta: "abc",
        maxChars: 4,
      });

      expect(result.next.length).toBe(4);
      expect(result.next.charCodeAt(0)).toBe(0xde00);
      expect(result.next.slice(1)).toBe("abc");
      expect(result.didTruncate).toBe(true);
    });
  });

  describe("CodexCommandOutputQueue", () => {
    test("builds the exact raw colon key including nullable turns", () => {
      expect(buildCodexCommandOutputKey(output("x"))).toBe("conversation-a:turn-a:item-a");
      expect(buildCodexCommandOutputKey(output("x", { turnId: null }))).toBe(
        "conversation-a:null:item-a",
      );
    });

    test("keeps A/B/A Map order and permits adapter metadata aggregation", () => {
      const scheduler = new ManualCommandOutputScheduler();
      const flushes: SequencedOutput[][] = [];
      const queue = new CodexCommandOutputQueue<SequencedOutput>({
        scheduler,
        mergeUpdate: (existing, incoming, mergedDelta) => ({
          ...incoming,
          delta: mergedDelta,
          sequences: [
            ...(existing?.sequences ??
              [existing?.sequence].filter(
                (sequence): sequence is number => typeof sequence === "number",
              )),
            ...(incoming.sequences ?? [incoming.sequence]),
          ],
        }),
        onFlush: (updates) => flushes.push([...updates]),
      });

      queue.enqueue(output("A1", { sequence: 1 }));
      queue.enqueue(
        output("B1", {
          conversationId: "conversation-b",
          itemId: "item-b",
          sequence: 2,
        }),
      );
      queue.enqueue(output("A2", { sequence: 3 }));
      scheduler.runNextTimeout();

      expect(flushes.length).toBe(1);
      expect(flushes[0]?.map((update) => update.conversationId).join(",")).toBe(
        "conversation-a,conversation-b",
      );
      expect(flushes[0]?.[0]?.delta).toBe("A1A2");
      expect(flushes[0]?.[0]?.sequences?.join(",")).toBe("1,3");
      expect(flushes[0]?.[1]?.delta).toBe("B1");
    });

    test("uses one non-resetting 50ms timeout and exact bounded coalescing", () => {
      const scheduler = new ManualCommandOutputScheduler();
      const flushed: string[] = [];
      const queue = new CodexCommandOutputQueue<SequencedOutput>({
        scheduler,
        maxBufferedChars: 5,
        onFlush: (updates) => flushed.push(updates[0]?.delta ?? "missing"),
      });

      queue.enqueue(output("1234"));
      queue.enqueue(output("567"));

      expect(scheduler.timeoutCount).toBe(1);
      expect(scheduler.nextDelayMs).toBe(50);
      scheduler.runNextTimeout();
      expect(flushed.join(",")).toBe("34567");
    });

    test("retains every command key until the scheduled batch even above aggregate byte and key thresholds", () => {
      const scheduler = new ManualCommandOutputScheduler();
      const flushes: SequencedOutput[][] = [];
      const queue = new CodexCommandOutputQueue<SequencedOutput>({
        scheduler,
        onFlush: (updates) => flushes.push([...updates]),
      });
      const updates = Array.from({ length: 1500 }, (_, index) =>
        output("汉".repeat(3000), { itemId: `item-${index}` }),
      );
      for (const update of updates) queue.enqueue(update);
      expect(flushes).toEqual([]);
      expect(scheduler.timeoutCount).toBe(1);
      scheduler.runNextTimeout();
      expect(flushes).toEqual([updates]);
    });

    test("coalesces repeated notifications without an early update-count flush", () => {
      const scheduler = new ManualCommandOutputScheduler();
      const flushes: SequencedOutput[][] = [];
      const queue = new CodexCommandOutputQueue<SequencedOutput>({
        scheduler,
        maxBufferedChars: 5,
        onFlush: (updates) => flushes.push([...updates]),
      });
      for (let sequence = 1; sequence <= 20000; sequence += 1)
        queue.enqueue(output("x", { sequence }));
      expect(flushes).toEqual([]);
      scheduler.runNextTimeout();
      expect(flushes).toEqual([[output("xxxxx", { sequence: 20000 })]]);
    });

    test("treats an empty delta as queued work", () => {
      const scheduler = new ManualCommandOutputScheduler();
      const flushed: string[] = [];
      const queue = new CodexCommandOutputQueue<SequencedOutput>({
        scheduler,
        onFlush: (updates) => flushed.push(updates[0]?.delta ?? "missing"),
      });

      queue.enqueue(output(""));
      expect(scheduler.timeoutCount).toBe(1);
      scheduler.runNextTimeout();

      expect(flushed.length).toBe(1);
      expect(flushed[0]).toBe("");
    });

    test("manual flush leaves the scheduled timeout available for its original batch", () => {
      const scheduler = new ManualCommandOutputScheduler();
      const flushed: string[] = [];
      const queue = new CodexCommandOutputQueue<SequencedOutput>({
        scheduler,
        onFlush: (updates) => flushed.push(updates[0]?.delta ?? "missing"),
      });

      queue.enqueue(output("first"));
      queue.flushNow();
      expect(scheduler.timeoutCount).toBe(1);
      queue.enqueue(output("second"));
      expect(scheduler.timeoutCount).toBe(1);
      scheduler.runNextTimeout();

      expect(flushed.join(",")).toBe("first,second");
    });

    test("scoped teardown preserves unrelated work and cancels only the last removal", () => {
      const scheduler = new ManualCommandOutputScheduler();
      const flushed: string[] = [];
      const queue = new CodexCommandOutputQueue<SequencedOutput>({
        scheduler,
        onFlush: (updates) => {
          flushed.push(updates.map((update) => update.conversationId).join(","));
        },
      });

      queue.enqueue(output("a"));
      queue.enqueue(
        output("b", {
          conversationId: "conversation-b",
          itemId: "item-b",
        }),
      );
      queue.discardConversation("conversation-a");
      expect(scheduler.timeoutCount).toBe(1);
      scheduler.runNextTimeout();
      expect(flushed.join(",")).toBe("conversation-b");

      queue.enqueue(output("a2"));
      queue.discardConversation("conversation-a");
      expect(scheduler.timeoutCount).toBe(0);
    });

    test("dispose cancels the timeout and drops all buffered output", () => {
      const scheduler = new ManualCommandOutputScheduler();
      let flushCalls = 0;
      const queue = new CodexCommandOutputQueue<SequencedOutput>({
        scheduler,
        onFlush: () => {
          flushCalls += 1;
        },
      });

      queue.enqueue(output("pending"));
      queue.dispose();

      expect(scheduler.timeoutCount).toBe(0);
      expect(flushCalls).toBe(0);
    });

    test("clears the batch before callback so reentrant enqueue schedules a new timeout", () => {
      const scheduler = new ManualCommandOutputScheduler();
      const flushed: string[] = [];
      const queue = new CodexCommandOutputQueue<SequencedOutput>({
        scheduler,
        onFlush: (updates) => {
          const delta = updates[0]?.delta ?? "missing";
          flushed.push(delta);
          if (delta === "first") queue.enqueue(output("second"));
        },
      });

      queue.enqueue(output("first"));
      scheduler.runNextTimeout();
      expect(scheduler.timeoutCount).toBe(1);
      scheduler.runNextTimeout();

      expect(flushed.join(",")).toBe("first,second");
    });
  });
});

describe("codex file change stream", () => {
  const THREAD_ID = "thread_c06";
  const TURN_ID = "turn_c06";
  type FileChangeItem = Extract<
    ThreadItem,
    {
      type: "fileChange";
    }
  >;
  type McpToolCallItem = Extract<
    ThreadItem,
    {
      type: "mcpToolCall";
    }
  >;
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
      model: null,
      reasoningEffort: null,
      id: THREAD_ID,
      environments: null,
      extra: null,
      sessionId: "session_c06",
      forkedFromId: null,
      attachedToThreadId: null,
      parentThreadId: null,
      preview: "C-06 file stream fixture",
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
      cwd: "/workspace/project",
      cliVersion: "fixture",
      originator: null,
      source: "unknown",
      canAcceptDirectInput: true,
      threadSource: null,
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: "C-06 file stream fixture",
      daybreakEnabled: null,
      turns: [
        {
          rootTurnId: null,
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
      hostId: "local",
      ...{
        turnParamsById: { [TURN_ID]: buildTurnParams() },
      },
    });
  }

  interface CanonicalTurnFixture {
    readonly turnId: string | null;
    readonly status?: CodexCanonicalTurnState["status"];
    readonly items?: readonly CodexCanonicalItem[];
    readonly turnStartedAtMs?: number | null;
    readonly firstWork?: number | null;
    readonly hookRuns?: CodexCanonicalTurnState["hookRuns"];
  }

  function withCanonicalTurns(
    state: CodexCanonicalConversationState,
    fixtures: readonly CanonicalTurnFixture[],
  ): CodexCanonicalConversationState {
    const template = state.turns[0];
    if (!template) throw new Error("Missing canonical turn fixture template");

    return {
      ...state,
      turns: fixtures.map((fixture) => ({
        ...template,
        turnId: fixture.turnId,
        status: fixture.status ?? "inProgress",
        error: null,
        items: fixture.items ?? [],
        turnStartedAtMs: fixture.turnStartedAtMs ?? null,
        ...("firstWork" in fixture ? { firstTurnWorkItemStartedAtMs: fixture.firstWork } : {}),
        ...("hookRuns" in fixture ? { hookRuns: fixture.hookRuns } : {}),
      })),
    };
  }

  function rawTurn(
    items: readonly unknown[] = [],
    overrides: Partial<CodexFileChangeRawTurn> = {},
  ): CodexFileChangeRawTurn {
    return {
      turnId: TURN_ID,
      status: "inProgress",
      hasError: false,
      itemCount: items.length,
      turnStartedAtMs: 1000,
      firstTurnWorkItemStartedAtMs: 2000,
      ...overrides,
      items,
    };
  }

  function change(path: string, diff = `diff for ${path}`): FileUpdateChange {
    return {
      path,
      kind: { type: "update", move_path: null },
      diff,
    };
  }

  function fileChange(
    id: string,
    changes: FileUpdateChange[],
    status: FileChangeItem["status"] = "inProgress",
  ): FileChangeItem {
    return { type: "fileChange", id, changes, status };
  }

  function mcpToolCall(id: string): McpToolCallItem {
    return {
      type: "mcpToolCall",
      environmentId: null,
      id,
      server: "fixture-server",
      tool: "fixture-tool",
      status: "inProgress",
      arguments: {},
      appContext: null,
      mcpAppUi: null,
      pluginId: null,
      readOnlyHint: null,
      result: null,
      error: null,
      durationMs: null,
    };
  }

  function patchUpdate(
    changes: FileUpdateChange[],
    overrides: Partial<{
      conversationId: string;
      turnId: string | null;
      itemId: string;
    }> = {},
  ) {
    return {
      conversationId: THREAD_ID,
      turnId: TURN_ID,
      itemId: "patch-item",
      changes,
      ...overrides,
    };
  }

  function progressUpdate(
    overrides: Partial<{
      conversationId: string;
      turnId: string | null;
      itemId: string;
      message: string;
    }> = {},
  ) {
    return {
      conversationId: THREAD_ID,
      turnId: TURN_ID,
      itemId: "mcp-item",
      message: "still working",
      ...overrides,
    };
  }

  describe("Codex canonical file-change stream", () => {
    test("keeps foreign, zero-turn, and ordinary missing-turn states unchanged", () => {
      const state = buildState([fileChange("patch-item", [change("old.ts")])]);
      const foreign = reduceCodexConversationFileChangePatch(
        state,
        patchUpdate([], { conversationId: "foreign-thread" }),
        {
          now: () => {
            throw new Error("foreign updates must not read the clock");
          },
        },
      );
      const noTurnsState: CodexCanonicalConversationState = {
        ...state,
        turns: [],
      };
      const noTurns = reduceCodexConversationFileChangePatch(noTurnsState, patchUpdate([]), {
        now: () => {
          throw new Error("zero-turn updates must not read the clock");
        },
      });
      const missingPatch = reduceCodexConversationFileChangePatch(
        state,
        patchUpdate([], { turnId: "missing-turn" }),
        {
          now: () => {
            throw new Error("missing-turn updates must not read the clock");
          },
        },
      );
      const missingProgress = reduceCodexConversationMcpToolCallProgress(
        state,
        progressUpdate({ turnId: "missing-turn" }),
        {
          now: () => {
            throw new Error("missing progress must not read the clock");
          },
        },
      );

      expect(foreign.disposition).toBe("foreignConversation");
      expect(foreign.state).toBe(state);
      expect(foreign.stateChanged).toBe(false);
      expect(noTurns.disposition).toBe("noTurns");
      expect(noTurns.state).toBe(noTurnsState);
      expect(noTurns.stateChanged).toBe(false);
      expect(missingPatch.disposition).toBe("missingTurn");
      expect(missingPatch.state).toBe(state);
      expect(missingPatch.stateChanged).toBe(false);
      expect(missingProgress.disposition).toBe("missingTurn");
      expect(missingProgress.state).toBe(state);
      expect(missingProgress.stateChanged).toBe(false);
    });

    test("patches the newest duplicate turn reference", () => {
      const oldestChanges = [change("oldest.ts")];
      const newestChanges = [change("newest.ts")];
      const oldestItem = fileChange("patch-item", oldestChanges);
      const newestItem = fileChange("patch-item", newestChanges);
      const turns = [
        rawTurn([oldestItem], { turnId: "duplicate" }),
        rawTurn([], { turnId: "between" }),
        rawTurn([newestItem], { turnId: "duplicate" }),
      ];
      const incoming = [change("incoming.ts")];
      const result = reduceCodexFileChangePatchRawTurns(
        turns,
        patchUpdate(incoming, { turnId: "duplicate" }),
        {
          now: () => {
            throw new Error("existing clocks must be preserved");
          },
        },
      );

      expect(result.disposition).toBe("applied");
      expect(result.resolutionKind).toBe("existing");
      expect(result.turnIndex).toBe(2);
      expect(result.rawItem?.changes === incoming).toBe(true);
      expect(oldestItem.changes === oldestChanges).toBe(true);
      expect(newestItem.changes === newestChanges).toBe(true);
      expect(turns[0]?.items[0] === oldestItem).toBe(true);
    });

    test("patch alone rebinds a live null placeholder and reads two clocks independently", () => {
      const source = rawTurn([], {
        turnId: null,
        turnStartedAtMs: null,
        firstTurnWorkItemStartedAtMs: null,
      });
      const emptyChanges: FileUpdateChange[] = [];
      const clockValues = [10001, 10002];
      let clockCalls = 0;
      const patch = reduceCodexFileChangePatchRawTurns(
        [source],
        patchUpdate(emptyChanges, { turnId: "bound-turn" }),
        {
          now: () => {
            const value = clockValues[clockCalls];
            clockCalls += 1;
            if (value === undefined) throw new Error("Unexpected clock call");
            return value;
          },
        },
      );
      const progress = reduceCodexMcpToolCallProgressRawTurns(
        [source],
        progressUpdate({ turnId: "bound-turn" }),
        {
          now: () => {
            throw new Error("MCP progress cannot bind a live null placeholder");
          },
        },
      );

      expect(patch.resolutionKind).toBe("reboundInProgressPlaceholder");
      expect(patch.turn?.turnId).toBe("bound-turn");
      expect(patch.turn?.status).toBe("inProgress");
      expect(patch.turn?.turnStartedAtMs).toBe(10001);
      expect(patch.turn?.firstTurnWorkItemStartedAtMs).toBe(10002);
      expect(patch.itemMutation).toBe("appended");
      expect(patch.rawItem?.status).toBe("inProgress");
      expect(patch.rawItem?.changes === emptyChanges).toBe(true);
      expect(clockCalls).toBe(2);
      expect(progress.disposition).toBe("missingTurn");
      expect(progress.stateChanged).toBe(false);
    });

    test("patch and MCP progress both rebind the sole completed empty placeholder", () => {
      const source = rawTurn([], {
        turnId: null,
        status: "completed",
        turnStartedAtMs: null,
        firstTurnWorkItemStartedAtMs: null,
      });
      const patchClock = [20001, 20002];
      const patch = reduceCodexFileChangePatchRawTurns(
        [source],
        patchUpdate([change("created.ts")], { turnId: "patch-turn" }),
        {
          now: () => {
            const value = patchClock.shift();
            if (value === undefined) throw new Error("Unexpected patch clock call");
            return value;
          },
        },
      );
      let progressClockCalls = 0;
      const progress = reduceCodexMcpToolCallProgressRawTurns(
        [source],
        progressUpdate({ turnId: "progress-turn" }),
        {
          now: () => {
            progressClockCalls += 1;
            return 30001;
          },
        },
      );

      expect(patch.resolutionKind).toBe("reboundCompletedEmptyPlaceholder");
      expect(patch.turn?.turnId).toBe("patch-turn");
      expect(patch.turn?.status).toBe("inProgress");
      expect(patch.turn?.turnStartedAtMs).toBe(20001);
      expect(patch.turn?.firstTurnWorkItemStartedAtMs).toBe(20002);
      expect(progress.resolutionKind).toBe("reboundCompletedEmptyPlaceholder");
      expect(progress.turn?.turnId).toBe("progress-turn");
      expect(progress.turn?.status).toBe("inProgress");
      expect(progress.turn?.turnStartedAtMs).toBe(30001);
      expect(progress.turn?.firstTurnWorkItemStartedAtMs).toBe(null);
      expect(progress.turn?.items === source.items).toBe(true);
      expect(progress.matchedItemIndex).toBe(-1);
      expect(progress.stateChanged).toBe(true);
      expect(progressClockCalls).toBe(1);
    });

    test("updates the reverse-last exact file item while preserving terminal state and extensions", () => {
      const first = fileChange("shared", [change("first.ts")]);
      const wrongType: ThreadItem = {
        questions: null,
        type: "agentMessage",
        moderation: null,
        id: "shared",
        text: "must not mask the exact item",
        phase: null,
        memoryCitation: null,
        delivery: null,
      };
      const last = {
        ...fileChange("shared", [change("last.ts")], "declined"),
        extensionSentinel: { retained: true },
      } as FileChangeItem & {
        readonly extensionSentinel: {
          readonly retained: true;
        };
      };
      const source = rawTurn([first, wrongType, last], {
        status: "failed",
        turnStartedAtMs: 40001,
        firstTurnWorkItemStartedAtMs: 40002,
      });
      const incoming = [change("replacement.ts")];
      const result = reduceCodexFileChangePatchRawTurns(
        [source],
        patchUpdate(incoming, { itemId: "shared" }),
        {
          now: () => {
            throw new Error("ordinary patch updates must preserve clocks");
          },
        },
      );
      const resultItem = result.rawItem as typeof last | null;

      expect(result.itemIndex).toBe(2);
      expect(result.itemMutation).toBe("updatedExact");
      expect(resultItem?.status).toBe("declined");
      expect(resultItem?.extensionSentinel === last.extensionSentinel).toBe(true);
      expect(resultItem?.changes === incoming).toBe(true);
      expect(result.turn?.items[0] === first).toBe(true);
      expect(result.turn?.items[1] === wrongType).toBe(true);
      expect(result.turn?.status).toBe("failed");
      expect(result.turn?.turnStartedAtMs).toBe(40001);
      expect(result.turn?.firstTurnWorkItemStartedAtMs).toBe(40002);
      expect(last.changes[0]?.path).toBe("last.ts");
    });

    test("replaces the first same-ID wrong type when no exact file item exists", () => {
      const firstWrongType: ThreadItem = {
        questions: null,
        type: "agentMessage",
        moderation: null,
        id: "shared",
        text: "replace this slot",
        phase: null,
        memoryCitation: null,
        delivery: null,
      };
      const middle: ThreadItem = {
        type: "plan",
        id: "middle",
        text: "retain this slot",
      };
      const laterWrongType: ThreadItem = {
        type: "plan",
        id: "shared",
        text: "retain the later duplicate",
      };
      const incoming: FileUpdateChange[] = [];
      const result = reduceCodexFileChangePatchRawTurns(
        [rawTurn([firstWrongType, middle, laterWrongType])],
        patchUpdate(incoming, { itemId: "shared" }),
        {
          now: () => {
            throw new Error("existing first-work time must suppress the clock");
          },
        },
      );

      expect(result.itemIndex).toBe(0);
      expect(result.itemMutation).toBe("replacedSameId");
      expect(result.rawItem?.id).toBe("shared");
      expect(result.rawItem?.status).toBe("inProgress");
      expect(result.rawItem?.changes === incoming).toBe(true);
      expect(result.turn?.items[1] === middle).toBe(true);
      expect(result.turn?.items[2] === laterWrongType).toBe(true);
    });

    test("preserves identity for the same changes array but treats a new array as a change", () => {
      const changes = [change("same.ts")];
      const existing = fileChange("patch-item", changes, "completed");
      const source = rawTurn([existing], { hookRuns: [] });
      const same = reduceCodexFileChangePatchRawTurns([source], patchUpdate(changes), {
        now: () => {
          throw new Error("identity updates must not read the clock");
        },
      });
      const structurallyEqual = [changes[0]!];
      const changed = reduceCodexFileChangePatchRawTurns([source], patchUpdate(structurallyEqual), {
        now: () => {
          throw new Error("ordinary updates must not read the clock");
        },
      });

      expect(same.rawItem).toBe(existing);
      expect(same.turn).toBe(source);
      expect(same.stateChanged).toBe(false);
      expect(changed.rawItem === existing).toBe(false);
      expect(changed.rawItem?.changes === structurallyEqual).toBe(true);
      expect(changed.turn === source).toBe(false);
      expect(changed.stateChanged).toBe(true);
      expect(existing.changes === changes).toBe(true);
    });

    test("keeps ordinary MCP progress content-identical after collection repair", () => {
      const first = mcpToolCall("mcp-item");
      const last = { ...mcpToolCall("mcp-item"), tool: "newest-tool" };
      const wrongType: ThreadItem = {
        questions: null,
        type: "agentMessage",
        moderation: null,
        id: "mcp-item",
        text: "does not mask MCP",
        phase: null,
        memoryCitation: null,
        delivery: null,
      };
      const raw = rawTurn([first, last, wrongType], {
        firstTurnWorkItemStartedAtMs: null,
        hookRuns: [],
      });
      const rawResult = reduceCodexMcpToolCallProgressRawTurns([raw], progressUpdate(), {
        now: () => {
          throw new Error("ordinary progress must not read the clock");
        },
      });
      const state = withCanonicalTurns(buildState(), [
        {
          turnId: TURN_ID,
          items: [first, last, wrongType],
          hookRuns: [],
        },
      ]);
      const canonical = reduceCodexConversationMcpToolCallProgress(state, progressUpdate(), {
        now: () => {
          throw new Error("ordinary canonical progress must not read the clock");
        },
      });

      expect(rawResult.disposition).toBe("applied");
      expect(rawResult.matchedItemIndex).toBe(1);
      expect(rawResult.turn).toBe(raw);
      expect(rawResult.stateChanged).toBe(false);
      expect(rawResult.turn?.firstTurnWorkItemStartedAtMs).toBe(null);
      expect(canonical.disposition).toBe("applied");
      expect(canonical.state).toBe(state);
      expect(canonical.stateChanged).toBe(false);
      expect(canonical.state.turns[0]?.firstTurnWorkItemStartedAtMs === undefined).toBe(true);
    });

    test("repairs missing turn collections before ordinary MCP progress", () => {
      const raw = rawTurn([], {
        firstTurnWorkItemStartedAtMs: null,
      });
      const firstRaw = reduceCodexMcpToolCallProgressRawTurns([raw], progressUpdate(), {
        now: () => {
          throw new Error("collection repair must not read the clock");
        },
      });
      const repairedRaw = firstRaw.turn;
      if (!repairedRaw) throw new Error("Missing repaired raw turn");
      const secondRaw = reduceCodexMcpToolCallProgressRawTurns([repairedRaw], progressUpdate(), {
        now: () => {
          throw new Error("repaired progress must not read the clock");
        },
      });

      const state = withCanonicalTurns(buildState(), [
        {
          turnId: TURN_ID,
          items: [],
        },
      ]);
      const firstCanonical = reduceCodexConversationMcpToolCallProgress(state, progressUpdate(), {
        now: () => {
          throw new Error("canonical collection repair must not read the clock");
        },
      });
      const secondCanonical = reduceCodexConversationMcpToolCallProgress(
        firstCanonical.state,
        progressUpdate(),
        {
          now: () => {
            throw new Error("repaired canonical progress must not read the clock");
          },
        },
      );

      expect(firstRaw.stateChanged).toBe(true);
      expect(firstRaw.turn === raw).toBe(false);
      expect(firstRaw.turn?.hookRuns?.length ?? -1).toBe(0);
      expect(firstRaw.turn?.firstTurnWorkItemStartedAtMs).toBe(null);
      expect(secondRaw.stateChanged).toBe(false);
      expect(secondRaw.turn).toBe(repairedRaw);
      expect(firstCanonical.stateChanged).toBe(true);
      expect(firstCanonical.state === state).toBe(false);
      expect(firstCanonical.state.turns[0]?.hookRuns?.length ?? -1).toBe(0);
      expect(secondCanonical.stateChanged).toBe(false);
      expect(secondCanonical.state).toBe(firstCanonical.state);
    });

    test("routes patch and completed-placeholder progress through canonical replay", () => {
      const oldChanges = [change("before.ts")];
      const file = {
        ...fileChange("patch-item", oldChanges, "failed"),
        extensionSentinel: "preserve-me",
      } as FileChangeItem & {
        readonly extensionSentinel: string;
      };
      const existing = withCanonicalTurns(buildState(), [
        {
          turnId: TURN_ID,
          items: [file],
          turnStartedAtMs: 50001,
          firstWork: 50002,
        },
      ]);
      const incoming = [change("after.ts")];
      const patchNotification = {
        method: "item/fileChange/patchUpdated",
        params: {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          itemId: "patch-item",
          changes: incoming,
        },
      } satisfies ServerNotification;
      const patched = reduceCodexConversationEventWithEffects(
        existing,
        {
          type: "notification",
          notification: patchNotification,
        },
        {
          now: () => {
            throw new Error("existing replay clocks must be preserved");
          },
        },
      );
      const patchedItem = patched.state.turns[0]?.items[0] as typeof file;

      expect(patched.state === existing).toBe(false);
      expect(patched.effects.length).toBe(0);
      expect(patchedItem.changes === incoming).toBe(true);
      expect(patchedItem.status).toBe("failed");
      expect(patchedItem.extensionSentinel).toBe("preserve-me");
      expect(patched.state.threadRuntimeStatus).toBe(existing.threadRuntimeStatus);
      expect(patched.state.updatedAt).toBe(existing.updatedAt);
      expect(patched.state.updatedAt).toBe(2000);
      expect(patched.state.turns[0]?.turnStartedAtMs).toBe(50001);
      expect(patched.state.turns[0]?.firstTurnWorkItemStartedAtMs).toBe(50002);
      expect(patched.state.turns[0]?.hookRuns?.length ?? -1).toBe(0);
      const placeholder = withCanonicalTurns(buildState(), [
        {
          turnId: null,
          status: "completed",
          items: [],
          turnStartedAtMs: null,
        },
      ]);
      let clockCalls = 0;
      const progressNotification = {
        method: "item/mcpToolCall/progress",
        params: {
          threadId: THREAD_ID,
          turnId: "bound-progress-turn",
          itemId: "mcp-item",
          message: "working",
        },
      } satisfies ServerNotification;
      const rebound = reduceCodexConversationEvent(
        placeholder,
        {
          type: "notification",
          notification: progressNotification,
        },
        {
          now: () => {
            clockCalls += 1;
            return 60001;
          },
        },
      );

      expect(rebound === placeholder).toBe(false);
      expect(rebound.turns[0]?.turnId).toBe("bound-progress-turn");
      expect(rebound.turns[0]?.status).toBe("inProgress");
      expect(rebound.turns[0]?.turnStartedAtMs).toBe(60001);
      expect(rebound.turns[0]?.firstTurnWorkItemStartedAtMs === undefined).toBe(true);
      expect(rebound.turns[0]?.items === placeholder.turns[0]?.items).toBe(true);
      expect(rebound.turns[0]?.hookRuns?.length ?? -1).toBe(0);
      expect(clockCalls).toBe(1);
    });

    test("treats file output as true canonical-state identity", () => {
      const state = buildState([fileChange("patch-item", [change("state.ts")])]);
      const notification = {
        method: "item/fileChange/outputDelta",
        params: {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          itemId: "patch-item",
          delta: "legacy textual output",
        },
      } satisfies ServerNotification;
      const result = reduceCodexConversationEventWithEffects(
        state,
        {
          type: "notification",
          notification,
        },
        {
          now: () => {
            throw new Error("file output must not read the state clock");
          },
        },
      );

      expect(result.state).toBe(state);
      expect(result.effects.length).toBe(0);
    });

    test("maps generated notifications and rejects malformed parser inputs", () => {
      const changes: FileUpdateChange[] = [];
      const patch = {
        method: "item/fileChange/patchUpdated",
        params: {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          itemId: "patch-item",
          changes,
        },
      } satisfies ServerNotification;
      const output = {
        method: "item/fileChange/outputDelta",
        params: {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          itemId: "patch-item",
          delta: "output",
        },
      } satisfies ServerNotification;
      const progress = {
        method: "item/mcpToolCall/progress",
        params: {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          itemId: "mcp-item",
          message: "working",
        },
      } satisfies ServerNotification;

      expect(isCodexFileChangePatchUpdatedNotification(patch)).toBe(true);
      expect(isCodexFileChangeOutputDeltaNotification(output)).toBe(true);
      expect(isCodexMcpToolCallProgressNotification(progress)).toBe(true);
      expect(isCodexMcpToolCallProgressNotification(patch)).toBe(false);

      const mappedPatch = toCodexFileChangePatchUpdate(patch, null);
      const mappedProgress = toCodexMcpToolCallProgressUpdate(progress, null);
      expect(mappedPatch.turnId).toBe(null);
      expect(mappedPatch.changes === changes).toBe(true);
      expect(mappedProgress.turnId).toBe(null);
      expect(mappedProgress.message).toBe("working");
    });
  });
});

describe("codex frame text delta queue", () => {
  class ManualFrameTextDeltaScheduler implements CodexFrameTextDeltaScheduler {
    canAnimate = true;
    private nextHandle = 1;
    private readonly frames = new Map<number, () => void>();
    private readonly timeouts = new Map<number, () => void>();

    readonly canUseAnimationFrame = (): boolean => this.canAnimate;

    readonly scheduleAnimationFrame = (callback: () => void): (() => void) => {
      const handle = this.nextHandle;
      this.nextHandle += 1;
      this.frames.set(handle, callback);
      return () => {
        this.frames.delete(handle);
      };
    };

    readonly scheduleTimeout = (callback: () => void): (() => void) => {
      const handle = this.nextHandle;
      this.nextHandle += 1;
      this.timeouts.set(handle, callback);
      return () => {
        this.timeouts.delete(handle);
      };
    };

    runNextFrame(): void {
      const entry = this.frames.entries().next().value as [number, () => void] | undefined;
      if (!entry) throw new Error("No animation frame is scheduled");
      this.frames.delete(entry[0]);
      entry[1]();
    }

    runNextTimeout(): void {
      const entry = this.timeouts.entries().next().value as [number, () => void] | undefined;
      if (!entry) throw new Error("No timeout is scheduled");
      this.timeouts.delete(entry[0]);
      entry[1]();
    }

    get frameCount(): number {
      return this.frames.size;
    }

    get timeoutCount(): number {
      return this.timeouts.size;
    }
  }

  interface SequencedDelta extends CodexFrameTextDeltaUpdate {
    readonly sequence: number;
  }

  function delta(deltaText: string, overrides: Partial<SequencedDelta> = {}): SequencedDelta {
    return {
      conversationId: "conversation-a",
      turnId: "turn-a",
      itemId: "item-a",
      target: { type: "agentMessage" },
      delta: deltaText,
      sequence: 1,
      ...overrides,
    };
  }

  describe("CodexFrameTextDeltaQueue", () => {
    test("builds the exact raw colon-joined buffer key", () => {
      expect(buildCodexFrameTextDeltaKey(delta("x"))).toBe(
        "conversation-a:turn-a:item-a:agentMessage",
      );
      expect(
        buildCodexFrameTextDeltaKey(
          delta("x", {
            turnId: null,
            target: { type: "reasoningContent", contentIndex: 2 },
          }),
        ),
      ).toBe("conversation-a:null:item-a:reasoningContent:2");
    });

    test("coalesces exact keys without moving Map order and retains newest metadata", () => {
      const scheduler = new ManualFrameTextDeltaScheduler();
      const flushes: SequencedDelta[][] = [];
      const queue = new CodexFrameTextDeltaQueue<SequencedDelta>({
        scheduler,
        onFlush: (updates) => flushes.push([...updates]),
      });

      queue.enqueue(delta("A1", { sequence: 1 }));
      queue.enqueue(
        delta("B1", {
          conversationId: "conversation-b",
          itemId: "item-b",
          sequence: 2,
        }),
      );
      queue.enqueue(delta("A2", { sequence: 3 }));
      scheduler.runNextFrame();

      expect(flushes.length).toBe(1);
      expect(flushes[0]?.map((update) => update.conversationId).join(",")).toBe(
        "conversation-a,conversation-b",
      );
      expect(flushes[0]?.[0]?.delta).toBe("A1A2");
      expect(flushes[0]?.[0]?.sequence).toBe(3);
      expect(flushes[0]?.[1]?.delta).toBe("B1");
    });

    test("isolates targets and reasoning indexes in the exact key", () => {
      const scheduler = new ManualFrameTextDeltaScheduler();
      const flushed: SequencedDelta[] = [];
      const queue = new CodexFrameTextDeltaQueue<SequencedDelta>({
        scheduler,
        onFlush: (updates) => flushed.push(...updates),
      });

      queue.enqueue(delta("agent"));
      queue.enqueue(delta("plan", { target: { type: "plan" } }));
      queue.enqueue(
        delta("summary-0", {
          target: { type: "reasoningSummary", summaryIndex: 0 },
        }),
      );
      queue.enqueue(
        delta("summary-1", {
          target: { type: "reasoningSummary", summaryIndex: 1 },
        }),
      );
      queue.enqueue(
        delta("content-0", {
          target: { type: "reasoningContent", contentIndex: 0 },
        }),
      );
      scheduler.runNextFrame();

      expect(flushed.length).toBe(5);
      expect(flushed.map((update) => update.delta).join("|")).toBe(
        "agent|plan|summary-0|summary-1|content-0",
      );
    });

    test("slices every visible key by 24 JavaScript UTF-16 code units", () => {
      const scheduler = new ManualFrameTextDeltaScheduler();
      const chunks: string[] = [];
      const queue = new CodexFrameTextDeltaQueue<SequencedDelta>({
        scheduler,
        onFlush: (updates) => chunks.push(updates[0]?.delta ?? ""),
      });
      const text = `${"a".repeat(23)}😀z`;

      queue.enqueue(delta(text));
      scheduler.runNextFrame();
      scheduler.runNextFrame();

      expect(chunks.length).toBe(2);
      expect(chunks[0]?.length).toBe(24);
      expect(chunks[0]?.charCodeAt(23)).toBe(0xd83d);
      expect(chunks[1]?.charCodeAt(0)).toBe(0xde00);
      expect(chunks.join("")).toBe(text);
    });

    test("uses one delayed full flush when animation frames are unavailable", () => {
      const scheduler = new ManualFrameTextDeltaScheduler();
      scheduler.canAnimate = false;
      const chunks: string[] = [];
      const queue = new CodexFrameTextDeltaQueue<SequencedDelta>({
        scheduler,
        onFlush: (updates) => chunks.push(updates[0]?.delta ?? ""),
      });

      queue.enqueue(delta("x".repeat(100)));
      expect(scheduler.frameCount).toBe(0);
      expect(scheduler.timeoutCount).toBe(1);
      scheduler.runNextTimeout();

      expect(chunks.length).toBe(1);
      expect(chunks[0]?.length).toBe(100);
      expect(scheduler.timeoutCount).toBe(0);
    });

    test("treats an empty delta as queued work that flushes before completion", () => {
      const scheduler = new ManualFrameTextDeltaScheduler();
      const flushed: string[] = [];
      let callbackCalls = 0;
      const queue = new CodexFrameTextDeltaQueue<SequencedDelta>({
        scheduler,
        onFlush: (updates) => flushed.push(updates[0]?.delta ?? "missing"),
      });

      queue.enqueue(delta(""));
      const deferred = queue.drainBefore(() => {
        callbackCalls += 1;
      });

      expect(deferred).toBe(false);
      expect(flushed.length).toBe(1);
      expect(flushed[0]).toBe("");
      expect(callbackCalls).toBe(0);
      expect(scheduler.frameCount).toBe(0);
    });

    test("uses the global buffered length for cross-conversation drain", () => {
      const scheduler = new ManualFrameTextDeltaScheduler();
      const order: string[] = [];
      const terminalFlags: boolean[] = [];
      const queue = new CodexFrameTextDeltaQueue<SequencedDelta>({
        scheduler,
        onFlush: (updates, context) => {
          order.push(updates.map((update) => update.conversationId).join(","));
          terminalFlags.push(context.terminalDrainCommit);
        },
      });

      queue.enqueue(delta("a".repeat(13)));
      queue.enqueue(
        delta("b".repeat(13), {
          conversationId: "conversation-b",
          itemId: "item-b",
        }),
      );
      const deferred = queue.drainBefore(() => order.push("completed"));

      expect(deferred).toBe(true);
      expect(order.length).toBe(0);
      scheduler.runNextFrame();
      expect(order.join("|")).toBe("conversation-a,conversation-b|completed");
      expect(terminalFlags.join(",")).toBe("true");
    });

    test("shares one eight-frame drain budget across FIFO callbacks", () => {
      const scheduler = new ManualFrameTextDeltaScheduler();
      const chunks: number[] = [];
      const callbacks: string[] = [];
      const queue = new CodexFrameTextDeltaQueue<SequencedDelta>({
        scheduler,
        onFlush: (updates) => chunks.push(updates[0]?.delta.length ?? 0),
      });

      queue.enqueue(delta("x".repeat(193)));
      expect(queue.drainBefore(() => callbacks.push("first"))).toBe(true);
      scheduler.runNextFrame();
      expect(queue.drainBefore(() => callbacks.push("second"))).toBe(true);
      while (scheduler.frameCount > 0) {
        scheduler.runNextFrame();
      }

      expect(chunks.length).toBe(8);
      expect(chunks.reduce((total, chunk) => total + chunk, 0)).toBe(193);
      expect(callbacks.join(",")).toBe("first,second");
    });

    test("retains all terminal callbacks until the shared frame drain finishes", () => {
      const scheduler = new ManualFrameTextDeltaScheduler();
      const completed: number[] = [];
      const queue = new CodexFrameTextDeltaQueue<SequencedDelta>({ scheduler, onFlush: () => {} });
      queue.enqueue(delta("x".repeat(100)));
      for (let index = 0; index < 1100; index += 1)
        expect(queue.drainBefore(() => completed.push(index))).toBe(true);
      expect(completed).toEqual([]);
      while (scheduler.frameCount > 0) scheduler.runNextFrame();
      expect(completed).toEqual(Array.from({ length: 1100 }, (_, index) => index));
    });

    test("disposal drops pending buffers and terminal callbacks", () => {
      const scheduler = new ManualFrameTextDeltaScheduler();
      let callbackCalls = 0;
      let flushCalls = 0;
      const queue = new CodexFrameTextDeltaQueue<SequencedDelta>({
        scheduler,
        onFlush: () => {
          flushCalls += 1;
        },
      });

      queue.enqueue(delta("x".repeat(25)));
      queue.drainBefore(() => {
        callbackCalls += 1;
      });
      queue.dispose();

      expect(scheduler.frameCount).toBe(0);
      expect(flushCalls).toBe(0);
      expect(callbackCalls).toBe(0);
    });

    test("retains all prose until a normal frame or completion drain", () => {
      const scheduler = new ManualFrameTextDeltaScheduler();
      const flushed: SequencedDelta[][] = [];
      const queue = new CodexFrameTextDeltaQueue<SequencedDelta>({
        scheduler,
        onFlush: (updates) => flushed.push([...updates]),
      });
      const updates = Array.from({ length: 1100 }, (_, index) =>
        delta("x".repeat(index === 0 ? 600000 : 4000), { itemId: `item-${index}` }),
      );
      for (const update of updates) queue.enqueue(update);
      expect(flushed).toEqual([]);
      scheduler.runNextFrame();
      expect(flushed[0]?.map((update) => update.delta.length)).toEqual(updates.map(() => 24));
      queue.flushNow();
      expect(flushed[1]?.map((update) => update.delta.length)).toEqual(
        updates.map((update) => update.delta.length - 24),
      );
    });

    test("flushes reasoning summaries in full while prose remains frame-sized", () => {
      const scheduler = new ManualFrameTextDeltaScheduler();
      const flushed: SequencedDelta[][] = [];
      const queue = new CodexFrameTextDeltaQueue<SequencedDelta>({
        scheduler,
        onFlush: (updates) => flushed.push([...updates]),
      });
      queue.enqueue(
        delta("s".repeat(100), { target: { type: "reasoningSummary", summaryIndex: 0 } }),
      );
      queue.enqueue(delta("a".repeat(100)));
      scheduler.runNextFrame();
      expect(flushed[0]?.map((update) => update.delta.length)).toEqual([100, 24]);
      queue.dispose();
    });

    test("visibility loss flushes pending prose and releases the visibility subscription", () => {
      const scheduler = new ManualFrameTextDeltaScheduler();
      let changed: (() => void) | null = null;
      const visibleScheduler: CodexFrameTextDeltaScheduler = {
        canUseAnimationFrame: scheduler.canUseAnimationFrame,
        scheduleAnimationFrame: scheduler.scheduleAnimationFrame,
        scheduleTimeout: scheduler.scheduleTimeout,
        subscribeVisibilityChange: (callback) => {
          changed = callback;
          return () => {
            changed = null;
          };
        },
      };
      const flushed: string[] = [];
      const queue = new CodexFrameTextDeltaQueue<SequencedDelta>({
        scheduler: visibleScheduler,
        onFlush: (updates) => flushed.push(...updates.map((update) => update.delta)),
      });
      queue.enqueue(delta("a".repeat(100)));
      scheduler.canAnimate = false;
      const onVisibilityChange = changed as (() => void) | null;
      if (!onVisibilityChange) throw new Error("No visibility subscription");
      onVisibilityChange();
      expect(flushed).toEqual(["a".repeat(100)]);
      expect(scheduler.frameCount).toBe(0);
      expect(changed).toBeNull();
    });

    test("scoped teardown drops only that conversation without flushing or stranding others", () => {
      const scheduler = new ManualFrameTextDeltaScheduler();
      const flushed: string[] = [];
      const callbacks: string[] = [];
      const queue = new CodexFrameTextDeltaQueue<SequencedDelta>({
        scheduler,
        onFlush: (updates) => {
          flushed.push(updates.map((update) => update.conversationId).join(","));
        },
      });

      queue.enqueue(delta("a".repeat(30)));
      queue.enqueue(
        delta("b".repeat(30), {
          conversationId: "conversation-b",
          itemId: "item-b",
        }),
      );
      expect(queue.drainBefore(() => callbacks.push("a-completed"), "conversation-a")).toBe(true);
      expect(queue.drainBefore(() => callbacks.push("b-completed"), "conversation-b")).toBe(true);

      queue.discardConversation("conversation-a");
      expect(flushed.length).toBe(0);
      expect(callbacks.length).toBe(0);
      while (scheduler.frameCount > 0) {
        scheduler.runNextFrame();
      }

      expect(flushed.join("|")).toBe("conversation-b|conversation-b");
      expect(callbacks.join(",")).toBe("b-completed");
    });

    test("terminal flush publishes the complete manager batch and cancels its frame", () => {
      const scheduler = new ManualFrameTextDeltaScheduler();
      const flushed: string[] = [];
      const terminal: boolean[] = [];
      const queue = new CodexFrameTextDeltaQueue<SequencedDelta>({
        scheduler,
        onFlush: (updates, context) => {
          flushed.push(
            updates.map((update) => `${update.conversationId}:${update.delta}`).join(","),
          );
          terminal.push(context.terminalDrainCommit);
        },
      });

      queue.enqueue(delta("a"));
      queue.enqueue(
        delta("b", {
          conversationId: "conversation-b",
          itemId: "item-b",
        }),
      );

      queue.flushNow({ terminalDrainCommit: true });
      expect(flushed).toEqual(["conversation-a:a,conversation-b:b"]);
      expect(terminal).toEqual([true]);
      expect(scheduler.frameCount).toBe(0);
    });

    test("scoped teardown completes surviving drains when it removes the last buffer", () => {
      const scheduler = new ManualFrameTextDeltaScheduler();
      const callbacks: string[] = [];
      const queue = new CodexFrameTextDeltaQueue<SequencedDelta>({
        scheduler,
        onFlush: () => {
          throw new Error("discarded text must not flush");
        },
      });

      queue.enqueue(delta("a".repeat(30)));
      expect(queue.drainBefore(() => callbacks.push("discarded"), "conversation-a")).toBe(true);
      expect(queue.drainBefore(() => callbacks.push("survivor"), "conversation-b")).toBe(true);

      queue.discardConversation("conversation-a");

      expect(scheduler.frameCount).toBe(0);
      expect(callbacks.join(",")).toBe("survivor");
    });
  });
});

describe("codex frame text delta sequence tracker", () => {
  const delta = (
    text: string,
    overrides: Partial<CodexFrameTextDeltaUpdate> = {},
  ): CodexFrameTextDeltaUpdate => ({
    conversationId: "conversation-a",
    turnId: "turn-a",
    itemId: "item-a",
    target: { type: "agentMessage" },
    delta: text,
    ...overrides,
  });

  describe("CodexFrameTextDeltaSequenceTracker", () => {
    test("attributes partial coalesced frame flushes to exact completed sequences", () => {
      const tracker = new CodexFrameTextDeltaSequenceTracker();
      tracker.track(delta("abc"), 1);
      tracker.track(delta("de"), 2);
      tracker.track(delta(""), 3);

      expect(tracker.consume([delta("abcd")])).toEqual(new Map([["conversation-a", [1]]]));
      expect(tracker.consume([delta("e")])).toEqual(new Map([["conversation-a", [2, 3]]]));
    });

    test("rejects segment and code-unit pressure before growing its arrays", () => {
      const tracker = new CodexFrameTextDeltaSequenceTracker({
        maxSegments: 3,
        maxSegmentsPerKey: 2,
        maxCodeUnits: 4,
      });
      expect(tracker.track(delta("ab"), 1)).toEqual({ accepted: true });
      expect(tracker.track(delta("c"), 2)).toEqual({ accepted: true });
      expect(tracker.track(delta("d"), 3)).toMatchObject({
        accepted: false,
        reason: "per-key-segment-count",
        trackedSegments: 2,
        trackedCodeUnits: 3,
      });
      expect(
        tracker.track(delta("de", { conversationId: "conversation-b", itemId: "item-b" }), 4),
      ).toMatchObject({ accepted: false, reason: "code-units" });
      expect(
        tracker.track(delta("d", { conversationId: "conversation-b", itemId: "item-b" }), 5),
      ).toEqual({ accepted: true });
      expect(
        tracker.track(delta("", { conversationId: "conversation-c", itemId: "item-c" }), 6),
      ).toMatchObject({ accepted: false, reason: "segment-count" });
    });

    test("conversation discard releases exact segment and code-unit admission", () => {
      const tracker = new CodexFrameTextDeltaSequenceTracker({
        maxSegments: 2,
        maxSegmentsPerKey: 2,
        maxCodeUnits: 3,
      });
      tracker.track(delta("abc"), 1);
      tracker.discardConversation("conversation-a");
      expect(
        tracker.track(delta("xyz", { conversationId: "conversation-b", itemId: "item-b" }), 2),
      ).toEqual({ accepted: true });
      expect(
        tracker.consume([delta("xyz", { conversationId: "conversation-b", itemId: "item-b" })]),
      ).toEqual(new Map([["conversation-b", [2]]]));
    });
  });
});

describe("codex frame text delta", () => {
  const THREAD_ID = "thread_c04";
  const TURN_ID = "turn_c04";

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

  function buildState(
    items: ThreadItem[] = [],
    status: "inProgress" | "completed" = "inProgress",
  ): CodexCanonicalConversationState {
    const thread: Thread = {
      model: null,
      reasoningEffort: null,
      id: THREAD_ID,
      environments: null,
      extra: null,
      sessionId: "session_c04",
      forkedFromId: null,
      attachedToThreadId: null,
      parentThreadId: null,
      preview: "C-04 delta fixture",
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
      cwd: "/workspace/project",
      cliVersion: "fixture",
      originator: null,
      source: "unknown",
      canAcceptDirectInput: true,
      threadSource: null,
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: "C-04 delta fixture",
      daybreakEnabled: null,
      turns: [
        {
          rootTurnId: null,
          id: TURN_ID,
          items,
          itemsView: "full",
          status,
          error: null,
          startedAt: 1,
          completedAt: status === "completed" ? 2 : null,
          durationMs: status === "completed" ? 1000 : null,
        },
      ],
    };
    return createCodexCanonicalConversationState(thread, {
      hostId: "local",
      ...{
        turnParamsById: { [TURN_ID]: buildTurnParams() },
      },
    });
  }

  function update(
    target: CodexFrameTextDeltaUpdate["target"],
    delta: string,
    overrides: Partial<CodexFrameTextDeltaUpdate> = {},
  ): CodexFrameTextDeltaUpdate {
    return {
      conversationId: THREAD_ID,
      turnId: TURN_ID,
      itemId: "shared-item",
      target,
      delta,
      ...overrides,
    };
  }

  function notificationEvent(notification: ServerNotification) {
    return { type: "notification" as const, notification };
  }

  describe("canonical frame-text delta reduction", () => {
    test("maps all four generated notifications without resolving nullable turns early", () => {
      const notifications = [
        {
          method: "item/agentMessage/delta",
          params: { threadId: THREAD_ID, turnId: TURN_ID, itemId: "a", delta: "A" },
        },
        {
          method: "item/plan/delta",
          params: { threadId: THREAD_ID, turnId: TURN_ID, itemId: "p", delta: "P" },
        },
        {
          method: "item/reasoning/summaryTextDelta",
          params: {
            threadId: THREAD_ID,
            turnId: TURN_ID,
            itemId: "r",
            delta: "S",
            summaryIndex: 2,
          },
        },
        {
          method: "item/reasoning/textDelta",
          params: {
            threadId: THREAD_ID,
            turnId: TURN_ID,
            itemId: "r",
            delta: "C",
            contentIndex: 3,
          },
        },
      ] satisfies ServerNotification[];

      const mapped = notifications.map((notification) => toCodexFrameTextDelta(notification, null));
      expect(mapped.map((entry) => entry.target.type).join(",")).toBe(
        "agentMessage,plan,reasoningSummary,reasoningContent",
      );
      expect(mapped.map((entry) => String(entry.turnId)).join(",")).toBe("null,null,null,null");
    });

    test("updates the reverse-last same-ID exact raw protocol type", () => {
      const items: ThreadItem[] = [
        {
          questions: null,
          type: "agentMessage",
          moderation: null,
          id: "shared-item",
          text: "first",
          phase: null,
          memoryCitation: null,
          delivery: null,
        },
        { type: "plan", id: "shared-item", text: "plan" },
        {
          questions: null,
          type: "agentMessage",
          moderation: null,
          id: "shared-item",
          text: "last",
          phase: null,
          memoryCitation: null,
          delivery: null,
        },
      ];
      const result = reduceCodexFrameTextDeltaItems(
        items,
        update({ type: "agentMessage" }, "+delta"),
      );
      const nextItems = result.items as ThreadItem[];

      expect(result.disposition).toBe("applied");
      expect(result.itemIndex).toBe(2);
      expect(
        (
          nextItems[0] as {
            text?: string;
          }
        ).text,
      ).toBe("first");
      expect(
        (
          nextItems[1] as {
            text?: string;
          }
        ).text,
      ).toBe("plan");
      expect(
        (
          nextItems[2] as {
            text?: string;
          }
        ).text,
      ).toBe("last+delta");
      expect(
        (
          items[2] as {
            text?: string;
          }
        ).text,
      ).toBe("last");
    });

    test("accepts safe non-negative reasoning indexes and densely fills omitted slots", () => {
      const reasoning: ThreadItem = {
        type: "reasoning",
        id: "shared-item",
        summary: ["zero"],
        content: [],
      };
      const appended = reduceCodexFrameTextDeltaItems(
        [reasoning],
        update({ type: "reasoningSummary", summaryIndex: 1 }, "one"),
      );
      const appendedItem = appended.items[0] as Extract<
        ThreadItem,
        {
          type: "reasoning";
        }
      >;
      const invalidIndexes = [
        -1,
        0.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.MAX_SAFE_INTEGER + 1,
      ];

      expect(appendedItem.summary.join("|")).toBe("zero|one");
      const gapInput = [reasoning];
      const gap = reduceCodexFrameTextDeltaItems(
        gapInput,
        update({ type: "reasoningSummary", summaryIndex: 3 }, "three"),
      );
      expect(gap.disposition).toBe("applied");
      expect((gap.items[0] as Extract<ThreadItem, { type: "reasoning" }>).summary).toEqual([
        "zero",
        "",
        "",
        "three",
      ]);
      expect(canAppendCodexReasoningPartDelta([], Number.MAX_SAFE_INTEGER)).toBe(true);
      for (const index of invalidIndexes) {
        const invalidInput = [reasoning];
        const invalid = reduceCodexFrameTextDeltaItems(
          invalidInput,
          update({ type: "reasoningContent", contentIndex: index }, "bad"),
        );
        expect(invalid.disposition).toBe("invalidReasoningIndex");
        expect(invalid.items === invalidInput).toBe(true);
        expect(invalid.items[0] === reasoning).toBe(true);
      }

      const negativeZero = reduceCodexFrameTextDeltaItems(
        [reasoning],
        update({ type: "reasoningContent", contentIndex: -0 }, "valid"),
      );
      const negativeZeroItem = negativeZero.items[0] as Extract<
        ThreadItem,
        {
          type: "reasoning";
        }
      >;
      expect(negativeZero.disposition).toBe("applied");
      expect(negativeZeroItem.content[0]).toBe("valid");
    });

    test("preserves raw and canonical identity for empty deltas in existing reasoning slots", () => {
      const reasoning: Extract<
        ThreadItem,
        {
          type: "reasoning";
        }
      > = {
        type: "reasoning",
        id: "shared-item",
        summary: ["existing summary"],
        content: ["existing content"],
      };
      const rawItems = [reasoning];
      const summaryResult = reduceCodexFrameTextDeltaItems(
        rawItems,
        update({ type: "reasoningSummary", summaryIndex: 0 }, ""),
      );
      const contentResult = reduceCodexFrameTextDeltaItems(
        rawItems,
        update({ type: "reasoningContent", contentIndex: 0 }, ""),
      );
      const initial = buildState([reasoning]);
      const canonicalResult = reduceCodexConversationFrameTextDeltas(
        initial,
        [
          update({ type: "reasoningSummary", summaryIndex: 0 }, ""),
          update({ type: "reasoningContent", contentIndex: 0 }, ""),
        ],
        {
          now: () => {
            throw new Error("an existing empty-delta slot must not read the clock");
          },
        },
      );

      expect(summaryResult.items === rawItems).toBe(true);
      expect(summaryResult.items[0] === reasoning).toBe(true);
      expect(contentResult.items === rawItems).toBe(true);
      expect(contentResult.items[0] === reasoning).toBe(true);
      expect(canonicalResult.state === initial).toBe(true);
      expect(canonicalResult.outcomes[0]?.stateChanged).toBe(false);
      expect(canonicalResult.outcomes[1]?.stateChanged).toBe(false);
    });

    test("uses latest for nullable turn IDs and never rebinds an in-progress null placeholder", () => {
      const latest = resolveCodexFrameTextDeltaTurn(
        [
          { turnId: "older", status: "completed", hasError: false, itemCount: 1 },
          { turnId: "latest", status: "inProgress", hasError: false, itemCount: 1 },
        ],
        null,
      );
      const inProgressPlaceholder = resolveCodexFrameTextDeltaTurn(
        [{ turnId: null, status: "inProgress", hasError: false, itemCount: 0 }],
        "incoming",
      );

      expect(latest.kind).toBe("latest");
      expect("turnIndex" in latest ? latest.turnIndex : -1).toBe(1);
      expect(inProgressPlaceholder.kind).toBe("none");
    });

    test("persists the sole completed-empty placeholder rebind when the item is missing", () => {
      const initial = buildState([], "completed");
      const placeholder = {
        ...initial,
        turns: [
          {
            ...initial.turns[0]!,
            turnId: null,
            status: "completed" as const,
            turnStartedAtMs: null,
          },
        ],
      };
      let clockCalls = 0;
      const result = reduceCodexConversationFrameTextDeltas(
        placeholder,
        [
          update({ type: "plan" }, "missing", {
            turnId: "rebound-turn",
            itemId: "missing-plan",
          }),
        ],
        {
          now: () => {
            clockCalls += 1;
            return 44000;
          },
        },
      );

      expect(result.state.turns[0]?.turnId).toBe("rebound-turn");
      expect(result.state.turns[0]?.status).toBe("inProgress");
      expect(result.state.turns[0]?.turnStartedAtMs).toBe(44000);
      expect(result.outcomes[0]?.disposition).toBe("missingItem");
      expect(result.outcomes[0]?.stateChanged).toBe(true);
      expect(clockCalls).toBe(1);
    });

    test("applies all four targets in batch without changing lifecycle timing or status", () => {
      const items: ThreadItem[] = [
        {
          questions: null,
          type: "agentMessage",
          moderation: null,
          id: "agent",
          text: "",
          phase: null,
          memoryCitation: null,
          delivery: null,
        },
        { type: "plan", id: "plan", text: "" },
        { type: "reasoning", id: "reasoning", summary: [], content: [] },
      ];
      const initialBase = buildState(items, "completed");
      const initial = {
        ...initialBase,
        turns: [
          {
            ...initialBase.turns[0]!,
            turnStartedAtMs: 10,
            firstTurnWorkItemStartedAtMs: 20,
            finalAssistantStartedAtMs: 30,
          },
        ],
      };
      const result = reduceCodexConversationFrameTextDeltas(
        initial,
        [
          update({ type: "agentMessage" }, "agent", { itemId: "agent" }),
          update({ type: "plan" }, "plan", { itemId: "plan" }),
          update({ type: "reasoningSummary", summaryIndex: 0 }, "summary", { itemId: "reasoning" }),
          update({ type: "reasoningContent", contentIndex: 0 }, "content", { itemId: "reasoning" }),
        ],
        {
          now: () => {
            throw new Error("ordinary deltas must not read the clock");
          },
        },
      );
      const turn = result.state.turns[0]!;
      const agent = turn.items[0] as Extract<
        ThreadItem,
        {
          type: "agentMessage";
        }
      >;
      const plan = turn.items[1] as Extract<
        ThreadItem,
        {
          type: "plan";
        }
      >;
      const reasoning = turn.items[2] as Extract<
        ThreadItem,
        {
          type: "reasoning";
        }
      >;
      expect(agent.text).toBe("agent");
      expect(plan.text).toBe("plan");
      expect(reasoning.summary.join("|")).toBe("summary");
      expect(reasoning.content.join("|")).toBe("content");
      expect(turn.status).toBe("completed");
      expect(turn.turnStartedAtMs).toBe(10);
      expect(turn.firstTurnWorkItemStartedAtMs).toBe(20);
      expect(turn.finalAssistantStartedAtMs).toBe(30);
    });

    test("part announcements are observational and a later text delta materializes dense parts", () => {
      const initial = buildState([
        { type: "reasoning", id: "reasoning", summary: [], content: [] },
      ]);
      const announced = reduceCodexConversationEvent(
        initial,
        notificationEvent({
          method: "item/reasoning/summaryPartAdded",
          params: { threadId: THREAD_ID, turnId: TURN_ID, itemId: "reasoning", summaryIndex: 2 },
        }),
        { now: () => 1 },
      );
      expect(announced).toBe(initial);
      const text = reduceCodexConversationEvent(
        announced,
        notificationEvent({
          method: "item/reasoning/summaryTextDelta",
          params: {
            threadId: THREAD_ID,
            turnId: TURN_ID,
            itemId: "reasoning",
            summaryIndex: 2,
            delta: "third",
          },
        }),
        { now: () => 2 },
      );
      expect(
        (text.turns[0]!.items[0] as Extract<ThreadItem, { type: "reasoning" }>).summary,
      ).toEqual(["", "", "third"]);
    });

    test("completion and replay retain a legitimate 257th reasoning part", () => {
      const parts = Array.from({ length: 257 }, (_, index) => `part-${index}`);
      const initial = buildState([
        { type: "reasoning", id: "reasoning", summary: [], content: [] },
      ]);
      const completed = reduceCodexConversationEvent(
        initial,
        notificationEvent({
          method: "item/completed",
          params: {
            threadId: THREAD_ID,
            turnId: TURN_ID,
            completedAtMs: 2000,
            item: { type: "reasoning", id: "reasoning", summary: parts, content: parts },
          },
        }),
        { now: () => 3000 },
      );
      const terminal = completed.turns[0]!.items[0] as Extract<ThreadItem, { type: "reasoning" }>;
      expect(terminal.summary).toEqual(parts);
      expect(terminal.content).toEqual(parts);
      const replayed = replayCodexConversationEvents({
        threadId: THREAD_ID,
        initialState: initial,
        hydratedThread: null,
        events: [
          notificationEvent({
            method: "item/reasoning/textDelta",
            params: {
              threadId: THREAD_ID,
              turnId: TURN_ID,
              itemId: "reasoning",
              contentIndex: 256,
              delta: "257th",
            },
          }),
        ],
        reduce: (state, event) => reduceCodexConversationEvent(state, event, { now: () => 4000 }),
      });
      const content = (replayed.turns[0]!.items[0] as Extract<ThreadItem, { type: "reasoning" }>)
        .content;
      expect(content.length).toBe(257);
      expect(content.slice(0, 256)).toEqual(Array(256).fill(""));
      expect(content[256]).toBe("257th");
    });

    test("lets authoritative completion replace provisional delta text", () => {
      const started: Extract<
        ThreadItem,
        {
          type: "plan";
        }
      > = {
        type: "plan",
        id: "shared-item",
        text: "draft",
      };
      const completed: Extract<
        ThreadItem,
        {
          type: "plan";
        }
      > = {
        type: "plan",
        id: "shared-item",
        text: "authoritative final",
      };
      const afterDelta = reduceCodexConversationEvent(
        buildState([started]),
        notificationEvent({
          method: "item/plan/delta",
          params: {
            threadId: THREAD_ID,
            turnId: TURN_ID,
            itemId: "shared-item",
            delta: " provisional",
          },
        }),
        { now: () => 1 },
      );
      const afterCompletion = reduceCodexConversationEvent(
        afterDelta,
        notificationEvent({
          method: "item/completed",
          params: {
            threadId: THREAD_ID,
            turnId: TURN_ID,
            item: completed,
            completedAtMs: 2000,
          },
        }),
        { now: () => 3000 },
      );
      expect(
        (
          afterDelta.turns[0]?.items[0] as {
            text?: string;
          }
        ).text,
      ).toBe("draft provisional");
      expect(afterCompletion.turns[0]?.items[0] === completed).toBe(true);
      expect(
        (
          afterCompletion.turns[0]?.items[0] as {
            text?: string;
          }
        ).text,
      ).toBe("authoritative final");
    });
  });
});
