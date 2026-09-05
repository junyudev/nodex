import { describe, expect, test } from "vite-plus/test";
import type { ServerNotification } from "@nodex/codex-app-server-protocol";
import type { FileUpdateChange, Thread, ThreadItem } from "@nodex/codex-app-server-protocol/v2";
import {
  createCodexCanonicalConversationState,
  type CodexCanonicalConversationState,
  type CodexCanonicalItem,
  type CodexCanonicalTurnParams,
  type CodexCanonicalTurnState,
} from "./codex-conversation-state";
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

const THREAD_ID = "thread_c06";
const TURN_ID = "turn_c06";

type FileChangeItem = Extract<ThreadItem, { type: "fileChange" }>;
type McpToolCallItem = Extract<ThreadItem, { type: "mcpToolCall" }>;

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
    extra: null,
    sessionId: "session_c06",
    forkedFromId: null,
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
    source: "unknown",
    canAcceptDirectInput: true,
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: "C-06 file stream fixture",
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

interface CanonicalTurnFixture {
  readonly turnId: string | null;
  readonly status?: CodexCanonicalTurnState["protocol"]["status"];
  readonly items?: readonly CodexCanonicalItem[];
  readonly turnStartedAtMs?: number | null;
  readonly firstWork?: number | null;
  readonly hookRuns?: CodexCanonicalTurnState["sidecar"]["hookRuns"];
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
      protocol: {
        ...template.protocol,
        id: fixture.turnId,
        status: fixture.status ?? "inProgress",
        error: null,
      },
      items: fixture.items ?? [],
      sidecar: {
        ...template.sidecar,
        turnStartedAtMs: fixture.turnStartedAtMs ?? null,
        ...("firstWork" in fixture ? { firstTurnWorkItemStartedAtMs: fixture.firstWork } : {}),
        ...("hookRuns" in fixture ? { hookRuns: fixture.hookRuns } : {}),
      },
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
    turnStartedAtMs: 1_000,
    firstTurnWorkItemStartedAtMs: 2_000,
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
    id,
    server: "fixture-server",
    tool: "fixture-tool",
    status: "inProgress",
    arguments: {},
    appContext: null,
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
    const clockValues = [10_001, 10_002];
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
    expect(patch.turn?.turnStartedAtMs).toBe(10_001);
    expect(patch.turn?.firstTurnWorkItemStartedAtMs).toBe(10_002);
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
    const patchClock = [20_001, 20_002];
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
          return 30_001;
        },
      },
    );

    expect(patch.resolutionKind).toBe("reboundCompletedEmptyPlaceholder");
    expect(patch.turn?.turnId).toBe("patch-turn");
    expect(patch.turn?.status).toBe("inProgress");
    expect(patch.turn?.turnStartedAtMs).toBe(20_001);
    expect(patch.turn?.firstTurnWorkItemStartedAtMs).toBe(20_002);
    expect(progress.resolutionKind).toBe("reboundCompletedEmptyPlaceholder");
    expect(progress.turn?.turnId).toBe("progress-turn");
    expect(progress.turn?.status).toBe("inProgress");
    expect(progress.turn?.turnStartedAtMs).toBe(30_001);
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
      readonly extensionSentinel: { readonly retained: true };
    };
    const source = rawTurn([first, wrongType, last], {
      status: "failed",
      turnStartedAtMs: 40_001,
      firstTurnWorkItemStartedAtMs: 40_002,
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
    expect(result.turn?.turnStartedAtMs).toBe(40_001);
    expect(result.turn?.firstTurnWorkItemStartedAtMs).toBe(40_002);
    expect(last.changes[0]?.path).toBe("last.ts");
  });

  test("replaces the first same-ID wrong type when no exact file item exists", () => {
    const firstWrongType: ThreadItem = {
      questions: null,
      type: "agentMessage",
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
    expect(canonical.state.turns[0]?.sidecar.firstTurnWorkItemStartedAtMs === undefined).toBe(true);
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
    expect(firstCanonical.state.turns[0]?.sidecar.hookRuns?.length ?? -1).toBe(0);
    expect(secondCanonical.stateChanged).toBe(false);
    expect(secondCanonical.state).toBe(firstCanonical.state);
  });

  test("routes patch and completed-placeholder progress through canonical replay", () => {
    const oldChanges = [change("before.ts")];
    const file = {
      ...fileChange("patch-item", oldChanges, "failed"),
      extensionSentinel: "preserve-me",
    } as FileChangeItem & { readonly extensionSentinel: string };
    const existing = withCanonicalTurns(buildState(), [
      {
        turnId: TURN_ID,
        items: [file],
        turnStartedAtMs: 50_001,
        firstWork: 50_002,
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
    expect(patched.state.protocol).toBe(existing.protocol);
    expect(patched.state.protocol.updatedAt).toBe(2);
    expect(patched.state.turns[0]?.sidecar.turnStartedAtMs).toBe(50_001);
    expect(patched.state.turns[0]?.sidecar.firstTurnWorkItemStartedAtMs).toBe(50_002);
    expect(patched.state.turns[0]?.sidecar.hookRuns?.length ?? -1).toBe(0);

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
          return 60_001;
        },
      },
    );

    expect(rebound === placeholder).toBe(false);
    expect(rebound.turns[0]?.protocol.id).toBe("bound-progress-turn");
    expect(rebound.turns[0]?.protocol.status).toBe("inProgress");
    expect(rebound.turns[0]?.sidecar.turnStartedAtMs).toBe(60_001);
    expect(rebound.turns[0]?.sidecar.firstTurnWorkItemStartedAtMs === undefined).toBe(true);
    expect(rebound.turns[0]?.items === placeholder.turns[0]?.items).toBe(true);
    expect(rebound.turns[0]?.sidecar.hookRuns?.length ?? -1).toBe(0);
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
