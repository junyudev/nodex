import type { ProtocolAppInfo, ProtocolListMcpServerStatusResponse } from "../../../lib/types";
import {
  attachAutomaticApprovalReviewsToToolTargets,
  buildV2AgentActivityGroupBlock,
} from "./agent-activity-group";
import {
  buildThreadAgentActivityTargetAttribute,
  buildThreadAgentActivityUnitContexts,
  buildThreadAgentActivityUnits,
  filterThreadAgentActivityGroupBodyItems,
  isThreadClassifiableActivityItem,
  projectThreadIndexedAgentActivityItems,
  type ThreadClassifiableActivityItem,
} from "./agent-activity-v2";
import {
  demoteSettledThreadAgentActivitySingleton,
  isThreadAgentActivityItemInProgress,
  isThreadExplorationActivityItem,
} from "./agent-activity-v2-summary";
import {
  isThreadActivitySliceClosed,
  resolveThreadActivityGroupState,
  resolveThreadParentActivityPresentation,
} from "./thread-live-activity";
import type {
  ThreadAgentItemModel,
  ThreadAgentRenderUnit,
  ThreadLiveActivityPresentation,
  ThreadTranscriptBlockModel,
  ThreadWorkedForBlockModel,
} from "../thread-stage-types";

export interface ProjectThreadActivityPresentationInput {
  agentItems: readonly ThreadAgentItemModel[];
  assistantItem: ThreadTranscriptBlockModel | null;
  proposedPlanItem: ThreadTranscriptBlockModel | null;
  isLatestTurn: boolean;
  isTurnInProgress: boolean;
  isTurnCancelled: boolean;
  isBlocked: boolean;
  showSafetyBufferingUi: boolean;
  hasBlockingRequest: boolean;
  hasPendingGeneratedOutput: boolean;
  hasPostAssistantUnits: boolean;
  mcpApps?: readonly ProtocolAppInfo[];
  mcpServerStatuses?: ProtocolListMcpServerStatusResponse | null;
}

export interface ThreadActivityPresentation {
  units: ThreadAgentRenderUnit[];
  liveActivity: ThreadLiveActivityPresentation;
  isExploring: boolean;
}

function resolveThreadExplorationState(
  sourceItems: readonly ThreadClassifiableActivityItem[],
  input: Pick<ProjectThreadActivityPresentationInput, "isBlocked" | "isTurnInProgress">,
): boolean {
  let hasTrailingExploration = false;
  let trailingExplorationInProgress = false;
  for (const sourceItem of sourceItems) {
    if (isThreadExplorationActivityItem(sourceItem)) {
      hasTrailingExploration = true;
      trailingExplorationInProgress ||= isThreadAgentActivityItemInProgress({
        item: sourceItem,
        grouping: "groupable",
      });
      continue;
    }
    if (sourceItem.type === "reasoning" && hasTrailingExploration) continue;
    hasTrailingExploration = false;
    trailingExplorationInProgress = false;
  }
  return (
    input.isTurnInProgress &&
    !input.isBlocked &&
    hasTrailingExploration &&
    trailingExplorationInProgress
  );
}

function toTranscriptEntries(
  items: readonly { item: ThreadClassifiableActivityItem }[],
  errorMessage: string,
) {
  return items.map(({ item }) => {
    if (!("entry" in item)) throw new Error(errorMessage);
    return item;
  });
}

export function projectThreadActivityPresentation(
  input: ProjectThreadActivityPresentationInput,
): ThreadActivityPresentation {
  const workedForItems = input.agentItems.filter(
    (item): item is ThreadWorkedForBlockModel => item.type === "workedFor",
  );
  const activityItems = input.agentItems.filter((item) => item.type !== "workedFor");
  const attachedEntries = attachAutomaticApprovalReviewsToToolTargets([...activityItems]);
  const sourceItems = attachedEntries.map((entry): ThreadClassifiableActivityItem => {
    if ("entry" in entry && isThreadClassifiableActivityItem(entry)) return entry;
    throw new Error(`Unsupported agent activity item: ${entry.type}`);
  });
  const activityUnits = buildThreadAgentActivityUnits(
    projectThreadIndexedAgentActivityItems(sourceItems, {
      mcpServerStatuses: input.mcpServerStatuses ?? null,
    }),
  );
  const isExploring = resolveThreadExplorationState(sourceItems, input);
  const liveActivity = resolveThreadParentActivityPresentation({
    isLatestTurn: input.isLatestTurn,
    isTurnInProgress: input.isTurnInProgress,
    isBlocked: input.isBlocked,
    showSafetyBufferingUi: input.showSafetyBufferingUi,
    assistantItem: input.assistantItem,
    proposedPlanItem: input.proposedPlanItem,
    agentItems: input.agentItems,
    activityUnits,
    isExploring,
    hasBlockingRequest: input.hasBlockingRequest,
    hasPendingGeneratedOutput: input.hasPendingGeneratedOutput,
    hasPostAssistantUnits: input.hasPostAssistantUnits,
  });
  const unitContexts = buildThreadAgentActivityUnitContexts({
    slices: [
      {
        kind: "main",
        units: activityUnits,
        isActivitySliceClosed: isThreadActivitySliceClosed(liveActivity.mainSlice),
        isExploring,
      },
    ],
    isTurnInProgress: input.isTurnInProgress,
    isTurnCancelled: input.isTurnCancelled,
  });
  const projectedUnits = unitContexts.map((context): ThreadAgentRenderUnit => {
    const { unit, unitIndex } = context;
    const targetAttributes = buildThreadAgentActivityTargetAttribute(unit);
    if (unit.kind === "standalone") {
      return {
        kind: "entry",
        targetAttributes,
        block: { ...unit.item.item, renderKey: unit.key },
      };
    }

    const state = resolveThreadActivityGroupState({
      unit,
      unitIndex,
      unitCount: activityUnits.length,
      parent: liveActivity,
      isTurnInProgress: input.isTurnInProgress,
      isExploring,
    });
    const renderUnit = demoteSettledThreadAgentActivitySingleton(unit, state);
    if (renderUnit.kind === "standalone") {
      return {
        kind: "entry",
        targetAttributes,
        block: { ...renderUnit.item.item, renderKey: renderUnit.key },
      };
    }

    const body = filterThreadAgentActivityGroupBodyItems(renderUnit.items, input.isTurnCancelled);
    const block = buildV2AgentActivityGroupBlock(
      toTranscriptEntries(renderUnit.items, "worked-for cannot be groupable in activity topology"),
      renderUnit.key,
      {
        bodyEntries: toTranscriptEntries(
          body.items,
          "worked-for cannot be visible in an activity group body",
        ),
        canExpand: body.canExpand,
        resolvedApps: input.mcpApps,
        state,
        thinkingFallbackMessage:
          liveActivity.fallback.owner === "group" ? liveActivity.fallback.message : null,
      },
    );
    return { kind: "agentActivityGroup", targetAttributes, block };
  });
  const workedForUnits: ThreadAgentRenderUnit[] = workedForItems.map((item) => ({
    kind: "entry",
    block: item,
  }));

  return {
    units: [...workedForUnits, ...projectedUnits],
    liveActivity,
    isExploring,
  };
}
