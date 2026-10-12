import type {
  ThreadRealtimeItem,
  ThreadRealtimeBemItemPresentation,
} from "@nodex/codex-app-server-protocol/v2";
import type { CodexHistoryRow } from "../../../../shared/codex-conversation-state/codex-history-topology";
import type {
  CodexTranscriptReadOwner,
  CodexTranscriptStructure,
  CodexTranscriptTurnSlice,
} from "../normalized-transcript-read-owner";
import type { ConversationTurnListEntry, NormalizedConversationTurnEntry } from "../selectors";
import { isNormalizedConversationTurnEntry } from "../selectors";

export type CodexTimelineTurnSlice = CodexTranscriptTurnSlice;

export type CodexTimelineTurnEntry = NormalizedConversationTurnEntry & {
  readonly timelineSlice: CodexTimelineTurnSlice;
  readonly timelinePresentation?: ThreadRealtimeBemItemPresentation;
  readonly timelineUserActions: boolean;
};

export interface CodexRealtimeTimelineEntry {
  readonly type: "realtime";
  readonly itemId: string;
  readonly itemType: ThreadRealtimeItem["type"];
  readonly turnKey: string;
  readonly turnSearchKey: string;
  readonly turnId: null;
}

export type CodexTimelineViewEntry =
  | ConversationTurnListEntry
  | CodexTimelineTurnEntry
  | CodexRealtimeTimelineEntry;

export function isCodexRealtimeTimelineEntry(
  entry: CodexTimelineViewEntry,
): entry is CodexRealtimeTimelineEntry {
  return "type" in entry && entry.type === "realtime";
}

export function isCodexTimelineTurnEntry(
  entry: CodexTimelineViewEntry,
): entry is CodexTimelineTurnEntry {
  return "timelineSlice" in entry;
}

/** Realtime and inline-presentation tails do not own native Turn follow/actions. */
export function isCodexNativeTimelineTurnEntry(
  entry: CodexTimelineViewEntry,
): entry is ConversationTurnListEntry {
  if (isCodexRealtimeTimelineEntry(entry)) return false;
  return (
    !isCodexTimelineTurnEntry(entry) ||
    !entry.timelinePresentation ||
    entry.timelinePresentation.type === "wholeItem"
  );
}

export function readLatestCodexTimelineTurnEntry(
  entries: readonly CodexTimelineViewEntry[],
): ConversationTurnListEntry | null {
  return entries.findLast(isCodexNativeTimelineTurnEntry) ?? null;
}

/** The final native Turn remains latest even when the ordered list ends in realtime content. */
export function markLatestCodexTimelineTurnEntry(
  entries: readonly CodexTimelineViewEntry[],
): readonly CodexTimelineViewEntry[] {
  const latest = readLatestCodexTimelineTurnEntry(entries);
  return entries.map((entry) => {
    if (!isCodexNativeTimelineTurnEntry(entry)) return entry;
    const isMostRecentTurn = entry === latest;
    return entry.isMostRecentTurn === isMostRecentTurn ? entry : { ...entry, isMostRecentTurn };
  });
}

type Segment = {
  readonly base: NormalizedConversationTurnEntry;
  readonly turnKey: string;
  readonly itemIds: string[];
  readonly includeInput: boolean;
  includeTurnExtras: boolean;
  presentationStatus: NormalizedConversationTurnEntry["turnStatus"];
  preserveServerUserMessages?: boolean;
  readonly presentation?: ThreadRealtimeBemItemPresentation;
  readonly userActions: boolean;
};
type Descriptor = Segment | CodexRealtimeTimelineEntry;

/** Voice history is presentation over native timeline identities, not synthetic canonical Turns. */
export function projectNormalizedTimelineEntries(input: {
  readonly owner: CodexTranscriptReadOwner;
  readonly structure: CodexTranscriptStructure | null;
  readonly entries: readonly ConversationTurnListEntry[];
}): {
  readonly entries: readonly CodexTimelineViewEntry[];
  readonly historyRows: readonly CodexHistoryRow[] | null;
} {
  const timeline = input.structure?.itemTimeline;
  if (!timeline) return { entries: input.entries, historyRows: input.structure?.timeline ?? null };

  const byTurnId = new Map(
    input.entries.flatMap((entry) =>
      isNormalizedConversationTurnEntry(entry) && entry.turnId !== null
        ? [[entry.turnId, entry] as const]
        : [],
    ),
  );
  const promoted = new Set(
    timeline.entries.flatMap((entry) =>
      entry.type === "realtime" && entry.item.type === "bemItemPromoted"
        ? [JSON.stringify([entry.item.turnId, entry.item.itemId])]
        : [],
    ),
  );
  const descriptors: Descriptor[] = [];
  const opened = new Set<string>();
  const represented = new Set<string>();
  const active = new Map<string, Segment>();
  const lastByTurnId = new Map<string, Segment>();
  const seenItems = new Set<string>();
  const openingByTurnId = new Map<string, Segment>();
  const anchors = new Map<Descriptor, string | undefined>();
  let currentTurnKey: string | undefined;
  let activeSession = timeline.activeRealtimeSessionAtPageStart;
  const endSegments = () => {
    for (const segment of active.values()) segment.presentationStatus = "completed";
    active.clear();
  };

  const open = (turnId: string): void => {
    if (opened.has(turnId)) return;
    opened.add(turnId);
    const base = byTurnId.get(turnId);
    if (!base) return;
    represented.add(base.turnKey);
    const details = input.owner.readTurnDetails(base.historyEntityKey);
    if (!details || details.params.input.length === 0) return;
    const segment: Segment = {
      base,
      turnKey: base.turnKey,
      itemIds: [],
      includeInput: true,
      includeTurnExtras: false,
      presentationStatus: "completed",
      userActions: activeSession === null,
    };
    descriptors.push(segment);
    openingByTurnId.set(turnId, segment);
    lastByTurnId.set(turnId, segment);
  };

  const addItem = (
    turnId: string,
    itemId: string,
    position: number,
    promotion?: Extract<ThreadRealtimeItem, { type: "bemItemPromoted" }>,
  ): void => {
    const address = JSON.stringify([turnId, itemId]);
    if (!promotion && (seenItems.has(address) || promoted.has(address))) return;
    const base = byTurnId.get(turnId);
    if (!base || !input.owner.readItem(base.historyEntityKey, itemId)) return;
    open(turnId);
    seenItems.add(address);
    const raw = input.owner.readItem(base.historyEntityKey, itemId)!;
    const openingId = input.owner.readOpeningUserMessageId(base.historyEntityKey);
    if (raw.type === "userMessage" && openingId === itemId) {
      const opening = openingByTurnId.get(turnId);
      if (opening) {
        opening.itemIds.push(itemId);
        return;
      }
    }
    const isUser = raw.type === "userMessage" || raw.type === "steeringUserMessage";
    if (isUser) {
      const preceding = active.get(turnId);
      if (preceding) preceding.presentationStatus = "completed";
      active.delete(turnId);
    }
    const separatePresentation =
      promotion !== undefined && promotion.presentation.type !== "wholeItem";
    let segment = separatePresentation || isUser ? undefined : active.get(turnId);
    if (!segment) {
      segment = {
        base,
        turnKey: separatePresentation
          ? `timeline:presentation:${promotion.id}`
          : opened.has(turnId) && lastByTurnId.has(turnId)
            ? `timeline:${base.historyEntityKey}:${position}:${itemId}`
            : base.turnKey,
        itemIds: [],
        includeInput: false,
        includeTurnExtras: false,
        presentationStatus: separatePresentation || isUser ? "completed" : "inProgress",
        userActions: false,
        ...(isUser ? { preserveServerUserMessages: true } : {}),
        ...(promotion ? { presentation: promotion.presentation } : {}),
      };
      descriptors.push(segment);
      lastByTurnId.set(turnId, segment);
      if (!separatePresentation && !isUser) active.set(turnId, segment);
    }
    segment.itemIds.push(itemId);
  };

  const addRealtime = (item: ThreadRealtimeItem): void => {
    const descriptor: CodexRealtimeTimelineEntry = {
      type: "realtime",
      itemId: item.id,
      itemType: item.type,
      turnKey: `realtime:${item.id}`,
      turnSearchKey: `realtime:${item.id}`,
      turnId: null,
    };
    descriptors.push(descriptor);
    anchors.set(descriptor, currentTurnKey);
  };

  for (const entry of timeline.entries) {
    if (entry.type === "turnStarted") {
      currentTurnKey = byTurnId.get(entry.turnId)?.turnKey ?? currentTurnKey;
      open(entry.turnId);
      continue;
    }
    if (entry.type === "turnCompleted") {
      currentTurnKey = byTurnId.get(entry.turnId)?.turnKey ?? currentTurnKey;
      const segment = active.get(entry.turnId) ?? lastByTurnId.get(entry.turnId);
      if (segment) {
        segment.includeTurnExtras = true;
        segment.presentationStatus = segment.base.turnStatus;
      }
      active.delete(entry.turnId);
      continue;
    }
    if (entry.type === "item") {
      currentTurnKey = byTurnId.get(entry.turnId)?.turnKey ?? currentTurnKey;
      addItem(entry.turnId, entry.item.id, entry.position);
      continue;
    }
    if (entry.item.type === "bemItemPromoted") {
      const base = byTurnId.get(entry.item.turnId);
      if (base && input.owner.readItem(base.historyEntityKey, entry.item.itemId)) {
        addItem(entry.item.turnId, entry.item.itemId, entry.position, entry.item);
        continue;
      }
      addRealtime(entry.item);
      continue;
    }
    if (entry.item.type === "realtimeSessionStarted") {
      endSegments();
      activeSession = entry.item.realtimeSessionId;
      continue;
    }
    if (entry.item.type === "realtimeSessionClosed") {
      if (entry.item.realtimeSessionId !== activeSession) continue;
      activeSession = null;
    }
    endSegments();
    addRealtime(entry.item);
  }

  // A native live suffix may not yet have a timeline receipt. Keep those identities visible.
  for (const [turnId, base] of byTurnId) {
    if (!opened.has(turnId)) continue;
    const missing = base.turnItemIds.filter(
      (itemId): itemId is string =>
        itemId !== undefined && !seenItems.has(JSON.stringify([turnId, itemId])),
    );
    for (const itemId of missing) addItem(turnId, itemId, Number.MAX_SAFE_INTEGER);
  }

  const projected = new Map<Descriptor, CodexTimelineViewEntry>();
  for (const descriptor of descriptors) {
    if (!("base" in descriptor)) continue;
    // Work receipts can repeat an item; a slice selects its canonical identity once.
    const selected = new Set(descriptor.itemIds);
    const itemIds = descriptor.base.turnItemIds.filter(
      (itemId): itemId is string => itemId !== undefined && selected.has(itemId),
    );
    const slice: CodexTimelineTurnSlice = {
      itemIds,
      includeInput: descriptor.includeInput,
      includeTurnExtras: descriptor.includeTurnExtras,
      presentationStatus: descriptor.presentationStatus,
      ...(descriptor.preserveServerUserMessages ? { preserveServerUserMessages: true } : {}),
    };
    const rawItems = itemIds.map((itemId) =>
      input.owner.readItem(descriptor.base.historyEntityKey, itemId),
    );
    projected.set(descriptor, {
      ...descriptor.base,
      turnKey: descriptor.turnKey,
      turnSearchKey: descriptor.turnKey,
      turnItemIds: itemIds,
      timelineSlice: slice,
      timelineUserActions: descriptor.userActions,
      requests:
        descriptor.includeInput ||
        descriptor.preserveServerUserMessages ||
        (descriptor.presentation?.type !== "wholeItem" && descriptor.presentation !== undefined)
          ? []
          : descriptor.base.requests.filter(
              (request) =>
                descriptor.presentationStatus === "inProgress" ||
                ("itemId" in request && selected.has(request.itemId)) ||
                ("callId" in request &&
                  typeof request.callId === "string" &&
                  selected.has(request.callId)),
            ),
      ...(descriptor.presentation ? { timelinePresentation: descriptor.presentation } : {}),
      turnStatus: descriptor.presentationStatus,
      isMostRecentTurn: false,
      hasUserMessage:
        descriptor.includeInput || rawItems.some((item) => item?.type === "userMessage"),
      hasAssistantMessage: rawItems.some((item) => item?.type === "agentMessage"),
      readTurn: () => input.owner.readTurnSlice(descriptor.base.historyEntityKey, slice),
    });
  }
  const result = orderTimelineIslands(input, descriptors, projected, represented, anchors);
  return { ...result, entries: markLatestCodexTimelineTurnEntry(result.entries) };
}

/** Sparse history gaps keep their native recovery references between the same islands. */
function orderTimelineIslands(
  input: {
    readonly structure: CodexTranscriptStructure | null;
    readonly entries: readonly ConversationTurnListEntry[];
  },
  descriptors: readonly Descriptor[],
  projected: ReadonlyMap<Descriptor, CodexTimelineViewEntry>,
  represented: ReadonlySet<string>,
  anchors: ReadonlyMap<Descriptor, string | undefined>,
) {
  const history =
    input.structure?.timeline ??
    input.entries.map((entry): CodexHistoryRow => ({
      kind: "content",
      key: entry.turnKey,
      turnKey: entry.turnKey,
      entityKey: entry.turnKey,
    }));
  const islandByKey = new Map<string, number>();
  let island = 0;
  for (const row of history) {
    if (row.kind === "gap") island += 1;
    else islandByKey.set(row.turnKey, island);
  }
  const sourceIndexByKey = new Map(input.entries.map((entry, index) => [entry.turnKey, index]));
  const buckets = new Map<number, Array<{ entry: CodexTimelineViewEntry; sourceIndex: number }>>();
  const firstRepresented = descriptors.find((descriptor) => "base" in descriptor);
  const defaultIsland =
    firstRepresented && "base" in firstRepresented
      ? (islandByKey.get(firstRepresented.base.turnKey) ?? island)
      : island;
  const defaultSourceIndex =
    firstRepresented && "base" in firstRepresented
      ? (sourceIndexByKey.get(firstRepresented.base.turnKey) ?? -1)
      : -1;
  for (const descriptor of descriptors) {
    const key = "base" in descriptor ? descriptor.base.turnKey : anchors.get(descriptor);
    const address = key === undefined ? defaultIsland : (islandByKey.get(key) ?? defaultIsland);
    const bucket = buckets.get(address) ?? [];
    bucket.push({
      entry: projected.get(descriptor) ?? (descriptor as CodexRealtimeTimelineEntry),
      sourceIndex:
        key === undefined ? defaultSourceIndex : (sourceIndexByKey.get(key) ?? defaultSourceIndex),
    });
    buckets.set(address, bucket);
  }
  for (const entry of input.entries) {
    if (represented.has(entry.turnKey)) continue;
    const address = islandByKey.get(entry.turnKey) ?? island;
    const bucket = buckets.get(address) ?? [];
    const sourceIndex = sourceIndexByKey.get(entry.turnKey) ?? Number.MAX_SAFE_INTEGER;
    const next = bucket.findIndex((value) => value.sourceIndex > sourceIndex);
    bucket.splice(next === -1 ? bucket.length : next, 0, { entry, sourceIndex });
    buckets.set(address, bucket);
  }
  const entries: CodexTimelineViewEntry[] = [];
  const historyRows: CodexHistoryRow[] = [];
  const emitted = new Set<number>();
  const emit = (address: number) => {
    if (emitted.has(address)) return;
    emitted.add(address);
    for (const { entry } of buckets.get(address) ?? []) {
      entries.push(entry);
      historyRows.push({
        kind: "content",
        key: `timeline-content:${entry.turnKey}`,
        turnKey: entry.turnKey,
        entityKey: isCodexRealtimeTimelineEntry(entry) ? entry.itemId : entry.turnKey,
      });
    }
  };
  island = 0;
  for (const row of history) {
    if (row.kind === "gap") {
      emit(island);
      historyRows.push(row);
      island += 1;
      continue;
    }
    emit(island);
  }
  for (const address of buckets.keys()) emit(address);
  return { entries, historyRows };
}
