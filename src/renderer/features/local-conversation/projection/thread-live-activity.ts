import { resolveThoughtHeading } from "../../../../shared/thought-presentation";
import type {
  ThreadActivitySlicePresentation,
  ThreadAgentActivityUnit,
  ThreadAgentItemModel,
  ThreadGlobalActivityPresentation,
  ThreadLiveActivityPresentation,
  ThreadLiveReasoningSummary,
  ThreadThinkingFallbackPresentation,
  ThreadTranscriptBlockModel,
} from "../thread-stage-types";
import {
  isThreadAgentActivityItemInProgress,
  isThreadExplorationActivityItem,
  resolveThreadAgentActivityGroupState as resolvePerGroupActivityState,
  type ThreadAgentActivityGroupState,
} from "./agent-activity-v2-summary";
import type { ThreadClassifiableActivityItem } from "./agent-activity-v2";

export interface ResolveThreadParentActivityInput {
  isLatestTurn: boolean;
  isTurnInProgress: boolean;
  isBlocked: boolean;
  showSafetyBufferingUi: boolean;
  assistantItem: ThreadTranscriptBlockModel | null;
  proposedPlanItem: ThreadTranscriptBlockModel | null;
  agentItems: readonly ThreadAgentItemModel[];
  activityUnits: readonly ThreadAgentActivityUnit<ThreadClassifiableActivityItem>[];
  isExploring: boolean;
  hasBlockingRequest: boolean;
  hasPendingGeneratedOutput: boolean;
  hasPostAssistantUnits: boolean;
  forceThinking?: boolean;
}

/** The current Thought's heading, which names the Turn's thinking status when it has one. */
export function resolveThreadReasoningSummary(
  agentItems: readonly ThreadAgentItemModel[],
): ThreadLiveReasoningSummary | null {
  const latest = agentItems.findLast((item) => item.type === "reasoning");
  if (latest?.type !== "reasoning") return null;
  const text = resolveThoughtHeading(latest.entry.markdownText);
  return text === null ? null : { itemId: latest.entry.itemId, text };
}

function isIncompleteBlock(block: ThreadTranscriptBlockModel | null): boolean {
  return block?.status === "inProgress";
}

function hasVisibleAssistantOutput(block: ThreadTranscriptBlockModel | null): boolean {
  if (block?.type !== "assistantMessage") return false;
  return block.status === "completed" || (block.entry.markdownText ?? "").trim().length > 0;
}

function hasFinalAssistantStarted(block: ThreadTranscriptBlockModel | null): boolean {
  return (
    block?.type === "assistantMessage" &&
    block.entry.assistantPhase === "final_answer" &&
    hasVisibleAssistantOutput(block)
  );
}

function flattenActivityItems(
  units: readonly ThreadAgentActivityUnit<ThreadClassifiableActivityItem>[],
) {
  return units.flatMap((unit) => (unit.kind === "group" ? unit.items : [unit.item]));
}

function resolveGlobalActivityState(
  input: ResolveThreadParentActivityInput,
): ThreadGlobalActivityPresentation {
  if (input.forceThinking === true) {
    return { state: { type: "thinking", isVisible: true }, reason: "force-thinking" };
  }
  if (!input.isLatestTurn) return { state: { type: "none" }, reason: "not-latest-turn" };
  if (!input.isTurnInProgress) return { state: { type: "none" }, reason: "turn-settled" };
  if (input.agentItems.some((item) => "entry" in item && item.entry.recovery?.state === "retrying"))
    return { state: { type: "none" }, reason: "provider-recovery" };
  if (input.isExploring) return { state: { type: "exploring" }, reason: "exploring" };
  if (isIncompleteBlock(input.proposedPlanItem)) {
    return { state: { type: "planning" }, reason: "planning" };
  }

  const activityItems = flattenActivityItems(input.activityUnits);
  const latestActivityItem = activityItems.at(-1) ?? null;
  const hasActiveWebSearch =
    latestActivityItem?.item.type === "webSearch" &&
    isThreadAgentActivityItemInProgress(latestActivityItem);
  const hasActiveDynamicTool = activityItems.some(
    ({ item }) =>
      item.type === "dynamicToolCall" &&
      isThreadAgentActivityItemInProgress({ item, grouping: "groupable" }),
  );
  const isAnyNonExploringItemInProgress = activityItems.some(
    (activityItem) =>
      activityItem.item.type !== "assistantMessage" &&
      !isThreadExplorationActivityItem(activityItem.item) &&
      isThreadAgentActivityItemInProgress(activityItem),
  );
  const hasBlockingRequest = input.isBlocked || input.hasBlockingRequest;
  if (hasBlockingRequest) return { state: { type: "none" }, reason: "blocking-request" };
  if (hasVisibleAssistantOutput(input.assistantItem)) {
    return { state: { type: "none" }, reason: "assistant-visible-output" };
  }
  if (hasActiveWebSearch) return { state: { type: "none" }, reason: "active-web-search" };
  if (hasActiveDynamicTool) return { state: { type: "none" }, reason: "active-dynamic-summary" };
  if (isIncompleteBlock(input.assistantItem)) {
    return { state: { type: "thinking", isVisible: true }, reason: "assistant-in-progress" };
  }
  if (isAnyNonExploringItemInProgress) {
    return { state: { type: "none" }, reason: "active-tool" };
  }
  return { state: { type: "thinking", isVisible: true }, reason: "between-activities" };
}

function resolveActivitySlice(
  input: ResolveThreadParentActivityInput,
): ThreadActivitySlicePresentation {
  const latestVisibleUnit = input.activityUnits.at(-1) ?? null;
  const presentation = (
    state: ThreadActivitySlicePresentation["state"],
  ): ThreadActivitySlicePresentation => ({
    kind: "main",
    state,
    latestVisibleUnit:
      latestVisibleUnit == null
        ? null
        : { key: latestVisibleUnit.key, kind: latestVisibleUnit.kind },
  });

  if (!input.isLatestTurn) {
    return presentation({ kind: "closed", reason: "not-latest-turn" });
  }
  if (!input.isTurnInProgress) {
    return presentation({ kind: "closed", reason: "turn-settled" });
  }
  if (input.isBlocked || input.hasBlockingRequest) {
    return presentation({ kind: "closed", reason: "blocking-request" });
  }
  if (input.showSafetyBufferingUi) {
    return presentation({ kind: "closed", reason: "safety-buffering" });
  }
  if (input.hasPendingGeneratedOutput) {
    return presentation({ kind: "closed", reason: "pending-generated-output" });
  }
  if (isIncompleteBlock(input.proposedPlanItem)) {
    return presentation({ kind: "closed", reason: "planning" });
  }
  if (hasVisibleAssistantOutput(input.assistantItem)) {
    return presentation({ kind: "closed", reason: "assistant-visible-output" });
  }
  return presentation({ kind: "open", reason: "turn-streaming" });
}

export function isThreadActivitySliceClosed(slice: ThreadActivitySlicePresentation): boolean {
  return slice.state.kind === "closed";
}

function resolveThinkingFallback(input: {
  parentInput: ResolveThreadParentActivityInput;
  global: ThreadGlobalActivityPresentation;
  mainSlice: ThreadActivitySlicePresentation;
  reasoningMessage: string | null;
}): ThreadThinkingFallbackPresentation {
  const { parentInput, global, mainSlice, reasoningMessage } = input;
  const isActivitySliceClosed = isThreadActivitySliceClosed(mainSlice);
  const hasActivityUnits = parentInput.activityUnits.length > 0;
  const postAssistantThinking =
    global.reason !== "provider-recovery" &&
    parentInput.isLatestTurn &&
    parentInput.isTurnInProgress &&
    isActivitySliceClosed &&
    !hasFinalAssistantStarted(parentInput.assistantItem) &&
    !(parentInput.isBlocked || parentInput.hasBlockingRequest) &&
    global.state.type === "none" &&
    !parentInput.hasPostAssistantUnits;
  const groupOwnsThinking =
    !parentInput.showSafetyBufferingUi &&
    !parentInput.hasPendingGeneratedOutput &&
    global.state.type === "thinking" &&
    !isActivitySliceClosed &&
    hasActivityUnits &&
    mainSlice.latestVisibleUnit?.kind === "group";

  if (groupOwnsThinking) {
    return {
      owner: "group",
      reason: "latest-open-group",
      message: reasoningMessage,
      isVisible: true,
    };
  }
  if (parentInput.showSafetyBufferingUi) {
    return {
      owner: "none",
      reason: "safety-buffering",
      message: null,
      isVisible: false,
    };
  }
  if (parentInput.hasPendingGeneratedOutput) {
    return {
      owner: "none",
      reason: "pending-generated-output",
      message: null,
      isVisible: false,
    };
  }
  if (global.state.type === "thinking") {
    return {
      owner: "standalone",
      reason: "global-thinking",
      message: reasoningMessage,
      isVisible: global.state.isVisible,
    };
  }
  if (postAssistantThinking) {
    return {
      owner: "standalone",
      reason: "post-assistant-thinking",
      message: reasoningMessage,
      isVisible: true,
    };
  }
  return {
    owner: "none",
    reason: "global-state-suppressed",
    message: null,
    isVisible: false,
  };
}

export function resolveThreadParentActivityPresentation(
  input: ResolveThreadParentActivityInput,
): ThreadLiveActivityPresentation {
  const reasoningSummary = resolveThreadReasoningSummary(input.agentItems);
  const global = resolveGlobalActivityState(input);
  const mainSlice = resolveActivitySlice(input);
  const fallback = resolveThinkingFallback({
    parentInput: input,
    global,
    mainSlice,
    reasoningMessage: reasoningSummary?.text ?? null,
  });

  return {
    global,
    mainSlice,
    fallback,
    reasoningSummary,
  };
}

export function resolveThreadActivityGroupState(input: {
  unit: Extract<ThreadAgentActivityUnit<ThreadClassifiableActivityItem>, { kind: "group" }>;
  unitIndex: number;
  unitCount: number;
  parent: ThreadLiveActivityPresentation;
  isTurnInProgress: boolean;
  isExploring: boolean;
}): ThreadAgentActivityGroupState {
  const isLatestVisibleUnit = input.unitIndex === input.unitCount - 1;
  return resolvePerGroupActivityState({
    unit: input.unit,
    isLatestVisibleUnit,
    isTurnInProgress: input.isTurnInProgress,
    isActivitySliceClosed: isThreadActivitySliceClosed(input.parent.mainSlice),
    isExploring: input.isExploring,
  });
}
