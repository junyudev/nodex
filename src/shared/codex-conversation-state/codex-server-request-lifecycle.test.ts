import { describe, expect, test } from "vite-plus/test";
import type { ServerRequest } from "@nodex/codex-app-server-protocol";
import {
  createCodexCanonicalConversationState,
  type CodexCanonicalConversationState,
  type CodexCanonicalOptionPickerRequest,
  type CodexCanonicalPlanImplementationRequest,
  type CodexCanonicalSetupContextPickerRequest,
  type CodexCanonicalTurnParams,
} from "./codex-conversation-state";
import {
  applyCodexCanonicalPlanImplementationTurnStartedState,
  applyCodexPlanImplementationTurnStartedRawState,
  classifyCodexCanonicalServerRequest,
  completeCodexCanonicalPlanImplementationRequest,
  createCodexCanonicalPlanImplementationRequest,
  normalizeCodexCanonicalMcpElicitation,
  reduceCodexConversationApprovalResponse,
  reduceCodexConversationMcpElicitationResponse,
  reduceCodexConversationOnboardingInputResponse,
  reduceCodexConversationOptionPickerResponse,
  reduceCodexConversationPermissionResponse,
  reduceCodexConversationServerRequest,
  reduceCodexConversationServerRequestResolved,
  reduceCodexConversationSetupContextPickerResponse,
  reduceCodexConversationUserInputResponse,
  reduceCodexServerRequestApprovalResponseRawState,
  reduceCodexServerRequestOptionPickerResponseRawState,
  reduceCodexServerRequestSetupCodexStepResponseRawState,
  reduceCodexServerRequestSetupContextPickerResponseRawState,
  reduceCodexServerRequestRawState,
  type CodexServerRequestRawState,
} from "./codex-server-request-lifecycle";
import {
  AGENT_ACTIVITY_V2_CORPUS_THREAD_ID as THREAD_ID,
  AGENT_ACTIVITY_V2_CORPUS_TURN_ID as TURN_ID,
  buildAgentActivityV2CorpusThread,
} from "./test-fixtures/agent-activity-v2-corpus-provenance";
import {
  agentActivityV2CommandApprovalRequest,
  agentActivityV2FileApprovalRequest,
  agentActivityV2DynamicOptionPickerRequest,
  agentActivityV2DynamicToolRequest,
  agentActivityV2McpElicitationRequest,
  agentActivityV2OneShotRequestCases,
  agentActivityV2PendingResolvedRequestCases,
  agentActivityV2PermissionRequest,
  agentActivityV2UserInputRequest,
} from "./test-fixtures/agent-activity-v2-request-family-corpus";

const NOW = 1_234_567;

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
  options: { readonly hasUnreadTurn?: boolean } = {},
): CodexCanonicalConversationState {
  return createCodexCanonicalConversationState(buildAgentActivityV2CorpusThread([]), {
    turnParamsById: { [TURN_ID]: buildTurnParams() },
    hasUnreadTurn: options.hasUnreadTurn,
  });
}

function context(isOpenAIFormElicitationsEnabled?: boolean) {
  return {
    now: () => NOW,
    isOpenAIFormElicitationsEnabled,
  };
}

function resolved(requestId: string | number) {
  return {
    method: "serverRequest/resolved" as const,
    params: { threadId: THREAD_ID, requestId },
  };
}

describe("Codex 30751 server-request lifecycle", () => {
  test("appends exact approval envelopes in arrival order and keeps unread independent", () => {
    const initial = buildState();
    const first = reduceCodexConversationServerRequest(
      initial,
      agentActivityV2CommandApprovalRequest,
      context(),
    );
    const second = reduceCodexConversationServerRequest(
      first.state,
      agentActivityV2CommandApprovalRequest,
      context(),
    );

    expect(initial.sidecar.hasUnreadTurn).toBe(false);
    expect(first.disposition).toBe("stored");
    expect(first.state.requests[0] === agentActivityV2CommandApprovalRequest).toBe(true);
    expect(second.state.requests.length).toBe(2);
    expect(second.state.requests[1] === agentActivityV2CommandApprovalRequest).toBe(true);
    expect(second.state.sidecar.hasUnreadTurn).toBe(true);
    expect(second.state.turns[0]?.items.length).toBe(0);
    expect(first.effects[0]?.type).toBe("approvalRequestReceived");

    const hydratedUnread = buildState({ hasUnreadTurn: true });
    expect(hydratedUnread.requests.length).toBe(0);
    expect(hydratedUnread.sidecar.hasUnreadTurn).toBe(true);
  });

  test("upserts exact permission synthetics, resolves all strict-ID requests, and never clears unread", () => {
    const collisionId = `permission-request-${agentActivityV2PermissionRequest.id}`;
    const initial = buildState();
    const withCollision: CodexCanonicalConversationState = {
      ...initial,
      turns: [
        {
          ...initial.turns[0]!,
          items: [{ type: "contextCompaction", id: collisionId }],
        },
      ],
    };
    const pending = reduceCodexConversationServerRequest(
      withCollision,
      agentActivityV2PermissionRequest,
      context(),
    );
    const duplicateRequest = {
      ...agentActivityV2PermissionRequest,
      params: {
        ...agentActivityV2PermissionRequest.params,
        reason: "Later duplicate reason",
      },
    } satisfies ServerRequest;
    const duplicated = reduceCodexConversationServerRequest(
      pending.state,
      duplicateRequest,
      context(),
    );
    const completed = reduceCodexConversationServerRequestResolved(
      duplicated.state,
      resolved(agentActivityV2PermissionRequest.id),
      context(),
    );
    const item = completed.state.turns[0]?.items[0];

    expect(pending.state.turns[0]?.items.length).toBe(1);
    expect(pending.state.turns[0]?.sidecar.hookRuns?.length).toBe(0);
    expect(item?.type).toBe("permissionRequest");
    expect(item && "completed" in item ? item.completed : null).toBe(true);
    expect(item && "reason" in item ? item.reason : null).toBe(
      agentActivityV2PermissionRequest.params.reason,
    );
    expect(item && "response" in item ? item.response : "missing").toBe(null);
    expect(completed.state.requests.length).toBe(0);
    expect(completed.selectedRequests[0] === agentActivityV2PermissionRequest).toBe(true);
    expect(completed.state.sidecar.hasUnreadTurn).toBe(true);
  });

  test("executes the five pending/resolved corpus rows through the shared reducer", () => {
    expect(agentActivityV2PendingResolvedRequestCases.length).toBe(5);
    for (const requestCase of agentActivityV2PendingResolvedRequestCases) {
      const pending = reduceCodexConversationServerRequest(
        buildState(),
        requestCase.request,
        context(),
      );
      const pendingItem = pending.state.turns[0]?.items[0];
      expect(pending.disposition).toBe("stored");
      expect(pending.state.requests.length).toBe(1);
      expect(pending.state.requests[0] === requestCase.request).toBe(true);
      expect(pending.state.sidecar.hasUnreadTurn).toBe(true);
      expect(pendingItem?.type ?? "none").toBe(requestCase.effect.syntheticItem);

      const completed = reduceCodexConversationServerRequestResolved(
        pending.state,
        resolved(requestCase.request.id),
        context(),
      );
      const completedItem = completed.state.turns[0]?.items[0];
      expect(completed.disposition).toBe("resolved");
      expect(completed.state.requests.length).toBe(0);
      expect(completed.selectedRequests[0] === requestCase.request).toBe(true);
      if (requestCase.effect.resolution === "complete-synthetic-and-remove") {
        expect(
          completedItem && "completed" in completedItem ? completedItem.completed : false,
        ).toBe(true);
      } else {
        expect(completedItem?.type ?? "none").toBe("none");
      }
    }
  });

  test("executes the seven one-shot corpus rows through the shared reducer", () => {
    expect(agentActivityV2OneShotRequestCases.length).toBe(7);
    for (const requestCase of agentActivityV2OneShotRequestCases) {
      const requests = requestCase.fixture.events.flatMap((event) =>
        event.type === "request" ? [event.request] : [],
      );
      expect(requests.length).toBe(requestCase.effects.length);
      requests.forEach((request, index) => {
        const result = reduceCodexConversationServerRequest(buildState(), request, context());
        const expected = requestCase.effects[index];
        const expectedDisposition =
          expected?.ingress === "auto-responded"
            ? "responded"
            : expected?.ingress === "dispatched"
              ? "dispatched"
              : expected?.ingress === "ignored"
                ? "ignored"
                : "stored";
        expect(result.disposition).toBe(expectedDisposition);
      });
    }
  });

  test("preserves scalar RequestId identity even when numeric and string synthetic IDs collide", () => {
    const numeric = { ...agentActivityV2PermissionRequest, id: 73 } satisfies ServerRequest;
    const string = { ...agentActivityV2PermissionRequest, id: "73" } satisfies ServerRequest;
    const numericPending = reduceCodexConversationServerRequest(buildState(), numeric, context());
    const bothPending = reduceCodexConversationServerRequest(
      numericPending.state,
      string,
      context(),
    );
    const numericResolved = reduceCodexConversationServerRequestResolved(
      bothPending.state,
      resolved(73),
      context(),
    );
    const item = numericResolved.state.turns[0]?.items[0];

    expect(bothPending.state.requests.length).toBe(2);
    expect(bothPending.state.turns[0]?.items.length).toBe(1);
    expect(item && "requestId" in item ? item.requestId : null).toBe(73);
    expect(item && "completed" in item ? item.completed : null).toBe(true);
    expect(numericResolved.state.requests.length).toBe(1);
    expect(numericResolved.state.requests[0]?.id).toBe("73");
  });

  test("maps user questions to the historical shape and rebinds the sole empty placeholder", () => {
    const initial = buildState();
    const placeholder: CodexCanonicalConversationState = {
      ...initial,
      turns: [
        {
          ...initial.turns[0]!,
          protocol: {
            ...initial.turns[0]!.protocol,
            id: null,
            status: "completed",
            error: null,
          },
          items: [],
          sidecar: {
            ...initial.turns[0]!.sidecar,
            turnStartedAtMs: null,
          },
        },
      ],
    };
    const pending = reduceCodexConversationServerRequest(
      placeholder,
      agentActivityV2UserInputRequest,
      context(),
    );
    const item = pending.state.turns[0]?.items[0];
    const question = item?.type === "userInputResponse" ? item.questions[0] : undefined;

    expect(pending.state.turns[0]?.protocol.id).toBe(TURN_ID);
    expect(pending.state.turns[0]?.protocol.status).toBe("inProgress");
    expect(pending.state.turns[0]?.sidecar.turnStartedAtMs).toBe(NOW);
    expect(item?.type).toBe("userInputResponse");
    expect(question?.options.length).toBe(2);
    expect(Object.prototype.hasOwnProperty.call(question ?? {}, "isOther")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(question ?? {}, "isSecret")).toBe(false);
    expect(pending.effects[0]?.type).toBe("userInputRequestReceived");
  });

  test("uses the ingress OpenAI-form flag but recomputes resolved MCP state with OW defaults", () => {
    const pending = reduceCodexConversationServerRequest(
      buildState(),
      agentActivityV2McpElicitationRequest,
      context(false),
    );
    const pendingItem = pending.state.turns[0]?.items[0];
    const completed = reduceCodexConversationServerRequestResolved(
      pending.state,
      resolved(agentActivityV2McpElicitationRequest.id),
      context(false),
    );
    const completedItem = completed.state.turns[0]?.items[0];

    expect(pendingItem && "elicitation" in pendingItem ? pendingItem.elicitation.kind : null).toBe(
      "unsupportedOpenAIForm",
    );
    expect(
      completedItem && "elicitation" in completedItem ? completedItem.elicitation.kind : null,
    ).toBe("openaiForm");
    expect(completedItem && "completed" in completedItem ? completedItem.completed : null).toBe(
      true,
    );
  });

  test("normalizes every OW family and declines only unrenderable MCP requests", () => {
    const urlAction = normalizeCodexCanonicalMcpElicitation({
      threadId: THREAD_ID,
      turnId: TURN_ID,
      serverName: "fixture",
      mode: "url",
      _meta: { riskLevel: "high", subtitle: "Review" },
      message: "Open",
      url: "https://example.invalid/path",
      elicitationId: "url-1",
    });
    const connectorAuth = normalizeCodexCanonicalMcpElicitation({
      threadId: THREAD_ID,
      turnId: TURN_ID,
      serverName: "codex_apps",
      mode: "url",
      _meta: {
        _codex_apps: {
          connector_auth_failure: {
            is_auth_failure: true,
            connector_id: "drive",
            connector_name: "Drive",
            install_url: "https://evil.invalid/install",
            requested_scopes: ["read"],
          },
        },
      },
      message: "Connect",
      url: "https://chatgpt.com/connect",
      elicitationId: "url-2",
    });
    const toolSuggestion = normalizeCodexCanonicalMcpElicitation({
      threadId: THREAD_ID,
      turnId: TURN_ID,
      serverName: "fixture",
      mode: "form",
      _meta: {
        codex_approval_kind: "tool_suggestion",
        suggest_type: "install",
        suggest_reason: "Needed",
        tool_id: "tool",
        tool_name: "Tool",
        tool_type: "plugin",
        remote_plugin_id: "remote",
      },
      message: "Install",
      requestedSchema: { type: "object", properties: {} },
    });
    const mcpToolCall = normalizeCodexCanonicalMcpElicitation({
      threadId: THREAD_ID,
      turnId: TURN_ID,
      serverName: "fixture",
      mode: "form",
      _meta: {
        codex_approval_kind: "mcp_tool_call",
        connector_id: "fixture",
        tool_params: { path: "/tmp" },
        tool_params_display: [{ name: "path", display_name: "Path", value: "/tmp" }],
      },
      message: "Run",
      requestedSchema: { type: "object", properties: {} },
    });
    const computerUse = normalizeCodexCanonicalMcpElicitation({
      threadId: THREAD_ID,
      turnId: TURN_ID,
      serverName: "computer-use",
      mode: "form",
      _meta: { persist: ["session", "always"] },
      message: "Allow Codex to use Safari?",
      requestedSchema: { type: "object", properties: {} },
    });
    const generic = normalizeCodexCanonicalMcpElicitation({
      threadId: THREAD_ID,
      turnId: TURN_ID,
      serverName: "browser",
      mode: "form",
      _meta: { persist: "always", origin: "https://example.invalid" },
      message: "Allow",
      requestedSchema: { type: "object", properties: {} },
    });
    const form = normalizeCodexCanonicalMcpElicitation({
      threadId: THREAD_ID,
      turnId: TURN_ID,
      serverName: "fixture",
      mode: "form",
      _meta: null,
      message: "Input",
      requestedSchema: { type: "object", properties: {} },
    });

    expect(urlAction?.kind).toBe("urlAction");
    expect(urlAction && "riskLevel" in urlAction ? urlAction.riskLevel : null).toBe("high");
    expect(connectorAuth?.kind).toBe("connectorAuth");
    expect(
      connectorAuth && "connector" in connectorAuth ? connectorAuth.connector.install_url : null,
    ).toBe("https://chatgpt.com/connect");
    expect(toolSuggestion?.kind).toBe("toolSuggestion");
    expect(mcpToolCall?.kind).toBe("mcpToolCall");
    expect(
      mcpToolCall && "toolParamsDisplay" in mcpToolCall
        ? mcpToolCall.toolParamsDisplay?.[0]?.displayName
        : null,
    ).toBe("Path");
    expect(
      mcpToolCall && "toolParamsDisplay" in mcpToolCall
        ? mcpToolCall.toolParamsDisplay?.length
        : null,
    ).toBe(1);
    expect(computerUse?.kind).toBe("mcpToolCall");
    expect(generic?.kind).toBe("generic");
    expect(form?.kind).toBe("formElicitation");

    const invalid = {
      id: "invalid-url",
      method: "mcpServer/elicitation/request",
      params: {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        serverName: "fixture",
        mode: "url",
        _meta: null,
        message: "Open",
        url: "http://example.invalid",
        elicitationId: "invalid",
      },
    } satisfies ServerRequest;
    const declined = reduceCodexConversationServerRequest(buildState(), invalid, context());
    const unknownModeParams = {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      serverName: "fixture",
      mode: "future/form",
      _meta: null,
      message: "Unknown form mode",
      requestedSchema: { type: "object", properties: {} },
    } as unknown as Parameters<typeof normalizeCodexCanonicalMcpElicitation>[0];
    const unknownMode = normalizeCodexCanonicalMcpElicitation(unknownModeParams);
    const unknownDeclined = reduceCodexConversationServerRequest(
      buildState(),
      {
        id: "unknown-mcp-mode",
        method: "mcpServer/elicitation/request",
        params: unknownModeParams,
      } as unknown as ServerRequest,
      context(),
    );
    const effect = declined.effects[0];
    expect(declined.state.requests.length).toBe(0);
    expect(declined.disposition).toBe("responded");
    expect(effect?.type).toBe("respond");
    expect(
      effect?.type === "respond" && "action" in effect.response ? effect.response.action : null,
    ).toBe("decline");
    expect(unknownMode).toBe(null);
    expect(unknownDeclined.disposition).toBe("responded");
    expect(unknownDeclined.state.requests.length).toBe(0);
    expect(
      unknownDeclined.effects[0]?.type === "respond" &&
        "action" in unknownDeclined.effects[0].response
        ? unknownDeclined.effects[0].response.action
        : null,
    ).toBe("decline");
  });

  test("matches OW metadata parsing, trim transforms, and display-list rejection", () => {
    const nullableDisplayMeta = normalizeCodexCanonicalMcpElicitation({
      threadId: THREAD_ID,
      turnId: TURN_ID,
      serverName: "fixture",
      mode: "url",
      _meta: { riskLevel: null, subtitle: "Review details" },
      message: "Open",
      url: "https://example.invalid/path",
      elicitationId: "nullable-display-meta",
    });
    const invalidDisplayMeta = normalizeCodexCanonicalMcpElicitation({
      threadId: THREAD_ID,
      turnId: TURN_ID,
      serverName: "fixture",
      mode: "url",
      _meta: { riskLevel: "medium", subtitle: "Must also be discarded" },
      message: "Open",
      url: "https://example.invalid/path",
      elicitationId: "invalid-display-meta",
    });
    const connectorAuth = normalizeCodexCanonicalMcpElicitation({
      threadId: THREAD_ID,
      turnId: TURN_ID,
      serverName: "codex_apps",
      mode: "url",
      _meta: {
        _codex_apps: {
          connector_auth_failure: {
            is_auth_failure: true,
            connector_id: "drive",
            connector_name: "Drive",
            install_url: "https://chatgpt.com/install",
            requested_scopes: [" read ", "write"],
          },
        },
      },
      message: "Connect",
      url: "https://chatgpt.com/connect",
      elicitationId: "trim-scopes",
    });
    const suggestion = normalizeCodexCanonicalMcpElicitation({
      threadId: THREAD_ID,
      turnId: TURN_ID,
      serverName: "fixture",
      mode: "form",
      _meta: {
        codex_approval_kind: "tool_suggestion",
        suggest_type: "install",
        suggest_reason: "Needed",
        tool_id: "tool",
        tool_name: "Tool",
        tool_type: "plugin",
        remote_plugin_id: " remote-plugin ",
      },
      message: "Install",
      requestedSchema: { type: "object", properties: {} },
    });
    const invalidDisplayList = normalizeCodexCanonicalMcpElicitation({
      threadId: THREAD_ID,
      turnId: TURN_ID,
      serverName: "fixture",
      mode: "form",
      _meta: {
        codex_approval_kind: "mcp_tool_call",
        connector_id: "fixture",
        tool_params: { path: "/tmp" },
        tool_params_display: [{ name: "path", display_name: 42, value: "/tmp" }],
      },
      message: "Run",
      requestedSchema: { type: "object", properties: {} },
    });

    expect(nullableDisplayMeta?.kind).toBe("urlAction");
    expect(nullableDisplayMeta && "riskLevel" in nullableDisplayMeta).toBe(false);
    expect(
      nullableDisplayMeta && "subtitle" in nullableDisplayMeta
        ? nullableDisplayMeta.subtitle
        : null,
    ).toBe("Review details");
    expect(invalidDisplayMeta?.kind).toBe("urlAction");
    expect(invalidDisplayMeta && "riskLevel" in invalidDisplayMeta).toBe(false);
    expect(invalidDisplayMeta && "subtitle" in invalidDisplayMeta).toBe(false);
    expect(connectorAuth?.kind).toBe("connectorAuth");
    expect(
      connectorAuth && "connector" in connectorAuth
        ? JSON.stringify(connectorAuth.connector.requested_scopes)
        : null,
    ).toBe(JSON.stringify(["read", "write"]));
    expect(suggestion?.kind).toBe("toolSuggestion");
    expect(
      suggestion && "suggestion" in suggestion ? suggestion.suggestion.remote_plugin_id : null,
    ).toBe("remote-plugin");
    expect(invalidDisplayList?.kind).toBe("mcpToolCall");
    expect(invalidDisplayList && "toolParamsDisplay" in invalidDisplayList).toBe(true);
    expect(
      invalidDisplayList && "toolParamsDisplay" in invalidDisplayList
        ? (invalidDisplayList.toolParamsDisplay ?? null)
        : "missing",
    ).toBe(null);
  });

  test("matches OpenAI-form union degradation and image-picker scalar identity", () => {
    const degraded = normalizeCodexCanonicalMcpElicitation({
      threadId: THREAD_ID,
      turnId: TURN_ID,
      serverName: "fixture",
      mode: "openai/form",
      _meta: null,
      message: "Input",
      requestedSchema: {
        type: "object",
        properties: {
          enumFallback: {
            type: "string",
            title: "Enum fallback",
            enum: ["a"],
            enumNames: [7],
            minLength: "ignored by the enum branch",
            format: "also-ignored",
          },
          oneOfFallback: {
            type: "string",
            title: "One-of fallback",
            oneOf: [{ const: "a", title: 7 }],
          },
          oneOfValid: {
            type: "string",
            oneOf: [{ const: "a", title: "A" }],
          },
        },
      },
    });
    const postTrimDuplicateIds = normalizeCodexCanonicalMcpElicitation({
      threadId: THREAD_ID,
      turnId: TURN_ID,
      serverName: "fixture",
      mode: "openai/form",
      _meta: null,
      message: "Pick",
      requestedSchema: {
        type: "object",
        properties: {
          image: {
            type: "openai/imagePicker",
            items: [
              { id: "image", title: "Image", image: "data:image/png;base64,QQ==" },
              { id: " image ", title: " Image ", image: "data:image/png;base64,Qg==" },
            ],
          },
        },
      },
    });
    const exactDuplicateIds = normalizeCodexCanonicalMcpElicitation({
      threadId: THREAD_ID,
      turnId: TURN_ID,
      serverName: "fixture",
      mode: "openai/form",
      _meta: null,
      message: "Pick",
      requestedSchema: {
        type: "object",
        properties: {
          image: {
            type: "openai/imagePicker",
            items: [
              { id: "image", title: "One", image: "data:image/png;base64,QQ==" },
              { id: "image", title: "Two", image: "data:image/png;base64,Qg==" },
            ],
          },
        },
      },
    });

    expect(degraded?.kind).toBe("openaiForm");
    expect(degraded && "schema" in degraded ? JSON.stringify(degraded.schema) : null).toBe(
      JSON.stringify({
        type: "object",
        properties: {
          enumFallback: {
            type: "string",
            title: "Enum fallback",
            enum: ["a"],
          },
          oneOfFallback: {
            type: "string",
            title: "One-of fallback",
          },
          oneOfValid: {
            type: "string",
            oneOf: [{ const: "a", title: "A" }],
          },
        },
      }),
    );
    expect(postTrimDuplicateIds?.kind).toBe("openaiForm");
    expect(
      postTrimDuplicateIds && "schema" in postTrimDuplicateIds
        ? JSON.stringify(postTrimDuplicateIds.schema)
        : null,
    ).toBe(
      JSON.stringify({
        type: "object",
        properties: {
          image: {
            type: "openai/imagePicker",
            items: [
              { id: "image", title: "Image", image: "data:image/png;base64,QQ==" },
              { id: " image ", title: " Image ", image: "data:image/png;base64,Qg==" },
            ],
          },
        },
      }),
    );
    expect(exactDuplicateIds?.kind).toBe("unsupportedOpenAIForm");
  });

  test("validates special dynamic calls before storing and dispatches ordinary or complete calls", () => {
    const valid = reduceCodexConversationServerRequest(
      buildState(),
      agentActivityV2DynamicOptionPickerRequest,
      context(),
    );
    const invalidRequest = {
      ...agentActivityV2DynamicOptionPickerRequest,
      id: "invalid-option",
      params: {
        ...agentActivityV2DynamicOptionPickerRequest.params,
        arguments: { question: "Missing options" },
      },
    } satisfies ServerRequest;
    const invalid = reduceCodexConversationServerRequest(buildState(), invalidRequest, context());
    const invalidOnboardingRequest = {
      ...agentActivityV2DynamicToolRequest,
      id: "invalid-onboarding",
      params: {
        ...agentActivityV2DynamicToolRequest.params,
        namespace: "codex_app",
        tool: "request_onboarding_input",
        arguments: {
          questions: [
            {
              id: "role",
              question: "Choose a role",
              options: [{ label: "Only one option" }],
            },
          ],
        },
      },
    } satisfies ServerRequest;
    const invalidOnboarding = reduceCodexConversationServerRequest(
      buildState(),
      invalidOnboardingRequest,
      context(),
    );
    const setupRole = {
      ...agentActivityV2DynamicToolRequest,
      id: "setup-role",
      params: {
        ...agentActivityV2DynamicToolRequest.params,
        namespace: "codex_app",
        tool: "setup_codex_step",
        arguments: { step: "role" },
      },
    } satisfies ServerRequest;
    const setupComplete = {
      ...setupRole,
      id: "setup-complete",
      params: { ...setupRole.params, arguments: { step: "complete" } },
    } satisfies ServerRequest;
    const invalidSetup = {
      ...setupRole,
      id: "setup-invalid",
      params: { ...setupRole.params, arguments: { step: "role", unexpected: true } },
    } satisfies ServerRequest;
    const role = reduceCodexConversationServerRequest(buildState(), setupRole, context());
    const complete = reduceCodexConversationServerRequest(buildState(), setupComplete, context());
    const rejectedSetup = reduceCodexConversationServerRequest(
      buildState(),
      invalidSetup,
      context(),
    );
    const ordinary = reduceCodexConversationServerRequest(
      buildState(),
      agentActivityV2DynamicToolRequest,
      context(),
    );

    expect(valid.disposition).toBe("stored");
    expect(valid.state.requests[0] === agentActivityV2DynamicOptionPickerRequest).toBe(true);
    expect(invalid.disposition).toBe("responded");
    expect(invalid.state.requests.length).toBe(0);
    expect(
      invalid.effects[0]?.type === "respond" && invalid.effects[0].method === "item/tool/call"
        ? invalid.effects[0].response.success
        : null,
    ).toBe(false);
    expect(invalidOnboarding.disposition).toBe("responded");
    expect(invalidOnboarding.state.requests.length).toBe(0);
    expect(
      invalidOnboarding.effects[0]?.type === "respond" &&
        invalidOnboarding.effects[0].method === "item/tool/call"
        ? invalidOnboarding.effects[0].response.success
        : null,
    ).toBe(false);
    expect(role.disposition).toBe("stored");
    expect(complete.effects[0]?.type).toBe("dispatchDynamicToolCall");
    expect(rejectedSetup.disposition).toBe("responded");
    expect(rejectedSetup.state.requests.length).toBe(0);
    expect(
      rejectedSetup.effects[0]?.type === "respond" &&
        rejectedSetup.effects[0].method === "item/tool/call"
        ? rejectedSetup.effects[0].response.success
        : null,
    ).toBe(false);
    expect(ordinary.effects[0]?.type).toBe("dispatchDynamicToolCall");
  });

  test("does not give foreign namespaces codex_app lifecycle behavior", () => {
    const foreignSetup = {
      ...agentActivityV2DynamicToolRequest,
      id: "foreign-setup",
      params: {
        ...agentActivityV2DynamicToolRequest.params,
        namespace: "nodex_app",
        tool: "setup_codex_step",
        arguments: { step: "role" },
      },
    } satisfies ServerRequest;
    const foreignPicker = {
      ...agentActivityV2DynamicOptionPickerRequest,
      id: "foreign-picker",
      params: {
        ...agentActivityV2DynamicOptionPickerRequest.params,
        namespace: "nodex_app",
        arguments: { question: "This would be invalid for codex_app" },
      },
    } satisfies ServerRequest;

    const setup = reduceCodexConversationServerRequest(buildState(), foreignSetup, context());
    const picker = reduceCodexConversationServerRequest(buildState(), foreignPicker, context());

    expect(setup.disposition).toBe("dispatched");
    expect(setup.effects[0]?.type).toBe("dispatchDynamicToolCall");
    expect(picker.disposition).toBe("dispatched");
    expect(picker.effects[0]?.type).toBe("dispatchDynamicToolCall");
  });

  test("routes onboarding replies through the first strict-ID dynamic request and removes every match", () => {
    const onboarding = {
      ...agentActivityV2DynamicToolRequest,
      id: 73,
      params: {
        ...agentActivityV2DynamicToolRequest.params,
        namespace: "codex_app",
        tool: "request_onboarding_input",
        arguments: {
          questions: [
            {
              id: "role",
              header: null,
              question: "Choose a role",
              options: [{ label: "Engineer" }, { label: "Designer", description: null }],
            },
          ],
        },
      },
    } satisfies ServerRequest;
    const duplicate = {
      ...onboarding,
      params: { ...onboarding.params, callId: "onboarding-duplicate" },
    } satisfies ServerRequest;
    const textual = { ...onboarding, id: "73" } satisfies ServerRequest;
    const pending = {
      ...buildState(),
      requests: [onboarding, duplicate, textual],
    };

    const replied = reduceCodexConversationOnboardingInputResponse(pending, 73);

    expect(replied.disposition).toBe("resolved");
    expect(replied.selectedRequests.length).toBe(1);
    expect(replied.selectedRequests[0] === onboarding).toBe(true);
    expect(replied.state.requests.length).toBe(1);
    expect(replied.state.requests[0] === textual).toBe(true);
    expect(replied.state.turns[0]?.items.length).toBe(0);

    const wrongTool = { ...agentActivityV2DynamicToolRequest, id: 73 } satisfies ServerRequest;
    const wrongFirst = {
      ...pending,
      requests: [wrongTool, onboarding],
    };
    const ignored = reduceCodexConversationOnboardingInputResponse(wrongFirst, 73);
    expect(ignored.disposition).toBe("ignored");
    expect(ignored.state === wrongFirst).toBe(true);

    const replayedMalformedOnboarding = {
      ...onboarding,
      params: {
        ...onboarding.params,
        arguments: { replayedWithoutIngressValidation: true },
      },
    } satisfies ServerRequest;
    const replayedReply = reduceCodexConversationOnboardingInputResponse(
      {
        ...pending,
        requests: [replayedMalformedOnboarding],
      },
      73,
    );
    expect(replayedReply.disposition).toBe("resolved");
    expect(replayedReply.selectedRequests[0] === replayedMalformedOnboarding).toBe(true);
    expect(replayedReply.state.requests.length).toBe(0);
  });

  test("validates setup-step replies against the first stored request and original step", () => {
    const requestFor = (step: "role" | "task" | "context") =>
      ({
        ...agentActivityV2DynamicToolRequest,
        id: `setup-${step}`,
        params: {
          ...agentActivityV2DynamicToolRequest.params,
          namespace: "codex_app",
          tool: "setup_codex_step",
          arguments: { step },
        },
      }) satisfies ServerRequest;
    const cases = [
      {
        request: requestFor("role"),
        response: { step: "role", action: "submit", selectedRoles: ["engineer"] } as const,
      },
      {
        request: requestFor("task"),
        response: {
          step: "task",
          action: "submit",
          answers: { first_task: { answers: ["Ship parity"] } },
        } as const,
      },
      {
        request: requestFor("context"),
        response: { step: "context", action: "continue", selectedSources: ["repo"] } as const,
      },
    ];

    for (const entry of cases) {
      const raw: CodexServerRequestRawState = {
        threadId: THREAD_ID,
        turns: [],
        requests: [entry.request, entry.request],
        hasUnreadTurn: true,
      };
      const replied = reduceCodexServerRequestSetupCodexStepResponseRawState(
        raw,
        entry.request.id,
        entry.response,
      );
      expect(replied.disposition).toBe("resolved");
      expect(replied.selectedRequests.length).toBe(1);
      expect(replied.state.requests.length).toBe(0);
      expect(replied.state.hasUnreadTurn).toBe(true);
    }

    const roleRequest = requestFor("role");
    const mismatched: CodexServerRequestRawState = {
      threadId: THREAD_ID,
      turns: [],
      requests: [roleRequest],
      hasUnreadTurn: true,
    };
    const ignored = reduceCodexServerRequestSetupCodexStepResponseRawState(
      mismatched,
      roleRequest.id,
      { step: "context", action: "dismiss", selectedSources: [] },
    );
    expect(ignored.disposition).toBe("ignored");
    expect(ignored.state === mismatched).toBe(true);
  });

  test("handles one-shot responses, missing turns, private plan replacement, and classification", () => {
    const noTurns: CodexCanonicalConversationState = { ...buildState(), turns: [] };
    const permission = reduceCodexConversationServerRequest(
      noTurns,
      agentActivityV2PermissionRequest,
      context(),
    );
    const currentTime = reduceCodexConversationServerRequest(
      buildState(),
      {
        id: 909,
        method: "currentTime/read",
        params: { threadId: THREAD_ID },
      },
      context(),
    );
    const planOne = createCodexCanonicalPlanImplementationRequest(
      THREAD_ID,
      TURN_ID,
      "one",
      "plan-one",
    );
    const planTwo = createCodexCanonicalPlanImplementationRequest(
      THREAD_ID,
      TURN_ID,
      "two",
      "plan-two",
    );
    const firstPlan = reduceCodexConversationServerRequest(buildState(), planOne, context());
    const secondPlan = reduceCodexConversationServerRequest(firstPlan.state, planTwo, context());
    const completedPlan = completeCodexCanonicalPlanImplementationRequest(
      secondPlan.state,
      TURN_ID,
    );

    expect(permission.state.requests.length).toBe(1);
    expect(permission.state.turns.length).toBe(0);
    expect(permission.state.sidecar.hasUnreadTurn).toBe(true);
    expect(
      currentTime.effects[0]?.type === "respond"
        ? "currentTimeAt" in currentTime.effects[0].response
          ? currentTime.effects[0].response.currentTimeAt
          : null
        : null,
    ).toBe(1_234);
    expect(secondPlan.state.requests.length).toBe(1);
    expect(secondPlan.state.requests[0] === planTwo).toBe(true);
    expect(completedPlan.requests.length).toBe(0);
    expect(completedPlan.sidecar.hasUnreadTurn).toBe(true);
    expect(classifyCodexCanonicalServerRequest(planTwo).source).toBe("private");
    expect(classifyCodexCanonicalServerRequest(agentActivityV2PermissionRequest).behavior).toBe(
      "storeAndSynthesize",
    );
  });

  test("replaces identical plan requests at the tail and globally filters stale plans on turn start", () => {
    const stalePlan = createCodexCanonicalPlanImplementationRequest(
      THREAD_ID,
      "turn-stale",
      "stale",
      "plan-stale",
    );
    const oldCurrent = createCodexCanonicalPlanImplementationRequest(
      THREAD_ID,
      TURN_ID,
      "same",
      "plan-old",
    );
    const duplicateCurrent = createCodexCanonicalPlanImplementationRequest(
      THREAD_ID,
      TURN_ID,
      "same",
      "plan-duplicate",
    );
    const freshCurrent = createCodexCanonicalPlanImplementationRequest(
      THREAD_ID,
      TURN_ID,
      "same",
      "plan-fresh",
    );
    const unrelated = agentActivityV2DynamicToolRequest;
    const initial: CodexServerRequestRawState = {
      threadId: THREAD_ID,
      turns: [],
      requests: [oldCurrent, unrelated, stalePlan, duplicateCurrent],
      hasUnreadTurn: false,
    };

    const replaced = reduceCodexServerRequestRawState(initial, freshCurrent, context());

    expect(JSON.stringify(replaced.state.requests.map((request) => request.id))).toBe(
      JSON.stringify([unrelated.id, stalePlan.id, freshCurrent.id]),
    );
    expect(replaced.state.requests[2] === freshCurrent).toBe(true);
    expect(replaced.state.hasUnreadTurn).toBe(true);

    const turnStarted = applyCodexPlanImplementationTurnStartedRawState(replaced.state, TURN_ID);
    expect(JSON.stringify(turnStarted.requests.map((request) => request.id))).toBe(
      JSON.stringify([unrelated.id, freshCurrent.id]),
    );
    expect(turnStarted.hasUnreadTurn).toBe(true);
    const canonicalTurnStarted = applyCodexCanonicalPlanImplementationTurnStartedState(
      {
        ...buildState(),
        requests: replaced.state.requests,
        sidecar: { ...buildState().sidecar, hasUnreadTurn: true },
      },
      TURN_ID,
    );
    expect(JSON.stringify(canonicalTurnStarted.requests.map((request) => request.id))).toBe(
      JSON.stringify([unrelated.id, freshCurrent.id]),
    );
    expect(canonicalTurnStarted.sidecar.hasUnreadTurn).toBe(true);
  });

  test("stores turnless MCP and exact private picker envelopes without synthetics", () => {
    const turnlessMcp = {
      ...agentActivityV2McpElicitationRequest,
      id: "turnless-mcp",
      params: {
        ...agentActivityV2McpElicitationRequest.params,
        turnId: null,
      },
    } satisfies ServerRequest;
    const optionPicker = {
      id: 301,
      method: "item/tool/requestOptionPicker",
      params: {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        question: "Choose",
        options: [{ label: "Continue", description: "Continue" }],
        allowMultiple: false,
        submitLabel: "Submit",
        skipLabel: null,
      },
    } satisfies CodexCanonicalOptionPickerRequest;
    const setupPicker = {
      id: "setup-picker",
      method: "item/tool/requestSetupCodexContextPicker",
      params: { threadId: THREAD_ID, turnId: TURN_ID },
    } satisfies CodexCanonicalSetupContextPickerRequest;

    const mcpPending = reduceCodexConversationServerRequest(buildState(), turnlessMcp, context());
    const mcpResolved = reduceCodexConversationServerRequestResolved(
      mcpPending.state,
      resolved(turnlessMcp.id),
      context(),
    );
    const optionPending = reduceCodexConversationServerRequest(
      buildState(),
      optionPicker,
      context(),
    );
    const bothPickers = reduceCodexConversationServerRequest(
      optionPending.state,
      setupPicker,
      context(),
    );

    expect(mcpPending.state.requests[0] === turnlessMcp).toBe(true);
    expect(mcpPending.state.turns[0]?.items.length).toBe(0);
    expect(mcpPending.state.sidecar.hasUnreadTurn).toBe(true);
    expect(mcpResolved.state.requests.length).toBe(0);
    expect(mcpResolved.state.turns[0]?.items.length).toBe(0);
    expect(bothPickers.state.requests.length).toBe(2);
    expect(bothPickers.state.requests[0] === optionPicker).toBe(true);
    expect(bothPickers.state.requests[1] === setupPicker).toBe(true);
    expect(bothPickers.state.turns[0]?.items.length).toBe(0);
    expect(classifyCodexCanonicalServerRequest(optionPicker).source).toBe("private");
    expect(classifyCodexCanonicalServerRequest(setupPicker).source).toBe("private");
  });

  test("stored picker replies validate the first strict-id envelope and remove every same-id occurrence", () => {
    const directOption = {
      id: 301,
      method: "item/tool/requestOptionPicker",
      params: {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        question: "Choose",
        options: [{ label: "Continue", description: "Continue" }],
        allowMultiple: false,
        submitLabel: "Submit",
        skipLabel: null,
      },
    } satisfies CodexCanonicalOptionPickerRequest;
    const directSetup = {
      id: 301,
      method: "item/tool/requestSetupCodexContextPicker",
      params: { threadId: THREAD_ID, turnId: TURN_ID },
    } satisfies CodexCanonicalSetupContextPickerRequest;
    const dynamicOption = {
      id: 301,
      method: "item/tool/call",
      params: {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        callId: "dynamic-option",
        namespace: "codex_app",
        tool: "request_option_picker",
        arguments: {
          question: "Choose",
          options: [{ label: "Continue" }, { label: "Stop" }],
        },
      },
    } satisfies ServerRequest;
    const dynamicSetup = {
      id: "setup-302",
      method: "item/tool/call",
      params: {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        callId: "dynamic-setup",
        namespace: "codex_app",
        tool: "setup_codex_context_picker",
        arguments: {},
      },
    } satisfies ServerRequest;
    const directSetupDuplicate = {
      ...directSetup,
      id: dynamicSetup.id,
    } satisfies CodexCanonicalSetupContextPickerRequest;
    const unrelated = agentActivityV2DynamicToolRequest;
    const rawState = (
      requests: CodexServerRequestRawState["requests"],
    ): CodexServerRequestRawState => ({
      threadId: THREAD_ID,
      turns: [],
      requests,
      hasUnreadTurn: true,
    });

    const wrongFirst = reduceCodexServerRequestOptionPickerResponseRawState(
      rawState([directSetup, directOption, dynamicOption]),
      directOption.id,
    );
    expect(wrongFirst.disposition).toBe("ignored");
    expect(wrongFirst.stateChanged).toBe(false);
    expect(wrongFirst.state.requests.length).toBe(3);

    const optionReply = reduceCodexServerRequestOptionPickerResponseRawState(
      rawState([directOption, unrelated, dynamicOption, directSetup]),
      directOption.id,
    );
    expect(optionReply.selectedRequests[0] === directOption).toBe(true);
    expect(JSON.stringify(optionReply.state.requests.map((request) => request.id))).toBe(
      JSON.stringify([unrelated.id]),
    );
    expect(optionReply.state.hasUnreadTurn).toBe(true);
    const canonicalOptionReply = reduceCodexConversationOptionPickerResponse(
      { ...buildState(), requests: [directOption, unrelated, dynamicOption, directSetup] },
      directOption.id,
    );
    expect(canonicalOptionReply.selectedRequests[0] === directOption).toBe(true);
    expect(JSON.stringify(canonicalOptionReply.state.requests.map((request) => request.id))).toBe(
      JSON.stringify([unrelated.id]),
    );
    expect(canonicalOptionReply.state.sidecar.hasUnreadTurn).toBe(false);

    const setupReply = reduceCodexServerRequestSetupContextPickerResponseRawState(
      rawState([dynamicSetup, unrelated, directSetupDuplicate]),
      dynamicSetup.id,
    );
    expect(setupReply.selectedRequests[0] === dynamicSetup).toBe(true);
    expect(JSON.stringify(setupReply.state.requests.map((request) => request.id))).toBe(
      JSON.stringify([unrelated.id]),
    );
    const canonicalSetupReply = reduceCodexConversationSetupContextPickerResponse(
      { ...buildState(), requests: [dynamicSetup, unrelated, directSetupDuplicate] },
      dynamicSetup.id,
    );
    expect(canonicalSetupReply.selectedRequests[0] === dynamicSetup).toBe(true);
    expect(JSON.stringify(canonicalSetupReply.state.requests.map((request) => request.id))).toBe(
      JSON.stringify([unrelated.id]),
    );
  });

  test("blocks both approval routes when the first ordinary same-id envelope has the other method", () => {
    const requestId = "shared-approval-route";
    const commandRequest = {
      ...agentActivityV2CommandApprovalRequest,
      id: requestId,
    };
    const fileRequest = {
      ...agentActivityV2FileApprovalRequest,
      id: requestId,
    };
    const rawState = (
      requests: CodexServerRequestRawState["requests"],
    ): CodexServerRequestRawState => ({
      threadId: THREAD_ID,
      turns: [],
      requests,
      hasUnreadTurn: false,
    });

    const commandBlockedByFile = reduceCodexServerRequestApprovalResponseRawState(
      rawState([fileRequest, commandRequest]),
      requestId,
      "item/commandExecution/requestApproval",
    );
    const fileBlockedByCommand = reduceCodexServerRequestApprovalResponseRawState(
      rawState([commandRequest, fileRequest]),
      requestId,
      "item/fileChange/requestApproval",
    );

    expect(commandBlockedByFile.disposition).toBe("ignored");
    expect(commandBlockedByFile.stateChanged).toBe(false);
    expect(commandBlockedByFile.state.requests.length).toBe(2);
    expect(fileBlockedByCommand.disposition).toBe("ignored");
    expect(fileBlockedByCommand.stateChanged).toBe(false);
    expect(fileBlockedByCommand.state.requests.length).toBe(2);
  });

  test("applies actual approval, permission, and user replies while exposing raw transport selection", () => {
    const approvalPending = reduceCodexConversationServerRequest(
      buildState(),
      agentActivityV2CommandApprovalRequest,
      context(),
    ).state;
    const approval = reduceCodexConversationApprovalResponse(
      approvalPending,
      agentActivityV2CommandApprovalRequest.id,
      "item/commandExecution/requestApproval",
    );
    const permissionPending = reduceCodexConversationServerRequest(
      buildState(),
      agentActivityV2PermissionRequest,
      context(),
    ).state;
    const permissionResponse = {
      permissions: { network: { enabled: true } },
      scope: "turn" as const,
      strictAutoReview: true,
    };
    const permission = reduceCodexConversationPermissionResponse(
      permissionPending,
      agentActivityV2PermissionRequest.id,
      permissionResponse,
      context(),
    );
    const permissionItem = permission.state.turns[0]?.items[0];
    const userPending = reduceCodexConversationServerRequest(
      buildState(),
      agentActivityV2UserInputRequest,
      context(),
    ).state;
    const user = reduceCodexConversationUserInputResponse(
      userPending,
      agentActivityV2UserInputRequest.id,
      { choice: ["Continue"], omitted: undefined },
      context(),
    );
    const userItem = user.state.turns[0]?.items[0];

    expect(approval.state.requests.length).toBe(0);
    expect(approval.state.turns[0]?.items.length).toBe(0);
    expect(approval.selectedRequests[0] === agentActivityV2CommandApprovalRequest).toBe(true);
    expect(approval.selectedRequestIds[0]).toBe(agentActivityV2CommandApprovalRequest.id);
    expect(permission.state.requests.length).toBe(0);
    expect(
      permissionItem && "response" in permissionItem
        ? permissionItem.response === permissionResponse
        : false,
    ).toBe(true);
    expect(permissionItem && "completed" in permissionItem ? permissionItem.completed : false).toBe(
      true,
    );
    expect(user.state.requests.length).toBe(0);
    expect(userItem && "answers" in userItem ? userItem.answers.choice?.[0] : null).toBe(
      "Continue",
    );
    expect(
      userItem && "answers" in userItem
        ? Object.prototype.hasOwnProperty.call(userItem.answers, "omitted")
        : true,
    ).toBe(false);
  });

  test("ignores a reply whose first strict-ID request belongs to another family", () => {
    const sharedId = "shared-family-id";
    const commandRequest = {
      ...agentActivityV2CommandApprovalRequest,
      id: sharedId,
    } satisfies ServerRequest;
    const permissionRequest = {
      ...agentActivityV2PermissionRequest,
      id: sharedId,
    } satisfies ServerRequest;
    const commandPending = reduceCodexConversationServerRequest(
      buildState(),
      commandRequest,
      context(),
    );
    const bothPending = reduceCodexConversationServerRequest(
      commandPending.state,
      permissionRequest,
      context(),
    );
    const wrongFamily = reduceCodexConversationPermissionResponse(
      bothPending.state,
      sharedId,
      {
        permissions: { network: { enabled: true } },
        scope: "turn",
        strictAutoReview: true,
      },
      context(),
    );
    const resolvedCollision = reduceCodexConversationServerRequestResolved(
      bothPending.state,
      resolved(sharedId),
      context(),
    );
    const synthetic = resolvedCollision.state.turns[0]?.items[0];

    expect(wrongFamily.disposition).toBe("ignored");
    expect(wrongFamily.state === bothPending.state).toBe(true);
    expect(wrongFamily.state.requests.length).toBe(2);
    expect(resolvedCollision.state.requests.length).toBe(0);
    expect(resolvedCollision.selectedRequests[0] === commandRequest).toBe(true);
    expect(synthetic?.type).toBe("permissionRequest");
    expect(synthetic && "completed" in synthetic ? synthetic.completed : true).toBe(false);
  });

  test("skips plan requests during ordinary reply lookup but not another non-plan family", () => {
    const sharedId = "plan-shadowed-family-id";
    const planRequest = {
      id: sharedId,
      method: "item/plan/requestImplementation",
      params: {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        planContent: "Implement the verified plan",
      },
    } satisfies CodexCanonicalPlanImplementationRequest;
    const permissionRequest = {
      ...agentActivityV2PermissionRequest,
      id: sharedId,
    } satisfies ServerRequest;
    const commandRequest = {
      ...agentActivityV2CommandApprovalRequest,
      id: sharedId,
    } satisfies ServerRequest;
    const response = {
      permissions: { network: { enabled: true } },
      scope: "turn" as const,
      strictAutoReview: true,
    };
    const state = buildState();

    const planThenPermission = reduceCodexConversationPermissionResponse(
      {
        ...state,
        requests: [planRequest, permissionRequest],
      },
      sharedId,
      response,
      context(),
    );
    expect(planThenPermission.disposition).toBe("resolved");
    expect(planThenPermission.selectedRequests[0] === permissionRequest).toBe(true);
    expect(planThenPermission.state.requests.length).toBe(0);

    const wrongNonPlanFirst = reduceCodexConversationPermissionResponse(
      {
        ...state,
        requests: [planRequest, commandRequest, permissionRequest],
      },
      sharedId,
      response,
      context(),
    );
    expect(wrongNonPlanFirst.disposition).toBe("ignored");
    expect(wrongNonPlanFirst.state.requests.length).toBe(3);
  });

  test("fans out accepted connector auth replies by exact equivalence in arrival order", () => {
    function connectorRequest(
      id: string,
      scopes: string[],
      linkId: string,
    ): Extract<ServerRequest, { method: "mcpServer/elicitation/request" }> {
      return {
        id,
        method: "mcpServer/elicitation/request",
        params: {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          serverName: "codex_apps",
          mode: "url",
          message: "Connect",
          url: "https://chatgpt.com/connect",
          elicitationId: id,
          _meta: {
            _codex_apps: {
              connector_auth_failure: {
                is_auth_failure: true,
                connector_id: "drive",
                connector_name: "Drive",
                install_url: "https://chatgpt.com/install",
                auth_reason: "expired",
                link_id: linkId,
                requested_scopes: scopes,
              },
            },
          },
        },
      };
    }

    const first = connectorRequest("connector-first", ["read", "write"], "link");
    const equivalent = connectorRequest("connector-second", ["write", "read"], "link");
    const different = connectorRequest("connector-third", ["read"], "other-link");
    let pending = buildState();
    for (const request of [first, equivalent, different]) {
      pending = reduceCodexConversationServerRequest(pending, request, context()).state;
    }
    const accepted = reduceCodexConversationMcpElicitationResponse(
      pending,
      first.id,
      { action: "accept", content: {}, _meta: null },
      context(),
    );
    const items = accepted.state.turns[0]?.items ?? [];

    expect(accepted.selectedRequestIds.length).toBe(2);
    expect(accepted.selectedRequestIds[0]).toBe(first.id);
    expect(accepted.selectedRequestIds[1]).toBe(equivalent.id);
    expect(accepted.selectedRequests[0] === first).toBe(true);
    expect(accepted.selectedRequests[1] === equivalent).toBe(true);
    expect(accepted.state.requests.length).toBe(1);
    expect(accepted.state.requests[0] === different).toBe(true);
    expect(items.length).toBe(3);
    expect(items[0] && "action" in items[0] ? items[0].action : null).toBe("accept");
    expect(items[1] && "action" in items[1] ? items[1].action : null).toBe("accept");
    expect(items[2] && "completed" in items[2] ? items[2].completed : null).toBe(false);
  });

  test("runs the same ingress contract against minimal raw adapter state", () => {
    const raw: CodexServerRequestRawState = {
      threadId: THREAD_ID,
      turns: [
        {
          turnId: TURN_ID,
          status: "inProgress",
          hasError: false,
          items: [],
          turnStartedAtMs: null,
        },
      ],
      requests: [],
      hasUnreadTurn: false,
    };
    const result = reduceCodexServerRequestRawState(
      raw,
      agentActivityV2PermissionRequest,
      context(),
    );

    expect(result.stateChanged).toBe(true);
    expect(result.state.requests[0] === agentActivityV2PermissionRequest).toBe(true);
    expect(result.state.hasUnreadTurn).toBe(true);
    expect(result.turnMutations.length).toBe(1);
    expect(result.turnMutations[0]?.turnIndex).toBe(0);
    expect(result.turnMutations[0]?.syntheticItem.type).toBe("permissionRequest");
    expect(result.turnMutations[0]?.turn.hookRuns?.length).toBe(0);
  });

  test("rebuilds the request array for unmatched resolved notifications", () => {
    const pending = reduceCodexConversationServerRequest(
      buildState(),
      agentActivityV2CommandApprovalRequest,
      context(),
    ).state;
    const before = JSON.stringify(pending);
    const result = reduceCodexConversationServerRequestResolved(
      pending,
      resolved("missing"),
      context(),
    );
    const next = result.state;

    expect(result.disposition).toBe("resolved");
    expect(result.stateChanged).toBe(true);
    expect(result.selectedRequests.length).toBe(0);
    expect(next.requests.length).toBe(1);
    expect(next.requests[0] === pending.requests[0]).toBe(true);
    expect(next === pending).toBe(false);
    expect(next.requests === pending.requests).toBe(false);
    expect(JSON.stringify(next)).toBe(before);
    expect(next.sidecar.hasUnreadTurn).toBe(true);
  });
});

const privatePlanTypeProof = {
  id: "proof",
  method: "item/plan/requestImplementation",
  params: {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    planContent: "proof",
  },
} satisfies CodexCanonicalPlanImplementationRequest;

void privatePlanTypeProof;
