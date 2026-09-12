import type { CodexRequestTraceContext } from "../../shared/codex-request-lifecycle";
import { runMainTraceSpan, type MainTraceSpanOptions } from "../observability/sentry-main";

const TRACE_TTL_MS = 60_000;
const STREAMING_WINDOW_MS = 15_000;

type StreamingWindowEnd = "window" | "completed" | "cleanup";

interface RequestTraceEntry {
  expiresAtMs: number;
  kind: "discovery" | "resume" | "turn";
  notificationCount: number;
  notificationMethods: Set<string>;
  requestId: string;
  requestSettled: boolean;
  seenMethods: Set<string>;
  trace: CodexRequestTraceContext;
  firstNotificationAtMs?: number;
}

interface PendingThreadStart {
  readonly expiresAtMs: number;
  readonly trace: CodexRequestTraceContext;
  readonly webContentsId: number;
}

export interface CodexRequestTraceTrackInput {
  readonly method: string;
  readonly requestId: string;
  readonly threadId?: string | null;
  readonly trace?: CodexRequestTraceContext | null;
  readonly webContentsId: number;
}

export interface CodexNotificationTraceRecipient {
  readonly link: boolean;
  readonly trace: CodexRequestTraceContext;
}

export interface CodexNotificationTraceDelivery {
  readonly method: string;
  readonly receivedAtMs: number;
  readonly recipients: ReadonlyMap<number, CodexNotificationTraceRecipient>;
}

export interface CodexRequestTraceCoordinatorService {
  readonly trackRequest: (input: CodexRequestTraceTrackInput) => void;
  readonly settleRequest: (
    threadId: string | null | undefined,
    webContentsId: number | null | undefined,
    requestId: string,
    success: boolean,
  ) => void;
  readonly takeNotificationDelivery: (
    threadId: string | null | undefined,
    method: string,
    receivedAtMs: number,
  ) => CodexNotificationTraceDelivery | undefined;
  readonly dropWindow: (webContentsId: number) => void;
  readonly clear: () => void;
}

export interface CodexRequestTraceCoordinatorOptions {
  readonly now?: () => number;
  readonly runSpan?: <A>(
    options: MainTraceSpanOptions,
    callback: (trace: CodexRequestTraceContext | null) => A,
  ) => A;
}

export function makeCodexRequestTraceCoordinator(
  options: CodexRequestTraceCoordinatorOptions = {},
): CodexRequestTraceCoordinatorService {
  const now = options.now ?? Date.now;
  const runSpan = options.runSpan ?? runMainTraceSpan;
  const appListTracesByWebContentsId = new Map<number, RequestTraceEntry>();
  const tracesByThreadId = new Map<string, Map<number, RequestTraceEntry>>();
  const pendingThreadStarts = new Map<string, PendingThreadStart>();

  const closeStreamingWindow = (
    entry: RequestTraceEntry | undefined,
    endAtMs: number,
    reason: StreamingWindowEnd,
  ): void => {
    const startAtMs = entry?.firstNotificationAtMs;
    if (!entry || startAtMs === undefined) return;
    runSpan(
      {
        name: "app_server.streaming_window",
        op: "codex.app_server.streaming_window",
        trace: entry.trace,
        startTimeMs: startAtMs,
        endTimeMs: Math.max(startAtMs, Math.min(endAtMs, startAtMs + STREAMING_WINDOW_MS)),
        attributes: {
          "app_server.distinct_notification_method_count": entry.notificationMethods.size,
          "app_server.notification_count": entry.notificationCount,
          "app_server.streaming_window_end": reason,
        },
      },
      () => undefined,
    );
    entry.firstNotificationAtMs = undefined;
    entry.notificationCount = 0;
    entry.notificationMethods.clear();
  };

  const closeThreadTraces = (
    traces: Map<number, RequestTraceEntry> | undefined,
    endAtMs: number,
    reason: StreamingWindowEnd,
  ): void => {
    for (const entry of traces?.values() ?? []) closeStreamingWindow(entry, endAtMs, reason);
  };

  const trackRequest: CodexRequestTraceCoordinatorService["trackRequest"] = ({
    method,
    requestId,
    threadId,
    trace,
    webContentsId,
  }) => {
    const timestamp = now();
    for (const [id, entry] of pendingThreadStarts)
      if (entry.expiresAtMs <= timestamp) pendingThreadStarts.delete(id);
    for (const [id, entry] of appListTracesByWebContentsId)
      if (entry.expiresAtMs <= timestamp) appListTracesByWebContentsId.delete(id);

    if (method === "app/list" && trace) {
      appListTracesByWebContentsId.set(webContentsId, {
        expiresAtMs: timestamp + TRACE_TTL_MS,
        kind: "discovery",
        notificationCount: 0,
        notificationMethods: new Set(),
        requestId,
        requestSettled: false,
        seenMethods: new Set(),
        trace,
      });
      return;
    }
    if ((method === "thread/start" || method === "thread/fork") && trace) {
      pendingThreadStarts.set(requestId, {
        expiresAtMs: timestamp + TRACE_TTL_MS,
        trace,
        webContentsId,
      });
      return;
    }
    if (!threadId) return;
    if (method === "thread/delete") {
      closeThreadTraces(tracesByThreadId.get(threadId), timestamp, "cleanup");
      tracesByThreadId.delete(threadId);
      return;
    }
    if (method === "thread/unsubscribe") {
      const traces = tracesByThreadId.get(threadId);
      closeStreamingWindow(traces?.get(webContentsId), timestamp, "cleanup");
      traces?.delete(webContentsId);
      if (traces?.size === 0) tracesByThreadId.delete(threadId);
      return;
    }
    if (!trace || (method !== "thread/resume" && method !== "turn/start")) return;

    for (const [trackedThreadId, traces] of tracesByThreadId) {
      for (const [trackedWebContentsId, entry] of traces) {
        if (entry.expiresAtMs > timestamp) continue;
        closeStreamingWindow(entry, timestamp, "cleanup");
        traces.delete(trackedWebContentsId);
      }
      if (traces.size === 0) tracesByThreadId.delete(trackedThreadId);
    }

    let traces = tracesByThreadId.get(threadId);
    if (!traces) {
      traces = new Map();
      tracesByThreadId.set(threadId, traces);
    }
    closeStreamingWindow(traces.get(webContentsId), timestamp, "cleanup");
    traces.set(webContentsId, {
      expiresAtMs: timestamp + TRACE_TTL_MS,
      kind: method === "thread/resume" ? "resume" : "turn",
      notificationCount: 0,
      notificationMethods: new Set(),
      requestId,
      requestSettled: false,
      seenMethods: new Set(),
      trace,
    });
  };

  const settleRequest: CodexRequestTraceCoordinatorService["settleRequest"] = (
    threadId,
    webContentsId,
    requestId,
    success,
  ) => {
    const discovery =
      webContentsId === null || webContentsId === undefined
        ? undefined
        : appListTracesByWebContentsId.get(webContentsId);
    if (discovery?.requestId === requestId) {
      if (success) {
        discovery.requestSettled = true;
        discovery.seenMethods.clear();
      } else {
        appListTracesByWebContentsId.delete(webContentsId!);
      }
    }

    const pending = pendingThreadStarts.get(requestId);
    pendingThreadStarts.delete(requestId);
    if (
      success &&
      threadId &&
      pending &&
      tracesByThreadId.get(threadId)?.get(pending.webContentsId)?.requestId !== requestId
    ) {
      trackRequest({
        method: "turn/start",
        requestId,
        threadId,
        trace: pending.trace,
        webContentsId: pending.webContentsId,
      });
    }
    if (!threadId || webContentsId === null || webContentsId === undefined) return;
    const traces = tracesByThreadId.get(threadId);
    const entry = traces?.get(webContentsId);
    if (!traces || entry?.requestId !== requestId) return;
    if (success) {
      entry.requestSettled = true;
      return;
    }
    closeStreamingWindow(entry, now(), "cleanup");
    traces.delete(webContentsId);
    if (traces.size === 0) tracesByThreadId.delete(threadId);
  };

  const takeNotificationDelivery: CodexRequestTraceCoordinatorService["takeNotificationDelivery"] =
    (threadId, method, receivedAtMs) => {
      if (method === "app/list/updated") {
        const recipients = new Map<number, CodexNotificationTraceRecipient>();
        const timestamp = now();
        for (const [webContentsId, entry] of appListTracesByWebContentsId) {
          if (entry.expiresAtMs <= timestamp) {
            appListTracesByWebContentsId.delete(webContentsId);
            continue;
          }
          if (entry.seenMethods.has(method)) continue;
          entry.seenMethods.add(method);
          recipients.set(webContentsId, { link: entry.requestSettled, trace: entry.trace });
        }
        return recipients.size === 0 ? undefined : { method, receivedAtMs, recipients };
      }
      if (!threadId) return undefined;
      if (method === "thread/started" && pendingThreadStarts.size === 1) {
        const [requestId, pending] = Array.from(pendingThreadStarts)[0]!;
        if (pending.expiresAtMs > now()) {
          trackRequest({
            method: "turn/start",
            requestId,
            threadId,
            trace: pending.trace,
            webContentsId: pending.webContentsId,
          });
        }
      }

      const traces = tracesByThreadId.get(threadId);
      const recipients = new Map<number, CodexNotificationTraceRecipient>();
      const timestamp = now();
      for (const [webContentsId, entry] of traces ?? []) {
        if (entry.expiresAtMs <= timestamp) {
          closeStreamingWindow(entry, timestamp, "cleanup");
          traces?.delete(webContentsId);
          continue;
        }
        if (entry.kind === "turn") {
          entry.expiresAtMs = timestamp + TRACE_TTL_MS;
          if (
            entry.firstNotificationAtMs !== undefined &&
            receivedAtMs - entry.firstNotificationAtMs >= STREAMING_WINDOW_MS
          )
            closeStreamingWindow(entry, receivedAtMs, "window");
          entry.firstNotificationAtMs ??= receivedAtMs;
          entry.notificationCount += 1;
          entry.notificationMethods.add(method);
        }
        if (!entry.seenMethods.has(method)) {
          entry.seenMethods.add(method);
          recipients.set(webContentsId, { link: entry.requestSettled, trace: entry.trace });
        }
        if (method === "turn/completed" && entry.kind === "turn") {
          closeStreamingWindow(entry, receivedAtMs, "completed");
          traces?.delete(webContentsId);
        }
      }
      if (traces?.size === 0 || method === "thread/deleted" || method === "thread/archived") {
        closeThreadTraces(traces, receivedAtMs, "cleanup");
        tracesByThreadId.delete(threadId);
      }
      return recipients.size === 0 ? undefined : { method, receivedAtMs, recipients };
    };

  const clear = (): void => {
    const timestamp = now();
    for (const traces of tracesByThreadId.values()) closeThreadTraces(traces, timestamp, "cleanup");
    appListTracesByWebContentsId.clear();
    tracesByThreadId.clear();
    pendingThreadStarts.clear();
  };

  const dropWindow = (webContentsId: number): void => {
    appListTracesByWebContentsId.delete(webContentsId);
    const timestamp = now();
    for (const [threadId, traces] of tracesByThreadId) {
      closeStreamingWindow(traces.get(webContentsId), timestamp, "cleanup");
      traces.delete(webContentsId);
      if (traces.size === 0) tracesByThreadId.delete(threadId);
    }
    for (const [requestId, pending] of pendingThreadStarts)
      if (pending.webContentsId === webContentsId) pendingThreadStarts.delete(requestId);
  };

  return { trackRequest, settleRequest, takeNotificationDelivery, dropWindow, clear };
}

/** Process-scoped transport trace state shared by the physical request and renderer projection paths. */
export const codexRequestTraceCoordinator = makeCodexRequestTraceCoordinator();
