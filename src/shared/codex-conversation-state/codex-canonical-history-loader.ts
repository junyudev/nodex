import notificationSchema from "@nodex/codex-app-server-protocol/runtime-schemas/ServerNotification.schema.json";
import { createGeneratedCodexSchema } from "../generated-codex-schema";
import { CodexProtocolThreadItemSchema } from "../codex-protocol-thread-item";
import {
  reconcileCodexHydratedSteering,
  relocateCodexHydratedSteering,
} from "./codex-steering-reconciliation";
import type { Draft } from "immer";
import type {
  ClientRequestParamsByMethod,
  ClientRequestResponsesByMethod,
} from "@nodex/effect-codex-app-server/rpc";
import type {
  ThreadItem,
  Turn,
  TurnItemsView,
  ThreadTurnsListResponse,
} from "@nodex/codex-app-server-protocol/v2";
import {
  materializeCodexCanonicalProtocolItem,
  extractCodexCanonicalHydratedAttachments,
  mergeCodexCanonicalTurnState,
  mergeCodexCanonicalTurnStates,
  type CodexCanonicalConversationState,
  type CodexCanonicalTurnState,
} from "./codex-conversation-state";
import {
  conversationTurnDraft,
  residentConversationTurnEntries,
  residentConversationTurns,
} from "./codex-turn-mutation";
import { mergeCodexCanonicalHistoryItems } from "./codex-history-item-merge";
import {
  availableCodexHistoryBoundary,
  exhaustedCodexHistoryBoundary,
  readCurrentCodexHistoryBoundary,
  type CodexCanonicalHistoryTopology,
  type CodexHistoryBoundaryHandle,
  type CodexHistoryBoundaryRef,
  type CodexHistoryEntry,
  type CodexHistoryIsland,
  type CodexHistoryTurnItemsPagination,
} from "./codex-history-topology";

const nativeTurnSchema = createGeneratedCodexSchema<Turn>({
  $schema: notificationSchema.$schema,
  definitions: notificationSchema.definitions,
  $ref: "#/definitions/definitions__v2__Turn",
});

type HistoryMethod = "thread/turns/list" | "thread/items/list";
export interface CanonicalHistoryRequestOptions {
  readonly timeoutMs?: number;
  readonly priority?: "background" | "interactive" | "critical";
  readonly source?: string;
}
export interface CanonicalHistoryClient {
  readonly hostId: string;
  supportsPaginatedHistory(): boolean;
  getConversation(conversationId: string): CodexCanonicalConversationState | null | undefined;
  sendRequest<M extends HistoryMethod>(
    method: M,
    params: ClientRequestParamsByMethod[M],
    options?: CanonicalHistoryRequestOptions,
  ): Promise<ClientRequestResponsesByMethod[M]>;
  updateConversation(
    conversationId: string,
    recipe: (draft: Draft<CodexCanonicalConversationState>) => void,
    broadcast?: boolean,
  ): void;
  broadcastSnapshot(conversationId: string): void;
  mapTurns(
    conversationId: string,
    turns: readonly Turn[],
    pagination: Readonly<Record<string, CodexHistoryTurnItemsPagination>>,
  ): readonly CodexCanonicalTurnState[];
}
export interface CanonicalHistoryTurnPage {
  readonly response: ThreadTurnsListResponse;
  readonly itemsPaginationByTurnId: Readonly<Record<string, CodexHistoryTurnItemsPagination>>;
}
export interface CanonicalHistoryPageOptions {
  readonly cursor?: string | null;
  readonly limit?: number | null;
  readonly sortDirection?: "asc" | "desc" | null;
  readonly itemsView?: TurnItemsView | null;
  readonly requestOptions?: CanonicalHistoryRequestOptions;
  readonly source?: "ordinary" | "compact";
}

/** The physical item request validates its Turn identity and retains chronological item order. */
export async function readCanonicalHistoryItems(
  client: CanonicalHistoryClient,
  conversationId: string,
  turnId: string,
  cursor: string | null,
  options?: CanonicalHistoryRequestOptions,
  limit = 100,
  sortDirection: "asc" | "desc" = "desc",
) {
  const response = await client.sendRequest(
    "thread/items/list",
    { threadId: conversationId, turnId, cursor, limit, sortDirection },
    options,
  );
  if (response.nextCursor !== null && response.nextCursor === cursor)
    throw new Error(`thread/items/list returned unchanged cursor for turn ${turnId}`);
  const items = response.data.map((entry) => {
    if (entry.turnId !== turnId)
      throw new Error(`thread/items/list returned item for unexpected turn ${entry.turnId}`);
    return CodexProtocolThreadItemSchema.parse(entry.item);
  });
  return {
    items: sortDirection === "desc" ? items.reverse() : items,
    nextCursor: response.nextCursor ?? null,
  };
}

async function readDurableTurnItems(
  client: CanonicalHistoryClient,
  conversationId: string,
  turnId: string,
  options: CanonicalHistoryRequestOptions,
): Promise<ThreadItem[]> {
  const items: ThreadItem[] = [];
  const cursors = new Set<string>();
  let cursor: string | null = null;
  let limit = 500;
  for (;;) {
    let response: ClientRequestResponsesByMethod["thread/items/list"];
    try {
      response = await client.sendRequest(
        "thread/items/list",
        { threadId: conversationId, turnId, cursor, limit, sortDirection: "asc" },
        options,
      );
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.includes("decoded message length too large") ||
        limit <= 1
      )
        throw error;
      limit = Math.floor(limit / 2);
      continue;
    }
    items.push(
      ...response.data.map((entry) =>
        CodexProtocolThreadItemSchema.parse("item" in entry ? entry.item : entry),
      ),
    );
    if (response.nextCursor == null) return items;
    if (cursors.has(response.nextCursor))
      throw new Error(`thread/items/list returned a repeated cursor for turn ${turnId}`);
    cursors.add(response.nextCursor);
    cursor = response.nextCursor;
  }
}

/** Native paging follows the execution host's ordinary history path. */
export async function listCanonicalHistoryTurns(
  client: CanonicalHistoryClient,
  conversationId: string,
  options: CanonicalHistoryPageOptions = {},
): Promise<CanonicalHistoryTurnPage> {
  if (options.source === "compact")
    throw new Error("Compact history is unsupported for this thread");
  const conversation = client.getConversation(conversationId);
  const durable = client.hostId === "durable";
  const paginated =
    !durable &&
    client.supportsPaginatedHistory() &&
    conversation?.historyMode === "paginated" &&
    conversation.paginatedHistory != null;
  const requestOptions = durable
    ? { timeoutMs: 30000, ...options.requestOptions }
    : options.requestOptions;
  const rawResponse = await client.sendRequest(
    "thread/turns/list",
    {
      threadId: conversationId,
      cursor: options.cursor ?? null,
      limit: options.limit ?? null,
      sortDirection: options.sortDirection ?? (durable || paginated ? "desc" : undefined),
      itemsView: durable || paginated ? "notLoaded" : (options.itemsView ?? "full"),
    },
    requestOptions,
  );
  const response: ThreadTurnsListResponse = {
    ...rawResponse,
    nextCursor: rawResponse.nextCursor ?? null,
    backwardsCursor: rawResponse.backwardsCursor ?? null,
    data: rawResponse.data.map((turn) =>
      nativeTurnSchema.parse({
        ...turn,
        itemsView: turn.itemsView ?? "full",
        items: turn.items.map((item) => CodexProtocolThreadItemSchema.parse(item)),
        error:
          turn.error == null
            ? null
            : {
                ...turn.error,
                codexErrorInfo: turn.error.codexErrorInfo ?? null,
                additionalDetails: turn.error.additionalDetails ?? null,
                misalignment: turn.error.misalignment ?? null,
              },
        startedAt: turn.startedAt ?? null,
        completedAt: turn.completedAt ?? null,
        durationMs: turn.durationMs ?? null,
      }),
    ),
  };
  if (
    (!durable && !paginated) ||
    options.itemsView === "notLoaded" ||
    (durable && options.itemsView === "summary")
  )
    return { response, itemsPaginationByTurnId: {} };
  if (durable) {
    const data = new Array<Turn>(response.data.length);
    const worker = async (index: number): Promise<void> => {
      const turn = response.data[index];
      if (!turn) return;
      data[index] = {
        ...turn,
        items: await readDurableTurnItems(client, conversationId, turn.id, requestOptions!),
        itemsView: "full",
      };
      await worker(index + 5);
    };
    await Promise.all(
      Array.from({ length: Math.min(response.data.length, 5) }, (_, index) => worker(index)),
    );
    return { response: { ...response, data }, itemsPaginationByTurnId: {} };
  }
  const data: Turn[] = [];
  const itemsPaginationByTurnId: Record<string, CodexHistoryTurnItemsPagination> = {};
  const openingLookups: Promise<void>[] = [];
  const openingConversation = client.getConversation(conversationId);
  const resident = openingConversation
    ? mergeCodexCanonicalTurnStates(
        residentConversationTurns(openingConversation),
        openingConversation.turns,
      )
    : [];
  let budget = Math.min(options.limit ?? 5, 5) * 100;
  for (const raw of response.data) {
    let cursor = conversation!.paginatedHistory!.itemsBackwardsCursor;
    let requested = false;
    const seenCursors = new Set<string | null>();
    const seenItems = new Set<string>();
    const descendingItems: ThreadItem[] = [];
    while ((!requested || cursor !== null) && budget > 0) {
      if (seenCursors.has(cursor))
        throw new Error(`thread/items/list repeated cursor ${cursor} for turn ${raw.id}`);
      seenCursors.add(cursor);
      const page = await readCanonicalHistoryItems(
        client,
        conversationId,
        raw.id,
        cursor,
        requestOptions,
        Math.min(100, budget),
      );
      requested = true;
      const items = page.items.filter((item) =>
        seenItems.has(item.id) ? false : (seenItems.add(item.id), true),
      );
      descendingItems.push(...items.reverse());
      budget -= items.length;
      cursor = page.nextCursor;
    }
    const items = descendingItems.reverse();
    const complete = requested && cursor === null;
    const itemsView = complete ? "full" : "summary";
    data.push({ ...raw, items, itemsView });
    const pagination: Draft<CodexHistoryTurnItemsPagination> = {
      olderCursor: cursor,
      isLoadingOlder: false,
      hasLoadedOldest: complete,
      newestSnapshotItemId: items.at(-1)?.id,
      itemsView,
    };
    if (!complete) {
      const existing = resident.find((turn) => turn.turnId === raw.id);
      const oldestInput =
        existing?.itemsPagination?.oldestUserInput ??
        (existing &&
        existing.itemsPagination?.hasLoadedOldest !== false &&
        existing.params.input.length > 0
          ? existing.params.input
          : undefined);
      if (oldestInput != null) {
        pagination.oldestUserInput = [...oldestInput];
        pagination.openingUserMessageClientId =
          existing?.itemsPagination?.oldestUserInput == null
            ? existing?.params.clientUserMessageId
            : existing.itemsPagination.openingUserMessageClientId;
      }
      const openingId = existing?.itemsPagination?.openingUserMessageId;
      if (openingId !== undefined) pagination.openingUserMessageId = openingId;
      else if (items.length > 0)
        openingLookups.push(
          readCanonicalHistoryItems(client, conversationId, raw.id, null, requestOptions, 2, "asc")
            .then((page) => {
              const opening = page.items.find((item) => item.type !== "contextCompaction");
              if (!opening && !(page.nextCursor === null && raw.status !== "inProgress")) return;
              pagination.oldestUserInput = opening?.type === "userMessage" ? opening.content : [];
              pagination.openingUserMessageId = opening?.type === "userMessage" ? opening.id : null;
              pagination.openingUserMessageClientId =
                opening?.type === "userMessage" ? opening.clientId : null;
            })
            .catch(() => undefined),
        );
    }
    itemsPaginationByTurnId[raw.id] = pagination;
  }
  await Promise.all(openingLookups);
  return { response: { ...response, data }, itemsPaginationByTurnId };
}

/** Installs fetched history once; local overlays do not survive history replacement. */
export function replaceCanonicalHistoryDraft(
  state: Draft<CodexCanonicalConversationState>,
  turns: readonly CodexCanonicalTurnState[],
  complete: boolean,
  boundary: CodexHistoryBoundaryHandle | null = null,
): void {
  const generation = state.turnHistory ? state.turnHistory.history.generation + 1 : 0;
  const id = `tail:${generation}`;
  const entitiesByKey: Record<string, CodexCanonicalTurnState> = {};
  const entries: CodexHistoryEntry[] = [];
  turns.forEach((input, index) => {
    const turn = input.itemsPagination?.isLoadingOlder
      ? { ...input, itemsPagination: { ...input.itemsPagination, isLoadingOlder: false } }
      : input;
    const key = turn.turnId === null ? `${id}:local:${index}` : `turn:${turn.turnId}`;
    const existing = entitiesByKey[key];
    if (existing) entitiesByKey[key] = mergeCodexCanonicalTurnState(existing, turn);
    else {
      entitiesByKey[key] = turn;
      entries.push({ key, value: key });
    }
  });
  state.turnHistory = {
    kind: "canonical",
    history: {
      generation,
      isComplete: complete,
      entitiesByKey,
      islands: [
        {
          id,
          entries,
          olderBoundary: boundary
            ? availableCodexHistoryBoundary(`${id}:older`, boundary)
            : exhaustedCodexHistoryBoundary(`${id}:older`),
          newerBoundary: exhaustedCodexHistoryBoundary(`${id}:newer`),
        },
      ],
    },
  } as Draft<NonNullable<CodexCanonicalConversationState["turnHistory"]>>;
  state.turns = [];
}

function pagePositions(
  history: CodexCanonicalHistoryTopology<CodexCanonicalTurnState>,
  ref: CodexHistoryBoundaryRef,
  entries: readonly CodexHistoryEntry[],
): Map<string, number> {
  const positions = new Map<string, number>();
  let position = 0;
  for (const island of history.islands) {
    for (const entry of island.entries) positions.set(entry.value, position++);
    position += Math.max(5, entries.length) + 1;
  }
  const island = history.islands.find((candidate) => candidate.id === ref.islandId);
  const anchor = ref.edge === "older" ? island?.entries[0] : island?.entries.at(-1);
  const start = anchor ? (positions.get(anchor.value) ?? 0) : 0;
  entries.forEach((entry, index) => {
    if (!positions.has(entry.value))
      positions.set(
        entry.value,
        start + (ref.edge === "older" ? index - entries.length : index + 1),
      );
  });
  return positions;
}

function mergePageIslands(
  history: CodexCanonicalHistoryTopology<CodexCanonicalTurnState>,
  target: CodexHistoryIsland,
  changed: CodexHistoryIsland,
  positions: ReadonlyMap<string, number>,
  entity: (key: string) => CodexCanonicalTurnState | undefined,
): readonly CodexHistoryIsland[] {
  const range = (island: CodexHistoryIsland) => {
    if (island.entries.length === 0) return null;
    let first = Infinity,
      last = -Infinity;
    for (const entry of island.entries) {
      const position = positions.get(entry.value);
      if (position === undefined) throw new Error(`Missing history position for ${entry.value}`);
      first = Math.min(first, position);
      last = Math.max(last, position);
    }
    return { first, last };
  };
  const incomingRange = range(changed);
  if (!incomingRange && history.islands.some((island) => island !== target))
    throw new Error("Cannot place an empty history island");
  const overlaps = history.islands.filter((island) => {
    if (island === target || !incomingRange) return false;
    const value = range(island);
    return value !== null && value.first <= incomingRange.last && incomingRange.first <= value.last;
  });
  const participants = [...overlaps, changed];
  const first = participants.reduce((previous, next) =>
    (range(next)?.first ?? 0) < (range(previous)?.first ?? 0) ? next : previous,
  );
  const last = participants.reduce((previous, next) =>
    (range(next)?.last ?? 0) > (range(previous)?.last ?? 0) ? next : previous,
  );
  const identities = new Set<string>();
  const entries = [...overlaps.flatMap((island) => island.entries), ...changed.entries]
    .filter((entry) => {
      const identity = entity(entry.value)?.turnId;
      if (identity == null) return true;
      if (identities.has(identity)) return false;
      identities.add(identity);
      return true;
    })
    .sort((left, right) => positions.get(left.value)! - positions.get(right.value)!);
  const merged = {
    ...changed,
    id: last.id,
    entries,
    olderBoundary: first.olderBoundary,
    newerBoundary: last.newerBoundary,
  };
  return [
    ...history.islands.filter((island) => island !== target && !overlaps.includes(island)),
    merged,
  ].sort((left, right) => (range(left)?.first ?? 0) - (range(right)?.first ?? 0));
}

export async function loadCanonicalHistoryBoundaryPage(
  client: CanonicalHistoryClient,
  conversationId: string,
  ref: CodexHistoryBoundaryRef,
  options: Pick<CanonicalHistoryPageOptions, "limit" | "itemsView" | "requestOptions"> = {},
): Promise<"applied" | "stale"> {
  const before = client.getConversation(conversationId);
  const history = before?.turnHistory?.history;
  const boundary = history ? readCurrentCodexHistoryBoundary(history, ref) : null;
  if (!before || !history || !boundary) return "stale";
  const page = await listCanonicalHistoryTurns(client, conversationId, {
    ...options,
    cursor: boundary.handle.cursor,
    source: boundary.handle.source,
    limit: options.limit ?? 5,
    sortDirection: ref.edge === "older" ? "desc" : "asc",
  });
  if (page.response.nextCursor === boundary.handle.cursor)
    throw new Error("thread/turns/list returned an unchanged cursor");
  const turns = client.mapTurns(
    conversationId,
    ref.edge === "older" ? page.response.data.slice().reverse() : page.response.data,
    page.itemsPaginationByTurnId,
  );
  let applied = false;
  client.updateConversation(
    conversationId,
    (draft) => {
      const current = draft.turnHistory?.history;
      const currentBoundary = current ? readCurrentCodexHistoryBoundary(current, ref) : null;
      if (
        !current ||
        !currentBoundary ||
        currentBoundary.handle.source !== boundary.handle.source ||
        currentBoundary.handle.cursor !== boundary.handle.cursor
      )
        return;
      const installed: Record<string, CodexCanonicalTurnState> = {};
      const lookup = (key: string) => installed[key] ?? current.entitiesByKey[key];
      const pageEntries = turns.map((turn, index) => {
        const key =
          turn.turnId === null
            ? `${ref.boundaryId}:${ref.progressKey}:local:${index}`
            : `turn:${turn.turnId}`;
        const resident = lookup(key);
        installed[key] = resident ? mergeCodexCanonicalTurnState(resident, turn) : turn;
        return { key, value: key };
      });
      const oldestLoadedTurnId =
        options.itemsView === "summary" && ref.edge === "older"
          ? (turns.find((turn) => turn.turnId !== null)?.turnId ??
            boundary.handle.oldestLoadedTurnId)
          : boundary.handle.oldestLoadedTurnId;
      const continuation =
        page.response.nextCursor === null
          ? exhaustedCodexHistoryBoundary(ref.boundaryId)
          : availableCodexHistoryBoundary(ref.boundaryId, {
              source: boundary.handle.source,
              cursor: page.response.nextCursor,
              oldestLoadedTurnId,
            });
      const target = current.islands.find((island) => island.id === ref.islandId)!;
      const changed = {
        ...target,
        entries: [...target.entries, ...pageEntries],
        ...(ref.edge === "older"
          ? { olderBoundary: continuation }
          : { newerBoundary: continuation }),
      };
      const positions = pagePositions(current, ref, pageEntries);
      const islands = mergePageIslands(current, target, changed, positions, lookup);
      for (const [key, turn] of Object.entries(installed))
        current.entitiesByKey[key] = turn as Draft<CodexCanonicalTurnState>;
      current.islands = islands as Draft<CodexHistoryIsland[]>;
      current.isComplete =
        islands.length === 1 &&
        islands[0]?.olderBoundary.status === "exhausted" &&
        islands[0].newerBoundary.status === "exhausted";
      if (options.itemsView === "summary" && ref.edge === "older")
        draft.turnsPagination = {
          source: before.turnsPagination?.source,
          olderCursor: page.response.nextCursor,
          oldestLoadedTurnId,
          isLoadingOlder: false,
          hasLoadedOldest: page.response.nextCursor === null,
        };
      const residentEntries = residentConversationTurnEntries(draft);
      const relocated = relocateCodexHydratedSteering(residentEntries.map((entry) => entry.turn));
      for (const [index, entry] of residentEntries.entries()) {
        const next = relocated[index];
        if (next && next.items !== entry.turn.items)
          conversationTurnDraft(draft, entry.address)!.items = next.items as Draft<
            CodexCanonicalTurnState["items"]
          >;
      }
      applied = true;
    },
    false,
  );
  if (applied) client.broadcastSnapshot(conversationId);
  return applied ? "applied" : "stale";
}

interface ItemLoad {
  readonly conversationId: string;
  readonly turnId: string;
  readonly generation: number | null;
  pagination: CodexHistoryTurnItemsPagination | undefined;
  cancelled: boolean;
  promise: Promise<void>;
}

/** Item loads belong to the exact pagination object, not a second request/revision authority. */
export class CanonicalHistoryItemLoader implements Disposable {
  private readonly inFlight = new Map<string, ItemLoad>();
  private readonly queuedPreviews = new Map<ItemLoad, (admitted: boolean) => void>();
  private activePreviews = 0;
  private disposed = false;
  constructor(private readonly client: CanonicalHistoryClient) {}

  cancelLoads(conversationId?: string): void {
    for (const [key, load] of this.inFlight) {
      if (conversationId !== undefined && load.conversationId !== conversationId) continue;
      load.cancelled = true;
      this.queuedPreviews.get(load)?.(false);
      this.queuedPreviews.delete(load);
      if (!this.disposed) this.updateLoading(load, false);
      this.inFlight.delete(key);
    }
  }
  [Symbol.dispose](): void {
    this.disposed = true;
    this.cancelLoads();
  }
  async loadPartialTurnItemsPage(
    conversationId: string,
    count: number,
    oldestFirst: boolean,
    options?: CanonicalHistoryRequestOptions,
  ): Promise<boolean> {
    const conversation = this.client.getConversation(conversationId);
    if (!conversation) return false;
    const ids = residentConversationTurns(conversation).flatMap((turn) =>
      turn.turnId !== null && turn.itemsPagination?.hasLoadedOldest === false ? [turn.turnId] : [],
    );
    const selected = oldestFirst ? ids.slice(0, count) : ids.slice(-count);
    if (selected.length === 0) return false;
    await Promise.all(selected.map((id) => this.loadTurnItems(conversationId, id, false, options)));
    return true;
  }
  async loadRemainingTurnItems(conversationId: string): Promise<void> {
    const initial = this.client.getConversation(conversationId);
    const generation = initial?.turnHistory?.history.generation ?? null;
    while (!this.disposed) {
      const current = this.client.getConversation(conversationId);
      if (
        (current?.turnHistory?.history.generation ?? null) !== generation ||
        current?.resumeState !== initial?.resumeState
      )
        return;
      const turn = residentConversationTurns(current).find(
        (candidate) =>
          candidate.turnId !== null && candidate.itemsPagination?.hasLoadedOldest === false,
      );
      if (turn?.turnId == null) return;
      await this.loadTurnItems(conversationId, turn.turnId, true);
    }
  }
  async loadTurnItems(
    conversationId: string,
    turnId: string,
    all = false,
    options?: CanonicalHistoryRequestOptions,
  ): Promise<void> {
    if (this.disposed) return;
    const key = `${conversationId}:${turnId}`;
    const existing = this.inFlight.get(key);
    if (existing && this.owns(existing)) {
      await existing.promise;
      if (all && this.owns(existing))
        await this.loadTurnItems(conversationId, turnId, true, options);
      return;
    }
    if (existing) {
      existing.cancelled = true;
      this.queuedPreviews.get(existing)?.(false);
      this.queuedPreviews.delete(existing);
    }
    const conversation = this.client.getConversation(conversationId);
    const load: ItemLoad = {
      conversationId,
      turnId,
      generation: conversation?.turnHistory?.history.generation ?? null,
      pagination: this.pagination(conversationId, turnId),
      cancelled: false,
      promise: Promise.resolve(),
    };
    this.inFlight.set(key, load);
    load.promise = this.loadInner(load, all, options);
    try {
      await load.promise;
    } finally {
      if (!this.disposed) this.updateLoading(load, false);
      if (this.inFlight.get(key) === load) this.inFlight.delete(key);
    }
  }
  private pagination(
    conversationId: string,
    turnId: string,
  ): CodexHistoryTurnItemsPagination | undefined {
    return residentConversationTurns(this.client.getConversation(conversationId)).find(
      (turn) => turn.turnId === turnId,
    )?.itemsPagination;
  }
  private owns(load: ItemLoad): boolean {
    const current = this.client.getConversation(load.conversationId);
    return (
      !this.disposed &&
      !load.cancelled &&
      (current?.turnHistory?.history.generation ?? null) === load.generation &&
      this.pagination(load.conversationId, load.turnId) === load.pagination
    );
  }
  private updateLoading(load: ItemLoad, loading: boolean): void {
    const pagination = this.pagination(load.conversationId, load.turnId);
    if (!pagination || pagination !== load.pagination || pagination.isLoadingOlder === loading)
      return;
    this.client.updateConversation(load.conversationId, (draft) => {
      const entry = residentConversationTurnEntries(draft).findLast(
        ({ turn }) => turn.turnId === load.turnId,
      );
      const turn = entry ? conversationTurnDraft(draft, entry.address) : undefined;
      if (turn?.itemsPagination) turn.itemsPagination.isLoadingOlder = loading;
    });
    load.pagination = this.pagination(load.conversationId, load.turnId);
  }
  private async loadInner(
    load: ItemLoad,
    all: boolean,
    options?: CanonicalHistoryRequestOptions,
  ): Promise<void> {
    const { conversationId, turnId } = load;
    while (!this.disposed) {
      let turn = residentConversationTurns(this.client.getConversation(conversationId)).find(
        (candidate) => candidate.turnId === turnId,
      );
      const pagination = turn?.itemsPagination;
      if (!this.owns(load) || !turn || !pagination || pagination.hasLoadedOldest) return;
      const cursor = pagination.olderCursor;
      const summaryIds = pagination.summaryItemIds;
      const beforeItems = new Map(turn.items.map((item) => [item.id, item]));
      const preview = !all && summaryIds != null;
      if (preview && this.activePreviews >= 2) {
        if (
          !(await new Promise<boolean>((resolve) => {
            this.queuedPreviews.set(load, resolve);
          }))
        )
          return;
      } else if (preview) this.activePreviews += 1;
      try {
        if (!this.owns(load)) return;
        this.updateLoading(load, true);
        const requestOptions =
          options ??
          (all || summaryIds != null
            ? { priority: "background", source: "tail_history" }
            : undefined);
        const page = await readCanonicalHistoryItems(
          this.client,
          conversationId,
          turnId,
          cursor,
          requestOptions,
          summaryIds == null ? 100 : 98,
        );
        turn = residentConversationTurns(this.client.getConversation(conversationId)).find(
          (candidate) => candidate.turnId === turnId,
        );
        if (!this.owns(load) || !turn) return;
        const stopId = turn.itemsPagination?.reconnect?.stopItemId;
        const foundStop = stopId != null && page.items.some((item) => item.id === stopId);
        const nextCursor = foundStop
          ? (turn.itemsPagination?.reconnect?.olderCursorAfterReconnect ?? null)
          : page.nextCursor;
        let openingItems = page.items;
        if (summaryIds != null && nextCursor !== null) {
          openingItems = (
            await readCanonicalHistoryItems(
              this.client,
              conversationId,
              turnId,
              null,
              { priority: "background", source: "tail_history" },
              2,
              "asc",
            )
          ).items;
          turn = residentConversationTurns(this.client.getConversation(conversationId)).find(
            (candidate) => candidate.turnId === turnId,
          );
          if (!this.owns(load) || !turn) return;
        }
        const opening = openingItems.find((item) => item.type !== "contextCompaction");
        const incoming = page.items.map((item) => materializeCodexCanonicalProtocolItem(item));
        const reconnect = turn.itemsPagination?.reconnect;
        const liveItems = new Map(
          turn.items
            .filter((item) => beforeItems.get(item.id) !== item)
            .map((item) => [item.id, item]),
        );
        const retained =
          summaryIds == null
            ? turn.items
            : turn.items.filter((item) => !summaryIds.includes(item.id) || liveItems.has(item.id));
        const merged = mergeCodexCanonicalHistoryItems(
          retained,
          incoming,
          reconnect ? { snapshotBeforeItemId: reconnect.beforeItemId } : "prepend",
        ).items.map((item) => liveItems.get(item.id) ?? item);
        this.client.updateConversation(
          conversationId,
          (draft) => {
            const entry = residentConversationTurnEntries(draft).findLast(
              ({ turn }) => turn.turnId === turnId,
            );
            const target = entry ? conversationTurnDraft(draft, entry.address) : undefined;
            if (!target?.itemsPagination || target.itemsPagination.olderCursor !== cursor) return;
            target.items = merged as Draft<CodexCanonicalTurnState["items"]>;
            if (summaryIds != null && opening?.type === "userMessage") {
              applyOpeningUserInput(target, opening);
              target.itemsPagination.oldestUserInput = opening.content;
              target.itemsPagination.openingUserMessageId = opening.id;
              target.itemsPagination.openingUserMessageClientId = opening.clientId;
            }
            const first = merged.find((item) => item.type !== "contextCompaction");
            if (
              nextCursor === null &&
              first?.type === "userMessage" &&
              (target.itemsPagination.oldestUserInput == null || summaryIds != null)
            )
              applyOpeningUserInput(target, first);
            const reconciled = reconcileCodexHydratedSteering(target, target.itemsPagination);
            if (reconciled !== target)
              target.items = reconciled.items as Draft<CodexCanonicalTurnState["items"]>;
            target.itemsPagination = {
              ...target.itemsPagination,
              summaryItemIds: undefined,
              olderCursor: nextCursor,
              isLoadingOlder: false,
              hasLoadedOldest: nextCursor === null,
              newestSnapshotItemId:
                target.itemsPagination.newestSnapshotItemId ?? incoming.at(-1)?.id,
              reconnect:
                nextCursor === null || !reconnect || foundStop
                  ? undefined
                  : { ...reconnect, beforeItemId: incoming[0]?.id ?? reconnect.beforeItemId },
            };
          },
          false,
        );
        load.pagination = this.pagination(conversationId, turnId);
        this.client.broadcastSnapshot(conversationId);
        if (!all || nextCursor === null) return;
      } catch (error) {
        if (!this.owns(load)) return;
        throw error;
      } finally {
        if (preview) {
          const next = this.queuedPreviews.entries().next().value;
          if (!next) this.activePreviews -= 1;
          else {
            this.queuedPreviews.delete(next[0]);
            next[1](true);
          }
        }
      }
    }
  }
}

function applyOpeningUserInput(
  turn: Draft<CodexCanonicalTurnState>,
  message: Extract<ThreadItem, { type: "userMessage" }>,
): void {
  turn.params.input = message.content;
  turn.params.clientUserMessageId = message.clientId;
  turn.params.attachments = extractCodexCanonicalHydratedAttachments(message.content);
}
