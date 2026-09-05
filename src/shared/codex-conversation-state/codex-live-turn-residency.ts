import type { ServerNotification } from "@nodex/codex-app-server-protocol";
import type { ThreadItem, Turn } from "@nodex/codex-app-server-protocol/v2";
import type {
  CodexCanonicalConversationState,
  CodexCanonicalTurnState,
} from "./codex-conversation-state";

/** Five protected writable-tail Turns remain comfortably below the 16 MiB active budget. */
export const CODEX_LIVE_TURN_MAX_APPROXIMATE_BYTES = 2 * 1024 * 1024;
export const CODEX_LIVE_TURN_OVERFLOW_ITEM_ID = "nodex:live-turn-output-overflow";
const CODEX_LIVE_TURN_OVERFLOW_MESSAGE =
  "Live output exceeded the resident Turn limit. Additional output was omitted from memory; the persisted transcript remains authoritative.";

/**
 * Conservative JS-heap estimate that treats string length as O(1). It deliberately avoids
 * serializing an ever-growing streaming Turn on every frame; traversal stops as soon as the budget
 * is crossed.
 */
const approximateHeapBytes = (value: unknown, remaining: number, seen: WeakSet<object>): number => {
  if (remaining < 0) return 1;
  if (value === null || value === undefined) return 8;
  if (typeof value === "string") return 16 + value.length * 2;
  if (typeof value === "number" || typeof value === "boolean") return 8;
  if (typeof value !== "object") return 16;
  if (seen.has(value)) return 8;
  seen.add(value);

  if (Array.isArray(value)) {
    let bytes = 24 + value.length * 8;
    if (bytes > remaining) return bytes;
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) continue;
      bytes += approximateHeapBytes(value[index], remaining - bytes, seen);
      if (bytes > remaining) return bytes;
    }
    return bytes;
  }

  let bytes = 32;
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    bytes += 8 + key.length * 2;
    if (bytes > remaining) return bytes;
    bytes += approximateHeapBytes((value as Record<string, unknown>)[key], remaining - bytes, seen);
    if (bytes > remaining) return bytes;
  }
  return bytes;
};

export const approximateCodexLiveTurnBytes = (
  turn: unknown,
  limit = Number.MAX_SAFE_INTEGER,
): number => approximateHeapBytes(turn, limit, new WeakSet());

const exceedsCodexLiveTurnBudget = (value: unknown): boolean =>
  approximateHeapBytes(value, CODEX_LIVE_TURN_MAX_APPROXIMATE_BYTES, new WeakSet()) >
  CODEX_LIVE_TURN_MAX_APPROXIMATE_BYTES;

type CodexLifecycleItemStatus = "inProgress" | "completed" | "failed" | "declined" | "interrupted";

const lifecycleItemStatus = (value: unknown): CodexLifecycleItemStatus | null =>
  value === "inProgress" ||
  value === "completed" ||
  value === "failed" ||
  value === "declined" ||
  value === "interrupted"
    ? value
    : null;

/**
 * A valid agent-message item keeps the original occurrence identity while making overflow visible
 * to the canonical transcript. The optional status is deliberately retained as an extra field:
 * lifecycle reduction uses it to preserve terminal semantics for the original item type.
 */
const overflowLifecycleItem = (item: ThreadItem): ThreadItem => {
  const status = "status" in item ? lifecycleItemStatus(item.status) : null;
  const marker = {
    questions: null,
    type: "agentMessage" as const,
    id: item.id,
    text: CODEX_LIVE_TURN_OVERFLOW_MESSAGE,
    phase: null,
    memoryCitation: null,
    delivery: null,
  };
  return status === null ? marker : ({ ...marker, status } as ThreadItem);
};

const overflowLifecycleTurn = (turn: Turn): Turn => ({
  id: turn.id,
  items: [
    {
      questions: null,
      type: "agentMessage",
      id: CODEX_LIVE_TURN_OVERFLOW_ITEM_ID,
      text: CODEX_LIVE_TURN_OVERFLOW_MESSAGE,
      phase: null,
      memoryCitation: null,
      delivery: null,
    },
  ],
  itemsView: "summary",
  status: turn.status,
  error: null,
  startedAt: turn.startedAt,
  completedAt: turn.completedAt,
  durationMs: turn.durationMs,
});

/**
 * Sanitizes only lifecycle payloads before they can enter an ingress buffer or renderer queue.
 * This is intentionally earlier than canonical residency admission: a giant turn/item must never
 * first be materialized, copied, or forwarded just so a later projection can discard it.
 */
export const sanitizeCodexLiveLifecycleNotification = (
  notification: ServerNotification,
): ServerNotification => {
  if (notification.method === "turn/started" || notification.method === "turn/completed") {
    if (!exceedsCodexLiveTurnBudget(notification.params.turn)) return notification;
    return {
      ...notification,
      params: { ...notification.params, turn: overflowLifecycleTurn(notification.params.turn) },
    };
  }

  if (notification.method === "item/started" || notification.method === "item/completed") {
    if (!exceedsCodexLiveTurnBudget(notification.params.item)) return notification;
    return {
      ...notification,
      params: { ...notification.params, item: overflowLifecycleItem(notification.params.item) },
    } as ServerNotification;
  }

  return notification;
};

const boundedLiveTurnParams = (
  params: CodexCanonicalTurnState["sidecar"]["params"],
): CodexCanonicalTurnState["sidecar"]["params"] =>
  ({
    ...params,
    input: [],
    responsesapiClientMetadata: null,
    additionalContext: null,
    environments: [],
    cwd: typeof params.cwd === "string" ? params.cwd.slice(0, 4_096) : params.cwd,
    runtimeWorkspaceRoots: [],
    sandboxPolicy: { type: "readOnly", networkAccess: false },
    permissions: typeof params.permissions === "string" ? params.permissions.slice(0, 1_024) : null,
    model: typeof params.model === "string" ? params.model.slice(0, 1_024) : params.model,
    outputSchema: null,
    collaborationMode: null,
    multiAgentMode: null,
    attachments: [],
    commentAttachments: [],
  }) as CodexCanonicalTurnState["sidecar"]["params"];

const overflowTurn = (turn: CodexCanonicalTurnState): CodexCanonicalTurnState => ({
  protocol: { ...turn.protocol, error: null },
  items: [
    {
      questions: null,
      type: "agentMessage",
      id: CODEX_LIVE_TURN_OVERFLOW_ITEM_ID,
      text: CODEX_LIVE_TURN_OVERFLOW_MESSAGE,
      phase: null,
      memoryCitation: null,
      delivery: null,
    },
  ],
  sidecar: {
    params: boundedLiveTurnParams(turn.sidecar.params),
    diff: null,
    turnStartedAtMs: turn.sidecar.turnStartedAtMs,
    completedAtMs: turn.sidecar.completedAtMs ?? null,
    firstTurnWorkItemStartedAtMs: turn.sidecar.firstTurnWorkItemStartedAtMs ?? null,
    finalAssistantStartedAtMs: turn.sidecar.finalAssistantStartedAtMs,
    lifecycleStatusByItemId: {},
    commandExecutionStartedAtMsById: {},
    interruptedCommandExecutionItemIds: [],
    hookRuns: [],
  },
});

/**
 * Bounds only identity-changed Turns, so ordinary metadata updates and retained history pages are
 * untouched. Overflow is represented explicitly before canonical/snapshot/replica publication.
 */
export const boundChangedCodexLiveTurns = (
  before: CodexCanonicalConversationState,
  after: CodexCanonicalConversationState,
): CodexCanonicalConversationState => {
  const unchangedTurns = new Set(before.turns);
  let changed = false;
  const turns = after.turns.map((turn) => {
    if (unchangedTurns.has(turn)) return turn;
    if (
      approximateCodexLiveTurnBytes(turn, CODEX_LIVE_TURN_MAX_APPROXIMATE_BYTES) <=
      CODEX_LIVE_TURN_MAX_APPROXIMATE_BYTES
    ) {
      return turn;
    }
    changed = true;
    return overflowTurn(turn);
  });
  return changed ? { ...after, turns } : after;
};
