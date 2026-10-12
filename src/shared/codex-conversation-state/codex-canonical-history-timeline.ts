import type { Draft } from "immer";
import type {
  ThreadItem,
  ThreadTimelineListResponse,
  ThreadRealtimeItem,
  ThreadTimelineEntry,
  Turn,
} from "@nodex/codex-app-server-protocol/v2";
import type { ClientRequestResponsesByMethod } from "@nodex/effect-codex-app-server/rpc";
import notificationSchema from "@nodex/codex-app-server-protocol/runtime-schemas/ServerNotification.schema.json";
import { createGeneratedCodexSchema } from "../generated-codex-schema";
import { CodexProtocolThreadItemSchema } from "../codex-protocol-thread-item";
import {
  normalizeCanonicalHistoryTurn,
  readCanonicalHistoryItems,
  type CanonicalHistoryClient,
  type CanonicalHistoryRequestOptions,
  type CanonicalHistoryTurnPage,
} from "./codex-canonical-history-loader";
import type {
  CodexCanonicalConversationState,
  CodexCanonicalTimelineEntry,
} from "./codex-conversation-state";
import { residentConversationTurns } from "./codex-turn-mutation";
import type { CodexHistoryTurnItemsPagination } from "./codex-history-topology";

const realtimeItemSchema = createGeneratedCodexSchema<ThreadRealtimeItem>({
  $schema: notificationSchema.$schema,
  definitions: notificationSchema.definitions,
  $ref: "#/definitions/definitions__v2__ThreadRealtimeItem",
});

/** The native library's decoded shape becomes the generated wire contract at this one seam. */
export function normalizeCanonicalHistoryTimelinePage(
  response: ClientRequestResponsesByMethod["thread/timeline/list"],
): ThreadTimelineListResponse {
  if (
    !Array.isArray(response.data) ||
    (response.nextCursor !== null && typeof response.nextCursor !== "string") ||
    (response.activeRealtimeSessionAtPageStart !== null &&
      typeof response.activeRealtimeSessionAtPageStart !== "string")
  )
    throw new Error("Invalid native timeline page metadata");
  const data = response.data.map((entry): ThreadTimelineEntry => {
    if (!Number.isSafeInteger(entry.position) || entry.position < 0)
      throw new Error("Invalid native timeline position");
    if (entry.type === "realtime") return { ...entry, item: realtimeItemSchema.parse(entry.item) };
    if (typeof entry.turnId !== "string" || entry.turnId.length === 0)
      throw new Error("Invalid native timeline Turn identity");
    if (entry.type === "item")
      return { ...entry, item: CodexProtocolThreadItemSchema.parse(entry.item) };
    if (entry.type === "turnStarted") {
      if (
        entry.startedAt !== null &&
        (typeof entry.startedAt !== "number" || !Number.isFinite(entry.startedAt))
      )
        throw new Error("Invalid native timeline start timestamp");
      return entry;
    }
    if (entry.type !== "turnCompleted") throw new Error("Unsupported native timeline entry");
    const normalized = normalizeCanonicalHistoryTurn({
      id: entry.turnId,
      rootTurnId: null,
      items: [],
      itemsView: "notLoaded",
      status: entry.status,
      error: entry.error,
      startedAt: entry.startedAt,
      completedAt: entry.completedAt,
      durationMs: entry.durationMs,
    });
    return {
      type: "turnCompleted",
      position: entry.position,
      turnId: entry.turnId,
      status: normalized.status,
      error: normalized.error,
      startedAt: normalized.startedAt,
      completedAt: normalized.completedAt,
      durationMs: normalized.durationMs,
    };
  });
  return {
    data,
    nextCursor: response.nextCursor,
    activeRealtimeSessionAtPageStart: response.activeRealtimeSessionAtPageStart,
  };
}

/** Reads rollout order once, supplementing only missing Turn metadata and opening inputs. */
export async function readCanonicalHistoryTimeline(
  client: CanonicalHistoryClient,
  conversationId: string,
  cursor: string | null,
  options?: CanonicalHistoryRequestOptions,
): Promise<CanonicalHistoryTurnPage> {
  if (!client.sendTimelineRequest) throw new Error("Timeline request Adapter is unavailable");
  const conversation = client.getConversation(conversationId);
  const resident = residentConversationTurns(conversation);
  const shells = new Map<string, Turn>();
  for (const turn of resident) {
    if (turn.turnId === null) continue;
    shells.set(turn.turnId, {
      id: turn.turnId,
      rootTurnId: turn.rootTurnId ?? null,
      items: [],
      itemsView: "notLoaded",
      status: turn.status,
      error: turn.error,
      startedAt: turn.turnStartedAtMs == null ? null : turn.turnStartedAtMs / 1000,
      completedAt: turn.completedAtMs == null ? null : turn.completedAtMs / 1000,
      durationMs: turn.durationMs,
    });
  }
  const read = (pageCursor: string | null) =>
    client.sendTimelineRequest!(
      { threadId: conversationId, cursor: pageCursor, limit: 500 },
      options,
    ).then(normalizeCanonicalHistoryTimelinePage);
  let timeline = await read(cursor);
  if (timeline.nextCursor !== null && timeline.nextCursor === cursor)
    throw new Error("thread/timeline/list returned a repeated cursor");
  let shellPage =
    cursor === null
      ? await client.sendRequest(
          "thread/turns/list",
          { threadId: conversationId, limit: 5, itemsView: "notLoaded", sortDirection: "desc" },
          options,
        )
      : null;
  for (const turn of shellPage?.data ?? [])
    shells.set(turn.id, normalizeCanonicalHistoryTurn(turn));
  const timelineCursors = new Set<string | null>([cursor]);
  for (;;) {
    if (timeline.nextCursor !== null && timelineCursors.has(timeline.nextCursor))
      throw new Error("thread/timeline/list returned a repeated cursor");
    if (
      conversation?.canonicalVoiceHistory ||
      timeline.nextCursor === null ||
      timeline.data.some((entry) => entry.type !== "realtime")
    )
      break;
    timelineCursors.add(timeline.nextCursor);
    timeline = await read(timeline.nextCursor);
  }
  const itemsByTurn = new Map<string, ThreadItem[]>();
  const hasStarted = new Set<string>();
  const completedItemIdsByTurnId: Record<string, Record<string, boolean>> = {};
  for (const entry of timeline.data) {
    if (entry.type === "realtime") continue;
    if (!itemsByTurn.has(entry.turnId)) itemsByTurn.set(entry.turnId, []);
    if (entry.type === "item") {
      itemsByTurn.get(entry.turnId)!.push(entry.item);
      (completedItemIdsByTurnId[entry.turnId] ??= {})[entry.item.id] = true;
    }
    if (entry.type === "turnStarted") hasStarted.add(entry.turnId);
    if (entry.type === "turnCompleted")
      shells.set(entry.turnId, {
        id: entry.turnId,
        rootTurnId: shells.get(entry.turnId)?.rootTurnId ?? null,
        items: [],
        itemsView: "notLoaded",
        status: entry.status,
        error: entry.error,
        startedAt: entry.startedAt,
        completedAt: entry.completedAt,
        durationMs: entry.durationMs,
      });
  }
  const missing = new Set([...itemsByTurn.keys()].filter((turnId) => !shells.has(turnId)));
  const shellCursors = new Set<string | null>();
  while (missing.size > 0 && (shellPage === null || shellPage.nextCursor !== null)) {
    const shellCursor = shellPage?.nextCursor ?? null;
    if (shellCursors.has(shellCursor))
      throw new Error("thread/turns/list returned a repeated cursor");
    shellCursors.add(shellCursor);
    shellPage = await client.sendRequest(
      "thread/turns/list",
      {
        threadId: conversationId,
        cursor: shellCursor,
        limit: 100,
        itemsView: "notLoaded",
        sortDirection: "desc",
      },
      options,
    );
    for (const turn of shellPage.data)
      if (missing.delete(turn.id)) shells.set(turn.id, normalizeCanonicalHistoryTurn(turn));
  }
  const itemsPaginationByTurnId: Record<string, CodexHistoryTurnItemsPagination> = {};
  const data = await Promise.all(
    [...itemsByTurn].map(async ([turnId, items]): Promise<Turn> => {
      const shell = shells.get(turnId);
      if (!shell) throw new Error("Timeline turn metadata is unavailable");
      const complete = timeline.nextCursor === null || hasStarted.has(turnId);
      const pagination: Draft<CodexHistoryTurnItemsPagination> = {
        source: "timeline",
        olderCursor: null,
        isLoadingOlder: false,
        hasLoadedOldest: complete,
        newestSnapshotItemId: items.at(-1)?.id,
        itemsView: complete ? "full" : "summary",
      };
      const existing = resident.find((turn) => turn.turnId === turnId)?.itemsPagination;
      if (existing?.openingUserMessageId !== undefined) {
        pagination.oldestUserInput = existing.oldestUserInput
          ? [...existing.oldestUserInput]
          : existing.oldestUserInput;
        pagination.openingUserMessageId = existing.openingUserMessageId;
        pagination.openingUserMessageClientId = existing.openingUserMessageClientId;
      } else if (!complete) {
        try {
          const page = await readCanonicalHistoryItems(
            client,
            conversationId,
            turnId,
            null,
            options,
            2,
            "asc",
          );
          const first = page.items.find((item) => item.type !== "contextCompaction");
          if (first || (page.nextCursor === null && shell.status !== "inProgress")) {
            pagination.oldestUserInput = first?.type === "userMessage" ? first.content : [];
            pagination.openingUserMessageId = first?.type === "userMessage" ? first.id : null;
            pagination.openingUserMessageClientId =
              first?.type === "userMessage" ? first.clientId : null;
          }
        } catch {
          /* Opening input is optional; ordinary paging can retry its metadata later. */
        }
      }
      itemsPaginationByTurnId[turnId] = pagination;
      return { ...shell, items, itemsView: complete ? "full" : "summary" };
    }),
  );
  return {
    source: "timeline",
    timeline,
    response: { data: data.reverse(), nextCursor: timeline.nextCursor, backwardsCursor: null },
    itemsPaginationByTurnId,
    completedItemIdsByTurnId,
  };
}

function timelineIdentity(entry: CodexCanonicalTimelineEntry): string {
  if (entry.type === "item") return JSON.stringify([entry.type, entry.turnId, entry.item.id]);
  if (entry.type === "realtime") return `realtime:${entry.item.id}`;
  return `${entry.type}:${entry.turnId}`;
}

/** Voice presentation stores interleaved order without retaining a second copy of Turn payloads. */
export function applyCanonicalHistoryTimelineDraft(
  state: Draft<CodexCanonicalConversationState>,
  page: ThreadTimelineListResponse | undefined,
  mode: "replace" | "prepend",
): void {
  if (!page || !state.canonicalVoiceHistory) return;
  const entries: CodexCanonicalTimelineEntry[] = page.data.map((entry) =>
    entry.type === "item"
      ? { ...entry, item: { id: entry.item.id, type: entry.item.type, completed: true } }
      : entry,
  );
  const previous = state.itemTimeline;
  const oldIds = new Set(previous?.entries.map(timelineIdentity));
  const newIds = new Set(entries.map(timelineIdentity));
  const overlap = previous?.entries.findIndex((entry) => newIds.has(timelineIdentity(entry))) ?? -1;
  const prefix =
    mode === "replace" && page.nextCursor !== null && overlap >= 0
      ? previous!.entries.slice(0, overlap)
      : [];
  const live =
    mode === "replace"
      ? (previous?.entries.filter(
          (entry) =>
            entry.type === "realtime" &&
            state.realtimeItems?.[entry.item.id]?.completed === false &&
            !newIds.has(timelineIdentity(entry)),
        ) ?? [])
      : [];
  state.itemTimeline = {
    activeRealtimeSessionAtPageStart:
      prefix.length > 0
        ? (previous?.activeRealtimeSessionAtPageStart ?? null)
        : page.activeRealtimeSessionAtPageStart,
    entries: (mode === "prepend" && previous
      ? [...entries.filter((entry) => !oldIds.has(timelineIdentity(entry))), ...previous.entries]
      : [...prefix.filter((entry) => !live.includes(entry)), ...entries, ...live]) as Draft<
      CodexCanonicalTimelineEntry[]
    >,
  };
  if (mode === "replace") {
    const oldRealtime = state.realtimeItems;
    state.realtimeItems = Object.fromEntries(
      [...prefix, ...live].flatMap((entry) =>
        entry.type === "realtime" && oldRealtime?.[entry.item.id]
          ? [[entry.item.id, oldRealtime[entry.item.id]]]
          : [],
      ),
    );
  }
  const realtime = (state.realtimeItems ??= {});
  for (const entry of page.data)
    if (entry.type === "realtime" && (mode === "replace" || realtime[entry.item.id] === undefined))
      realtime[entry.item.id] = { item: entry.item, completed: true };
}
