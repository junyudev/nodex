import type { VisibleConversationTurnEntry } from "../selectors";
import type { ThreadSearchUnitModel } from "../thread-stage-types";
import { selectTurnRenderModel } from "../projection/build-turn-render-model";
import { projectCodexMarkdownToPlainText } from "../../../../shared/codex-markdown-text";
import { projectAssistantText } from "../../../../shared/codex-canonical-item-projector";
import type { CodexTranscriptReadOwner } from "../normalized-transcript-read-owner";
import {
  isCodexRealtimeTimelineEntry,
  isCodexTimelineTurnEntry,
  type CodexRealtimeTimelineEntry,
  type CodexTimelineTurnEntry,
  type CodexTimelineViewEntry,
} from "../projection/normalized-timeline-entries";
import { materializeConversationTurnListEntry } from "../selectors";
import { resolveTimelineInlinePresentation } from "../projection/timeline-inline-presentation";
import type { ContentSearchLocalResult } from "../../content-search/content-search-model";
import {
  resolveLocalConversationPersistedSearchTarget,
  type LocalConversationPersistedSearchMatchMeta,
} from "./local-conversation-persisted-search";

export const realtimeSearchUnitKey = (
  entry: CodexRealtimeTimelineEntry,
  itemId = entry.itemId,
): string => `${entry.turnSearchKey}:item:${itemId}`;
export const inlineMarkdownSearchUnitKey = (entry: CodexTimelineTurnEntry): string =>
  `${entry.turnKey}:inlineMarkdown`;

/** Count every literal occurrence even when the bounded result list is full. */
export function projectLocalConversationResidentSearchResult(input: {
  readonly units: readonly ThreadSearchUnitModel[];
  readonly query: string;
  readonly contextId: string;
  readonly limit: number;
}): ContentSearchLocalResult {
  const query = input.query.trim();
  const needle = query.toLowerCase();
  const matches: ContentSearchLocalResult["matches"] = [];
  let totalMatches = 0;
  if (!needle) return { query, matches, totalMatches, capped: false };
  for (const unit of input.units) {
    const text = unit.text.toLowerCase();
    let cursor = 0;
    let occurrenceIndex = 0;
    for (
      let offset = text.indexOf(needle, cursor);
      offset >= 0;
      offset = text.indexOf(needle, cursor)
    ) {
      totalMatches += 1;
      if (matches.length < input.limit)
        matches.push({
          id: `conversation:${unit.key}:${occurrenceIndex}`,
          domain: "conversation",
          contextId: input.contextId,
          ordinal: matches.length,
          label: unit.text,
          meta: { unitKey: unit.key, turnKey: unit.turnKey, occurrenceIndex },
        });
      occurrenceIndex += 1;
      cursor = offset + needle.length;
    }
  }
  return { query, matches, totalMatches, capped: totalMatches > matches.length };
}

export type LocalConversationSearchSourceTurn = VisibleConversationTurnEntry;

interface CachedSearchTurnState {
  readonly turnIdentity: number;
  readonly requestsIdentity: number;
  units: ThreadSearchUnitModel[];
}

export interface LocalConversationSearchSource {
  routeContextId: string;
  cwd?: string | null;
  projectlessOutputDirectory?: string | null;
  getTurns: () => LocalConversationSearchSourceTurn[];
  getProjectedEntries?: () => readonly CodexTimelineViewEntry[];
  readOwner?: () => CodexTranscriptReadOwner | null;
  scrollAdapter: {
    scrollToTurn: (turnKey: string, options?: { signal?: AbortSignal }) => Promise<void>;
    getTurnContainer: (turnKey: string) => HTMLElement | null;
  };
}

export function createLocalConversationSearchSource(input: LocalConversationSearchSource) {
  const cachedUnitsByTurnKey = new Map<string, CachedSearchTurnState>();
  const cachedTimelineUnits = new Map<
    string,
    {
      identity: object;
      realtimeItems?: readonly ReturnType<CodexTranscriptReadOwner["readRealtimeItem"]>[];
      status?: string;
      units: ThreadSearchUnitModel[];
    }
  >();
  const identities = new WeakMap<object, number>();
  let nextIdentity = 0;
  const identityOf = (value: object): number => {
    const existing = identities.get(value);
    if (existing !== undefined) return existing;
    const identity = ++nextIdentity;
    identities.set(value, identity);
    return identity;
  };

  const pruneCachedData = (entries = input.getTurns()): void => {
    const current = new Map(entries.map((entry) => [entry.turnKey, entry]));
    for (const [key, cached] of cachedUnitsByTurnKey) {
      const entry = current.get(key);
      if (
        !entry ||
        cached.turnIdentity !== identityOf(entry.turn) ||
        cached.requestsIdentity !== identityOf(entry.requests)
      )
        cachedUnitsByTurnKey.delete(key);
    }
    const keys = new Set(input.getProjectedEntries?.().map((entry) => entry.turnKey));
    for (const key of cachedTimelineUnits.keys()) {
      if (!keys.has(key)) cachedTimelineUnits.delete(key);
    }
  };

  const getTurns = (): LocalConversationSearchSourceTurn[] => {
    const entries = input.getTurns();
    pruneCachedData(entries);
    return entries;
  };

  const getUnitsForTurn = (entry: VisibleConversationTurnEntry): ThreadSearchUnitModel[] => {
    const cached = cachedUnitsByTurnKey.get(entry.turnKey);
    const turnIdentity = identityOf(entry.turn);
    const requestsIdentity = identityOf(entry.requests);
    if (cached?.turnIdentity === turnIdentity && cached.requestsIdentity === requestsIdentity)
      return cached.units;

    const model = selectTurnRenderModel({
      entry,
      canEditTurnUserPrefix: false,
      canForkTurn: false,
      cwd: input.cwd,
      projectlessOutputDirectory: input.projectlessOutputDirectory,
    });
    const units = model.searchUnits.filter((unit) => unit.text.length > 0);
    cachedUnitsByTurnKey.set(entry.turnKey, { turnIdentity, requestsIdentity, units });
    return units;
  };

  const getUnitsForProjectedEntry = (entry: CodexTimelineViewEntry): ThreadSearchUnitModel[] => {
    if (isCodexTimelineTurnEntry(entry) && entry.timelineEndResources) return [];
    const owner = input.readOwner?.();
    if (isCodexRealtimeTimelineEntry(entry)) {
      if (entry.itemType !== "transcriptSegment" || !owner) return [];
      const values = entry.segmentIds.map((itemId) => owner.readRealtimeItem(itemId));
      const cached = cachedTimelineUnits.get(entry.turnKey);
      if (
        cached?.realtimeItems?.length === values.length &&
        values.every((value, index) => value === cached.realtimeItems?.[index])
      )
        return cached.units;
      // Spoken transcript text is literal, unlike promoted assistant Markdown.
      const units = values.flatMap((value): ThreadSearchUnitModel[] => {
        if (!value || value.item.type !== "transcriptSegment" || !value.item.text) return [];
        return [
          {
            key: realtimeSearchUnitKey(entry, value.item.id),
            itemId: value.item.id,
            turnId: null,
            turnKey: entry.turnKey,
            text: value.item.text,
            blockType: value.item.role === "user" ? "userMessage" : "assistantMessage",
          },
        ];
      });
      cachedTimelineUnits.set(entry.turnKey, { identity: entry, realtimeItems: values, units });
      return units;
    }
    if (
      isCodexTimelineTurnEntry(entry) &&
      entry.timelinePresentation?.type !== undefined &&
      entry.timelinePresentation.type !== "wholeItem"
    ) {
      if (entry.timelinePresentation.type !== "inlineMarkdown") return [];
      const itemId = entry.timelineSlice.itemIds[0];
      const raw = itemId ? owner?.readItem(entry.historyEntityKey, itemId) : null;
      if (!raw) return [];
      const cached = cachedTimelineUnits.get(entry.turnKey);
      if (cached?.identity === raw && cached.status === entry.turnStatus) return cached.units;
      const presentation = resolveTimelineInlinePresentation(raw, entry.timelinePresentation);
      if (presentation?.type !== "markdown") return [];
      const text = projectCodexMarkdownToPlainText(
        projectAssistantText(presentation.content, entry.turnStatus === "inProgress") ?? "",
      );
      const units: ThreadSearchUnitModel[] = text
        ? [
            {
              key: inlineMarkdownSearchUnitKey(entry),
              itemId: raw.id,
              turnId: entry.turnId,
              turnKey: entry.turnKey,
              text,
              blockType: "assistantMessage",
            },
          ]
        : [];
      cachedTimelineUnits.set(entry.turnKey, { identity: raw, status: entry.turnStatus, units });
      return units;
    }
    const materialized = materializeConversationTurnListEntry(entry);
    return materialized ? getUnitsForTurn(materialized) : [];
  };

  return {
    ...input,
    getTurns,
    getUnitsForTurn,
    getUnitsForProjectedEntry,
    findPersistedTarget(meta: LocalConversationPersistedSearchMatchMeta) {
      for (const entry of input.getProjectedEntries?.() ?? getTurns()) {
        if (
          isCodexRealtimeTimelineEntry(entry) ||
          (isCodexTimelineTurnEntry(entry) && entry.timelineEndResources) ||
          entry.turnId !== meta.occurrence.turnId
        )
          continue;
        const materialized = materializeConversationTurnListEntry(entry);
        if (!materialized) continue;
        const target = resolveLocalConversationPersistedSearchTarget({
          entry: materialized,
          occurrence: meta.occurrence,
          itemOccurrenceIndex: meta.itemOccurrenceIndex,
          query: meta.query,
          units: getUnitsForProjectedEntry(entry),
        });
        if (target) return target;
      }
      return null;
    },
    clearCachedData: () => {
      cachedUnitsByTurnKey.clear();
      cachedTimelineUnits.clear();
    },
    pruneCachedData,
    findMatches(query: string): ThreadSearchUnitModel[] {
      const normalizedQuery = query.trim().toLowerCase();
      if (!normalizedQuery) return [];

      const entries = input.getProjectedEntries?.() ?? getTurns();
      return entries.flatMap((entry) =>
        getUnitsForProjectedEntry(entry).filter((unit) =>
          unit.text.toLowerCase().includes(normalizedQuery),
        ),
      );
    },
  };
}
