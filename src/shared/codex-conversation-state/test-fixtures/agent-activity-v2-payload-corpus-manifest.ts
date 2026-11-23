import {
  AGENT_ACTIVITY_V2_CORPUS_RUNTIME_EVIDENCE,
  AGENT_ACTIVITY_V2_CORPUS_SANITIZATION,
  AGENT_ACTIVITY_V2_CORPUS_TARGET,
} from "./agent-activity-v2-corpus-provenance";
import { agentActivityV2ItemFamilyCorpus } from "./agent-activity-v2-item-family-corpus";
import { agentActivityV2MixedFamilyFixture } from "./agent-activity-v2-mixed-family";
import {
  agentActivityV2BundleOnlyRequestMethods,
  agentActivityV2OneShotRequestCases,
  agentActivityV2PendingResolvedRequestCases,
} from "./agent-activity-v2-request-family-corpus";

export const AGENT_ACTIVITY_V2_PAYLOAD_CORPUS_MANIFEST_SCHEMA_VERSION = 1 as const;

export const AGENT_ACTIVITY_V2_GENERATED_AUTHORITIES = [
  "ServerRequest.ts",
  "RequestId.ts",
  "ApplyPatchApprovalParams.ts",
  "ExecCommandApprovalParams.ts",
  "v2/AttestationGenerateParams.ts",
  "v2/ChatgptAuthTokensRefreshParams.ts",
  "v2/CommandExecutionRequestApprovalParams.ts",
  "v2/DynamicToolCallParams.ts",
  "v2/FileChangeRequestApprovalParams.ts",
  "v2/McpServerElicitationRequestParams.ts",
  "v2/PermissionsRequestApprovalParams.ts",
  "v2/ToolRequestUserInputParams.ts",
  "v2/ThreadItem.ts",
  "v2/CommandAction.ts",
  "v2/FileUpdateChange.ts",
  "v2/McpToolCallAppContext.ts",
  "v2/McpToolCallResult.ts",
  "v2/DynamicToolCallOutputContentItem.ts",
  "v2/ListMcpServerStatusResponse.ts",
] as const;

function describeReplayEvents(
  events: readonly (
    | { readonly type: "notification"; readonly notification: { readonly method: string } }
    | { readonly type: "request"; readonly request: { readonly method: string } }
  )[],
): readonly string[] {
  return events.map((event) => event.type === "request"
    ? `request:${event.request.method}`
    : `notification:${event.notification.method}`);
}

function sortedKeys(value: object): readonly string[] {
  return Object.keys(value).sort();
}

export function buildAgentActivityV2PayloadCorpusManifest() {
  const evidenceCatalog = [
    ...agentActivityV2ItemFamilyCorpus.flatMap((payloadCase) => payloadCase.evidence),
    ...agentActivityV2PendingResolvedRequestCases.flatMap((requestCase) => requestCase.evidence),
    ...agentActivityV2OneShotRequestCases.flatMap((requestCase) => requestCase.evidence),
    ...agentActivityV2BundleOnlyRequestMethods.map((requestMethod) => requestMethod.evidence),
    ...agentActivityV2MixedFamilyFixture.replay.provenance.evidence,
  ].filter((value, index, values) => values.indexOf(value) === index);
  const evidenceIndexes = (evidence: readonly string[]): readonly number[] =>
    evidence.map((entry) => evidenceCatalog.indexOf(entry));

  return {
    schemaVersion: AGENT_ACTIVITY_V2_PAYLOAD_CORPUS_MANIFEST_SCHEMA_VERSION,
    matrixId: "E-04",
    corpus: "thread-agent-activity-v2-representative-protocol-payloads",
    provenance: {
      kind: "bundle-synthesized",
      target: AGENT_ACTIVITY_V2_CORPUS_TARGET,
      runtimeEvidence: AGENT_ACTIVITY_V2_CORPUS_RUNTIME_EVIDENCE,
      generatedAuthorities: AGENT_ACTIVITY_V2_GENERATED_AUTHORITIES,
      evidenceCatalog,
    },
    sanitization: AGENT_ACTIVITY_V2_CORPUS_SANITIZATION,
    itemCases: agentActivityV2ItemFamilyCorpus.map((payloadCase) => ({
      id: payloadCase.id,
      family: payloadCase.family,
      rawItemId: payloadCase.item.id,
      rawType: payloadCase.item.type,
      rawFields: sortedKeys(payloadCase.item),
      projectionContext: {
        turnStatus: payloadCase.projectionContext.turnStatus,
        rawItemIndex: payloadCase.projectionContext.rawItemIndex,
        lastNonUserWorkItemIndex: payloadCase.projectionContext.lastNonUserWorkItemIndex,
        turnCwd: payloadCase.projectionContext.turnCwd,
        turnDiff: payloadCase.projectionContext.turnDiff,
        commandStartItemIds: sortedKeys(
          payloadCase.projectionContext.commandExecutionStartedAtMsById,
        ),
        interruptedCommandItemIds:
          payloadCase.projectionContext.interruptedCommandExecutionItemIds,
        mcpServerStatuses: payloadCase.projectionContext.mcpServerStatuses === null
          ? null
          : {
              shape: "ListMcpServerStatusResponse",
              dataCount: payloadCase.projectionContext.mcpServerStatuses.data.length,
              nextCursor: payloadCase.projectionContext.mcpServerStatuses.nextCursor,
            },
      },
      expected: {
        directPayloads: payloadCase.expected.directPayloads.map((payload) => ({
          itemType: payload.itemType,
          fieldRules: payload.fields.map((field) => field.state === "equals"
            ? `${field.path} equals ${JSON.stringify(field.value)}`
            : `${field.path} ${field.state}`),
        })),
        aggregateItemTypes: payloadCase.expected.aggregateItemTypes,
        activityDispositions: payloadCase.expected.activityDispositions,
        identityValues: payloadCase.expected.identityValues,
      },
      evidenceIndexes: evidenceIndexes(payloadCase.evidence),
    })),
    requestCases: {
      pendingResolved: agentActivityV2PendingResolvedRequestCases.map((requestCase) => ({
        id: requestCase.id,
        request: {
          id: requestCase.request.id,
          idType: typeof requestCase.request.id,
          method: requestCase.request.method,
          rawFields: sortedKeys(requestCase.request),
          paramFields: sortedKeys(requestCase.request.params),
        },
        effect: requestCase.effect,
        pendingFixtureId: requestCase.pendingFixture.id,
        resolvedFixtureId: requestCase.resolvedFixture.id,
        initialItemIds: requestCase.pendingFixture.initialThread?.turns[0]?.items.map(
          (item) => item.id,
        ) ?? [],
        pendingEvents: describeReplayEvents(requestCase.pendingFixture.events),
        resolvedEvents: describeReplayEvents(requestCase.resolvedFixture.events),
        evidenceIndexes: evidenceIndexes(requestCase.evidence),
      })),
      oneShot: agentActivityV2OneShotRequestCases.map((requestCase) => ({
        id: requestCase.id,
        fixtureId: requestCase.fixture.id,
        events: describeReplayEvents(requestCase.fixture.events),
        effects: requestCase.effects,
        evidenceIndexes: evidenceIndexes(requestCase.evidence),
      })),
      bundleOnly: agentActivityV2BundleOnlyRequestMethods.map((requestMethod) => ({
        method: requestMethod.method,
        requestProjection: requestMethod.requestProjection,
        evidenceIndex: evidenceCatalog.indexOf(requestMethod.evidence),
      })),
    },
    mixedProjection: {
      fixtureId: agentActivityV2MixedFamilyFixture.replay.id,
      evidenceIndexes: evidenceIndexes(
        agentActivityV2MixedFamilyFixture.replay.provenance.evidence,
      ),
      projectedItemTypes: agentActivityV2MixedFamilyFixture.expected.projectedItems.map(
        (item) => item.itemType,
      ),
      activitySources: agentActivityV2MixedFamilyFixture.expected.activitySourceItems.map(
        (item) => ({
          sourceIndex: item.activitySourceIndex,
          itemType: item.itemType,
          classification: item.classification,
          identity: item.identity,
        }),
      ),
      units: agentActivityV2MixedFamilyFixture.expected.units,
    },
  } as const;
}

export function serializeAgentActivityV2PayloadCorpusManifest(): string {
  return `${JSON.stringify(buildAgentActivityV2PayloadCorpusManifest(), null, 2)}\n`;
}
