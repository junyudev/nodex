import type { ClientRequestResponsesByMethod } from "@nodex/effect-codex-app-server/rpc";
import type { Draft } from "immer";
import {
  CodexHistoryViewportRegistry,
  type CodexHistoryViewportBoundary,
} from "../codex-history-policy";
import type { CanonicalHistoryClient } from "./codex-canonical-history-loader";
import { availableCodexHistoryBoundary, type CodexHistoryIsland } from "./codex-history-topology";
import type {
  CodexCanonicalConversationState,
  CodexCanonicalTurnState,
} from "./codex-conversation-state";

/** A conversation may grow to the trigger before retention returns it to the target. */
export const CODEX_ACTIVE_HISTORY_EVICTION_TRIGGER_ITEMS = 1_000;
export const CODEX_ACTIVE_HISTORY_EVICTION_TARGET_ITEMS = 500;
/** Presentation-owned items that a later history read cannot recreate. */
export const CODEX_ACTIVE_HISTORY_PROTECTED_ITEM_TYPES: ReadonlySet<string> = new Set([
  "todo-list",
  "plan",
  "planImplementation",
  "error",
  "automaticApprovalReview",
  "strictReviewNotice",
  "remoteTaskCreated",
  "personalityChanged",
  "forkedFromConversation",
  "worktreeInit",
  "modelChanged",
  "modelRerouted",
  "mcpServerElicitation",
  "userInputResponse",
  "permissionRequest",
  "steered",
  "steeringUserMessage",
]);

/** The facts retention reads from a Turn, whichever owner holds its bodies. */
export interface CodexHistoryWindowTurn {
  readonly turnId: string | null;
  readonly status: string;
  readonly items: readonly { readonly id: string }[];
}

export interface CodexHistoryWindowEntry<TTurn extends CodexHistoryWindowTurn> {
  readonly entityKey: string;
  readonly turn: TTurn;
  /** State that a history read cannot restore keeps the Turn resident, though its items may go. */
  readonly pinned?: boolean;
  /** Item pagination is in flight or awaiting reconciliation, so nothing past it is settled. */
  readonly settling?: boolean;
}

export interface CodexHistoryWindowInput<TTurn extends CodexHistoryWindowTurn> {
  readonly entries: readonly CodexHistoryWindowEntry<TTurn>[];
  /** Resident weight of the entries, counting an empty Turn as one. */
  readonly size: number;
  readonly boundaries: readonly (CodexHistoryViewportBoundary | null)[];
  readonly isTurnResidentElsewhere: (turnId: string) => boolean;
  readonly isItemReleasable: (turn: TTurn, index: number) => boolean;
}

export interface CodexHistoryWindowItemCut {
  readonly entityKey: string;
  /** Items below this index are released, except the retained ones. */
  readonly end: number;
  readonly retained: ReadonlySet<number>;
}

export interface CodexHistoryWindowPlan {
  readonly itemCuts: readonly CodexHistoryWindowItemCut[];
  /** Whole Turns released from `from` up to, excluding, `to`. */
  readonly turns?: { readonly from: number; readonly to: number };
}

type ReleaseMode = "prefix" | "gaps";

/**
 * Selects what returns one contiguous run of Turns to the target. Oldest history goes first, a
 * viewer's boundary is never crossed and live Turns are only ever cut, never removed. An item
 * that cannot be released stops its Turn's prefix; only when that leaves nothing to release does
 * a second pass keep such items in place and release around them.
 */
export function planCodexHistoryWindow<TTurn extends CodexHistoryWindowTurn>(
  input: CodexHistoryWindowInput<TTurn>,
  mode: ReleaseMode = "prefix",
): CodexHistoryWindowPlan | null {
  const { entries, boundaries } = input;
  const target = CODEX_ACTIVE_HISTORY_EVICTION_TARGET_ITEMS;
  let protectedEntry = entries.length;
  let protectedItem = 0;
  for (const boundary of boundaries) {
    if (boundary === null) return null;
    const entry = entries.findIndex(({ turn }) => turn.turnId === boundary.oldestProtectedTurnId);
    if (entry < 0) {
      if (input.isTurnResidentElsewhere(boundary.oldestProtectedTurnId)) continue;
      return null;
    }
    const item =
      boundary.firstProtectedItemId === null
        ? 0
        : entries[entry]!.turn.items.findIndex(({ id }) => id === boundary.firstProtectedItemId);
    if (item < 0) return null;
    if (entry < protectedEntry || (entry === protectedEntry && item < protectedItem)) {
      protectedEntry = entry;
      protectedItem = item;
    }
  }
  let lastTurn = entries.length - 1;
  while (lastTurn >= 0 && entries[lastTurn]!.turn.turnId === null) lastTurn -= 1;
  if (lastTurn < 0) return null;

  const itemCuts: CodexHistoryWindowItemCut[] = [];
  let remaining = input.size;
  let turnsFrom = 0;
  let turnsTo = 0;
  let afterPlaceholder = false;
  let prefixBlocked = false;
  for (
    let index = 0;
    index <= protectedEntry && index < entries.length && remaining > target;
    index += 1
  ) {
    const { entityKey, turn, pinned, settling } = entries[index]!;
    if (turn.turnId === null) {
      if (turnsTo > turnsFrom || turn.status !== "completed" || turn.items.length !== 0) break;
      turnsTo = turnsFrom = index + 1;
      afterPlaceholder = true;
      continue;
    }
    if (settling) break;
    const reach = Math.min(
      index === protectedEntry ? protectedItem : turn.items.length,
      remaining - target,
    );
    const retained = new Set<number>();
    let end = 0;
    let released = 0;
    for (let item = 0; item < reach; item += 1) {
      if (
        !input.isItemReleasable(turn, item) ||
        (item + 1 < turn.items.length && !input.isItemReleasable(turn, item + 1))
      ) {
        if (mode === "prefix") {
          if (item + 1 < reach) prefixBlocked = true;
          break;
        }
        retained.add(item);
        continue;
      }
      end = item + 1;
      released += 1;
    }
    if (
      released === turn.items.length &&
      index < lastTurn &&
      index < protectedEntry &&
      !afterPlaceholder &&
      !pinned &&
      turn.status !== "inProgress"
    ) {
      turnsTo = index + 1;
      remaining -= Math.max(1, released);
      continue;
    }
    // A partial Turn keeps a resident item for its older items to be read before.
    if (end > 0 && end === turn.items.length) {
      end -= 1;
      released -= 1;
    }
    if (released > 0) {
      itemCuts.push({ entityKey, end, retained });
      remaining -= released;
    }
    if (
      remaining <= target ||
      index === protectedEntry ||
      index === lastTurn ||
      turnsTo > turnsFrom ||
      turn.status === "inProgress"
    )
      break;
    turnsTo = turnsFrom = index + 1;
    afterPlaceholder = false;
  }
  if (turnsTo === turnsFrom && itemCuts.length === 0)
    return prefixBlocked ? planCodexHistoryWindow(input, "gaps") : null;
  return turnsTo > turnsFrom ? { itemCuts, turns: { from: turnsFrom, to: turnsTo } } : { itemCuts };
}

export function isCodexActiveHistoryItemEvictable(
  turn: CodexCanonicalTurnState,
  index: number,
): boolean {
  const item = turn.items[index];
  if (
    !item ||
    CODEX_ACTIVE_HISTORY_PROTECTED_ITEM_TYPES.has(item.type) ||
    item.type === "autoReviewInterruptionWarning"
  )
    return false;
  if (
    ("status" in item && item.status === "inProgress") ||
    ("completed" in item && item.completed === false)
  )
    return false;
  return turn.status !== "inProgress" || turn.completedItemIds?.[item.id] === true;
}

export interface CodexActiveHistoryCapabilities {
  readonly supportsThreadItemAnchors: boolean;
  readonly supportsPaginatedThreadHistory: boolean;
  readonly isFollower: boolean;
  readonly hasFollowersOrPendingReconnect: boolean;
}

interface CodexActiveHistorySnapshot {
  readonly history: NonNullable<CodexCanonicalConversationState["turnHistory"]>["history"];
  readonly island: CodexHistoryIsland;
  readonly size: number;
}

export interface CodexActiveHistoryEvictionPlan extends Pick<CodexHistoryWindowPlan, "itemCuts"> {
  readonly generation: number;
  readonly islandId: string;
  readonly turns?: {
    readonly from: number;
    readonly to: number;
    readonly oldestRetainedTurnId: string;
    readonly retainedTurnCount: number;
  };
}

/** The live tail is the only island that grows; older islands are left to their readers. */
function readCodexActiveHistorySnapshot(
  state: CodexCanonicalConversationState | null | undefined,
  capabilities: CodexActiveHistoryCapabilities,
): CodexActiveHistorySnapshot | null {
  if (
    !state?.rolloutPath ||
    state.ephemeral ||
    state.resumeState !== "resumed" ||
    state.historyMode !== "paginated" ||
    !state.turnHistory ||
    state.turns.length !== 0 ||
    state.itemTimeline != null ||
    state.turnsPagination?.source === "timeline" ||
    state.requests.some((request) => !("completed" in request && request.completed)) ||
    !capabilities.supportsPaginatedThreadHistory ||
    !capabilities.supportsThreadItemAnchors ||
    capabilities.isFollower ||
    capabilities.hasFollowersOrPendingReconnect
  )
    return null;
  const history = state.turnHistory.history;
  const island = history.islands.at(-1);
  if (island?.newerBoundary.status !== "exhausted") return null;
  let size = 0;
  for (const { value } of island.entries) {
    const turn = history.entitiesByKey[value];
    if (!turn) return null;
    size += Math.max(1, turn.items.length);
  }
  return size > CODEX_ACTIVE_HISTORY_EVICTION_TRIGGER_ITEMS ? { history, island, size } : null;
}

function planFromSnapshot(
  snapshot: CodexActiveHistorySnapshot,
  boundaries: readonly (CodexHistoryViewportBoundary | null)[],
): CodexActiveHistoryEvictionPlan | null {
  const { history, island, size } = snapshot;
  const entries = island.entries.map(({ value }) => {
    const turn = history.entitiesByKey[value]!;
    return {
      entityKey: value,
      turn,
      // A Turn's hook runs arrive live; item history does not carry them back.
      pinned: (turn.hookRuns?.length ?? 0) > 0,
      settling:
        turn.itemsPagination?.isLoadingOlder === true ||
        turn.itemsPagination?.summaryItemIds != null ||
        turn.itemsPagination?.reconnect != null,
    };
  });
  const plan = planCodexHistoryWindow({
    entries,
    size,
    boundaries,
    isTurnResidentElsewhere: (turnId) =>
      history.islands.some(
        (other) =>
          other !== island &&
          other.entries.some(({ value }) => history.entitiesByKey[value]?.turnId === turnId),
      ),
    isItemReleasable: isCodexActiveHistoryItemEvictable,
  });
  if (!plan) return null;
  const base = {
    generation: history.generation,
    islandId: island.id,
    itemCuts: plan.itemCuts,
  };
  if (!plan.turns) return base;
  const retained = island.entries.slice(plan.turns.to).flatMap(({ value }) => {
    const turnId = history.entitiesByKey[value]!.turnId;
    return turnId === null ? [] : [turnId];
  });
  if (retained.length === 0) return null;
  return {
    ...base,
    turns: {
      ...plan.turns,
      oldestRetainedTurnId: retained[0]!,
      retainedTurnCount: retained.length,
    },
  };
}

/** Selects the release a conversation needs now, or null when it is bounded or must not change. */
export function planCodexActiveHistoryEviction(
  state: CodexCanonicalConversationState | null | undefined,
  boundaries: readonly (CodexHistoryViewportBoundary | null)[],
  capabilities: CodexActiveHistoryCapabilities,
): CodexActiveHistoryEvictionPlan | null {
  const snapshot = readCodexActiveHistorySnapshot(state, capabilities);
  return snapshot && planFromSnapshot(snapshot, boundaries);
}

const ITEM_KEYED_TURN_FIELDS = [
  "completedItemIds",
  "assistantMessageStartedAtMsById",
  "commandExecutionStartedAtMsById",
  "lifecycleStatusByItemId",
] as const;

function releaseTurnItems(
  turn: Draft<CodexCanonicalTurnState>,
  { end, retained }: CodexHistoryWindowItemCut,
): void {
  const loadsBefore = turn.itemsPagination?.olderPageBeforeItemId;
  const anchorIndex = Math.max(
    end,
    loadsBefore == null ? -1 : turn.items.findIndex(({ id }) => id === loadsBefore),
  );
  const anchorId = turn.items[anchorIndex]!.id;
  let newestSnapshotItemId = turn.itemsPagination?.newestSnapshotItemId;
  const released = new Set<string>();
  turn.items = turn.items.filter((item, index) => {
    if (index < anchorIndex && item.id === newestSnapshotItemId) newestSnapshotItemId = undefined;
    if (index >= end || retained.has(index)) return true;
    released.add(item.id);
    return false;
  });
  for (const field of ITEM_KEYED_TURN_FIELDS) {
    const values = turn[field];
    if (!values) continue;
    for (const id of released) delete values[id];
    if (Object.keys(values).length === 0) delete turn[field];
  }
  if (turn.interruptedCommandExecutionItemIds) {
    turn.interruptedCommandExecutionItemIds = turn.interruptedCommandExecutionItemIds.filter(
      (id) => !released.has(id),
    );
    if (turn.interruptedCommandExecutionItemIds.length === 0)
      delete turn.interruptedCommandExecutionItemIds;
  }
  turn.itemsPagination = {
    ...turn.itemsPagination,
    itemsView: "summary",
    newestSnapshotItemId,
    olderCursor: { type: "item", itemId: anchorId },
    olderPageBeforeItemId: turn.items[0]!.id === anchorId ? undefined : anchorId,
    isLoadingOlder: false,
    hasLoadedOldest: false,
  };
}

/** Applies one plan against the topology generation it was computed from. */
export function applyCodexActiveHistoryEviction(
  state: Draft<CodexCanonicalConversationState>,
  plan: CodexActiveHistoryEvictionPlan,
  olderTurnsCursor: string | null,
): void {
  const history = state.turnHistory?.history;
  if (!history) return;
  const island = history.islands.at(-1);
  if (island?.id !== plan.islandId || history.generation !== plan.generation) return;
  for (const cut of plan.itemCuts) releaseTurnItems(history.entitiesByKey[cut.entityKey]!, cut);
  if (!plan.turns || olderTurnsCursor === null) return;
  const { from, to, oldestRetainedTurnId } = plan.turns;
  for (const entry of island.entries.splice(from, to - from))
    delete history.entitiesByKey[entry.value];
  const onlyIsland = history.islands.length === 1;
  let boundaryId = island.olderBoundary.boundaryId;
  if (from > 0) {
    const prefixId = `${island.id}:prefix:${history.generation + 1}`;
    history.islands.splice(history.islands.length - 1, 0, {
      id: prefixId,
      entries: island.entries.splice(0, from),
      olderBoundary: island.olderBoundary,
      newerBoundary: { status: "exhausted", boundaryId: `${prefixId}:newer` },
    });
    boundaryId = `${island.id}:older:${history.generation + 1}`;
  }
  island.olderBoundary = availableCodexHistoryBoundary(boundaryId, {
    cursor: olderTurnsCursor,
    oldestLoadedTurnId: oldestRetainedTurnId,
  }) as Draft<CodexHistoryIsland["olderBoundary"]>;
  history.generation += 1;
  history.isComplete = false;
  if (onlyIsland && from === 0)
    state.turnsPagination = {
      olderCursor: olderTurnsCursor,
      oldestLoadedTurnId: oldestRetainedTurnId,
      isLoadingOlder: false,
      hasLoadedOldest: false,
    };
}

export const CODEX_ACTIVE_HISTORY_ENFORCING_NOTIFICATIONS: ReadonlySet<string> = new Set([
  "item/started",
  "item/completed",
  "turn/started",
  "turn/completed",
]);

export interface CodexActiveHistoryWindowOptions {
  readonly client: Pick<
    CanonicalHistoryClient,
    "getConversation" | "updateConversation" | "sendRequest"
  >;
  readonly capabilities: (id: string) => CodexActiveHistoryCapabilities;
  /** The read a release must not overlap: its response could rebuild what was released. */
  readonly getActiveRead: (id: string) => Promise<unknown> | undefined;
  readonly schedule: (work: () => void) => () => void;
  readonly onError: (id: string, error: unknown) => void;
}

interface CodexActiveHistoryView {
  readonly viewports: CodexHistoryViewportRegistry;
  enforceOnChange: boolean;
}

interface CodexActiveHistoryPass {
  dirty: boolean;
  cancel?: () => void;
}

/**
 * Keeps each conversation's live tail bounded as it runs, including conversations nobody is
 * viewing. One pass runs at a time per conversation; a viewport only re-evaluates a conversation
 * that was waiting on viewports, so scrolling a bounded chat costs nothing.
 */
export class CodexActiveHistoryWindow {
  private readonly views = new Map<string, CodexActiveHistoryView>();
  private readonly passes = new Map<string, CodexActiveHistoryPass>();
  private disposed = false;

  constructor(private readonly options: CodexActiveHistoryWindowOptions) {}

  setViewport(
    id: string,
    viewer: symbol,
    boundaries: readonly (CodexHistoryViewportBoundary | null)[] | undefined,
  ): void {
    let view = this.views.get(id);
    if (!view) {
      if (boundaries === undefined) return;
      view = { viewports: new CodexHistoryViewportRegistry(), enforceOnChange: true };
      this.views.set(id, view);
    }
    if (!view.viewports.set(viewer, boundaries)) return;
    if (boundaries === undefined) {
      if (view.viewports.getBoundaries().length === 0) this.views.delete(id);
      this.enforce(id);
    } else if (view.enforceOnChange) this.enforce(id);
  }

  enforce(id: string): void {
    if (this.disposed) return;
    const running = this.passes.get(id);
    if (running) {
      running.dirty = true;
      return;
    }
    const view = this.views.get(id);
    if (view) view.enforceOnChange = false;
    const snapshot = readCodexActiveHistorySnapshot(
      this.options.client.getConversation(id),
      this.options.capabilities(id),
    );
    if (!snapshot) return;
    const read = this.options.getActiveRead(id);
    const pass: CodexActiveHistoryPass = { dirty: false };
    if (read) {
      this.passes.set(id, pass);
      const settle = () => this.finish(id, pass, true);
      void read.then(settle, settle);
      return;
    }
    const plan = planFromSnapshot(snapshot, view?.viewports.getBoundaries() ?? []);
    if (!plan) {
      if (view) view.enforceOnChange = true;
      return;
    }
    this.passes.set(id, pass);
    pass.cancel = this.options.schedule(() => {
      pass.cancel = undefined;
      this.apply(id, plan).then(
        (changed) => this.finish(id, pass, changed),
        (error: unknown) => {
          this.options.onError(id, error);
          this.finish(id, pass, false);
        },
      );
    });
  }

  remove(id: string): void {
    this.passes.get(id)?.cancel?.();
    this.passes.delete(id);
    this.views.delete(id);
  }

  clear(): void {
    for (const pass of this.passes.values()) pass.cancel?.();
    this.passes.clear();
    this.views.clear();
  }

  dispose(): void {
    this.disposed = true;
    this.clear();
  }

  private finish(id: string, pass: CodexActiveHistoryPass, again: boolean): void {
    if (this.passes.get(id) !== pass) return;
    this.passes.delete(id);
    if (again || pass.dirty) this.enforce(id);
  }

  private currentPlan(id: string): CodexActiveHistoryEvictionPlan | null {
    return planCodexActiveHistoryEviction(
      this.options.client.getConversation(id),
      this.views.get(id)?.viewports.getBoundaries() ?? [],
      this.options.capabilities(id),
    );
  }

  private async apply(id: string, plan: CodexActiveHistoryEvictionPlan): Promise<boolean> {
    const cursor = plan.turns ? await this.readOlderTurnsCursor(id, plan.turns) : null;
    if (this.disposed || (plan.turns && cursor === null)) return false;
    const read = this.options.getActiveRead(id);
    if (read) {
      await read.catch(() => undefined);
      return true;
    }
    const current = this.currentPlan(id);
    if (
      current?.generation !== plan.generation ||
      current.islandId !== plan.islandId ||
      current.turns?.oldestRetainedTurnId !== plan.turns?.oldestRetainedTurnId
    )
      return false;
    this.options.client.updateConversation(id, (draft) =>
      applyCodexActiveHistoryEviction(draft, current, cursor),
    );
    return true;
  }

  /** Turn cursors are opaque, so finding one means reading past the Turns that stay resident. */
  private async readOlderTurnsCursor(
    id: string,
    {
      retainedTurnCount,
      oldestRetainedTurnId,
    }: NonNullable<CodexActiveHistoryEvictionPlan["turns"]>,
  ): Promise<string | null> {
    let remaining = retainedTurnCount;
    let cursor: string | null = null;
    while (remaining > 0) {
      const { data, nextCursor }: ClientRequestResponsesByMethod["thread/turns/list"] =
        await this.options.client.sendRequest(
          "thread/turns/list",
          {
            threadId: id,
            cursor,
            limit: remaining,
            sortDirection: "desc",
            itemsView: "notLoaded",
          },
          { priority: "background", source: "tail_history" },
        );
      if (
        data.length === 0 ||
        data.length > remaining ||
        nextCursor == null ||
        nextCursor === cursor
      )
        return null;
      remaining -= data.length;
      if (remaining === 0) return data.at(-1)?.id === oldestRetainedTurnId ? nextCursor : null;
      cursor = nextCursor;
    }
    return null;
  }
}
