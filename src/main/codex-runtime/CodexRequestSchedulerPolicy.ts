import { cappedApproximateValueBytes } from "../../shared/codex-bounded-value-size";

export const CODEX_REQUEST_SCHEDULER_LIMITS = {
  totalInFlight: 6,
  nonCriticalInFlight: 5,
  backgroundInFlight: 4,
  nonCriticalPerConversation: 4,
  nonCriticalPerConversationWidget: 3,
  backgroundMetadataInFlight: 3,
  backgroundThreadHydrationInFlight: 2,
  backgroundThreadCatalogInFlight: 1,
  queuedPerGroup: 20,
  queuedByPriority: {
    background: 128,
    critical: 16,
    interactive: 64,
  },
  coalescedWaiters: 128,
  interactiveDispatchesBeforeBackground: 4,
} as const;

/**
 * Byte limits complement the source-confirmed count limits. They bound the retained request
 * parameters even when a queue contains only a few unusually large requests. Runtime pressure
 * evidence can tune these values without changing the scheduling policy.
 */
export const CODEX_REQUEST_SCHEDULER_BYTE_LIMITS = {
  request: 16 * 1024 * 1024,
  hostQueue: 32 * 1024 * 1024,
  priorityQueue: 16 * 1024 * 1024,
  groupQueue: 8 * 1024 * 1024,
} as const;

export const CODEX_REQUEST_QUEUE_EXPIRY_MS = {
  background: 30_000,
  backgroundThreadHydration: 60_000,
} as const;

export type CodexRequestPriority = "background" | "critical" | "interactive";

export type CodexRequestBackgroundLane = "metadata" | "thread" | null;

export type CodexRequestSchedulingSource =
  | "collab_hydration"
  | "history_export"
  | "recent_threads"
  | "tail_history"
  | "thread_catalog"
  | "thread_hydration"
  | "thread_list"
  | (string & Record<never, never>);

const CRITICAL_METHODS = new Set<string>([
  "thread/approveGuardianDeniedAction",
  "thread/resume",
  "thread/start",
  "turn/interrupt",
  "turn/start",
  "turn/steer",
]);

const BACKGROUND_METADATA_METHODS = new Set<string>([
  "app/list",
  "collaborationMode/list",
  "config/read",
  "configRequirements/read",
  "experimentalFeature/list",
  "hooks/list",
  "mcpServerStatus/list",
  "model/list",
  "permissionProfile/list",
  "plugin/list",
  "skills/list",
]);

const COALESCIBLE_METHODS = new Set<string>([
  ...BACKGROUND_METADATA_METHODS,
  "thread/list",
  "thread/loaded/list",
  "thread/read",
  "thread/turns/list",
  // Exact tuple identity keeps cursor ownership isolated while avoiding duplicate physical reads.
  "thread/items/list",
]);

const THREAD_BACKGROUND_SOURCES = new Set<CodexRequestSchedulingSource>([
  "collab_hydration",
  "history_export",
  "recent_threads",
  "tail_history",
  "thread_catalog",
  "thread_hydration",
  "thread_list",
]);

const CATALOG_BACKGROUND_SOURCES = new Set<CodexRequestSchedulingSource>([
  "recent_threads",
  "thread_catalog",
  "thread_list",
]);

export interface CodexRequestSchedulingOptions {
  readonly priority?: CodexRequestPriority;
  readonly source?: CodexRequestSchedulingSource | null;
  readonly timeoutMs?: number | null;
  readonly expiresAtMs?: number | null;
}

export interface CodexScheduledRequestDescriptor {
  readonly requestId: string;
  readonly hostId: string;
  readonly generation: number;
  readonly method: string;
  readonly params: unknown;
  readonly priority: CodexRequestPriority;
  readonly source: CodexRequestSchedulingSource | null;
  readonly backgroundLane: CodexRequestBackgroundLane;
  readonly conversationId: string | null;
  readonly widgetId: string | null;
  readonly timeoutMs: number | null;
  readonly queuedBytes: number;
}

export interface CodexRequestDispatchCursor {
  readonly conversationId: string;
  readonly widgetIdsByConversation: ReadonlyMap<string, string | null>;
}

export interface CodexRequestSelectionState {
  readonly cursorByPriority: ReadonlyMap<CodexRequestPriority, CodexRequestDispatchCursor>;
  readonly interactiveDispatchesSinceBackground: number;
}

export interface CodexRequestSelection {
  readonly index: number;
  readonly request: CodexScheduledRequestDescriptor;
  readonly nextState: CodexRequestSelectionState;
}

export type CodexRequestAdmissionRejectionReason =
  | "invalid-request-bytes"
  | "request-too-large"
  | "host-queue-bytes-full"
  | "priority-queue-full"
  | "priority-queue-bytes-full"
  | "group-queue-full"
  | "group-queue-bytes-full";

export interface CodexRequestAdmissionRejection {
  readonly reason: CodexRequestAdmissionRejectionReason;
  readonly priority: CodexRequestPriority;
  readonly queuedCount: number;
  readonly queuedBytes: number;
  readonly limit: number;
  readonly groupKey: string | null;
}

export type CodexRequestAdmission =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly rejection: CodexRequestAdmissionRejection };

export type CodexCoalescedWaiterAdmission =
  | { readonly accepted: true }
  | {
      readonly accepted: false;
      readonly rejection: {
        readonly reason: "coalesced-queue-full";
        readonly waiterCount: number;
        readonly limit: number;
      };
    };

export const defaultCodexRequestPriority = (
  method: string,
  requested?: CodexRequestPriority,
): CodexRequestPriority => {
  if (requested !== undefined) return requested;
  if (CRITICAL_METHODS.has(method)) return "critical";
  if (BACKGROUND_METADATA_METHODS.has(method)) return "background";
  return "interactive";
};

export const codexRequestBackgroundLane = (
  priority: CodexRequestPriority,
  source: CodexRequestSchedulingSource | null,
): CodexRequestBackgroundLane => {
  if (priority !== "background") return null;
  return source !== null && THREAD_BACKGROUND_SOURCES.has(source) ? "thread" : "metadata";
};

export const codexRequestQueueExpiryMs = (input: {
  readonly priority: CodexRequestPriority;
  readonly source: CodexRequestSchedulingSource | null;
  readonly timeoutMs?: number | null;
  readonly expiresAtMs?: number | null;
  readonly nowMs: number;
}): number | null => {
  const backgroundDefault = (() => {
    if (input.priority !== "background") return null;
    if (
      input.source !== null &&
      THREAD_BACKGROUND_SOURCES.has(input.source) &&
      !CATALOG_BACKGROUND_SOURCES.has(input.source)
    ) {
      return CODEX_REQUEST_QUEUE_EXPIRY_MS.backgroundThreadHydration;
    }
    return CODEX_REQUEST_QUEUE_EXPIRY_MS.background;
  })();
  const explicit = (() => {
    if (input.expiresAtMs !== undefined && input.expiresAtMs !== null) {
      return Math.max(0, input.expiresAtMs - input.nowMs);
    }
    if (
      input.timeoutMs !== undefined &&
      input.timeoutMs !== null &&
      Number.isFinite(input.timeoutMs) &&
      input.timeoutMs >= 0
    ) {
      return input.timeoutMs;
    }
    return null;
  })();
  if (backgroundDefault === null) return explicit;
  if (explicit === null) return backgroundDefault;
  return Math.min(backgroundDefault, explicit);
};

export const isCodexRequestCoalescible = (method: string): boolean =>
  COALESCIBLE_METHODS.has(method);

const stableJson = (value: unknown): string | null => {
  const stack = new Set<object>();
  const normalize = (child: unknown, inArray: boolean): unknown => {
    if (child === null || typeof child === "string" || typeof child === "boolean") return child;
    if (typeof child === "number") return Number.isFinite(child) ? child : null;
    if (typeof child === "bigint") throw new TypeError("BigInt is not JSON serializable");
    if (typeof child === "undefined" || typeof child === "function" || typeof child === "symbol") {
      return inArray ? null : undefined;
    }
    if (typeof child !== "object") return child;
    if (stack.has(child)) throw new TypeError("Cyclic value is not JSON serializable");
    stack.add(child);
    try {
      if (Array.isArray(child)) return child.map((item) => normalize(item, true));
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(child).sort()) {
        const normalized = normalize((child as Record<string, unknown>)[key], false);
        if (normalized !== undefined) sorted[key] = normalized;
      }
      return sorted;
    } finally {
      stack.delete(child);
    }
  };
  try {
    return JSON.stringify(normalize(value, false)) ?? null;
  } catch {
    return null;
  }
};

const utf8Encoder = new TextEncoder();

/** Returns the deterministic JSON bytes retained by the scheduler, or null for non-JSON input. */
export const codexScheduledRequestBytes = (method: string, params: unknown): number | null => {
  const maximumBytes = CODEX_REQUEST_SCHEDULER_BYTE_LIMITS.request;
  if (cappedApproximateValueBytes({ method, params }, maximumBytes) > maximumBytes) {
    return maximumBytes + 1;
  }
  const encodedParams = stableJson(params);
  if (encodedParams === null) return null;
  return utf8Encoder.encode(`{"method":${JSON.stringify(method)},"params":${encodedParams}}`)
    .byteLength;
};

export const codexRequestCoalescingKey = (
  request: Pick<
    CodexScheduledRequestDescriptor,
    | "hostId"
    | "generation"
    | "method"
    | "params"
    | "priority"
    | "source"
    | "conversationId"
    | "widgetId"
    | "timeoutMs"
  >,
  options: { readonly coalesce?: boolean } = {},
): string | null => {
  if (options.coalesce === false || !isCodexRequestCoalescible(request.method)) return null;
  if (
    cappedApproximateValueBytes(
      { method: request.method, params: request.params },
      CODEX_REQUEST_SCHEDULER_BYTE_LIMITS.request,
    ) > CODEX_REQUEST_SCHEDULER_BYTE_LIMITS.request
  ) {
    return null;
  }
  const params = stableJson(request.params);
  if (params === null) return null;
  return JSON.stringify([
    request.hostId,
    request.generation,
    request.method,
    params,
    request.priority,
    request.source,
    request.conversationId,
    request.widgetId,
    request.timeoutMs ?? 0,
  ]);
};

const queueGroupKey = (
  request: Pick<CodexScheduledRequestDescriptor, "priority" | "conversationId" | "widgetId">,
): string => {
  if (request.widgetId !== null) {
    return `widget:${request.conversationId ?? ""}\0${request.widgetId}`;
  }
  if (request.conversationId !== null) return `conversation:${request.conversationId}`;
  return `global:${request.priority}`;
};

const rejection = (input: {
  readonly reason: CodexRequestAdmissionRejectionReason;
  readonly request: CodexScheduledRequestDescriptor;
  readonly queuedCount: number;
  readonly queuedBytes: number;
  readonly limit: number;
  readonly groupKey?: string | null;
}): CodexRequestAdmission => ({
  accepted: false,
  rejection: {
    reason: input.reason,
    priority: input.request.priority,
    queuedCount: input.queuedCount,
    queuedBytes: input.queuedBytes,
    limit: input.limit,
    groupKey: input.groupKey ?? null,
  },
});

export const admitCodexScheduledRequest = (input: {
  readonly request: CodexScheduledRequestDescriptor;
  readonly queued: readonly CodexScheduledRequestDescriptor[];
}): CodexRequestAdmission => {
  const { request, queued } = input;
  if (!Number.isSafeInteger(request.queuedBytes) || request.queuedBytes < 0) {
    return rejection({
      reason: "invalid-request-bytes",
      request,
      queuedCount: queued.length,
      queuedBytes: request.queuedBytes,
      limit: CODEX_REQUEST_SCHEDULER_BYTE_LIMITS.request,
    });
  }
  if (request.queuedBytes > CODEX_REQUEST_SCHEDULER_BYTE_LIMITS.request) {
    return rejection({
      reason: "request-too-large",
      request,
      queuedCount: queued.length,
      queuedBytes: request.queuedBytes,
      limit: CODEX_REQUEST_SCHEDULER_BYTE_LIMITS.request,
    });
  }

  const hostBytes = queued.reduce((total, item) => total + item.queuedBytes, 0);
  if (hostBytes + request.queuedBytes > CODEX_REQUEST_SCHEDULER_BYTE_LIMITS.hostQueue) {
    return rejection({
      reason: "host-queue-bytes-full",
      request,
      queuedCount: queued.length,
      queuedBytes: hostBytes,
      limit: CODEX_REQUEST_SCHEDULER_BYTE_LIMITS.hostQueue,
    });
  }

  const samePriority = queued.filter((item) => item.priority === request.priority);
  if (samePriority.length >= CODEX_REQUEST_SCHEDULER_LIMITS.queuedByPriority[request.priority]) {
    return rejection({
      reason: "priority-queue-full",
      request,
      queuedCount: samePriority.length,
      queuedBytes: samePriority.reduce((total, item) => total + item.queuedBytes, 0),
      limit: CODEX_REQUEST_SCHEDULER_LIMITS.queuedByPriority[request.priority],
    });
  }
  const priorityBytes = samePriority.reduce((total, item) => total + item.queuedBytes, 0);
  if (priorityBytes + request.queuedBytes > CODEX_REQUEST_SCHEDULER_BYTE_LIMITS.priorityQueue) {
    return rejection({
      reason: "priority-queue-bytes-full",
      request,
      queuedCount: samePriority.length,
      queuedBytes: priorityBytes,
      limit: CODEX_REQUEST_SCHEDULER_BYTE_LIMITS.priorityQueue,
    });
  }

  const groupKey = queueGroupKey(request);
  const sameGroup = queued.filter((item) => queueGroupKey(item) === groupKey);
  if (sameGroup.length >= CODEX_REQUEST_SCHEDULER_LIMITS.queuedPerGroup) {
    return rejection({
      reason: "group-queue-full",
      request,
      queuedCount: sameGroup.length,
      queuedBytes: sameGroup.reduce((total, item) => total + item.queuedBytes, 0),
      limit: CODEX_REQUEST_SCHEDULER_LIMITS.queuedPerGroup,
      groupKey,
    });
  }
  const groupBytes = sameGroup.reduce((total, item) => total + item.queuedBytes, 0);
  if (groupBytes + request.queuedBytes > CODEX_REQUEST_SCHEDULER_BYTE_LIMITS.groupQueue) {
    return rejection({
      reason: "group-queue-bytes-full",
      request,
      queuedCount: sameGroup.length,
      queuedBytes: groupBytes,
      limit: CODEX_REQUEST_SCHEDULER_BYTE_LIMITS.groupQueue,
      groupKey,
    });
  }
  return { accepted: true };
};

export const admitCodexCoalescedWaiter = (
  currentWaiterCount: number,
): CodexCoalescedWaiterAdmission => {
  if (currentWaiterCount < CODEX_REQUEST_SCHEDULER_LIMITS.coalescedWaiters) {
    return { accepted: true };
  }
  return {
    accepted: false,
    rejection: {
      reason: "coalesced-queue-full",
      waiterCount: currentWaiterCount,
      limit: CODEX_REQUEST_SCHEDULER_LIMITS.coalescedWaiters,
    },
  };
};

export const emptyCodexRequestSelectionState = (): CodexRequestSelectionState => ({
  cursorByPriority: new Map(),
  interactiveDispatchesSinceBackground: 0,
});

const nonCriticalConversationCounts = (
  inFlight: readonly CodexScheduledRequestDescriptor[],
  request: CodexScheduledRequestDescriptor,
): { readonly conversation: number; readonly widget: number } => {
  if (request.conversationId === null) return { conversation: 0, widget: 0 };
  let conversation = 0;
  let widget = 0;
  for (const active of inFlight) {
    if (active.priority === "critical" || active.conversationId !== request.conversationId)
      continue;
    conversation += 1;
    if (active.widgetId === request.widgetId) widget += 1;
  }
  return { conversation, widget };
};

const isEligibleNonCritical = (
  request: CodexScheduledRequestDescriptor,
  inFlight: readonly CodexScheduledRequestDescriptor[],
  laneCounts: { readonly metadata: number; readonly thread: number; readonly catalog: number },
): boolean => {
  const counts = nonCriticalConversationCounts(inFlight, request);
  if (counts.conversation >= CODEX_REQUEST_SCHEDULER_LIMITS.nonCriticalPerConversation) {
    return false;
  }
  if (counts.widget >= CODEX_REQUEST_SCHEDULER_LIMITS.nonCriticalPerConversationWidget) {
    return false;
  }
  if (request.priority !== "background") return true;
  if (
    request.source === "thread_catalog" &&
    laneCounts.catalog >= CODEX_REQUEST_SCHEDULER_LIMITS.backgroundThreadCatalogInFlight
  ) {
    return false;
  }
  if (request.backgroundLane === "metadata") {
    return laneCounts.metadata < CODEX_REQUEST_SCHEDULER_LIMITS.backgroundMetadataInFlight;
  }
  return laneCounts.thread < CODEX_REQUEST_SCHEDULER_LIMITS.backgroundThreadHydrationInFlight;
};

const nextIndexForPriority = (input: {
  readonly priority: "background" | "interactive";
  readonly queued: readonly CodexScheduledRequestDescriptor[];
  readonly inFlight: readonly CodexScheduledRequestDescriptor[];
  readonly state: CodexRequestSelectionState;
  readonly laneCounts: {
    readonly metadata: number;
    readonly thread: number;
    readonly catalog: number;
  };
}): number => {
  const eligible = input.queued.filter(
    (request) =>
      request.priority === input.priority &&
      isEligibleNonCritical(request, input.inFlight, input.laneCounts),
  );
  const withoutConversation = eligible.find((request) => request.conversationId === null);
  if (withoutConversation !== undefined) return input.queued.indexOf(withoutConversation);

  const conversationIds = [
    ...new Set(
      eligible.flatMap((request) =>
        request.conversationId === null ? [] : [request.conversationId],
      ),
    ),
  ];
  if (conversationIds.length === 0) return -1;
  const cursor = input.state.cursorByPriority.get(input.priority);
  const conversationId =
    conversationIds[
      ((cursor === undefined ? -1 : conversationIds.indexOf(cursor.conversationId)) + 1) %
        conversationIds.length
    ];
  if (conversationId === undefined) return -1;

  const widgetIds = [
    ...new Set(
      eligible.flatMap((request) =>
        request.conversationId === conversationId ? [request.widgetId] : [],
      ),
    ),
  ];
  const previousWidgetId = cursor?.widgetIdsByConversation.get(conversationId);
  const widgetId =
    widgetIds[
      ((previousWidgetId === undefined ? -1 : widgetIds.indexOf(previousWidgetId)) + 1) %
        widgetIds.length
    ];
  if (widgetId === undefined) return -1;
  const selected = eligible.find(
    (request) => request.conversationId === conversationId && request.widgetId === widgetId,
  );
  return selected === undefined ? -1 : input.queued.indexOf(selected);
};

const advanceSelectionState = (
  state: CodexRequestSelectionState,
  request: CodexScheduledRequestDescriptor,
): CodexRequestSelectionState => {
  const cursorByPriority = new Map(state.cursorByPriority);
  if (request.conversationId !== null) {
    const current = cursorByPriority.get(request.priority);
    const widgetIdsByConversation = new Map(current?.widgetIdsByConversation ?? []);
    widgetIdsByConversation.set(request.conversationId, request.widgetId);
    cursorByPriority.set(request.priority, {
      conversationId: request.conversationId,
      widgetIdsByConversation,
    });
  }
  return {
    cursorByPriority,
    interactiveDispatchesSinceBackground:
      request.priority === "background"
        ? 0
        : request.priority === "interactive"
          ? state.interactiveDispatchesSinceBackground + 1
          : state.interactiveDispatchesSinceBackground,
  };
};

export const selectNextCodexScheduledRequest = (input: {
  readonly queued: readonly CodexScheduledRequestDescriptor[];
  readonly inFlight: readonly CodexScheduledRequestDescriptor[];
  readonly state: CodexRequestSelectionState;
}): CodexRequestSelection | null => {
  if (input.inFlight.length >= CODEX_REQUEST_SCHEDULER_LIMITS.totalInFlight) return null;
  const criticalIndex = input.queued.findIndex((request) => request.priority === "critical");
  if (criticalIndex !== -1) {
    const request = input.queued[criticalIndex];
    if (request === undefined) return null;
    return {
      index: criticalIndex,
      request,
      nextState: advanceSelectionState(input.state, request),
    };
  }

  const nonCritical = input.inFlight.filter((request) => request.priority !== "critical");
  if (nonCritical.length >= CODEX_REQUEST_SCHEDULER_LIMITS.nonCriticalInFlight) return null;
  const laneCounts = {
    metadata: input.inFlight.filter((request) => request.backgroundLane === "metadata").length,
    thread: input.inFlight.filter((request) => request.backgroundLane === "thread").length,
    catalog: input.inFlight.filter((request) => request.source === "thread_catalog").length,
  };
  const interactiveIndex = nextIndexForPriority({
    priority: "interactive",
    ...input,
    laneCounts,
  });
  const backgroundIndex =
    input.inFlight.filter((request) => request.priority === "background").length <
    CODEX_REQUEST_SCHEDULER_LIMITS.backgroundInFlight
      ? nextIndexForPriority({ priority: "background", ...input, laneCounts })
      : -1;
  const index =
    backgroundIndex !== -1 &&
    (interactiveIndex === -1 ||
      input.state.interactiveDispatchesSinceBackground >=
        CODEX_REQUEST_SCHEDULER_LIMITS.interactiveDispatchesBeforeBackground)
      ? backgroundIndex
      : interactiveIndex;
  if (index === -1) return null;
  const request = input.queued[index];
  if (request === undefined) return null;
  return { index, request, nextState: advanceSelectionState(input.state, request) };
};
