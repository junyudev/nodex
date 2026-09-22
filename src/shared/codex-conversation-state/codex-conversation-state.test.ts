import { replaceCodexCanonicalRollbackThread } from "./codex-rollback-state";
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
  projectCodexCanonicalProtocolThread,
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
      hostId: "local",
      ...{
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
    },
  );
}

describe("protocol-backed canonical conversation state", () => {
  test("rollback replaces protocol history while retaining conversation context", () => {
    const thread = buildAgentActivityV2CorpusThread([]);
    const params = buildCompleteFixtureTurnParams(thread.id, thread.cwd);
    const state = {
      ...createCodexCanonicalConversationState(thread, {
        hostId: "local",
        ...{
          turnParamsById: { [AGENT_ACTIVITY_V2_CORPUS_TURN_ID]: params },
          pendingRequests: [agentActivityV2CommandApprovalRequest],
          hasUnreadTurn: true,
        },
      }),
      previousTurnModel: "previous-model",
      title: "Local title",
      latestModel: "local-model",
      rolloutPath: "/previous/rollout",
    };
    const rolledBack = replaceCodexCanonicalRollbackThread(state, {
      ...thread,
      name: "After rollback",
      model: "server-model",
      updatedAt: 123,
      recencyAt: 456,
      path: null,
      cwd: "",
      sessionId: "rollback-session",
      turns: [],
    });
    expect(rolledBack?.title).toBe("Local title");
    expect(rolledBack?.latestModel).toBe("local-model");
    expect(rolledBack?.createdAt).toBe(state.createdAt);
    expect(rolledBack?.recencyAt).toBe(state.recencyAt);
    expect(rolledBack?.updatedAt).toBe(123000);
    expect(rolledBack?.sessionId).toBe("rollback-session");
    expect(rolledBack?.rolloutPath).toBe("/previous/rollout");
    expect(rolledBack?.cwd).toBe(state.cwd);
    expect(rolledBack?.resumeState).toBe("resumed");
    expect(rolledBack?.turns).toEqual([]);
    expect(rolledBack?.requests).toEqual([]);
    expect(rolledBack?.hasUnreadTurn).toBe(false);
    expect(rolledBack?.previousTurnModel).toBe("previous-model");
    expect(rolledBack?.hydrationContext).toBe(state.hydrationContext);
    expect(state.turns).toHaveLength(1);
    expect(state.requests).toHaveLength(1);
    expect(state.hasUnreadTurn).toBe(true);
  });

  test("rollback hydrates previously nonresident turns using current model and inferred workspace permissions", () => {
    const thread = buildAgentActivityV2CorpusThread([]);
    const state = {
      ...hydrateCanonicalFixtureTurns([]),
      latestModel: "current-model",
      latestReasoningEffort: "high" as const,
      cwd: "/before",
    };
    const responseTurn = {
      ...thread.turns[0]!,
      id: "nonresident",
      items: [
        {
          type: "userMessage" as const,
          id: "opening",
          content: [{ type: "text" as const, text: "retained input", text_elements: [] }],
          clientId: "client-opening",
        },
      ],
    };
    const result = replaceCodexCanonicalRollbackThread(state, {
      ...thread,
      id: state.id,
      cwd: "/after",
      turns: [responseTurn],
    });
    expect(result?.turns[0]?.params).toMatchObject({
      input: responseTurn.items[0]!.content,
      clientUserMessageId: "client-opening",
      model: "current-model",
      effort: "high",
      cwd: "/after",
      permissions: ":workspace",
      runtimeWorkspaceRoots: ["/before"],
      approvalPolicy: "on-request",
    });
    expect(result?.turns[0]?.turnId).toBe("nonresident");
  });

  test.each([null, 0, 1.25, 1730000000.125])(
    "preserves protocol timestamp %s across repeated hydration and projection",
    (startedAt) => {
      const completedAt = startedAt === null ? null : startedAt + 1.25;
      let state = hydrateCanonicalFixtureTurns([
        {
          id: "timestamp-roundtrip",
          items: [],
          itemsView: "full",
          status: "completed",
          error: null,
          startedAt,
          completedAt,
          durationMs: 1250,
        },
      ]);
      for (let cycle = 0; cycle < 3; cycle += 1) {
        expect(state.turns[0]?.turnStartedAtMs).toBe(startedAt === null ? null : startedAt * 1000);
        expect(state.turns[0]?.finalAssistantStartedAtMs).toBeNull();
        expect(state.turns[0]?.assistantMessageStartedAtMsById).toBeUndefined();
        const projected = projectCodexCanonicalProtocolThread(
          state,
          buildAgentActivityV2CorpusThread([]),
        );
        expect(projected.turns[0]).toEqual({
          id: "timestamp-roundtrip",
          items: [],
          itemsView: "full",
          status: "completed",
          error: null,
          startedAt,
          completedAt,
          durationMs: 1250,
        });
        state = hydrateCanonicalFixtureTurns(projected.turns);
      }
    },
  );

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

  test("retains partial turns without requiring a separate item pagination cursor", () => {
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

    const state = hydrateCanonicalFixtureTurns([turn]);
    expect(state.turns[0]?.turnId).toBe(turn.id);
    expect(state.turns[0]?.itemsView).toBe("summary");
    expect(state.turns[0]?.items).toEqual([]);
    expect(state.turns[0]?.params.input).toEqual([]);
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
        openingUserMessageClientId: "opening-client",
        itemsView: "summary",
      },
    });
    expect(state.turns[0]?.params.input).toEqual(openingInput);
    expect(state.turns[0]?.params.clientUserMessageId).toBe("opening-client");
    expect(state.turns[0]?.itemsView).toBe("summary");
  });

  test("finds the opening input past compaction but never treats a partial suffix as the opening", () => {
    const user: ThreadItem = {
      type: "userMessage",
      id: "user",
      clientId: "client",
      content: [{ type: "text", text: "prompt", text_elements: [] }],
    };
    const turn: Turn = {
      id: "turn-opening",
      items: [{ type: "contextCompaction", id: "compaction" }, user],
      itemsView: "full",
      status: "completed",
      error: null,
      startedAt: null,
      completedAt: null,
      durationMs: null,
    };
    const complete = hydrateCanonicalFixtureTurns([turn]).turns[0]!;
    expect(complete.params.input).toEqual(user.content);
    expect(complete.params.clientUserMessageId).toBe("client");
    const partial = hydrateCanonicalFixtureTurns([turn], {
      [turn.id]: {
        olderCursor: "older",
        isLoadingOlder: false,
        hasLoadedOldest: false,
        itemsView: "summary",
      },
    }).turns[0]!;
    expect(partial.params.input).toEqual([]);
    expect(partial.params.clientUserMessageId).toBeUndefined();
    const known = hydrateCanonicalFixtureTurns([turn], {
      [turn.id]: {
        olderCursor: "older",
        isLoadingOlder: false,
        hasLoadedOldest: false,
        itemsView: "summary",
        oldestUserInput: [],
        openingUserMessageId: null,
        openingUserMessageClientId: null,
      },
    }).turns[0]!;
    expect(known.params.input).toEqual([]);
    expect(known.params.clientUserMessageId).toBeNull();
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

    const first = createCodexCanonicalConversationState(thread, { hostId: "local", ...options });
    const second = createCodexCanonicalConversationState(thread, { hostId: "local", ...options });
    const turn = first.turns[0];
    if (!turn) {
      throw new Error("Canonical corpus turn is missing");
    }

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(JSON.stringify(thread)).toBe(serializedThreadBefore);
    expect(Object.prototype.hasOwnProperty.call(first, "protocol")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(first, "sidecar")).toBe(false);
    expect(first.hasUnreadTurn).toBe(false);
    expect(first.hydrationContext).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(turn, "protocol")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(turn, "startedAt")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(turn, "completedAt")).toBe(false);
    expect(turn.items.length).toBe(items.length);
    expect(first.requests.length).toBe(pendingRequests.length);
    expect(Object.prototype.hasOwnProperty.call(turn, "sidecar")).toBe(false);
    expect(turn.params === turnParams).toBe(true);
    expect(turn.params.threadId).toBe(thread.id);
    expect(turn.params.cwd).toBe(thread.cwd);
    expect(turn.turnStartedAtMs).toBe(1000);
    expect(turn.finalAssistantStartedAtMs).toBe(null);
    expect(turn.diff).toBe(null);
    expect(Object.prototype.hasOwnProperty.call(turn, "commandExecutionStartedAtMsById")).toBe(
      false,
    );
    expect(Object.prototype.hasOwnProperty.call(turn, "interruptedCommandExecutionItemIds")).toBe(
      false,
    );
    expect(Object.prototype.hasOwnProperty.call(turn, "hookRuns")).toBe(false);
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
      hostId: "local",
      ...{
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
      },
    });

    const turn = state.turns[0];
    if (!turn) throw new Error("Hydrated production turn is missing");
    expect(turn.items.length).toBe(4);
    expect(turn.items[0] === userMessage).toBe(true);
    expect(turn.items[1] === hidden).toBe(true);
    expect(turn.items[2] === fileChange).toBe(true);
    expect(turn.items[3] === command).toBe(true);
    expect(turn.params.input === userMessage.content).toBe(true);
    expect(turn.params.approvalPolicy).toBe("on-request");
    expect(turn.params.approvalsReviewer).toBe("user");
    expect(turn.params.model).toBe("gpt-fixture");
    expect(turn.params.cwd).toBe("/workspace/project");
    expect(turn.params.effort).toBe("high");
    expect(JSON.stringify(turn.params.attachments)).toBe(
      JSON.stringify([
        {
          label: "fixture",
          path: "/workspace/project/file.ts",
          fsPath: "/workspace/project/file.ts",
        },
      ]),
    );
    expect(turn.params.sandboxPolicy?.type).toBe("workspaceWrite");
    expect(Object.prototype.hasOwnProperty.call(turn.params, "permissions")).toBe(false);
    expect(state.hydrationContext?.model ?? null).toBe("gpt-fixture");
    expect(state.hydrationContext?.cwd ?? null).toBe("/workspace/project");
    expect(state.currentPermissions?.sandboxPolicy.type ?? null).toBe("workspaceWrite");
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
    ] satisfies Extract<
      ThreadItem,
      {
        type: "userMessage";
      }
    >["content"];
    const ordinaryInput = [
      {
        type: "text",
        text: "Continue normally",
        text_elements: [],
      },
    ] satisfies Extract<
      ThreadItem,
      {
        type: "userMessage";
      }
    >["content"];
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
    expect(hydrated.turns[0]?.params.input === heartbeatInput).toBe(true);
    expect(hydrated.turns[1]?.params.input === ordinaryInput).toBe(true);
    const canonical = canonicalizeCodexCanonicalTurnStates(hydrated.turns);
    expect(canonical.length).toBe(1);
    expect(canonical[0]?.params.input === heartbeatInput).toBe(true);
  });

  test("hydrates active permission profiles with required runtime roots", () => {
    const thread = buildAgentActivityV2CorpusThread([]);
    const state = createCodexCanonicalHydratedConversationState(thread, {
      hostId: "local",
      ...{
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
      },
    });
    const params = state.turns[0]?.params;
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
        hostId: "local",
        ...{
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
    expect(JSON.stringify(latestTurn?.hookRuns ?? null)).toBe("[]");
    expect(isCodexCanonicalProtocolItem(marker)).toBe(false);

    const synthesized = appendCodexCanonicalForkedFromConversationItem(
      { ...base, turns: [] },
      marker,
    ).turns[0];
    expect(synthesized?.turnId).toBe(null);
    expect(synthesized?.status).toBe("completed");
    expect(synthesized?.turnStartedAtMs).toBe(null);
    expect(synthesized?.firstTurnWorkItemStartedAtMs).toBe(null);
    expect(synthesized?.params.model).toBe(null);
    expect(synthesized?.params.effort).toBe("minimal");
    expect(Object.prototype.hasOwnProperty.call(synthesized?.params ?? {}, "attachments")).toBe(
      false,
    );
    expect(JSON.stringify(synthesized?.hookRuns ?? null)).toBe("[]");
  });

  test("places worktree init in the optimistic first turn and isolates fork initialization", () => {
    const base = createCodexCanonicalHydratedConversationState(
      buildAgentActivityV2CorpusThread([]),
      {
        hostId: "local",
        ...{
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
    expect(appendedToLatest.turns.at(-1)?.status).toBe(base.turns.at(-1)?.status);

    const forkInit = appendCodexCanonicalWorktreeInitItem(base, item, "new-turn");
    const forkInitTurn = forkInit.turns.at(-1);
    expect(forkInit.turns.length).toBe(base.turns.length + 1);
    expect(forkInitTurn?.turnId).toBe(null);
    expect(forkInitTurn?.status).toBe("completed");
    expect(forkInitTurn?.items[0] === item).toBe(true);
    expect(forkInitTurn?.params.approvalPolicy).toBe("never");
    expect(forkInitTurn?.params.approvalsReviewer).toBe("guardian_subagent");
    expect(forkInitTurn?.params.sandboxPolicy?.type).toBe("workspaceWrite");
    expect(forkInitTurn?.params.model).toBe(null);
    expect(forkInitTurn?.params.effort).toBe("minimal");
    expect(forkInitTurn?.turnStartedAtMs).toBe(null);
    expect(isCodexCanonicalProtocolItem(item)).toBe(false);

    const rendererReloadTurns = mergeCodexCanonicalTurnStates(forkInit.turns, base.turns);
    expect(rendererReloadTurns.flatMap((turn) => turn.items)).toContain(item);
    expect(rendererReloadTurns.filter((turn) => turn.turnId === null)).toHaveLength(1);

    const noTurns = appendCodexCanonicalWorktreeInitItem({ ...base, turns: [] }, item);
    expect(noTurns.turns.length).toBe(1);
    expect(noTurns.turns[0]?.status).toBe("completed");
    expect(noTurns.turns[0]?.items[0] === item).toBe(true);
  });

  test("creates and cancels an in-progress local compaction occurrence", () => {
    const base = createCodexCanonicalHydratedConversationState(
      buildAgentActivityV2CorpusThread([]),
      {
        hostId: "local",
        ...{
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

    expect(pending.turns[0]?.turnId).toBe(null);
    expect(pending.turns[0]?.status).toBe("inProgress");
    expect(pending.turns[0]?.turnStartedAtMs).toBe(42);
    expect(pending.turns[0]?.items).toStrictEqual([placeholder]);
    expect(appendCodexCanonicalInProgressSyntheticItem(pending, placeholder, 43)).toBe(pending);

    const cancelled = removeCodexCanonicalLocalSyntheticItem(pending, placeholder.id);
    expect(cancelled.turns).toStrictEqual([]);

    const completed = {
      ...pending,
      turns: pending.turns.map((turn) => ({
        ...turn,
        status: "completed" as const,
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
    expect(merged.map((turn) => turn.turnId).join(",")).toBe(
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
    expect(anchored.map((turn) => turn.turnId).join(",")).toBe(
      "turn-a,turn-b,turn-c,turn-d,turn-e",
    );
  });

  test("merges lifecycle metadata monotonically without reopening terminal items", () => {
    const template = buildAgentActivityV2CorpusThread([]).turns[0];
    if (!template) throw new Error("Canonical turn fixture is missing");
    const existing = hydrateCanonicalFixtureTurns([template]).turns[0];
    if (!existing) throw new Error("Canonical turn fixture is missing");
    const incoming = {
      ...existing,
      lifecycleStatusByItemId: {
        "reasoning-live": "completed" as const,
        "reasoning-terminal": "completed" as const,
      },
    };
    const current = {
      ...existing,
      lifecycleStatusByItemId: {
        "reasoning-live": "inProgress" as const,
        "reasoning-terminal": "completed" as const,
      },
    };

    const merged = mergeCodexCanonicalTurnState(current, incoming);
    expect(merged.lifecycleStatusByItemId).toEqual({
      "reasoning-live": "completed",
      "reasoning-terminal": "completed",
    });
  });

  test("preserves async questions and delivery while reconciling a shorter hydrated turn", () => {
    const template = buildAgentActivityV2CorpusThread([]).turns[0];
    if (!template) throw new Error("Canonical turn fixture is missing");
    const base = hydrateCanonicalFixtureTurns([template]).turns[0];
    if (!base) throw new Error("Canonical turn fixture is missing");
    const existingMessage = {
      questions: [{ title: "Which scope?", options: ["Project", "Library"] }],
      type: "agentMessage",
      id: "live-final",
      text: "Which scope?\n- Project\n- Library",
      phase: "final_answer",
      memoryCitation: null,
      delivery: "async",
    } satisfies ThreadItem;
    const hydratedMessage = {
      ...existingMessage,
      id: "hydrated-final",
      delivery: null,
      questions: null,
    } satisfies ThreadItem;

    const merged = mergeCodexCanonicalTurnState(
      {
        ...base,
        items: [existingMessage, { type: "plan", id: "live-plan", text: "Done" }],
      },
      { ...base, items: [hydratedMessage] },
    );

    expect(merged.items[0]).toMatchObject({
      id: "live-final",
      type: "agentMessage",
      delivery: "async",
      questions: existingMessage.questions,
    });
  });

  test("keeps distinct asynchronous calls with identical question text when hydrating a shorter tail", () => {
    const template = buildAgentActivityV2CorpusThread([]).turns[0]!;
    const base = hydrateCanonicalFixtureTurns([template]).turns[0]!;
    const first: ThreadItem = {
      type: "agentMessage",
      id: "ask-first",
      text: "Which scope?",
      phase: "final_answer",
      delivery: "async",
      memoryCitation: null,
      questions: [{ title: "Which scope?", options: null }],
    };
    const second = { ...first, id: "ask-second" };
    const merged = mergeCodexCanonicalTurnState(
      { ...base, items: [first, { type: "plan", id: "plan", text: "Working" }] },
      { ...base, items: [second] },
    );
    expect(
      merged.items.filter((item) => item.type === "agentMessage").map((item) => item.id),
    ).toEqual(["ask-first", "ask-second"]);
  });

  test("rejects hydration when exact app-side turn context is unavailable", () => {
    const thread = buildAgentActivityV2CorpusThread([]);
    let error: unknown = null;

    try {
      createCodexCanonicalConversationState(thread, { hostId: "local", ...{ turnParamsById: {} } });
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
      hostId: "local",
      ...{
        turnParamsById: {
          [AGENT_ACTIVITY_V2_CORPUS_TURN_ID]: turnParams,
        },
      },
    });
    expect(state.turns[0]?.params === turnParams).toBe(true);
    expect(state.turns[0]?.params.model).toBe("fixture-model");
    expect(state.turns[0]?.params.attachments === attachments).toBe(true);
    expect(state.turns[0]?.params.commentAttachments === commentAttachments).toBe(true);
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
      hostId: "local",
      ...{
        turnParamsById: {
          [AGENT_ACTIVITY_V2_CORPUS_TURN_ID]: buildCompleteFixtureTurnParams(thread.id, thread.cwd),
        },
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
      hostId: "local",
      ...{
        turnParamsById: {
          [AGENT_ACTIVITY_V2_CORPUS_TURN_ID]: profileParams,
        },
      },
    });
    const liveState = createCodexCanonicalConversationState(thread, {
      hostId: "local",
      ...{
        turnParamsById: {
          [AGENT_ACTIVITY_V2_CORPUS_TURN_ID]: liveParams,
        },
      },
    });
    expect(profileState.turns[0]?.params === profileParams).toBe(true);
    expect(profileState.turns[0]?.params.runtimeWorkspaceRoots?.[0]).toBe("/workspace/project");
    expect(liveState.turns[0]?.params === liveParams).toBe(true);
    expect(liveState.turns[0]?.params.sandboxPolicy?.type).toBe("workspaceWrite");
    expect(liveState.turns[0]?.params.permissions).toBe("fixture-profile");
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
        observedAtMs: 7300,
        turnStatus: "inProgress",
      });
      for (const view of views) {
        expect(view.rawItemId).toBe(payloadCase.item.id);
        expect(view.createdAt).toBe(7300);
        expect(view.updatedAt).toBe(7300);
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
          observedAtMs: 7300,
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

test("resume overlap closes reconnect using the resident Turn pagination anchor", () => {
  const template = buildAgentActivityV2CorpusThread([]).turns[0]!;
  const base = hydrateCanonicalFixtureTurns([template]).turns[0]!;
  const stop = { type: "plan" as const, id: "snapshot-stop", text: "saved" };
  const existing = {
    ...base,
    items: [stop],
    itemsPagination: {
      olderCursor: "resume-current",
      isLoadingOlder: false,
      hasLoadedOldest: false,
      itemsView: "summary" as const,
      reconnect: { beforeItemId: "before", stopItemId: stop.id, olderCursorAfterReconnect: null },
    },
  };
  const incoming = {
    ...base,
    items: [stop, { type: "plan" as const, id: "latest", text: "new" }],
    itemsPagination: {
      olderCursor: "server-cursor",
      isLoadingOlder: false,
      hasLoadedOldest: false,
      itemsView: "summary" as const,
    },
  };
  const merged = mergeCodexCanonicalTurnState(existing, incoming, { isResumeSnapshot: true });
  expect(merged.itemsPagination?.olderCursor).toBeNull();
  expect(merged.itemsPagination?.hasLoadedOldest).toBe(true);
  expect(merged.itemsPagination?.reconnect).toBeUndefined();
  expect(merged.items.map((item) => item.id)).toEqual(["snapshot-stop", "latest"]);
});

test("merges per-assistant starts without substituting a turn completion time", () => {
  const template = buildAgentActivityV2CorpusThread([]).turns[0]!;
  const existing = hydrateCanonicalFixtureTurns([{ ...template, startedAt: 1, completedAt: 9 }])
    .turns[0]!;
  expect(existing.finalAssistantStartedAtMs).toBeNull();
  expect(existing.completedAtMs).toBe(9000);
  const merged = mergeCodexCanonicalTurnState(
    { ...existing, assistantMessageStartedAtMsById: { commentary: 2000, final: 5000 } },
    { ...existing, assistantMessageStartedAtMsById: { earlier: 1500, final: 6000 } },
  );
  expect(merged.assistantMessageStartedAtMsById).toEqual({
    earlier: 1500,
    commentary: 2000,
    final: 5000,
  });
  const hydratedAgain = mergeCodexCanonicalTurnState(merged, existing, { isResumeSnapshot: true });
  expect(hydratedAgain.assistantMessageStartedAtMsById).toEqual(
    merged.assistantMessageStartedAtMsById,
  );
  expect(hydratedAgain.finalAssistantStartedAtMs).toBeNull();
});
