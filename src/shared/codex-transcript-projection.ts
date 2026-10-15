import type { Patch } from "immer";
import type {
  CodexCanonicalConversationState,
  CodexCanonicalItem,
  CodexCanonicalTurnState,
  CodexCanonicalItemTimeline,
  CodexCanonicalTimelineEntry,
  CodexCanonicalRealtimeItem,
} from "./codex-conversation-state/codex-conversation-state";
import {
  flattenCodexHistoryTopology,
  type CodexHistoryRow,
} from "./codex-conversation-state/codex-history-topology";
import { areStructurallyEqual } from "./structural-equality";

export interface CodexTranscriptKey {
  readonly hostId: string;
  readonly threadId: string;
}
export interface CodexTranscriptTurnKey extends CodexTranscriptKey {
  readonly entityKey: string;
}
export interface CodexTranscriptItemKey extends CodexTranscriptTurnKey {
  readonly itemId: string;
}
export interface CodexTranscriptItemSlots {
  readonly length: number;
  readonly entries: readonly { readonly index: number; readonly itemId: string }[];
}
export type CodexTranscriptTurnDetails = Omit<
  CodexCanonicalTurnState,
  "items" | "completedItemIds"
>;
export interface CodexTranscriptTurn {
  readonly details: CodexTranscriptTurnDetails;
  readonly hasSubagentActivity: boolean;
  readonly itemSlots: CodexTranscriptItemSlots;
}
export type CodexTranscriptItemTimeline = CodexCanonicalItemTimeline;
export type CodexTranscriptRealtimeItem = CodexCanonicalRealtimeItem;
export interface CodexTranscriptMetadata {
  readonly resumeState: CodexCanonicalConversationState["resumeState"];
  readonly historyComplete: boolean;
  readonly itemTimeline: CodexTranscriptItemTimeline | null;
  readonly timeline: readonly CodexHistoryRow[] | null;
  readonly turnEntityKeys: readonly string[];
}
export interface CodexTranscriptSnapshot extends CodexTranscriptMetadata {
  readonly turnsByKey: Readonly<Record<string, CodexTranscriptTurn>>;
  readonly itemsByKey: Readonly<Record<string, CodexCanonicalItem>>;
  readonly realtimeItems: Readonly<Record<string, CodexTranscriptRealtimeItem>>;
}
export interface CodexTranscriptTextEdit {
  readonly at: number;
  readonly deleteCount: number;
  readonly insert: string;
}
export type CodexTranscriptTextChange =
  | {
      readonly type: "text";
      readonly key: CodexTranscriptItemKey;
      readonly target:
        | { readonly field: "text" }
        | { readonly field: "aggregatedOutput" }
        | { readonly field: "summary" | "content"; readonly index: number };
      readonly edits: readonly CodexTranscriptTextEdit[];
    }
  | {
      readonly type: "text-parts";
      readonly key: CodexTranscriptItemKey;
      readonly field: "summary" | "content";
      readonly at: number;
      readonly values: readonly string[];
    };
export type CodexTranscriptChange =
  | CodexTranscriptTextChange
  | {
      readonly type: "structure";
      readonly timeline: readonly CodexHistoryRow[] | null;
      readonly turnEntityKeys: readonly string[];
    }
  | { readonly type: "remove-turn"; readonly key: CodexTranscriptTurnKey }
  | {
      readonly type: "turn";
      readonly key: CodexTranscriptTurnKey;
      readonly details: CodexTranscriptTurnDetails;
      readonly hasSubagentActivity: boolean;
    }
  | {
      readonly type: "item-slots";
      readonly key: CodexTranscriptTurnKey;
      readonly slots: CodexTranscriptItemSlots;
    }
  | {
      readonly type: "item-slots-append";
      readonly key: CodexTranscriptTurnKey;
      readonly previousLength: number;
      readonly length: number;
      readonly entries: CodexTranscriptItemSlots["entries"];
    }
  | {
      readonly type: "item-slots-prepend";
      readonly key: CodexTranscriptTurnKey;
      readonly previousLength: number;
      readonly length: number;
      readonly entries: CodexTranscriptItemSlots["entries"];
    }
  | {
      readonly type: "item";
      readonly key: CodexTranscriptItemKey;
      readonly value: CodexCanonicalItem | null;
    }
  | {
      readonly type: "history";
      readonly resumeState: CodexTranscriptMetadata["resumeState"];
      readonly historyComplete: boolean;
    }
  | { readonly type: "item-timeline"; readonly value: CodexTranscriptItemTimeline | null }
  | {
      readonly type: "item-timeline-prepend";
      readonly entries: readonly CodexCanonicalTimelineEntry[];
      readonly activeRealtimeSessionAtPageStart: string | null;
    }
  | {
      readonly type: "item-timeline-entry";
      readonly index: number;
      readonly entry: CodexCanonicalTimelineEntry;
    }
  | {
      readonly type: "realtime-item";
      readonly itemId: string;
      readonly value: CodexTranscriptRealtimeItem | null;
    }
  | { readonly type: "realtime-text"; readonly itemId: string; readonly delta: string };
export type CodexTranscriptUpdate =
  | { readonly type: "reset"; readonly value: CodexTranscriptSnapshot | null }
  | { readonly type: "changes"; readonly changes: readonly CodexTranscriptChange[] };
export type CodexTranscriptEvent =
  | CodexTranscriptUpdate
  | { readonly type: "reset-start"; readonly value: CodexTranscriptMetadata }
  | {
      readonly type: "reset-part";
      readonly turnsByKey: CodexTranscriptSnapshot["turnsByKey"];
      readonly itemsByKey: CodexTranscriptSnapshot["itemsByKey"];
      readonly realtimeItems: CodexTranscriptSnapshot["realtimeItems"];
    }
  | { readonly type: "reset-commit" };
export type CodexTranscriptConversationState = CodexCanonicalConversationState & {
  readonly itemTimeline?: CodexTranscriptItemTimeline | null;
  readonly realtimeItems?: Readonly<Record<string, CodexTranscriptRealtimeItem>>;
};
export interface CodexTranscriptProjectionEvidence {
  readonly patches?: readonly Patch[];
  readonly changedItems?: readonly { readonly entityKey: string; readonly itemId: string }[];
  readonly acceptedTranscriptText?: {
    readonly changes: readonly CodexTranscriptTextChange[];
    readonly turnEntityKeys: ReadonlySet<string>;
  };
}

export interface CodexTranscriptAcceptedMutationContext {
  /** Called only after a successful canonical draft write, never from native input admission. */
  readonly onAcceptedText?: (change: CodexTranscriptTextChange) => void;
}

/** Reducers already know the actual Turn address; no item scan or text comparison is needed. */
export function codexTranscriptMutationItemKey(
  state: CodexCanonicalConversationState,
  address: import("./codex-conversation-state/codex-turn-mutation").CodexConversationTurnAddress,
  itemId: string,
): CodexTranscriptItemKey {
  const turn = address.kind === "turns" ? state.turns[address.index] : undefined;
  const entityKey =
    address.kind === "canonical"
      ? address.entityKey
      : (turn?.entityKey ??
        (turn?.turnId == null ? `legacy:${address.index}` : `turn:${turn.turnId}`));
  return { hostId: state.hostId, threadId: state.id, entityKey, itemId };
}

/**
 * Consumes only post-write reducer evidence. Patch coverage and lengths fence the receipt while
 * avoiding reconstruction/comparison of previously accepted text. Unrelated item writes fall back.
 */
export function buildCodexTranscriptAcceptedMutation(
  before: CodexTranscriptConversationState,
  after: CodexTranscriptConversationState,
  patches: readonly Patch[],
  changes: readonly CodexTranscriptTextChange[],
): CodexTranscriptProjectionEvidence["acceptedTranscriptText"] {
  if (changes.length === 0) return undefined;
  const items = new Map<
    string,
    { previous: CodexCanonicalItem; next: CodexCanonicalItem; fields: Set<string> }
  >();
  for (const patch of patches) {
    const address = turnPatchAddress(patch, before, after);
    if (address === "structure") return undefined;
    if (!address || patch.path[address.offset] !== "items") continue;
    const index = patch.path[address.offset + 1];
    const field = patch.path[address.offset + 2];
    const part = patch.path[address.offset + 3];
    if (
      typeof index !== "number" ||
      (field !== "text" &&
        field !== "aggregatedOutput" &&
        field !== "summary" &&
        field !== "content") ||
      patch.op === "remove"
    )
      return undefined;
    if ((field === "summary" || field === "content") && typeof part !== "number") return undefined;
    const previous = codexTranscriptCanonicalTurn(before, address.entityKey)?.items[index];
    const next = codexTranscriptCanonicalTurn(after, address.entityKey)?.items[index];
    if (!previous || !next || previous.id !== next.id || previous.type !== next.type)
      return undefined;
    const key = codexTranscriptItemAddress(address.entityKey, next.id);
    const item = items.get(key) ?? { previous, next, fields: new Set<string>() };
    item.fields.add(JSON.stringify([field, part ?? null]));
    items.set(key, item);
  }
  const lengths = new Map<string, number>();
  const partCounts = new Map<string, number>();
  const covered = new Map<string, Set<string>>();
  const turnEntityKeys = new Set<string>();
  for (const change of changes) {
    if (change.key.hostId !== after.hostId || change.key.threadId !== after.id) return undefined;
    const key = codexTranscriptItemAddress(change.key.entityKey, change.key.itemId);
    const item = items.get(key);
    if (!item) return undefined;
    const fields = covered.get(key) ?? new Set<string>();
    covered.set(key, fields);
    turnEntityKeys.add(change.key.entityKey);
    if (change.type === "text-parts") {
      if (item.previous.type !== "reasoning" || item.next.type !== "reasoning") return undefined;
      const countKey = JSON.stringify([key, change.field]);
      const count = partCounts.get(countKey) ?? item.previous[change.field].length;
      if (change.at !== count) return undefined;
      partCounts.set(countKey, count + change.values.length);
      for (let offset = 0; offset < change.values.length; offset += 1) {
        const part = change.at + offset;
        lengths.set(JSON.stringify([key, change.field, part]), change.values[offset]!.length);
        fields.add(JSON.stringify([change.field, part]));
      }
      continue;
    }
    const { field } = change.target;
    const index = "index" in change.target ? change.target.index : null;
    let previousLength: number;
    if (
      field === "text" &&
      (item.previous.type === "agentMessage" || item.previous.type === "plan")
    )
      previousLength = item.previous.text.length;
    else if (field === "aggregatedOutput" && item.previous.type === "commandExecution")
      previousLength = item.previous.aggregatedOutput?.length ?? 0;
    else if (
      (field === "summary" || field === "content") &&
      item.previous.type === "reasoning" &&
      index !== null
    ) {
      const count = partCounts.get(JSON.stringify([key, field])) ?? item.previous[field].length;
      if (!Number.isSafeInteger(index) || index < 0 || index >= count) return undefined;
      previousLength = item.previous[field][index]?.length ?? 0;
    } else return undefined;
    const lengthKey = JSON.stringify([key, field, index]);
    let length = lengths.get(lengthKey) ?? previousLength;
    for (const edit of change.edits) {
      if (
        !Number.isSafeInteger(edit.at) ||
        !Number.isSafeInteger(edit.deleteCount) ||
        edit.at < 0 ||
        edit.deleteCount < 0 ||
        edit.at + edit.deleteCount > length
      )
        return undefined;
      length += edit.insert.length - edit.deleteCount;
    }
    lengths.set(lengthKey, length);
    fields.add(JSON.stringify([field, index]));
  }
  for (const [key, item] of items) {
    const fields = covered.get(key);
    if (!fields || [...item.fields].some((field) => !fields.has(field))) return undefined;
    for (const fieldKey of fields) {
      const [field, index] = JSON.parse(fieldKey) as [
        "text" | "aggregatedOutput" | "summary" | "content",
        number | null,
      ];
      const nextLength =
        field === "text" && (item.next.type === "agentMessage" || item.next.type === "plan")
          ? item.next.text.length
          : field === "aggregatedOutput" && item.next.type === "commandExecution"
            ? (item.next.aggregatedOutput?.length ?? 0)
            : (field === "summary" || field === "content") &&
                item.next.type === "reasoning" &&
                index !== null
              ? item.next[field][index]?.length
              : undefined;
      if (
        nextLength === undefined ||
        nextLength !== lengths.get(JSON.stringify([key, field, index]))
      )
        return undefined;
    }
    for (const field of ["summary", "content"] as const) {
      const count = partCounts.get(JSON.stringify([key, field]));
      if (
        count !== undefined &&
        (item.next.type !== "reasoning" || item.next[field].length !== count)
      )
        return undefined;
    }
  }
  return { changes, turnEntityKeys };
}

export interface CodexTranscriptProjectionAccess {
  readonly hasSubagentActivity?: (
    state: CodexCanonicalConversationState,
    entityKey: string,
  ) => boolean;
}

const activityCounts = new WeakMap<readonly (CodexCanonicalItem | null | undefined)[], number>();
function isSubagentActivity(item: CodexCanonicalItem | null | undefined): boolean {
  return item?.type === "collabAgentToolCall" || item?.type === "subAgentActivity";
}
function countSubagentActivity(items: readonly (CodexCanonicalItem | null | undefined)[]): number {
  const cached = activityCounts.get(items);
  if (cached !== undefined) return cached;
  const count = items.reduce((value, item) => value + Number(isSubagentActivity(item)), 0);
  activityCounts.set(items, count);
  return count;
}
function readSubagentActivity(
  state: CodexCanonicalConversationState,
  entityKey: string,
  access: CodexTranscriptProjectionAccess,
): boolean {
  if (access.hasSubagentActivity) return access.hasSubagentActivity(state, entityKey);
  const turn = codexTranscriptCanonicalTurn(state, entityKey);
  return turn !== undefined && countSubagentActivity(turn.items) > 0;
}

/** Item IDs are only unique within a Turn, not within a conversation. */
export function codexTranscriptItemAddress(entityKey: string, itemId: string): string {
  return JSON.stringify([entityKey, itemId]);
}

const legacyIdentities = new WeakMap<readonly CodexCanonicalTurnState[], readonly string[]>();
const historyOrders = new WeakMap<
  object,
  {
    readonly generation: number;
    readonly timeline: readonly CodexHistoryRow[];
    readonly keys: readonly string[];
  }
>();

export function codexTranscriptLegacyTurnEntityKeys(
  state: CodexCanonicalConversationState,
): readonly string[] {
  const cached = legacyIdentities.get(state.turns);
  if (cached) return cached;
  const keys = state.turns.map(
    (turn, index) =>
      turn.entityKey ?? (turn.turnId === null ? `legacy:${index}` : `turn:${turn.turnId}`),
  );
  const seen = new Set<string>();
  for (let index = keys.length - 1; index >= 0; index -= 1) {
    const key = keys[index]!;
    if (seen.has(key)) keys[index] = `legacy:${index}`;
    seen.add(key);
  }
  legacyIdentities.set(state.turns, keys);
  return keys;
}

function historyOrder(state: CodexCanonicalConversationState) {
  const history = state.turnHistory?.history;
  if (!history) return null;
  const cached = historyOrders.get(history.islands);
  if (cached?.generation === history.generation) return cached;
  const timeline = flattenCodexHistoryTopology(history);
  const result = {
    generation: history.generation,
    timeline,
    keys: timeline.flatMap((row) => (row.kind === "content" ? [row.entityKey] : [])),
  };
  historyOrders.set(history.islands, result);
  return result;
}

export function codexTranscriptTurnEntityKeys(
  state: CodexCanonicalConversationState,
): readonly string[] {
  const order = historyOrder(state);
  const legacy = codexTranscriptLegacyTurnEntityKeys(state);
  if (!order) return legacy;
  if (legacy.length === 0) return order.keys;
  const seen = new Set(order.keys);
  return [...order.keys, ...legacy.filter((key) => !seen.has(key))];
}

export function codexTranscriptCanonicalTurn(
  state: CodexCanonicalConversationState,
  entityKey: string,
): CodexCanonicalTurnState | undefined {
  const canonical = state.turnHistory?.history.entitiesByKey[entityKey];
  if (canonical) return canonical;
  const index = codexTranscriptLegacyTurnEntityKeys(state).indexOf(entityKey);
  return index < 0 ? undefined : state.turns[index];
}

export function codexTranscriptItemSlots(
  items: readonly (CodexCanonicalItem | null | undefined)[],
): CodexTranscriptItemSlots {
  const entries: { index: number; itemId: string }[] = [];
  items.forEach((item, index) => {
    if (item) entries.push({ index, itemId: item.id });
  });
  return { length: items.length, entries };
}

function turnDetails(turn: CodexCanonicalTurnState): CodexTranscriptTurnDetails {
  // Completion evidence belongs to retention; it must never invalidate presentation details.
  const {
    items: _items,
    completedItemIds: _completed,
    ...details
  } = turn as CodexCanonicalTurnState & {
    readonly completedItemIds?: Readonly<Record<string, boolean>>;
  };
  return details;
}

function historyMetadata(
  state: CodexCanonicalConversationState,
): Pick<CodexTranscriptMetadata, "resumeState" | "historyComplete"> {
  const itemsComplete = codexTranscriptTurnEntityKeys(state).every(
    (key) => codexTranscriptCanonicalTurn(state, key)?.itemsPagination?.hasLoadedOldest !== false,
  );
  const history = state.turnHistory?.history;
  const turnsComplete = history
    ? history.isComplete && history.islands.length === 1
    : state.resumeState === "resumed" && state.turnsPagination?.hasLoadedOldest !== false;
  return { resumeState: state.resumeState, historyComplete: itemsComplete && turnsComplete };
}

/** A read projection of one canonical document. It never installs state back into that document. */
export function projectCodexTranscript(
  state: CodexTranscriptConversationState,
  access: CodexTranscriptProjectionAccess = {},
): CodexTranscriptSnapshot {
  const turnEntityKeys = codexTranscriptTurnEntityKeys(state);
  const turnsByKey: Record<string, CodexTranscriptTurn> = {};
  const itemsByKey: Record<string, CodexCanonicalItem> = {};
  for (const entityKey of turnEntityKeys) {
    const turn = codexTranscriptCanonicalTurn(state, entityKey);
    if (!turn) continue;
    turnsByKey[entityKey] = {
      details: turnDetails(turn),
      hasSubagentActivity: readSubagentActivity(state, entityKey, access),
      itemSlots: codexTranscriptItemSlots(turn.items),
    };
    for (const item of turn.items)
      if (item) itemsByKey[codexTranscriptItemAddress(entityKey, item.id)] = item;
  }
  return {
    ...historyMetadata(state),
    itemTimeline: state.itemTimeline ?? null,
    realtimeItems: state.realtimeItems ?? {},
    timeline: historyOrder(state)?.timeline ?? null,
    turnEntityKeys,
    turnsByKey,
    itemsByKey,
  };
}

/** Mutation evidence limits projection work to affected entities and accepted text edits. */
export function projectCodexTranscriptUpdate(
  key: CodexTranscriptKey,
  before: CodexTranscriptConversationState | null,
  after: CodexTranscriptConversationState | null,
  evidence: CodexTranscriptProjectionEvidence = {},
  access: CodexTranscriptProjectionAccess = {},
): CodexTranscriptUpdate | null {
  if (!after) return before ? { type: "reset", value: null } : null;
  if (
    before &&
    before.turns === after.turns &&
    before.turnHistory === after.turnHistory &&
    before.turnsPagination === after.turnsPagination &&
    before.resumeState === after.resumeState &&
    before.itemTimeline === after.itemTimeline &&
    before.realtimeItems === after.realtimeItems
  )
    return null;
  const { patches, changedItems, acceptedTranscriptText } = evidence;
  if (
    !before ||
    (patches === undefined && changedItems === undefined && acceptedTranscriptText === undefined)
  )
    return { type: "reset", value: projectCodexTranscript(after, access) };
  const changes: CodexTranscriptChange[] = [];
  projectTimelineChanges(before, after, patches, changes);
  projectRealtimeChanges(before, after, patches, changes);
  changes.push(...(acceptedTranscriptText?.changes ?? []));
  const touched = new Map<string, Set<number> | "all">();
  let structureChanged = false;
  for (const entityKey of acceptedTranscriptText?.turnEntityKeys ?? [])
    touched.set(entityKey, new Set());
  for (const item of changedItems ?? []) {
    if (acceptedTranscriptText) continue;
    const current = touched.get(item.entityKey);
    if (current === "all") continue;
    const indices = current ?? new Set<number>();
    const index =
      codexTranscriptCanonicalTurn(after, item.entityKey)?.items.findIndex(
        (candidate) => candidate?.id === item.itemId,
      ) ?? -1;
    if (index >= 0) indices.add(index);
    touched.set(item.entityKey, indices);
  }
  for (const patch of patches ?? []) {
    const address = turnPatchAddress(patch, before, after);
    if (address === "structure") {
      structureChanged = true;
      continue;
    }
    if (!address) continue;
    const field = patch.path[address.offset];
    if (field === "completedItemIds") continue;
    if (!touched.has(address.entityKey)) touched.set(address.entityKey, new Set());
    if (field !== "items" || acceptedTranscriptText) continue;
    const index = patch.path[address.offset + 1];
    if (typeof index !== "number" || patch.op === "remove") {
      touched.set(address.entityKey, "all");
      continue;
    }
    const indices = touched.get(address.entityKey);
    if (indices !== "all") indices?.add(index);
  }
  for (const entityKey of touched.keys())
    if (
      !codexTranscriptCanonicalTurn(before, entityKey) ||
      !codexTranscriptCanonicalTurn(after, entityKey)
    )
      structureChanged = true;
  if (structureChanged) {
    const previousKeys = codexTranscriptTurnEntityKeys(before);
    const nextKeys = codexTranscriptTurnEntityKeys(after);
    const remaining = new Set(nextKeys);
    for (const entityKey of previousKeys)
      if (!remaining.has(entityKey))
        changes.push({ type: "remove-turn", key: { ...key, entityKey } });
    for (const entityKey of nextKeys)
      if (
        codexTranscriptCanonicalTurn(before, entityKey) !==
        codexTranscriptCanonicalTurn(after, entityKey)
      )
        touched.set(entityKey, "all");
    changes.push({
      type: "structure",
      timeline: historyOrder(after)?.timeline ?? null,
      turnEntityKeys: nextKeys,
    });
  }
  if (
    structureChanged ||
    patches?.some(
      ({ path }) =>
        path[0] === "turnsPagination" ||
        path[0] === "resumeState" ||
        path.includes("itemsPagination"),
    )
  )
    changes.push({ type: "history", ...historyMetadata(after) });
  for (const [entityKey, indices] of touched)
    projectTurnChanges(key, before, after, entityKey, indices, access, changes);
  const filtered = changes.filter(
    (change) =>
      (change.type !== "text" && change.type !== "text-parts") ||
      touched.get(change.key.entityKey) !== "all",
  );
  return filtered.length === 0 ? null : { type: "changes", changes: filtered };
}

function turnPatchAddress(
  patch: Patch,
  before: CodexCanonicalConversationState,
  after: CodexCanonicalConversationState,
): { readonly entityKey: string; readonly offset: number } | "structure" | null {
  const path = patch.path;
  if (path[0] === "turns") {
    const index = path[1];
    if (
      typeof index !== "number" ||
      path.length < 3 ||
      path[2] === "turnId" ||
      path[2] === "entityKey"
    )
      return "structure";
    const entityKey =
      codexTranscriptLegacyTurnEntityKeys(after)[index] ??
      codexTranscriptLegacyTurnEntityKeys(before)[index];
    if (entityKey === undefined) return "structure";
    if (after.turnHistory?.history.entitiesByKey[entityKey]) return null;
    return { entityKey, offset: 2 };
  }
  if (path[0] !== "turnHistory") return null;
  if (
    path[1] !== "history" ||
    path[2] !== "entitiesByKey" ||
    typeof path[3] !== "string" ||
    path.length < 5
  )
    return "structure";
  return { entityKey: path[3], offset: 4 };
}

function projectTurnChanges(
  key: CodexTranscriptKey,
  before: CodexCanonicalConversationState,
  after: CodexCanonicalConversationState,
  entityKey: string,
  indices: Set<number> | "all",
  access: CodexTranscriptProjectionAccess,
  changes: CodexTranscriptChange[],
): void {
  const next = codexTranscriptCanonicalTurn(after, entityKey);
  if (!next) return;
  const previous = codexTranscriptCanonicalTurn(before, entityKey);
  const previousItems = previous?.items ?? [];
  const details = turnDetails(next);
  if (!access.hasSubagentActivity && previous && indices !== "all") {
    let count = countSubagentActivity(previousItems);
    for (const index of indices)
      count +=
        Number(isSubagentActivity(next.items[index])) -
        Number(isSubagentActivity(previousItems[index]));
    activityCounts.set(next.items, count);
  }
  const hasSubagentActivity = readSubagentActivity(after, entityKey, access);
  const turnKey = { ...key, entityKey };
  if (
    !previous ||
    !areStructurallyEqual(details, turnDetails(previous)) ||
    hasSubagentActivity !== readSubagentActivity(before, entityKey, access)
  )
    changes.push({ type: "turn", key: turnKey, details, hasSubagentActivity });
  const slotsChanged =
    !previous ||
    next.items.length !== previousItems.length ||
    (indices === "all"
      ? !areStructurallyEqual(
          codexTranscriptItemSlots(next.items),
          codexTranscriptItemSlots(previousItems),
        )
      : [...indices].some((index) => next.items[index]?.id !== previousItems[index]?.id));
  if (slotsChanged) {
    if (
      previous &&
      indices !== "all" &&
      next.items.length > previousItems.length &&
      [...indices].every((index) => index >= previousItems.length)
    ) {
      changes.push({
        type: "item-slots-append",
        key: turnKey,
        previousLength: previousItems.length,
        length: next.items.length,
        entries: codexTranscriptItemSlots(next.items.slice(previousItems.length)).entries.map(
          ({ index, itemId }) => ({ index: index + previousItems.length, itemId }),
        ),
      });
    } else {
      const slots = codexTranscriptItemSlots(next.items);
      changes.push({ type: "item-slots", key: turnKey, slots });
      const remaining = new Set(slots.entries.map(({ itemId }) => itemId));
      for (const item of previousItems)
        if (item && !remaining.has(item.id))
          changes.push({ type: "item", key: { ...turnKey, itemId: item.id }, value: null });
    }
  }
  const changedIndices = indices === "all" ? next.items.keys() : indices;
  for (const index of changedIndices) {
    const item = next.items[index];
    if (item && item !== previousItems[index])
      changes.push({ type: "item", key: { ...turnKey, itemId: item.id }, value: item });
  }
}

function projectTimelineChanges(
  before: CodexTranscriptConversationState,
  after: CodexTranscriptConversationState,
  patches: readonly Patch[] | undefined,
  changes: CodexTranscriptChange[],
): void {
  if (before.itemTimeline === after.itemTimeline) return;
  const previous = before.itemTimeline;
  const next = after.itemTimeline;
  const timelinePatches = patches?.filter(({ path }) => path[0] === "itemTimeline");
  if (
    previous &&
    next &&
    timelinePatches?.length &&
    timelinePatches.every(
      ({ op, path }) => op !== "remove" && path[1] === "entries" && typeof path[2] === "number",
    )
  ) {
    const indices = new Set(timelinePatches.map(({ path }) => path[2] as number));
    for (const index of indices) {
      const entry = next.entries[index];
      if (entry) changes.push({ type: "item-timeline-entry", index, entry });
    }
    return;
  }
  if (
    previous &&
    next &&
    next.entries.length > previous.entries.length &&
    previous.entries.every(
      (entry, index) =>
        entry === next.entries[index + next.entries.length - previous.entries.length],
    )
  ) {
    changes.push({
      type: "item-timeline-prepend",
      entries: next.entries.slice(0, next.entries.length - previous.entries.length),
      activeRealtimeSessionAtPageStart: next.activeRealtimeSessionAtPageStart,
    });
    return;
  }
  changes.push({ type: "item-timeline", value: next ?? null });
}

function projectRealtimeChanges(
  before: CodexTranscriptConversationState,
  after: CodexTranscriptConversationState,
  patches: readonly Patch[] | undefined,
  changes: CodexTranscriptChange[],
): void {
  const changed = new Set<string>();
  for (const { path } of patches ?? []) {
    if (path[0] !== "realtimeItems") continue;
    if (typeof path[1] === "string") changed.add(path[1]);
    else {
      for (const id of Object.keys(before.realtimeItems ?? {})) changed.add(id);
      for (const id of Object.keys(after.realtimeItems ?? {})) changed.add(id);
    }
  }
  for (const itemId of changed) {
    const previous = before.realtimeItems?.[itemId];
    const next = after.realtimeItems?.[itemId];
    if (previous === next) continue;
    if (
      previous?.item.type === "transcriptSegment" &&
      next?.item.type === "transcriptSegment" &&
      previous.completed === next.completed &&
      next.item.text.startsWith(previous.item.text)
    )
      changes.push({
        type: "realtime-text",
        itemId,
        delta: next.item.text.slice(previous.item.text.length),
      });
    else changes.push({ type: "realtime-item", itemId, value: next ?? null });
  }
}

/** Text edits address the result of preceding edits, not the original string. */
export function applyCodexTranscriptTextEdits(
  text: string,
  edits: readonly CodexTranscriptTextEdit[],
): string {
  let current = text;
  for (const { at, deleteCount, insert } of edits) {
    if (
      !Number.isSafeInteger(at) ||
      !Number.isSafeInteger(deleteCount) ||
      at < 0 ||
      deleteCount < 0 ||
      at + deleteCount > current.length
    )
      throw new Error("Transcript text update is out of order");
    current = current.slice(0, at) + insert + current.slice(at + deleteCount);
  }
  return current;
}

export function applyCodexTranscriptTextChange(
  item: CodexCanonicalItem,
  change: CodexTranscriptTextChange,
): CodexCanonicalItem {
  if (change.type === "text-parts") {
    if (item.type !== "reasoning")
      throw new Error("Transcript parts update targets a non-reasoning item");
    const parts = item[change.field];
    if (change.at !== parts.length) throw new Error("Transcript parts update is out of order");
    return { ...item, [change.field]: [...parts, ...change.values] };
  }
  const target = change.target;
  if (target.field === "text") {
    if (item.type !== "agentMessage" && item.type !== "plan")
      throw new Error("Transcript text update targets an incompatible item");
    return { ...item, text: applyCodexTranscriptTextEdits(item.text, change.edits) };
  }
  if (target.field === "aggregatedOutput") {
    if (item.type !== "commandExecution")
      throw new Error("Transcript output update targets a non-command item");
    return {
      ...item,
      aggregatedOutput: applyCodexTranscriptTextEdits(item.aggregatedOutput ?? "", change.edits),
    };
  }
  if (item.type !== "reasoning")
    throw new Error("Transcript reasoning update targets an incompatible item");
  const parts = [...item[target.field]];
  const current = parts[target.index];
  if (current === undefined) throw new Error("Transcript reasoning update has no part");
  parts[target.index] = applyCodexTranscriptTextEdits(current, change.edits);
  return { ...item, [target.field]: parts };
}
