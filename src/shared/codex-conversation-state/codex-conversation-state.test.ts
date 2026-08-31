import { describe, expect, test } from "vite-plus/test";
import type { ServerRequest } from "@nodex/codex-app-server-protocol";
import type {
  HookRunSummary,
  ThreadItem,
  Turn,
  UserInput,
} from "@nodex/codex-app-server-protocol/v2";
import { projectCodexCanonicalTurnItemViews } from "../codex-canonical-item-projector";
import {
  appendCodexCanonicalForkedFromConversationItem,
  appendCodexCanonicalInProgressSyntheticItem,
  appendCodexCanonicalWorktreeInitItem,
  buildCodexCanonicalRequestIdentityKey,
  canonicalizeCodexCanonicalTurnStates,
  createCodexCanonicalConversationState,
  createCodexCanonicalHydratedConversationState,
  createCodexCanonicalHookRun,
  createCodexCanonicalProtocolItem,
  createCodexCanonicalProtocolRequest,
  extractCodexCanonicalHydratedAttachments,
  mergeCodexCanonicalOlderTurnStates,
  mergeCodexCanonicalTurnState,
  mergeCodexCanonicalTurnStates,
  materializeCodexCanonicalProtocolItem,
  resolveCodexCanonicalHydratedCwd,
  resolveCodexCanonicalHydratedPermissionContext,
  resolveCodexCanonicalProjectlessCwd,
  removeCodexCanonicalLocalSyntheticItem,
  isCodexCanonicalProtocolItem,
  type CodexCanonicalHydratedSandboxTurnParams,
  type CodexCanonicalOptionPickerRequest,
  type CodexCanonicalPlanImplementationRequest,
  type CodexCanonicalMcpElicitation,
  type CodexCanonicalProtocolItem,
  type CodexCanonicalProtocolRequest,
  type CodexCanonicalRequestSyntheticItem,
  type CodexCanonicalSetupContextPickerRequest,
  type CodexCanonicalTurnParams,
  type CodexCanonicalWorktreeInitItem,
  type CodexProtocolServerRequestOf,
} from "./codex-conversation-state";
import {
  AGENT_ACTIVITY_V2_CORPUS_THREAD_ID,
  AGENT_ACTIVITY_V2_CORPUS_TURN_ID,
  buildAgentActivityV2CorpusThread,
} from "./test-fixtures/agent-activity-v2-corpus-provenance";
import {
  agentActivityV2ItemFamilyCorpus,
  agentActivityV2McpAppContextPrecedenceItem,
  agentActivityV2MultiActionCommandItem,
} from "./test-fixtures/agent-activity-v2-item-family-corpus";
import {
  agentActivityV2CommandApprovalRequest,
  agentActivityV2DynamicOptionPickerRequest,
  agentActivityV2McpElicitationRequest,
  agentActivityV2OneShotRequestCases,
  agentActivityV2PendingResolvedRequestCases,
  agentActivityV2PermissionRequest,
  agentActivityV2UserInputRequest,
} from "./test-fixtures/agent-activity-v2-request-family-corpus";

type IsExact<TLeft, TRight> =
  (<T>() => T extends TLeft ? 1 : 2) extends <T>() => T extends TRight ? 1 : 2
    ? (<T>() => T extends TRight ? 1 : 2) extends <T>() => T extends TLeft ? 1 : 2
      ? true
      : false
    : false;

const generatedItemTypeProof: IsExact<CodexCanonicalProtocolItem, ThreadItem> = true;
const generatedRequestTypeProof: IsExact<CodexCanonicalProtocolRequest, ServerRequest> = true;

function collectAllGeneratedCorpusRequests(): ServerRequest[] {
  const requests = agentActivityV2PendingResolvedRequestCases.map(
    (requestCase) => requestCase.request,
  );

  for (const requestCase of agentActivityV2OneShotRequestCases) {
    for (const event of requestCase.fixture.events) {
      if (event.type === "request") {
        switch (event.request.method) {
          case "item/tool/requestOptionPicker":
          case "item/tool/requestSetupCodexContextPicker":
          case "item/plan/requestImplementation":
            break;
          default:
            requests.push(event.request);
        }
      }
    }
  }

  return requests;
}

function getCommandApprovalItemId(
  request: CodexProtocolServerRequestOf<"item/commandExecution/requestApproval">,
): string {
  return request.params.itemId;
}

const optionPickerRequest = {
  id: 301,
  method: "item/tool/requestOptionPicker",
  params: {
    threadId: AGENT_ACTIVITY_V2_CORPUS_THREAD_ID,
    turnId: AGENT_ACTIVITY_V2_CORPUS_TURN_ID,
    question: "Choose a fixture option.",
    options: [
      {
        label: "Continue",
        description: "Continue with the sanitized fixture.",
      },
    ],
    allowMultiple: false,
    submitLabel: "Continue",
    skipLabel: null,
  },
} satisfies CodexCanonicalOptionPickerRequest;

const setupContextPickerRequest = {
  id: "setup-context-302",
  method: "item/tool/requestSetupCodexContextPicker",
  params: {
    threadId: AGENT_ACTIVITY_V2_CORPUS_THREAD_ID,
    turnId: AGENT_ACTIVITY_V2_CORPUS_TURN_ID,
  },
} satisfies CodexCanonicalSetupContextPickerRequest;

const planImplementationRequest = {
  id: "implement-plan:turn-activity-v2-corpus",
  method: "item/plan/requestImplementation",
  params: {
    threadId: AGENT_ACTIVITY_V2_CORPUS_THREAD_ID,
    turnId: AGENT_ACTIVITY_V2_CORPUS_TURN_ID,
    planContent: "Implement the sanitized fixture plan.",
  },
} satisfies CodexCanonicalPlanImplementationRequest;

function buildCompleteFixtureTurnParams(
  threadId: string,
  cwd: string | null,
): CodexCanonicalHydratedSandboxTurnParams {
  return {
    threadId,
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
    cwd,
    attachments: [],
    effort: "high",
    summary: "none",
    personality: null,
    outputSchema: null,
    collaborationMode: null,
  };
}

function hydrateCanonicalFixtureTurns(
  turns: Turn[],
  turnItemsPaginationById?: Parameters<
    typeof createCodexCanonicalHydratedConversationState
  >[1]["turnItemsPaginationById"],
) {
  const fixtureThread = buildAgentActivityV2CorpusThread([]);
  return createCodexCanonicalHydratedConversationState(
    {
      ...fixtureThread,
      turns,
    },
    {
      model: "gpt-fixture",
      reasoningEffort: "high",
      cwd: "/workspace/project",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "readOnly",
        networkAccess: false,
      },
      activePermissionProfile: null,
      runtimeWorkspaceRoots: ["/workspace/project"],
      turnItemsPaginationById,
    },
  );
}

describe("protocol-backed canonical conversation state", () => {
  test("uses generated item/request unions directly and retains exact references", () => {
    expect(generatedItemTypeProof).toBe(true);
    expect(generatedRequestTypeProof).toBe(true);

    for (const payloadCase of agentActivityV2ItemFamilyCorpus) {
      const canonical = createCodexCanonicalProtocolItem(payloadCase.item);
      expect(canonical === payloadCase.item).toBe(true);
    }

    for (const request of collectAllGeneratedCorpusRequests()) {
      const canonical = createCodexCanonicalProtocolRequest(request);
      expect(canonical === request).toBe(true);
    }

    expect(getCommandApprovalItemId(agentActivityV2CommandApprovalRequest)).toBe(
      "pending-command-approval",
    );
  });

  test("rejects partially loaded turns at the hydrated history boundary", () => {
    const turn: Turn = {
      id: "turn-partial-history",
      items: [],
      itemsView: "summary",
      status: "completed",
      error: null,
      startedAt: null,
      completedAt: null,
      durationMs: null,
    };

    expect(() => hydrateCanonicalFixtureTurns([turn])).toThrow(
      "Cannot hydrate partial turn 'turn-partial-history' without item pagination",
    );
  });

  test("hydrates partial turns from their stable opening user input", () => {
    const turn: Turn = {
      id: "turn-partial-history",
      items: [],
      itemsView: "summary",
      status: "completed",
      error: null,
      startedAt: null,
      completedAt: null,
      durationMs: null,
    };
    const openingInput: UserInput[] = [{ type: "text", text: "oldest prompt", text_elements: [] }];

    const state = hydrateCanonicalFixtureTurns([turn], {
      [turn.id]: {
        olderCursor: "items:older",
        isLoadingOlder: false,
        hasLoadedOldest: false,
        oldestUserInput: openingInput,
        openingUserMessageId: "opening-user",
        itemsView: "summary",
      },
    });

    expect(state.turns[0]?.sidecar.params.input).toEqual(openingInput);
    expect(state.turns[0]?.protocol.itemsView).toBe("summary");
  });

  test("hydrates only caller-supplied pending requests and preserves private exact extensions", () => {
    const items = agentActivityV2ItemFamilyCorpus.map((payloadCase) => payloadCase.item);
    const pendingRequests = [
      ...agentActivityV2PendingResolvedRequestCases.map((requestCase) => requestCase.request),
      agentActivityV2DynamicOptionPickerRequest,
      optionPickerRequest,
      setupContextPickerRequest,
      planImplementationRequest,
    ];
    const thread = buildAgentActivityV2CorpusThread(items);
    const turnParams = buildCompleteFixtureTurnParams(thread.id, thread.cwd);
    const options = {
      pendingRequests,
      turnParamsById: {
        [AGENT_ACTIVITY_V2_CORPUS_TURN_ID]: turnParams,
      },
    };
    const serializedThreadBefore = JSON.stringify(thread);

    const first = createCodexCanonicalConversationState(thread, options);
    const second = createCodexCanonicalConversationState(thread, options);
    const turn = first.turns[0];
    if (!turn) {
      throw new Error("Canonical corpus turn is missing");
    }

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(JSON.stringify(thread)).toBe(serializedThreadBefore);
    expect(Object.prototype.hasOwnProperty.call(first.protocol, "turns")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(turn.protocol, "items")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(turn.protocol, "startedAt")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(turn.protocol, "completedAt")).toBe(false);
    expect(turn.items.length).toBe(items.length);
    expect(first.requests.length).toBe(pendingRequests.length);
    expect(turn.sidecar.params === turnParams).toBe(true);
    expect(turn.sidecar.params.threadId).toBe(thread.id);
    expect(turn.sidecar.params.cwd).toBe(thread.cwd);
    expect(turn.sidecar.turnStartedAtMs).toBe(1_000);
    expect(turn.sidecar.finalAssistantStartedAtMs).toBe(null);
    expect(turn.sidecar.diff).toBe(null);
    expect(
      Object.prototype.hasOwnProperty.call(turn.sidecar, "commandExecutionStartedAtMsById"),
    ).toBe(false);
    expect(
      Object.prototype.hasOwnProperty.call(turn.sidecar, "interruptedCommandExecutionItemIds"),
    ).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(turn.sidecar, "hookRuns")).toBe(false);
    expect(turn.items[0] === items[0]).toBe(true);
    expect(first.requests[0] === pendingRequests[0]).toBe(true);
    expect(first.requests.at(-1)?.method).toBe("item/plan/requestImplementation");
  });

  test("hydrates complete production context without flattening duplicate or hidden raw slots", () => {
    const duplicateId = "shared-slot";
    const userMessage = {
      type: "userMessage",
      id: "hydrated-user-message",
      clientId: null,
      content: [
        {
          type: "text",
          text: [
            "# Files mentioned by the user:",
            "",
            "## fixture: /workspace/project/file.ts (lines 2-7)",
            "",
            "## My request for Codex:",
            "Inspect the raw slots.",
          ].join("\n"),
          text_elements: [],
        },
      ],
    } satisfies ThreadItem;
    const hidden = {
      type: "enteredReviewMode",
      id: duplicateId,
      review: "hidden payload",
    } satisfies ThreadItem;
    const fileChange = {
      type: "fileChange",
      id: duplicateId,
      changes: [],
      status: "inProgress",
    } satisfies ThreadItem;
    const command = {
      type: "commandExecution",
      id: duplicateId,
      command: "pwd",
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
    } satisfies ThreadItem;
    const thread = buildAgentActivityV2CorpusThread([userMessage, hidden, fileChange, command]);
    const state = createCodexCanonicalHydratedConversationState(thread, {
      model: "gpt-fixture",
      reasoningEffort: "high",
      cwd: "/workspace/project",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: ["/workspace/project"],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
      activePermissionProfile: null,
      runtimeWorkspaceRoots: ["/workspace/project"],
    });

    const turn = state.turns[0];
    if (!turn) throw new Error("Hydrated production turn is missing");
    expect(turn.items.length).toBe(4);
    expect(turn.items[0] === userMessage).toBe(true);
    expect(turn.items[1] === hidden).toBe(true);
    expect(turn.items[2] === fileChange).toBe(true);
    expect(turn.items[3] === command).toBe(true);
    expect(turn.sidecar.params.input === userMessage.content).toBe(true);
    expect(turn.sidecar.params.approvalPolicy).toBe("on-request");
    expect(turn.sidecar.params.approvalsReviewer).toBe("user");
    expect(turn.sidecar.params.model).toBe("gpt-fixture");
    expect(turn.sidecar.params.cwd).toBe("/workspace/project");
    expect(turn.sidecar.params.effort).toBe("high");
    expect(JSON.stringify(turn.sidecar.params.attachments)).toBe(
      JSON.stringify([
        {
          label: "fixture",
          path: "/workspace/project/file.ts",
          fsPath: "/workspace/project/file.ts",
        },
      ]),
    );
    expect(turn.sidecar.params.sandboxPolicy?.type).toBe("workspaceWrite");
    expect(Object.prototype.hasOwnProperty.call(turn.sidecar.params, "permissions")).toBe(false);
    expect(state.sidecar.hydrationContext?.model ?? null).toBe("gpt-fixture");
    expect(state.sidecar.hydrationContext?.cwd ?? null).toBe("/workspace/project");
    expect(state.sidecar.hydrationContext?.currentPermissions.sandboxPolicy.type ?? null).toBe(
      "workspaceWrite",
    );
  });

  test("hydrates duplicate turn ids per occurrence before the exact DB fold", () => {
    const baseTurn = buildAgentActivityV2CorpusThread([]).turns[0];
    if (!baseTurn) throw new Error("Canonical corpus turn is missing");
    const heartbeatInput = [
      {
        type: "text",
        text: [
          "<heartbeat>",
          "<current_time_iso>2026-07-10T00:00:00Z</current_time_iso>",
          "<instructions>Check status</instructions>",
          "</heartbeat>",
        ].join("\n"),
        text_elements: [],
      },
    ] satisfies Extract<ThreadItem, { type: "userMessage" }>["content"];
    const ordinaryInput = [
      {
        type: "text",
        text: "Continue normally",
        text_elements: [],
      },
    ] satisfies Extract<ThreadItem, { type: "userMessage" }>["content"];
    const duplicateTurns = [
      {
        ...baseTurn,
        id: "turn-duplicate-hydration",
        items: [
          {
            type: "userMessage",
            id: "heartbeat-input",
            clientId: null,
            content: heartbeatInput,
          },
        ],
      },
      {
        ...baseTurn,
        id: "turn-duplicate-hydration",
        items: [
          {
            type: "userMessage",
            id: "ordinary-input",
            clientId: null,
            content: ordinaryInput,
          },
        ],
      },
    ] satisfies Turn[];

    const hydrated = hydrateCanonicalFixtureTurns(duplicateTurns);
    expect(hydrated.turns.length).toBe(2);
    expect(hydrated.turns[0]?.sidecar.params.input === heartbeatInput).toBe(true);
    expect(hydrated.turns[1]?.sidecar.params.input === ordinaryInput).toBe(true);

    const canonical = canonicalizeCodexCanonicalTurnStates(hydrated.turns);
    expect(canonical.length).toBe(1);
    expect(canonical[0]?.sidecar.params.input === heartbeatInput).toBe(true);
  });

  test("hydrates active permission profiles with required runtime roots", () => {
    const thread = buildAgentActivityV2CorpusThread([]);
    const state = createCodexCanonicalHydratedConversationState(thread, {
      model: "gpt-fixture",
      reasoningEffort: null,
      cwd: "/workspace/project",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "readOnly",
        networkAccess: false,
      },
      activePermissionProfile: { id: "profile-fixture", extends: null },
      runtimeWorkspaceRoots: ["/workspace/project", "/workspace/shared"],
    });

    const params = state.turns[0]?.sidecar.params;
    expect(params?.permissions).toBe("profile-fixture");
    expect(JSON.stringify(params?.runtimeWorkspaceRoots)).toBe(
      JSON.stringify(["/workspace/project", "/workspace/shared"]),
    );
    expect(Object.prototype.hasOwnProperty.call(params ?? {}, "sandboxPolicy")).toBe(false);
  });

  test("resolves paged-resume cwd with the exact requested-descendant rule", () => {
    expect(
      resolveCodexCanonicalHydratedCwd({
        requestedCwd: "/workspace/project/subdir/",
        responseCwd: "/workspace/project",
        threadCwd: "/stale/thread",
        fallbackCwd: "/fallback",
      }),
    ).toBe("/workspace/project/subdir/");
    expect(
      resolveCodexCanonicalHydratedCwd({
        requestedCwd: "/other/project",
        responseCwd: "/workspace/project",
        threadCwd: null,
        fallbackCwd: "/fallback",
      }),
    ).toBe("/workspace/project");
    expect(
      resolveCodexCanonicalHydratedCwd({
        requestedCwd: "C:\\Workspace\\Project\\Subdir",
        responseCwd: "c:/workspace/project",
        threadCwd: null,
        fallbackCwd: null,
      }),
    ).toBe("C:\\Workspace\\Project\\Subdir");
    expect(
      resolveCodexCanonicalHydratedCwd({
        requestedCwd: null,
        responseCwd: null,
        threadCwd: null,
        fallbackCwd: null,
      }),
    ).toBe(null);
  });

  test("clamps projectless cwd to the workspace-browser root across path styles", () => {
    expect(
      resolveCodexCanonicalProjectlessCwd({
        cwd: "/workspace/root/nested",
        fallbackCwd: null,
        workspaceBrowserRoot: "/workspace/root",
        projectless: true,
      }),
    ).toBe("/workspace/root/nested");
    expect(
      resolveCodexCanonicalProjectlessCwd({
        cwd: "/outside/root",
        fallbackCwd: null,
        workspaceBrowserRoot: "/workspace/root/",
        projectless: true,
      }),
    ).toBe("/workspace/root/");
    expect(
      resolveCodexCanonicalProjectlessCwd({
        cwd: "C:\\Workspace\\Root\\nested",
        fallbackCwd: null,
        workspaceBrowserRoot: "c:/workspace/root",
        projectless: true,
      }),
    ).toBe("C:\\Workspace\\Root\\nested");
    expect(
      resolveCodexCanonicalProjectlessCwd({
        cwd: "D:\\outside",
        fallbackCwd: null,
        workspaceBrowserRoot: "C:\\Workspace\\Root",
        projectless: true,
      }),
    ).toBe("C:\\Workspace\\Root");
    expect(
      resolveCodexCanonicalProjectlessCwd({
        cwd: "/outside",
        fallbackCwd: "/fallback",
        workspaceBrowserRoot: null,
        projectless: false,
      }),
    ).toBe("/outside");
  });

  test("appends exact fork provenance and synthesizes the S1 placeholder when empty", () => {
    const base = createCodexCanonicalHydratedConversationState(
      buildAgentActivityV2CorpusThread([]),
      {
        model: "gpt-fixture",
        reasoningEffort: null,
        cwd: "/workspace/project",
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: ["/workspace/project"],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
        activePermissionProfile: null,
        runtimeWorkspaceRoots: ["/workspace/project"],
      },
    );
    const marker = {
      id: "fork-marker",
      type: "forkedFromConversation" as const,
      sourceConversationId: "source-thread",
      sourceConversationTitle: "Source task",
    };
    const appended = appendCodexCanonicalForkedFromConversationItem(base, marker);
    const latestTurn = appended.turns.at(-1);
    expect(latestTurn?.items.at(-1) === marker).toBe(true);
    expect(JSON.stringify(latestTurn?.sidecar.hookRuns ?? null)).toBe("[]");
    expect(isCodexCanonicalProtocolItem(marker)).toBe(false);

    const synthesized = appendCodexCanonicalForkedFromConversationItem(
      { ...base, turns: [] },
      marker,
    ).turns[0];
    expect(synthesized?.protocol.id).toBe(null);
    expect(synthesized?.protocol.status).toBe("completed");
    expect(synthesized?.sidecar.turnStartedAtMs).toBe(null);
    expect(synthesized?.sidecar.firstTurnWorkItemStartedAtMs).toBe(null);
    expect(synthesized?.sidecar.params.model).toBe(null);
    expect(synthesized?.sidecar.params.effort).toBe("minimal");
    expect(
      Object.prototype.hasOwnProperty.call(synthesized?.sidecar.params ?? {}, "attachments"),
    ).toBe(false);
    expect(JSON.stringify(synthesized?.sidecar.hookRuns ?? null)).toBe("[]");
  });

  test("places worktree init in the optimistic first turn and isolates fork initialization", () => {
    const base = createCodexCanonicalHydratedConversationState(
      buildAgentActivityV2CorpusThread([]),
      {
        model: "gpt-fixture",
        reasoningEffort: "high",
        cwd: "/workspace/project",
        approvalPolicy: "never",
        approvalsReviewer: "guardian_subagent",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: ["/workspace/project"],
          networkAccess: true,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
        activePermissionProfile: null,
        runtimeWorkspaceRoots: ["/workspace/project"],
      },
    );
    const item = {
      type: "worktreeInit",
      id: "pending-worktree:2",
      worktreeOutputText: "[info] Worktree created\n",
      setup: {
        outcome: "skipped",
        outputText: "[info] Continuing without local environment setup\n",
      },
    } satisfies CodexCanonicalWorktreeInitItem;

    const appendedToLatest = appendCodexCanonicalWorktreeInitItem(base, item);
    expect(appendedToLatest.turns.length).toBe(base.turns.length);
    expect(appendedToLatest.turns.at(-1)?.items.at(-1) === item).toBe(true);
    expect(appendedToLatest.turns.at(-1)?.protocol.status).toBe(base.turns.at(-1)?.protocol.status);

    const forkInit = appendCodexCanonicalWorktreeInitItem(base, item, "new-turn");
    const forkInitTurn = forkInit.turns.at(-1);
    expect(forkInit.turns.length).toBe(base.turns.length + 1);
    expect(forkInitTurn?.protocol.id).toBe(null);
    expect(forkInitTurn?.protocol.status).toBe("completed");
    expect(forkInitTurn?.items[0] === item).toBe(true);
    expect(forkInitTurn?.sidecar.params.approvalPolicy).toBe("never");
    expect(forkInitTurn?.sidecar.params.approvalsReviewer).toBe("guardian_subagent");
    expect(forkInitTurn?.sidecar.params.sandboxPolicy?.type).toBe("workspaceWrite");
    expect(forkInitTurn?.sidecar.params.model).toBe(null);
    expect(forkInitTurn?.sidecar.params.effort).toBe("minimal");
    expect(forkInitTurn?.sidecar.turnStartedAtMs).toBe(null);
    expect(isCodexCanonicalProtocolItem(item)).toBe(false);

    const rendererReloadTurns = mergeCodexCanonicalTurnStates(forkInit.turns, base.turns);
    expect(rendererReloadTurns.flatMap((turn) => turn.items)).toContain(item);
    expect(rendererReloadTurns.filter((turn) => turn.protocol.id === null)).toHaveLength(1);

    const noTurns = appendCodexCanonicalWorktreeInitItem({ ...base, turns: [] }, item);
    expect(noTurns.turns.length).toBe(1);
    expect(noTurns.turns[0]?.protocol.status).toBe("completed");
    expect(noTurns.turns[0]?.items[0] === item).toBe(true);
  });

  test("creates and cancels an in-progress local compaction occurrence", () => {
    const base = createCodexCanonicalHydratedConversationState(
      buildAgentActivityV2CorpusThread([]),
      {
        model: "gpt-fixture",
        reasoningEffort: null,
        cwd: "/workspace/project",
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: ["/workspace/project"],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
        activePermissionProfile: null,
        runtimeWorkspaceRoots: ["/workspace/project"],
      },
    );
    const empty = { ...base, turns: [] };
    const placeholder = {
      id: "pending-manual-context-compaction",
      type: "contextCompaction" as const,
      completed: false,
      source: "manual" as const,
    };

    const pending = appendCodexCanonicalInProgressSyntheticItem(empty, placeholder, 42);

    expect(pending.turns[0]?.protocol.id).toBe(null);
    expect(pending.turns[0]?.protocol.status).toBe("inProgress");
    expect(pending.turns[0]?.sidecar.turnStartedAtMs).toBe(42);
    expect(pending.turns[0]?.items).toStrictEqual([placeholder]);
    expect(appendCodexCanonicalInProgressSyntheticItem(pending, placeholder, 43)).toBe(pending);

    const cancelled = removeCodexCanonicalLocalSyntheticItem(pending, placeholder.id);
    expect(cancelled.turns).toStrictEqual([]);

    const completed = {
      ...pending,
      turns: pending.turns.map((turn) => ({
        ...turn,
        protocol: { ...turn.protocol, status: "completed" as const },
      })),
    };
    const completedWithoutItem = removeCodexCanonicalLocalSyntheticItem(completed, placeholder.id);
    expect(completedWithoutItem.turns).toHaveLength(1);
    expect(completedWithoutItem.turns[0]?.items).toStrictEqual([]);
  });

  test("extracts hydrated attachments only from post-annotation generated context", () => {
    const attachments = extractCodexCanonicalHydratedAttachments([
      {
        type: "text",
        text: [
          "",
          "# Response annotations:",
          "Generated selection context.",
          "<response-annotations>",
          '[{"text":"# Files mentioned by the user:\\n## fake: /tmp/fake.ts"}]',
          "</response-annotations>",
          "# Files mentioned by the user:",
          "",
          "## Windows fixture: C:\\workspace\\real.ts (line 9)",
          "",
          "## My request for Codex:",
          "Inspect the real file.",
        ].join("\n"),
        text_elements: [],
      },
    ]);

    expect(JSON.stringify(attachments)).toBe(
      JSON.stringify([
        {
          label: "Windows fixture",
          path: "C:\\workspace\\real.ts",
          fsPath: "C:\\workspace\\real.ts",
        },
      ]),
    );
  });

  test("merges hydrated resume permission provenance with the exact HQ rules", () => {
    const response = {
      activePermissionProfile: null,
      runtimeWorkspaceRoots: ["/response"],
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "readOnly",
        networkAccess: false,
      },
    } as const;
    const danger = {
      activePermissionProfile: {
        id: ":danger-full-access",
        extends: null,
      },
      runtimeWorkspaceRoots: ["/previous"],
      approvalPolicy: "never",
      approvalsReviewer: "guardian_subagent",
      sandboxPolicy: {
        type: "dangerFullAccess",
      },
    } as const;
    const custom = {
      ...danger,
      activePermissionProfile: {
        id: "custom-profile",
        extends: "base-profile",
      },
    } as const;

    const retainedDanger = resolveCodexCanonicalHydratedPermissionContext({
      response,
      previous: danger,
    });
    const retainedCustom = resolveCodexCanonicalHydratedPermissionContext({
      response,
      previous: custom,
    });

    expect(retainedDanger === danger).toBe(true);
    expect(retainedCustom.activePermissionProfile === custom.activePermissionProfile).toBe(true);
    expect(retainedCustom.approvalPolicy).toBe("on-request");
    expect(retainedCustom.runtimeWorkspaceRoots[0]).toBe("/response");
  });

  test("merges overlapping and anchored canonical turn history in exact chronology", () => {
    const template = buildAgentActivityV2CorpusThread([]).turns[0];
    if (!template) throw new Error("Canonical turn fixture is missing");
    const makeTurn = (id: string): Turn => ({
      ...template,
      id,
      items: [],
    });
    const existing = hydrateCanonicalFixtureTurns([
      makeTurn("turn-a"),
      makeTurn("turn-c"),
      makeTurn("turn-e"),
    ]).turns;
    const incoming = hydrateCanonicalFixtureTurns([
      makeTurn("turn-b"),
      makeTurn("turn-c"),
      makeTurn("turn-d"),
      makeTurn("turn-e"),
      makeTurn("turn-f"),
    ]).turns;

    const merged = mergeCodexCanonicalTurnStates(existing, incoming);
    expect(merged.map((turn) => turn.protocol.id).join(",")).toBe(
      "turn-a,turn-b,turn-c,turn-d,turn-e,turn-f",
    );

    const older = hydrateCanonicalFixtureTurns([
      makeTurn("turn-b"),
      makeTurn("turn-c"),
      makeTurn("turn-d"),
    ]).turns;
    const anchored = mergeCodexCanonicalOlderTurnStates({
      olderTurns: older,
      currentTurns: existing,
      oldestLoadedTurnId: "turn-c",
    });
    expect(anchored.map((turn) => turn.protocol.id).join(",")).toBe(
      "turn-a,turn-b,turn-c,turn-d,turn-e",
    );
  });

  test("merges lifecycle sidecars monotonically without reopening terminal items", () => {
    const template = buildAgentActivityV2CorpusThread([]).turns[0];
    if (!template) throw new Error("Canonical turn fixture is missing");
    const existing = hydrateCanonicalFixtureTurns([template]).turns[0];
    if (!existing) throw new Error("Canonical turn fixture is missing");
    const incoming = {
      ...existing,
      sidecar: {
        ...existing.sidecar,
        lifecycleStatusByItemId: {
          "reasoning-live": "completed" as const,
          "reasoning-terminal": "completed" as const,
        },
      },
    };
    const current = {
      ...existing,
      sidecar: {
        ...existing.sidecar,
        lifecycleStatusByItemId: {
          "reasoning-live": "inProgress" as const,
          "reasoning-terminal": "completed" as const,
        },
      },
    };

    const merged = mergeCodexCanonicalTurnState(current, incoming);
    expect(merged.sidecar.lifecycleStatusByItemId).toEqual({
      "reasoning-live": "completed",
      "reasoning-terminal": "completed",
    });
  });

  test("rejects hydration when exact app-side turn context is unavailable", () => {
    const thread = buildAgentActivityV2CorpusThread([]);
    let error: unknown = null;

    try {
      createCodexCanonicalConversationState(thread, { turnParamsById: {} });
    } catch (caught) {
      error = caught;
    }

    expect(error instanceof Error).toBe(true);
    expect(error instanceof Error ? error.message : null).toBe(
      `Missing complete canonical params for turn ${AGENT_ACTIVITY_V2_CORPUS_TURN_ID}`,
    );
  });

  test("retains complete generated and app-side turn context without copying it into items", () => {
    const thread = buildAgentActivityV2CorpusThread([agentActivityV2MultiActionCommandItem]);
    const attachments = [{ type: "image", source: "fixture-image" }];
    const commentAttachments = [{ type: "comment", body: "fixture comment" }];
    const turnParams = {
      ...buildCompleteFixtureTurnParams(thread.id, thread.cwd),
      model: "fixture-model",
      effort: "high",
      collaborationMode: {
        mode: "default",
        settings: {
          model: "fixture-model",
          reasoning_effort: "high",
          developer_instructions: null,
        },
      },
      attachments,
      commentAttachments,
    } satisfies CodexCanonicalTurnParams;
    const state = createCodexCanonicalConversationState(thread, {
      turnParamsById: {
        [AGENT_ACTIVITY_V2_CORPUS_TURN_ID]: turnParams,
      },
    });

    expect(state.turns[0]?.sidecar.params === turnParams).toBe(true);
    expect(state.turns[0]?.sidecar.params.model).toBe("fixture-model");
    expect(state.turns[0]?.sidecar.params.attachments === attachments).toBe(true);
    expect(state.turns[0]?.sidecar.params.commentAttachments === commentAttachments).toBe(true);
    expect(state.turns[0]?.items[0] === agentActivityV2MultiActionCommandItem).toBe(true);
  });

  test("materializes hydrated image and collaboration items with exact app-side fields", () => {
    const image = {
      type: "imageGeneration",
      id: "hydrated-image",
      status: "completed",
      revisedPrompt: null,
      result: "aHlkcmF0ZWQ=",
      failure: null,
    } satisfies ThreadItem;
    const collab = {
      type: "collabAgentToolCall",
      id: "hydrated-collab",
      tool: "spawnAgent",
      status: "completed",
      senderThreadId: AGENT_ACTIVITY_V2_CORPUS_THREAD_ID,
      receiverThreadIds: ["receiver-a", "receiver-b"],
      prompt: "Inspect the hydrated fixture",
      model: null,
      reasoningEffort: null,
      agentsStates: {},
    } satisfies ThreadItem;
    const thread = buildAgentActivityV2CorpusThread([image, collab]);
    const state = createCodexCanonicalConversationState(thread, {
      turnParamsById: {
        [AGENT_ACTIVITY_V2_CORPUS_TURN_ID]: buildCompleteFixtureTurnParams(thread.id, thread.cwd),
      },
    });
    const hydratedImage = state.turns[0]?.items[0];
    const hydratedCollab = state.turns[0]?.items[1];

    expect(
      hydratedImage?.type === "imageGeneration" && "src" in hydratedImage
        ? hydratedImage.src
        : null,
    ).toBe("data:image/png;base64,aHlkcmF0ZWQ=");
    expect(
      hydratedCollab?.type === "collabAgentToolCall" && "receiverThreads" in hydratedCollab
        ? hydratedCollab.receiverThreads
            .map((receiver) => `${receiver.threadId}:${String(receiver.thread)}`)
            .join(",")
        : "",
    ).toBe("receiver-a:null,receiver-b:null");
  });

  test("retains both exact hydrated-profile and live permission contexts", () => {
    const thread = buildAgentActivityV2CorpusThread([agentActivityV2MultiActionCommandItem]);
    const sandboxParams = buildCompleteFixtureTurnParams(thread.id, thread.cwd);
    const { sandboxPolicy: _sandboxPolicy, ...sharedParams } = sandboxParams;
    expect(_sandboxPolicy.type).toBe("workspaceWrite");
    const profileParams = {
      ...sharedParams,
      permissions: "fixture-profile",
      runtimeWorkspaceRoots: ["/workspace/project"],
    } satisfies CodexCanonicalTurnParams;
    const liveParams = {
      ...sandboxParams,
      permissions: "fixture-profile",
      runtimeWorkspaceRoots: ["/workspace/project"],
      useAppServerPermissionDefault: false,
    } satisfies CodexCanonicalTurnParams;

    const profileState = createCodexCanonicalConversationState(thread, {
      turnParamsById: {
        [AGENT_ACTIVITY_V2_CORPUS_TURN_ID]: profileParams,
      },
    });
    const liveState = createCodexCanonicalConversationState(thread, {
      turnParamsById: {
        [AGENT_ACTIVITY_V2_CORPUS_TURN_ID]: liveParams,
      },
    });

    expect(profileState.turns[0]?.sidecar.params === profileParams).toBe(true);
    expect(profileState.turns[0]?.sidecar.params.runtimeWorkspaceRoots?.[0]).toBe(
      "/workspace/project",
    );
    expect(liveState.turns[0]?.sidecar.params === liveParams).toBe(true);
    expect(liveState.turns[0]?.sidecar.params.sandboxPolicy?.type).toBe("workspaceWrite");
    expect(liveState.turns[0]?.sidecar.params.permissions).toBe("fixture-profile");
  });

  test("wraps hook runs with the exact stable local identity shape", () => {
    const run: HookRunSummary = {
      id: "fixture-hook",
      eventName: "sessionStart",
      handlerType: "command",
      executionMode: "sync",
      scope: "turn",
      sourcePath: "/fixture/hook.json",
      source: "user",
      displayOrder: 1n,
      status: "running",
      statusMessage: null,
      startedAt: 1n,
      completedAt: null,
      durationMs: null,
      entries: [],
    };

    const first = createCodexCanonicalHookRun(run);
    const repeated = createCodexCanonicalHookRun(run, "fixture-hook:1");

    expect(first.id).toBe(run.id);
    expect(first.run === run).toBe(true);
    expect(repeated.id).toBe("fixture-hook:1");
    expect(repeated.run === run).toBe(true);
  });

  test("models all request-caused synthetic families outside ThreadItem", () => {
    const userInputQuestions = agentActivityV2UserInputRequest.params.questions.map((question) => ({
      id: question.id,
      header: question.header,
      question: question.question,
      options: question.options ?? [],
    }));
    const firstUserInputQuestion = userInputQuestions[0];
    if (!firstUserInputQuestion) {
      throw new Error("Canonical fixture user-input request must have a question");
    }
    const mcpParams = agentActivityV2McpElicitationRequest.params;
    if (mcpParams.mode !== "openai/form") {
      throw new Error("Canonical fixture MCP request must use openai/form mode");
    }
    const elicitation = {
      kind: "openaiForm",
      message: mcpParams.message,
      serverName: mcpParams.serverName,
      schema: mcpParams.requestedSchema,
    } satisfies CodexCanonicalMcpElicitation;
    const syntheticItems = [
      {
        type: "userInputResponse",
        id: `user-input-response-${agentActivityV2UserInputRequest.id}`,
        requestId: agentActivityV2UserInputRequest.id,
        turnId: agentActivityV2UserInputRequest.params.turnId,
        questions: userInputQuestions,
        answers: {},
        completed: false,
      },
      {
        type: "permissionRequest",
        id: `permission-request-${agentActivityV2PermissionRequest.id}`,
        requestId: agentActivityV2PermissionRequest.id,
        turnId: agentActivityV2PermissionRequest.params.turnId,
        reason: agentActivityV2PermissionRequest.params.reason,
        permissions: agentActivityV2PermissionRequest.params.permissions,
        completed: false,
        response: null,
      },
      {
        type: "mcpServerElicitation",
        id: `mcp-server-elicitation-${agentActivityV2McpElicitationRequest.id}`,
        requestId: agentActivityV2McpElicitationRequest.id,
        turnId: mcpParams.turnId ?? AGENT_ACTIVITY_V2_CORPUS_TURN_ID,
        elicitation,
        completed: false,
        action: null,
      },
    ] satisfies readonly CodexCanonicalRequestSyntheticItem[];
    expect(syntheticItems.length).toBe(3);
    expect(syntheticItems[0]?.requestId).toBe(agentActivityV2UserInputRequest.id);
    expect(Object.prototype.hasOwnProperty.call(syntheticItems[0], "request")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(firstUserInputQuestion, "isOther")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(firstUserInputQuestion, "isSecret")).toBe(false);
    expect(syntheticItems[1]?.type).toBe("permissionRequest");
    expect(syntheticItems[2]?.type).toBe("mcpServerElicitation");
    expect(Object.prototype.hasOwnProperty.call(elicitation, "mode")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(elicitation, "requestedSchema")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(elicitation, "threadId")).toBe(false);
  });

  test("preserves scalar request identity while making internal lookup collision-safe", () => {
    const numeric = createCodexCanonicalProtocolRequest({
      ...agentActivityV2CommandApprovalRequest,
      id: 73,
    });
    const textual = createCodexCanonicalProtocolRequest({
      ...agentActivityV2CommandApprovalRequest,
      id: "73",
    });

    expect(typeof numeric.id).toBe("number");
    expect(typeof textual.id).toBe("string");
    expect(buildCodexCanonicalRequestIdentityKey(numeric.id)).toBe("number:73");
    expect(buildCodexCanonicalRequestIdentityKey(textual.id)).toBe("string:73");
    expect(
      buildCodexCanonicalRequestIdentityKey(numeric.id) ===
        buildCodexCanonicalRequestIdentityKey(textual.id),
    ).toBe(false);
  });

  test("strict protocol normalization accepts the full corpus and valid hidden markers", () => {
    for (const payloadCase of agentActivityV2ItemFamilyCorpus) {
      expect(
        isCodexCanonicalProtocolItem(payloadCase.item),
        `expected protocol corpus case ${payloadCase.id} to pass ingress validation`,
      ).toBe(true);
      const views = projectCodexCanonicalTurnItemViews({
        threadId: "thread-canonical",
        turnId: "turn-canonical",
        items: [materializeCodexCanonicalProtocolItem(payloadCase.item)],
        observedAtMs: 7_300,
        turnStatus: "inProgress",
      });
      for (const view of views) {
        expect(view.rawItemId).toBe(payloadCase.item.id);
        expect(view.createdAt).toBe(7_300);
        expect(view.updatedAt).toBe(7_300);
      }
    }

    const hiddenMarkers = [
      {
        type: "enteredReviewMode",
        id: "review-entered",
        review: "sanitized review",
      },
      {
        type: "exitedReviewMode",
        id: "review-exited",
        review: "sanitized review",
      },
    ] satisfies readonly ThreadItem[];

    for (const marker of hiddenMarkers) {
      expect(isCodexCanonicalProtocolItem(marker)).toBe(true);
      expect(
        projectCodexCanonicalTurnItemViews({
          threadId: "thread-canonical",
          turnId: "turn-canonical",
          items: [materializeCodexCanonicalProtocolItem(marker)],
          observedAtMs: 7_300,
          turnStatus: "inProgress",
        }),
      ).toEqual([]);
    }
  });

  test("retains complete MCP protocol context for the C-02 projection boundary", () => {
    const canonical = createCodexCanonicalProtocolItem(agentActivityV2McpAppContextPrecedenceItem);

    expect(canonical.appContext === agentActivityV2McpAppContextPrecedenceItem.appContext).toBe(
      true,
    );
    expect(Object.keys(canonical.appContext).length).toBe(6);
    expect(canonical.appContext.actionName).toBe("Lookup fixture");
  });
});
