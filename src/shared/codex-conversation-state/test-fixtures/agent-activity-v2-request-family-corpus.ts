import type { ServerRequest } from "@nodex/codex-app-server-protocol";
import type { ThreadItem } from "@nodex/codex-app-server-protocol/v2/ThreadItem";
import type {
  CodexConversationReplayEvent,
  CodexConversationReplayFixture,
} from "../codex-conversation-replay";
import type { CodexCanonicalServerRequest } from "../codex-conversation-state";
import {
  AGENT_ACTIVITY_V2_CORPUS_SANITIZATION,
  AGENT_ACTIVITY_V2_CORPUS_THREAD_ID,
  AGENT_ACTIVITY_V2_CORPUS_TURN_ID,
  buildAgentActivityV2BundleProvenance,
  buildAgentActivityV2CorpusThread,
  validateAgentActivityV2CorpusFixtureMetadata,
} from "./agent-activity-v2-corpus-provenance";
import { agentActivityV2MixedPatchItem } from "./agent-activity-v2-item-family-corpus";

export type AgentActivityV2RequestIngressEffect =
  | "stored"
  | "stored-with-synthetic-item"
  | "dispatched"
  | "auto-responded"
  | "ignored";

export type AgentActivityV2RequestSyntheticItem =
  | "none"
  | "userInputResponse"
  | "permissionRequest"
  | "mcpServerElicitation";

export type AgentActivityV2RequestProjectionEffect =
  | "append-exec"
  | "attach-patch"
  | "append-user-input"
  | "ensure-permission"
  | "ignore";

export type AgentActivityV2RequestResolutionEffect =
  | "remove-only"
  | "complete-synthetic-and-remove"
  | "none";

export interface AgentActivityV2RequestEffectExpectation {
  readonly requestId: string | number;
  readonly method: ServerRequest["method"];
  readonly ingress: AgentActivityV2RequestIngressEffect;
  readonly syntheticItem: AgentActivityV2RequestSyntheticItem;
  readonly requestProjection: AgentActivityV2RequestProjectionEffect;
  readonly resolution: AgentActivityV2RequestResolutionEffect;
}

export interface AgentActivityV2PendingResolvedRequestCase {
  readonly id: string;
  readonly request: ServerRequest;
  readonly effect: AgentActivityV2RequestEffectExpectation;
  readonly pendingFixture: CodexConversationReplayFixture;
  readonly resolvedFixture: CodexConversationReplayFixture;
  readonly evidence: readonly string[];
}

export interface AgentActivityV2OneShotRequestCase {
  readonly id: string;
  readonly fixture: CodexConversationReplayFixture;
  readonly effects: readonly AgentActivityV2RequestEffectExpectation[];
  readonly evidence: readonly string[];
}

type DynamicToolCallItem = Extract<ThreadItem, { type: "dynamicToolCall" }>;

export const agentActivityV2CommandApprovalRequest = {
  id: 201,
  method: "item/commandExecution/requestApproval",
  params: {
    kind: "command",
    threadId: AGENT_ACTIVITY_V2_CORPUS_THREAD_ID,
    turnId: AGENT_ACTIVITY_V2_CORPUS_TURN_ID,
    itemId: "pending-command-approval",
    startedAtMs: 2_010,
    environmentId: "environment-fixture",
    reason: "Sanitized network approval",
    networkApprovalContext: {
      host: "example.invalid",
      protocol: "https",
    },
    command: "curl https://example.invalid/fixture",
    cwd: "/workspace/request-specific-cwd",
    commandActions: [{
      type: "unknown",
      command: "curl https://example.invalid/fixture",
    }],
    additionalPermissions: {
      network: {
        enabled: true,
      },
      fileSystem: null,
    },
    proposedExecpolicyAmendment: ["curl"],
    proposedNetworkPolicyAmendments: [{
      host: "example.invalid",
      action: "allow",
    }],
    availableDecisions: ["accept", "decline"],
  },
} satisfies ServerRequest;

export const agentActivityV2FileApprovalRequest = {
  id: "file-approval-202",
  method: "item/fileChange/requestApproval",
  params: {
    threadId: AGENT_ACTIVITY_V2_CORPUS_THREAD_ID,
    turnId: AGENT_ACTIVITY_V2_CORPUS_TURN_ID,
    itemId: "patch-mixed",
    startedAtMs: 2_020,
    reason: "Sanitized extra write approval",
    grantRoot: "/workspace/shared",
  },
} satisfies ServerRequest;

export const agentActivityV2UserInputRequest = {
  id: 203,
  method: "item/tool/requestUserInput",
  params: {
    threadId: AGENT_ACTIVITY_V2_CORPUS_THREAD_ID,
    turnId: AGENT_ACTIVITY_V2_CORPUS_TURN_ID,
    itemId: "request-user-input",
    questions: [{
      id: "choice",
      header: "Choice",
      question: "Choose the sanitized fixture path.",
      isOther: true,
      isSecret: false,
      options: [
        {
          label: "Continue",
          description: "Continue with the representative fixture.",
        },
        {
          label: "Stop",
          description: "Stop before applying the representative fixture.",
        },
      ],
    }],
    isBlocking: false,
    autoResolutionMs: 60_000,
  },
} satisfies ServerRequest;

export const agentActivityV2PermissionRequest = {
  id: "permission-204",
  method: "item/permissions/requestApproval",
  params: {
    threadId: AGENT_ACTIVITY_V2_CORPUS_THREAD_ID,
    turnId: AGENT_ACTIVITY_V2_CORPUS_TURN_ID,
    itemId: "request-permissions",
    environmentId: "environment-fixture",
    startedAtMs: 2_040,
    cwd: "/workspace/project",
    reason: "Sanitized filesystem and network permissions",
    permissions: {
      network: {
        enabled: true,
      },
      fileSystem: {
        read: ["/workspace/shared"],
        write: ["/workspace/shared/output"],
        globScanMaxDepth: 4,
        entries: [{
          path: {
            type: "path",
            path: "/workspace/shared/output",
          },
          access: "write",
        }],
      },
    },
  },
} satisfies ServerRequest;

export const agentActivityV2McpElicitationRequest = {
  id: "mcp-elicitation-205",
  method: "mcpServer/elicitation/request",
  params: {
    threadId: AGENT_ACTIVITY_V2_CORPUS_THREAD_ID,
    turnId: AGENT_ACTIVITY_V2_CORPUS_TURN_ID,
    serverName: "fixture_server",
    mode: "openai/form",
    _meta: {
      fixture: true,
    },
    message: "Provide one sanitized fixture value.",
    requestedSchema: {
      type: "object",
      properties: {
        value: {
          type: "string",
          title: "Fixture value",
        },
      },
      required: ["value"],
    },
  },
} satisfies ServerRequest;

export const agentActivityV2DynamicToolRequest = {
  id: 206,
  method: "item/tool/call",
  params: {
    threadId: AGENT_ACTIVITY_V2_CORPUS_THREAD_ID,
    turnId: AGENT_ACTIVITY_V2_CORPUS_TURN_ID,
    callId: "dynamic-lifecycle",
    namespace: "fixture_namespace",
    tool: "fixture_tool",
    arguments: {
      input: "fixture",
    },
  },
} satisfies ServerRequest;

export const agentActivityV2DynamicOptionPickerRequest = {
  id: "dynamic-option-picker-207",
  method: "item/tool/call",
  params: {
    threadId: AGENT_ACTIVITY_V2_CORPUS_THREAD_ID,
    turnId: AGENT_ACTIVITY_V2_CORPUS_TURN_ID,
    callId: "dynamic-option-picker",
    namespace: "codex_app",
    tool: "request_option_picker",
    arguments: {
      question: "Choose the sanitized fixture option.",
      options: [
        {
          label: "First",
          description: "Use the first representative option.",
        },
        {
          label: "Second",
          description: "Use the second representative option.",
        },
      ],
      allowMultiple: false,
      submitLabel: "Continue",
      skipLabel: "Skip",
    },
  },
} satisfies ServerRequest;

export const agentActivityV2CurrentTimeRequest = {
  id: 209,
  method: "currentTime/read",
  params: {
    threadId: AGENT_ACTIVITY_V2_CORPUS_THREAD_ID,
  },
} satisfies ServerRequest;

export const agentActivityV2AuthRefreshRequest = {
  id: "auth-refresh-210",
  method: "account/chatgptAuthTokens/refresh",
  params: {
    reason: "unauthorized",
    previousAccountId: "account-fixture",
  },
} satisfies ServerRequest;

export const agentActivityV2AttestationRequest = {
  id: "attestation-211",
  method: "attestation/generate",
  params: {},
} satisfies ServerRequest;

export const agentActivityV2LegacyApplyPatchRequest = {
  id: "legacy-apply-207",
  method: "applyPatchApproval",
  params: {
    conversationId: AGENT_ACTIVITY_V2_CORPUS_THREAD_ID,
    callId: "legacy-patch-call",
    fileChanges: {
      "src/legacy.ts": {
        type: "update",
        unified_diff: "@@ -1 +1 @@\n-before\n+after\n",
        move_path: null,
      },
    },
    reason: "Sanitized legacy patch approval",
    grantRoot: null,
  },
} satisfies ServerRequest;

export const agentActivityV2LegacyExecRequest = {
  id: "legacy-exec-208",
  method: "execCommandApproval",
  params: {
    conversationId: AGENT_ACTIVITY_V2_CORPUS_THREAD_ID,
    callId: "legacy-exec-call",
    approvalId: null,
    command: ["printf", "fixture"],
    cwd: "/workspace/project",
    reason: "Sanitized legacy command approval",
    parsedCmd: [{
      type: "unknown",
      cmd: "printf fixture",
    }],
  },
} satisfies ServerRequest;

const REQUEST_INGRESS_EVIDENCE = [
  "h59fr3q5.pretty.js:91783-92000 (request ingress handling)",
  "h59fr3q5.pretty.js:91671-91681 (serverRequest/resolved handling)",
];
const REQUEST_PROJECTION_EVIDENCE = [
  "h59fr3q5.pretty.js:96029-96139 (R2 request loop effects)",
];

function requestEvent(request: ServerRequest): CodexConversationReplayEvent {
  return {
    type: "request",
    request,
  };
}

function resolvedEvent(requestId: string | number): CodexConversationReplayEvent {
  return {
    type: "notification",
    notification: {
      method: "serverRequest/resolved",
      params: {
        threadId: AGENT_ACTIVITY_V2_CORPUS_THREAD_ID,
        requestId,
      },
    },
  };
}

function buildRequestFixture(
  id: string,
  targetState: string,
  events: readonly CodexConversationReplayEvent[],
  evidence: readonly string[],
  initialItems: readonly ThreadItem[] = [],
): CodexConversationReplayFixture {
  return {
    id,
    threadId: AGENT_ACTIVITY_V2_CORPUS_THREAD_ID,
    targetState,
    provenance: buildAgentActivityV2BundleProvenance(evidence),
    sanitization: AGENT_ACTIVITY_V2_CORPUS_SANITIZATION,
    initialThread: buildAgentActivityV2CorpusThread(initialItems),
    events,
  };
}

function buildPendingResolvedCase(
  id: string,
  request: ServerRequest,
  effect: Omit<AgentActivityV2RequestEffectExpectation, "requestId" | "method">,
  evidence: readonly string[],
  initialItems: readonly ThreadItem[] = [],
): AgentActivityV2PendingResolvedRequestCase {
  const pendingEvents = [requestEvent(request)] as const;
  const resolvedEvents = [...pendingEvents, resolvedEvent(request.id)] as const;
  return {
    id,
    request,
    effect: {
      requestId: request.id,
      method: request.method,
      ...effect,
    },
    pendingFixture: buildRequestFixture(
      `${id}-pending`,
      `${request.method} is pending`,
      pendingEvents,
      evidence,
      initialItems,
    ),
    resolvedFixture: buildRequestFixture(
      `${id}-resolved`,
      `${request.method} has resolved`,
      resolvedEvents,
      evidence,
      initialItems,
    ),
    evidence,
  };
}

export const agentActivityV2PendingResolvedRequestCases = [
  buildPendingResolvedCase(
    "command-approval",
    agentActivityV2CommandApprovalRequest,
    {
      ingress: "stored",
      syntheticItem: "none",
      requestProjection: "append-exec",
      resolution: "remove-only",
    },
    [...REQUEST_INGRESS_EVIDENCE, ...REQUEST_PROJECTION_EVIDENCE],
  ),
  buildPendingResolvedCase(
    "file-approval",
    agentActivityV2FileApprovalRequest,
    {
      ingress: "stored",
      syntheticItem: "none",
      requestProjection: "attach-patch",
      resolution: "remove-only",
    },
    [...REQUEST_INGRESS_EVIDENCE, ...REQUEST_PROJECTION_EVIDENCE],
    [agentActivityV2MixedPatchItem],
  ),
  buildPendingResolvedCase(
    "user-input",
    agentActivityV2UserInputRequest,
    {
      ingress: "stored-with-synthetic-item",
      syntheticItem: "userInputResponse",
      requestProjection: "append-user-input",
      resolution: "complete-synthetic-and-remove",
    },
    [
      ...REQUEST_INGRESS_EVIDENCE,
      ...REQUEST_PROJECTION_EVIDENCE,
      "h59fr3q5.pretty.js:89557-89577 (user-input synthetic item)",
    ],
  ),
  buildPendingResolvedCase(
    "permission",
    agentActivityV2PermissionRequest,
    {
      ingress: "stored-with-synthetic-item",
      syntheticItem: "permissionRequest",
      requestProjection: "ensure-permission",
      resolution: "complete-synthetic-and-remove",
    },
    [
      ...REQUEST_INGRESS_EVIDENCE,
      ...REQUEST_PROJECTION_EVIDENCE,
      "h59fr3q5.pretty.js:89531-89544 (permission synthetic item)",
    ],
  ),
  buildPendingResolvedCase(
    "mcp-elicitation",
    agentActivityV2McpElicitationRequest,
    {
      ingress: "stored-with-synthetic-item",
      syntheticItem: "mcpServerElicitation",
      requestProjection: "ignore",
      resolution: "complete-synthetic-and-remove",
    },
    [
      ...REQUEST_INGRESS_EVIDENCE,
      ...REQUEST_PROJECTION_EVIDENCE,
      "h59fr3q5.pretty.js:89501-89524 (MCP elicitation synthetic item)",
    ],
  ),
] satisfies readonly AgentActivityV2PendingResolvedRequestCase[];

const dynamicStartedItem = {
  type: "dynamicToolCall",
  id: "dynamic-lifecycle",
  namespace: "fixture_namespace",
  tool: "fixture_tool",
  arguments: {
    input: "fixture",
  },
  status: "inProgress",
  contentItems: null,
  success: null,
  durationMs: null,
} satisfies DynamicToolCallItem;

const dynamicCompletedItem = {
  ...dynamicStartedItem,
  status: "completed",
  contentItems: [{
    type: "inputText",
    text: "sanitized dynamic completion",
  }],
  success: true,
  durationMs: 25,
} satisfies DynamicToolCallItem;

const dynamicLifecycleEvents = [
  {
    type: "notification",
    notification: {
      method: "item/started",
      params: {
        threadId: AGENT_ACTIVITY_V2_CORPUS_THREAD_ID,
        turnId: AGENT_ACTIVITY_V2_CORPUS_TURN_ID,
        startedAtMs: 3_000,
        item: dynamicStartedItem,
      },
    },
  },
  requestEvent(agentActivityV2DynamicToolRequest),
  {
    type: "notification",
    notification: {
      method: "item/completed",
      params: {
        threadId: AGENT_ACTIVITY_V2_CORPUS_THREAD_ID,
        turnId: AGENT_ACTIVITY_V2_CORPUS_TURN_ID,
        completedAtMs: 3_025,
        item: dynamicCompletedItem,
      },
    },
  },
] satisfies readonly CodexConversationReplayEvent[];

function buildOneShotRequestCase(
  id: string,
  events: readonly CodexConversationReplayEvent[],
  effects: readonly AgentActivityV2RequestEffectExpectation[],
  evidence: readonly string[],
): AgentActivityV2OneShotRequestCase {
  return {
    id,
    fixture: buildRequestFixture(
      id,
      `${id} representative request state`,
      events,
      evidence,
    ),
    effects,
    evidence,
  };
}

export const agentActivityV2OneShotRequestCases = [
  buildOneShotRequestCase(
    "dynamic-tool-lifecycle",
    dynamicLifecycleEvents,
    [{
      requestId: agentActivityV2DynamicToolRequest.id,
      method: agentActivityV2DynamicToolRequest.method,
      ingress: "dispatched",
      syntheticItem: "none",
      requestProjection: "ignore",
      resolution: "none",
    }],
    [
      ...REQUEST_INGRESS_EVIDENCE,
      ...REQUEST_PROJECTION_EVIDENCE,
      "official app-server dynamic item/started -> item/tool/call -> item/completed lifecycle",
    ],
  ),
  buildOneShotRequestCase(
    "dynamic-special-option-picker-pending",
    [requestEvent(agentActivityV2DynamicOptionPickerRequest)],
    [{
      requestId: agentActivityV2DynamicOptionPickerRequest.id,
      method: agentActivityV2DynamicOptionPickerRequest.method,
      ingress: "stored",
      syntheticItem: "none",
      requestProjection: "ignore",
      resolution: "remove-only",
    }],
    [
      ...REQUEST_INGRESS_EVIDENCE,
      ...REQUEST_PROJECTION_EVIDENCE,
      "h59fr3q5.pretty.js:66998-67020,91888-91946,92204-92217 (special option picker state)",
    ],
  ),
  buildOneShotRequestCase(
    "current-time-auto-responded",
    [requestEvent(agentActivityV2CurrentTimeRequest)],
    [{
      requestId: agentActivityV2CurrentTimeRequest.id,
      method: agentActivityV2CurrentTimeRequest.method,
      ingress: "auto-responded",
      syntheticItem: "none",
      requestProjection: "ignore",
      resolution: "none",
    }],
    [
      ...REQUEST_INGRESS_EVIDENCE,
      ...REQUEST_PROJECTION_EVIDENCE,
      "h59fr3q5.pretty.js:91976-91985 (current-time immediate response)",
    ],
  ),
  buildOneShotRequestCase(
    "auth-refresh-state-ignored",
    [requestEvent(agentActivityV2AuthRefreshRequest)],
    [{
      requestId: agentActivityV2AuthRefreshRequest.id,
      method: agentActivityV2AuthRefreshRequest.method,
      ingress: "ignored",
      syntheticItem: "none",
      requestProjection: "ignore",
      resolution: "none",
    }],
    [...REQUEST_INGRESS_EVIDENCE, ...REQUEST_PROJECTION_EVIDENCE],
  ),
  buildOneShotRequestCase(
    "attestation-state-ignored",
    [requestEvent(agentActivityV2AttestationRequest)],
    [{
      requestId: agentActivityV2AttestationRequest.id,
      method: agentActivityV2AttestationRequest.method,
      ingress: "ignored",
      syntheticItem: "none",
      requestProjection: "ignore",
      resolution: "none",
    }],
    [...REQUEST_INGRESS_EVIDENCE, ...REQUEST_PROJECTION_EVIDENCE],
  ),
  buildOneShotRequestCase(
    "legacy-apply-patch-ignored",
    [requestEvent(agentActivityV2LegacyApplyPatchRequest)],
    [{
      requestId: agentActivityV2LegacyApplyPatchRequest.id,
      method: agentActivityV2LegacyApplyPatchRequest.method,
      ingress: "ignored",
      syntheticItem: "none",
      requestProjection: "ignore",
      resolution: "none",
    }],
    [...REQUEST_INGRESS_EVIDENCE, ...REQUEST_PROJECTION_EVIDENCE],
  ),
  buildOneShotRequestCase(
    "legacy-exec-ignored",
    [requestEvent(agentActivityV2LegacyExecRequest)],
    [{
      requestId: agentActivityV2LegacyExecRequest.id,
      method: agentActivityV2LegacyExecRequest.method,
      ingress: "ignored",
      syntheticItem: "none",
      requestProjection: "ignore",
      resolution: "none",
    }],
    [...REQUEST_INGRESS_EVIDENCE, ...REQUEST_PROJECTION_EVIDENCE],
  ),
] satisfies readonly AgentActivityV2OneShotRequestCase[];

export const agentActivityV2BundleOnlyRequestMethods = [
  {
    method: "item/tool/requestOptionPicker",
    requestProjection: "ignore",
    evidence: "h59fr3q5.pretty.js:91850-91868,96097-96103",
  },
  {
    method: "item/tool/requestSetupCodexContextPicker",
    requestProjection: "ignore",
    evidence: "h59fr3q5.pretty.js:91871-91889,96097-96103",
  },
  {
    method: "item/plan/requestImplementation",
    requestProjection: "ignore",
    evidence: "h59fr3q5.pretty.js:96126-96129",
  },
] as const;

function requestIdentityKey(requestId: string | number): string {
  return `${typeof requestId}:${requestId}`;
}

function isGeneratedServerRequest(
  request: CodexCanonicalServerRequest,
): request is ServerRequest {
  return request.method !== "item/tool/requestOptionPicker"
    && request.method !== "item/tool/requestSetupCodexContextPicker"
    && request.method !== "item/plan/requestImplementation";
}

function effectsMatch(
  left: AgentActivityV2RequestEffectExpectation,
  right: AgentActivityV2RequestEffectExpectation,
): boolean {
  return requestIdentityKey(left.requestId) === requestIdentityKey(right.requestId)
    && left.method === right.method
    && left.ingress === right.ingress
    && left.syntheticItem === right.syntheticItem
    && left.requestProjection === right.requestProjection
    && left.resolution === right.resolution;
}

function expectedEffectForRepresentativeRequest(
  request: ServerRequest,
): AgentActivityV2RequestEffectExpectation {
  const base = {
    requestId: request.id,
    method: request.method,
  } as const;
  switch (request.method) {
    case "item/commandExecution/requestApproval":
      return {
        ...base,
        ingress: "stored",
        syntheticItem: "none",
        requestProjection: "append-exec",
        resolution: "remove-only",
      };
    case "item/fileChange/requestApproval":
      return {
        ...base,
        ingress: "stored",
        syntheticItem: "none",
        requestProjection: "attach-patch",
        resolution: "remove-only",
      };
    case "item/tool/requestUserInput":
      return {
        ...base,
        ingress: "stored-with-synthetic-item",
        syntheticItem: "userInputResponse",
        requestProjection: "append-user-input",
        resolution: "complete-synthetic-and-remove",
      };
    case "item/permissions/requestApproval":
      return {
        ...base,
        ingress: "stored-with-synthetic-item",
        syntheticItem: "permissionRequest",
        requestProjection: "ensure-permission",
        resolution: "complete-synthetic-and-remove",
      };
    case "mcpServer/elicitation/request":
      return {
        ...base,
        ingress: "stored-with-synthetic-item",
        syntheticItem: "mcpServerElicitation",
        requestProjection: "ignore",
        resolution: "complete-synthetic-and-remove",
      };
    case "item/tool/call":
      if (request === agentActivityV2DynamicOptionPickerRequest) {
        return {
          ...base,
          ingress: "stored",
          syntheticItem: "none",
          requestProjection: "ignore",
          resolution: "remove-only",
        };
      }
      if (request !== agentActivityV2DynamicToolRequest) {
        throw new Error(
          `Unmodeled representative item/tool/call variant ${request.params.tool}`,
        );
      }
      return {
        ...base,
        ingress: "dispatched",
        syntheticItem: "none",
        requestProjection: "ignore",
        resolution: "none",
      };
    case "applyPatchApproval":
    case "execCommandApproval":
      return {
        ...base,
        ingress: "ignored",
        syntheticItem: "none",
        requestProjection: "ignore",
        resolution: "none",
      };
    case "account/chatgptAuthTokens/refresh":
    case "attestation/generate":
      return {
        ...base,
        ingress: "ignored",
        syntheticItem: "none",
        requestProjection: "ignore",
        resolution: "none",
      };
    case "currentTime/read":
      return {
        ...base,
        ingress: "auto-responded",
        syntheticItem: "none",
        requestProjection: "ignore",
        resolution: "none",
      };
  }
}

function getRequestEvents(
  fixture: CodexConversationReplayFixture,
): readonly Extract<CodexConversationReplayEvent, { type: "request" }>[] {
  return fixture.events.filter(
    (event): event is Extract<CodexConversationReplayEvent, { type: "request" }> =>
      event.type === "request",
  );
}

function requestMatchesCorpusScope(request: ServerRequest): boolean {
  switch (request.method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
    case "item/tool/requestUserInput":
    case "item/permissions/requestApproval":
    case "mcpServer/elicitation/request":
    case "item/tool/call":
      return request.params.threadId === AGENT_ACTIVITY_V2_CORPUS_THREAD_ID
        && request.params.turnId === AGENT_ACTIVITY_V2_CORPUS_TURN_ID;
    case "applyPatchApproval":
    case "execCommandApproval":
      return request.params.conversationId === AGENT_ACTIVITY_V2_CORPUS_THREAD_ID;
    case "currentTime/read":
      return request.params.threadId === AGENT_ACTIVITY_V2_CORPUS_THREAD_ID;
    case "account/chatgptAuthTokens/refresh":
    case "attestation/generate":
      return true;
  }
}

function appendFixtureMetadataErrors(
  fixture: CodexConversationReplayFixture,
  errors: string[],
): void {
  for (const error of validateAgentActivityV2CorpusFixtureMetadata(fixture)) {
    errors.push(error);
  }
}

export function validateAgentActivityV2RequestFamilyCorpus(): readonly string[] {
  const errors: string[] = [];
  const caseIds = new Set<string>();
  const requestIds = new Set<string>();

  for (const requestCase of agentActivityV2PendingResolvedRequestCases) {
    if (caseIds.has(requestCase.id)) {
      errors.push(`duplicate request case ${requestCase.id}`);
    }
    caseIds.add(requestCase.id);

    const requestKey = requestIdentityKey(requestCase.request.id);
    if (requestIds.has(requestKey)) {
      errors.push(`duplicate request id ${requestKey}`);
    }
    requestIds.add(requestKey);

    appendFixtureMetadataErrors(requestCase.pendingFixture, errors);
    appendFixtureMetadataErrors(requestCase.resolvedFixture, errors);
    if (!requestMatchesCorpusScope(requestCase.request)) {
      errors.push(`request case ${requestCase.id} is outside the corpus thread or turn`);
    }

    const expectedEffect = expectedEffectForRepresentativeRequest(requestCase.request);
    if (!effectsMatch(requestCase.effect, expectedEffect)) {
      errors.push(`request case ${requestCase.id} has an incorrect effect manifest`);
    }
    if (requestCase.evidence.length === 0) {
      errors.push(`request case ${requestCase.id} has no exact evidence`);
    }
    if (requestCase.effect.requestProjection === "attach-patch") {
      const targetTurn = requestCase.pendingFixture.initialThread?.turns.find(
        (turn) => turn.id === AGENT_ACTIVITY_V2_CORPUS_TURN_ID,
      );
      let hasMatchingPatch = false;
      if (requestCase.request.method === "item/fileChange/requestApproval") {
        const { itemId } = requestCase.request.params;
        hasMatchingPatch = targetTurn?.items.some(
          (item) => item.type === "fileChange" && item.id === itemId,
        ) === true;
      }
      if (!hasMatchingPatch) {
        errors.push(`request case ${requestCase.id} has no matching raw patch to attach`);
      }
    }

    const pendingRequests = getRequestEvents(requestCase.pendingFixture);
    if (pendingRequests.length !== 1 || pendingRequests[0]?.request !== requestCase.request) {
      errors.push(`request case ${requestCase.id} pending fixture does not reuse its request`);
    }
    const resolvedPrefix = requestCase.resolvedFixture.events.slice(0, -1);
    if (JSON.stringify(requestCase.pendingFixture.events) !== JSON.stringify(resolvedPrefix)) {
      errors.push(`request case ${requestCase.id} resolved fixture changed the pending prefix`);
    }

    const resolvedEvent = requestCase.resolvedFixture.events.at(-1);
    if (
      resolvedEvent?.type !== "notification"
      || resolvedEvent.notification.method !== "serverRequest/resolved"
      || requestIdentityKey(resolvedEvent.notification.params.requestId) !== requestKey
    ) {
      errors.push(`request case ${requestCase.id} has an invalid resolved notification`);
    }
  }

  for (const requestCase of agentActivityV2OneShotRequestCases) {
    if (caseIds.has(requestCase.id)) {
      errors.push(`duplicate request case ${requestCase.id}`);
    }
    caseIds.add(requestCase.id);
    appendFixtureMetadataErrors(requestCase.fixture, errors);
    if (requestCase.evidence.length === 0) {
      errors.push(`request case ${requestCase.id} has no exact evidence`);
    }

    const requests = getRequestEvents(requestCase.fixture);
    if (requests.length !== requestCase.effects.length) {
      errors.push(`request case ${requestCase.id} does not have one effect per request`);
      continue;
    }
    requests.forEach((event, index) => {
      const effect = requestCase.effects[index];
      const requestKey = requestIdentityKey(event.request.id);
      if (requestIds.has(requestKey)) {
        errors.push(`duplicate request id ${requestKey}`);
      }
      requestIds.add(requestKey);
      if (!isGeneratedServerRequest(event.request)) {
        errors.push(`request case ${requestCase.id} unexpectedly uses a private method`);
        return;
      }
      if (!requestMatchesCorpusScope(event.request)) {
        errors.push(`request case ${requestCase.id} is outside the corpus thread or turn`);
      }
      if (
        effect === undefined
        || !effectsMatch(effect, expectedEffectForRepresentativeRequest(event.request))
      ) {
        errors.push(`request case ${requestCase.id} effect ${index} is incorrect`);
      }
    });
  }

  const dynamicCase = agentActivityV2OneShotRequestCases.find(
    (requestCase) => requestCase.id === "dynamic-tool-lifecycle",
  );
  const dynamicEvents = dynamicCase?.fixture.events;
  const started = dynamicEvents?.[0];
  const request = dynamicEvents?.[1];
  const completed = dynamicEvents?.[2];
  if (
    started?.type !== "notification"
    || started.notification.method !== "item/started"
    || request?.type !== "request"
    || request.request.method !== "item/tool/call"
    || completed?.type !== "notification"
    || completed.notification.method !== "item/completed"
    || started.notification.params.item.id !== request.request.params.callId
    || request.request.params.callId !== completed.notification.params.item.id
  ) {
    errors.push("dynamic lifecycle does not preserve item/call identity");
  }

  return errors;
}
