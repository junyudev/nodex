import { describe, expect, test } from "vite-plus/test";
import { assertAgentActivityV2ProjectionFixture, type AgentActivityV2ProjectionFixture, validateAgentActivityV2ProjectionFixture } from "./agent-activity-v2-fixture-schema";
import { agentActivityV2MixedFamilyFixture } from "./agent-activity-v2-mixed-family";
import { sanitizedCommandLifecycleFixture } from "./sanitized-command-lifecycle";
import { replayCodexConversationFixture, type CodexConversationReplayContext, type CodexConversationReplayEvent, type CodexConversationReplayFixture } from "../codex-conversation-replay";
import { AGENT_ACTIVITY_V2_CORPUS_RUNTIME_EVIDENCE, AGENT_ACTIVITY_V2_CORPUS_TARGET, validateAgentActivityV2CorpusFixtureMetadata } from "./agent-activity-v2-corpus-provenance";
import { agentActivityV2FallbackCommandItem, agentActivityV2ItemFamilyCorpus, agentActivityV2McpAppContextPrecedenceItem, agentActivityV2MixedPatchItem, agentActivityV2MultiActionCommandItem, validateAgentActivityV2ItemFamilyCorpus } from "./agent-activity-v2-item-family-corpus";
import { agentActivityV2BundleOnlyRequestMethods, agentActivityV2CommandApprovalRequest, agentActivityV2OneShotRequestCases, agentActivityV2PendingResolvedRequestCases, agentActivityV2PermissionRequest, validateAgentActivityV2RequestFamilyCorpus } from "./agent-activity-v2-request-family-corpus";

describe("agent activity v2 fixture schema", () => {
function hasError(errors: readonly string[], fragment: string): boolean {
  return errors.some((error) => error.includes(fragment));
}

describe("agent activity v2 projection fixture schema", () => {
  test("accepts a mixed groupable run across a hidden reasoning source", () => {
    const errors = validateAgentActivityV2ProjectionFixture(
      agentActivityV2MixedFamilyFixture,
    );

    expect(errors.length).toBe(0);
    expect(JSON.stringify(
      agentActivityV2MixedFamilyFixture.expected.projectedItems.map((item) => item.itemType),
    )).toBe(JSON.stringify([
      "exec",
      "exec",
      "exec",
      "exec",
      "reasoning",
      "patch",
      "web-search",
      "mcp-tool-call",
      "dynamic-tool-call",
      "dynamic-tool-call",
      "turn-diff",
      "exec",
    ]));
    expect(JSON.stringify(agentActivityV2MixedFamilyFixture.expected.units)).toBe(
      JSON.stringify([
        {
          kind: "group",
          key: "agent-activity-group:command-multi:0",
          activitySourceIndexes: [0, 1, 2, 3, 5, 6, 7, 8],
        },
        {
          kind: "standalone",
          key: "agent-activity-standalone:dynamic-handoff-thread",
          activitySourceIndex: 9,
        },
      ]),
    );
    expect(
      agentActivityV2MixedFamilyFixture.expected.activitySourceItems[6]?.identity?.value,
    ).toBe("web-search:6");
  });

  test("rejects splitting one maximal groupable run by tool family", () => {
    const invalidFixture = {
      ...agentActivityV2MixedFamilyFixture,
      expected: {
        ...agentActivityV2MixedFamilyFixture.expected,
        units: [
          {
            kind: "group",
            key: "agent-activity-group:command-multi:0",
            activitySourceIndexes: [0, 1, 2, 3],
          },
          {
            kind: "group",
            key: "agent-activity-group:patch-mixed",
            activitySourceIndexes: [5, 6, 7, 8],
          },
          {
            kind: "standalone",
            key: "agent-activity-standalone:dynamic-handoff-thread",
            activitySourceIndex: 9,
          },
        ],
      },
    } satisfies AgentActivityV2ProjectionFixture;

    const errors = validateAgentActivityV2ProjectionFixture(invalidFixture);

    expect(hasError(errors, "canonical hidden/filter/barrier grouping semantics")).toBe(true);
  });

  test("validates identity precedence and cross-stage carrier types", () => {
    const [execSource, ...remainingSources] =
      agentActivityV2MixedFamilyFixture.expected.activitySourceItems;
    if (execSource === undefined) {
      throw new Error("Invalid mixed-family fixture");
    }

    const invalidFixture = {
      ...agentActivityV2MixedFamilyFixture,
      expected: {
        ...agentActivityV2MixedFamilyFixture.expected,
        activitySourceItems: [
          {
            ...execSource,
            itemType: "patch",
            identity: { field: "requestId", value: "wrong-precedence" },
          },
          ...remainingSources,
        ],
        units: [{
          kind: "group",
          key: "agent-activity-group:wrong-precedence",
          activitySourceIndexes: [0, 1, 2, 3, 5, 6, 7, 8],
        }, {
          kind: "standalone",
          key: "agent-activity-standalone:dynamic-handoff-thread",
          activitySourceIndex: 9,
        }],
      },
    } satisfies AgentActivityV2ProjectionFixture;

    const errors = validateAgentActivityV2ProjectionFixture(invalidFixture);

    expect(hasError(errors, "does not match carrier projected type exec")).toBe(true);
    expect(hasError(errors, "does not match callId:command-multi:0")).toBe(true);
  });

  test("compares unit descriptors structurally instead of by property insertion order", () => {
    const reorderedFixture = {
      ...agentActivityV2MixedFamilyFixture,
      expected: {
        ...agentActivityV2MixedFamilyFixture.expected,
        units: [
          {
            key: "agent-activity-group:command-multi:0",
            activitySourceIndexes: [0, 1, 2, 3, 5, 6, 7, 8],
            kind: "group",
          },
          {
            activitySourceIndex: 9,
            key: "agent-activity-standalone:dynamic-handoff-thread",
            kind: "standalone",
          },
        ],
      },
    } satisfies AgentActivityV2ProjectionFixture;

    expect(validateAgentActivityV2ProjectionFixture(reorderedFixture).length).toBe(0);
  });

  test("supports turn-context-derived activity sources without a projected carrier", () => {
    const derivedFixture = {
      ...agentActivityV2MixedFamilyFixture,
      expected: {
        ...agentActivityV2MixedFamilyFixture.expected,
        activitySourceItems: agentActivityV2MixedFamilyFixture.expected.activitySourceItems.map(
          (sourceItem) => sourceItem.activitySourceIndex === 4
            ? {
                ...sourceItem,
                origin: {
                  kind: "derived" as const,
                  sourceReferences: [{
                    kind: "turn-context" as const,
                    turnId: agentActivityV2MixedFamilyFixture.projectionContext.turnId,
                  }],
                },
              }
            : sourceItem,
        ),
      },
    } satisfies AgentActivityV2ProjectionFixture;

    expect(validateAgentActivityV2ProjectionFixture(derivedFixture).length).toBe(0);
  });

  test("uses fallback identity when a higher-priority request ID is numeric", () => {
    const numericRequestIdentityFixture = {
      ...agentActivityV2MixedFamilyFixture,
      expected: {
        ...agentActivityV2MixedFamilyFixture.expected,
        activitySourceItems: agentActivityV2MixedFamilyFixture.expected.activitySourceItems.map(
          (sourceItem) => sourceItem.activitySourceIndex === 6
            ? {
                ...sourceItem,
                identityCandidates: { requestId: 73 },
              }
            : sourceItem,
        ),
      },
    } satisfies AgentActivityV2ProjectionFixture;

    expect(validateAgentActivityV2ProjectionFixture(numericRequestIdentityFixture).length).toBe(0);
  });

  test("rejects server-request provenance from another thread and turn", () => {
    const foreignRequest = sanitizedCommandLifecycleFixture.events[2];
    if (foreignRequest?.type !== "request") {
      throw new Error("Invalid sanitized command lifecycle fixture");
    }

    const [firstProjectedItem, ...remainingProjectedItems] =
      agentActivityV2MixedFamilyFixture.expected.projectedItems;
    if (firstProjectedItem === undefined) {
      throw new Error("Invalid mixed-family fixture");
    }

    const foreignRequestFixture = {
      ...agentActivityV2MixedFamilyFixture,
      replay: {
        ...agentActivityV2MixedFamilyFixture.replay,
        events: [foreignRequest],
      },
      expected: {
        ...agentActivityV2MixedFamilyFixture.expected,
        projectedItems: [{
          ...firstProjectedItem,
          sourceReferences: [{
            kind: "server-request",
            id: foreignRequest.request.id,
            usage: "pending-request-projection",
          }],
        }, ...remainingProjectedItems],
      },
    } satisfies AgentActivityV2ProjectionFixture;

    const errors = validateAgentActivityV2ProjectionFixture(foreignRequestFixture);

    expect(hasError(errors, "references unavailable pending-request-projection server request 73"))
      .toBe(true);
  });

  test("assertion reports broken raw-state provenance", () => {
    const invalidFixture = {
      ...agentActivityV2MixedFamilyFixture,
      expected: {
        ...agentActivityV2MixedFamilyFixture.expected,
        projectedItems: [
          {
            ...agentActivityV2MixedFamilyFixture.expected.projectedItems[0],
            sourceReferences: [{ kind: "thread-item", id: "missing-command" }],
          },
          ...agentActivityV2MixedFamilyFixture.expected.projectedItems.slice(1),
        ],
      },
    } satisfies AgentActivityV2ProjectionFixture;

    let message = "";
    try {
      assertAgentActivityV2ProjectionFixture(invalidFixture);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message.includes("references unknown thread item missing-command")).toBe(true);
  });
});
});

describe("agent activity v2 payload corpus", () => {
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
    expect(agentActivityV2OneShotRequestCases.length).toBe(6);
    expect(agentActivityV2BundleOnlyRequestMethods.length).toBe(2);
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
});
