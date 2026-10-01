import { describe, expect, test } from "vite-plus/test";
import {
  replayCodexConversationFixture,
  type CodexConversationReplayContext,
  type CodexConversationReplayEvent,
  type CodexConversationReplayFixture,
} from "../codex-conversation-replay";
import {
  AGENT_ACTIVITY_V2_CORPUS_RUNTIME_EVIDENCE,
  AGENT_ACTIVITY_V2_CORPUS_TARGET,
  validateAgentActivityV2CorpusFixtureMetadata,
} from "./agent-activity-v2-corpus-provenance";
import {
  type AgentActivityV2ProjectionFixture,
  validateAgentActivityV2ProjectionFixture,
} from "./agent-activity-v2-fixture-schema";
import {
  agentActivityV2FallbackCommandItem,
  agentActivityV2ItemFamilyCorpus,
  agentActivityV2McpAppContextPrecedenceItem,
  agentActivityV2MixedPatchItem,
  agentActivityV2MultiActionCommandItem,
  validateAgentActivityV2ItemFamilyCorpus,
} from "./agent-activity-v2-item-family-corpus";
import { agentActivityV2MixedFamilyFixture } from "./agent-activity-v2-mixed-family";
import {
  agentActivityV2BundleOnlyRequestMethods,
  agentActivityV2CommandApprovalRequest,
  agentActivityV2OneShotRequestCases,
  agentActivityV2PendingResolvedRequestCases,
  agentActivityV2PermissionRequest,
  validateAgentActivityV2RequestFamilyCorpus,
} from "./agent-activity-v2-request-family-corpus";

function describeEvent(
  event: CodexConversationReplayEvent,
  context: CodexConversationReplayContext,
): string {
  if (event.type === "request") {
    return [
      context.sourceIndex,
      "request",
      event.request.method,
      typeof event.request.id,
      event.request.id,
    ].join(":");
  }
  if (event.notification.method === "serverRequest/resolved") {
    return [
      context.sourceIndex,
      "notification",
      event.notification.method,
      typeof event.notification.params.requestId,
      event.notification.params.requestId,
    ].join(":");
  }
  return [context.sourceIndex, "notification", event.notification.method].join(":");
}

function recordEvent(
  state: readonly string[],
  event: CodexConversationReplayEvent,
  context: CodexConversationReplayContext,
): readonly string[] {
  return [...state, describeEvent(event, context)];
}

function assertDeterministicReplay(fixture: CodexConversationReplayFixture): void {
  const before = JSON.stringify(fixture);
  const first = replayCodexConversationFixture(fixture, [] as readonly string[], recordEvent);
  const second = replayCodexConversationFixture(fixture, [] as readonly string[], recordEvent);

  expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  expect(JSON.stringify(fixture)).toBe(before);
}

function hasError(errors: readonly string[], fragment: string): boolean {
  return errors.some((error) => error.includes(fragment));
}

describe("agent activity v2 representative payload corpus", () => {
  test("covers every scoped item/request family with exact bundle provenance", () => {
    expect(validateAgentActivityV2ItemFamilyCorpus().length).toBe(0);
    expect(validateAgentActivityV2RequestFamilyCorpus().length).toBe(0);
    expect(validateAgentActivityV2ProjectionFixture(agentActivityV2MixedFamilyFixture).length)
      .toBe(0);
    expect(validateAgentActivityV2CorpusFixtureMetadata(
      agentActivityV2MixedFamilyFixture.replay,
    ).length).toBe(0);

    expect(agentActivityV2ItemFamilyCorpus.length).toBe(20);
    expect(agentActivityV2PendingResolvedRequestCases.length).toBe(5);
    expect(agentActivityV2OneShotRequestCases.length).toBe(7);
    expect(agentActivityV2BundleOnlyRequestMethods.length).toBe(3);
    expect(AGENT_ACTIVITY_V2_CORPUS_TARGET.version).toBe("26.707.30751");
    expect(AGENT_ACTIVITY_V2_CORPUS_TARGET.build).toBe(5018);
    expect(AGENT_ACTIVITY_V2_CORPUS_TARGET.asarSha256).toBe(
      "bf6a8d30300c95cd12eb51fc39ea462a3b1bd4719a4ab260b22194340d0b2959",
    );
    expect(AGENT_ACTIVITY_V2_CORPUS_RUNTIME_EVIDENCE).toBe(
      "30751 runtime unavailable; bundle-only",
    );
  });

  test("keeps representative generated payload richness and projection presence rules", () => {
    expect(JSON.stringify(agentActivityV2MultiActionCommandItem.commandActions.map(
      (action) => action.type,
    ))).toBe(JSON.stringify(["read", "listFiles", "search", "unknown"]));
    expect(agentActivityV2FallbackCommandItem.commandActions.length).toBe(0);
    expect(agentActivityV2MixedPatchItem.changes.length).toBe(2);
    expect(Object.keys(agentActivityV2McpAppContextPrecedenceItem.appContext).length).toBe(5);
    expect(agentActivityV2McpAppContextPrecedenceItem.appContext.resourceUri).toBe(
      "ui://fixture/preferred",
    );
    expect(agentActivityV2McpAppContextPrecedenceItem.mcpAppResourceUri).toBe(
      "ui://fixture/deprecated",
    );
    expect(agentActivityV2McpAppContextPrecedenceItem.result?._meta?.fixture).toBe(true);

    const errorMcpCase = agentActivityV2ItemFamilyCorpus.find(
      (payloadCase) => payloadCase.id === "mcp-protocol-error",
    );
    if (errorMcpCase?.item.type !== "mcpToolCall") {
      throw new Error("Representative MCP error case is missing");
    }
    expect(errorMcpCase.item.result === null).toBe(false);
    expect(errorMcpCase.item.error === null).toBe(false);

    const fallbackCase = agentActivityV2ItemFamilyCorpus.find(
      (payloadCase) => payloadCase.id === "command-zero-action-fallback",
    );
    const genericDynamicCase = agentActivityV2ItemFamilyCorpus.find(
      (payloadCase) => payloadCase.id === "dynamic-generic-failed-output-elided",
    );
    const statusMcpCase = agentActivityV2ItemFamilyCorpus.find(
      (payloadCase) => payloadCase.id === "mcp-status-resolved-app",
    );
    if (fallbackCase === undefined || genericDynamicCase === undefined || statusMcpCase === undefined) {
      throw new Error("Representative item cases are missing");
    }

    expect(fallbackCase.expected.directPayloads[0]?.fields.some(
      (field) => field.path === "/commandExecutionItemId" && field.state === "absent",
    )).toBe(true);
    expect(genericDynamicCase.expected.directPayloads[0]?.fields.some(
      (field) => field.path === "/contentItems" && field.state === "absent",
    )).toBe(true);
    expect(statusMcpCase.projectionContext.mcpServerStatuses?.data.length).toBe(1);
  });

  test("replays every request state deterministically without mutating raw envelopes", () => {
    for (const requestCase of agentActivityV2PendingResolvedRequestCases) {
      assertDeterministicReplay(requestCase.pendingFixture);
      assertDeterministicReplay(requestCase.resolvedFixture);
    }
    for (const requestCase of agentActivityV2OneShotRequestCases) {
      assertDeterministicReplay(requestCase.fixture);
    }
  });

  test("expires direct request projection while retaining historical synthetic causality", () => {
    const resolvedCommandFixture = {
      ...agentActivityV2MixedFamilyFixture,
      replay: {
        ...agentActivityV2MixedFamilyFixture.replay,
        events: [
          ...agentActivityV2MixedFamilyFixture.replay.events,
          {
            type: "notification",
            notification: {
              method: "serverRequest/resolved",
              params: {
                threadId: agentActivityV2MixedFamilyFixture.replay.threadId,
                requestId: agentActivityV2CommandApprovalRequest.id,
              },
            },
          },
        ],
      },
    } satisfies AgentActivityV2ProjectionFixture;
    const directErrors = validateAgentActivityV2ProjectionFixture(resolvedCommandFixture);
    expect(hasError(
      directErrors,
      "projected item 11 references unavailable pending-request-projection server request 201",
    )).toBe(true);

    const historicalFixture = {
      ...agentActivityV2MixedFamilyFixture,
      replay: {
        ...agentActivityV2MixedFamilyFixture.replay,
        events: [
          ...agentActivityV2MixedFamilyFixture.replay.events,
          {
            type: "request",
            request: agentActivityV2PermissionRequest,
          },
          {
            type: "notification",
            notification: {
              method: "serverRequest/resolved",
              params: {
                threadId: agentActivityV2MixedFamilyFixture.replay.threadId,
                requestId: agentActivityV2PermissionRequest.id,
              },
            },
          },
        ],
      },
      expected: {
        ...agentActivityV2MixedFamilyFixture.expected,
        projectedItems: [
          ...agentActivityV2MixedFamilyFixture.expected.projectedItems.slice(0, 10),
          {
            projectedItemIndex: 10,
            itemType: "permission-request",
            sourceReferences: [{
              kind: "server-request" as const,
              id: agentActivityV2PermissionRequest.id,
              usage: "state-synthetic-cause" as const,
            }],
          },
          ...agentActivityV2MixedFamilyFixture.expected.projectedItems.slice(10).map(
            (item) => ({
              ...item,
              projectedItemIndex: item.projectedItemIndex + 1,
            }),
          ),
        ],
      },
    } satisfies AgentActivityV2ProjectionFixture;
    expect(validateAgentActivityV2ProjectionFixture(historicalFixture).length).toBe(0);
  });
});
