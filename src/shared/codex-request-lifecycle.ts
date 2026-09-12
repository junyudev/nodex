import type { RequestId } from "@nodex/codex-app-server-protocol";
import type { CodexAppServerRequestMetrics } from "@nodex/effect-codex-app-server/protocol";
import type { CodexRendererNativeRequestOptions } from "./codex-renderer-request";

/** W3C trace context carried by the renderer request lifecycle, distinct from transport metrics traces. */
export interface CodexRequestTraceContext {
  readonly traceparent?: string | null;
  readonly tracestate?: string | null;
}

export interface CodexRequestLifecycleTiming {
  readonly method: string;
  readonly priority: NonNullable<CodexRendererNativeRequestOptions["priority"]>;
  readonly source: string;
  readonly timeoutMs: number;
  readonly durationMs: number;
  readonly queueWaitMs: number;
  readonly requestDurationMs: number;
  readonly queuedRequestCountAtEnqueue: number;
  readonly peakInFlightRequestCount: number;
  readonly peakBackgroundInFlightRequestCount: number;
  readonly coalescedRequestCount: number;
  readonly trace?: CodexRequestTraceContext;
  readonly hostMetrics?: CodexAppServerRequestMetrics;
}

interface CodexRequestLifecycleIdentity {
  readonly hostId: string;
  readonly id: RequestId;
  readonly clientUserMessageId?: string;
}

export type CodexRequestLifecycleTerminalEvent = CodexRequestLifecycleIdentity &
  CodexRequestLifecycleTiming & { readonly endedAtMs: number } & (
    | { readonly type: "completed"; readonly result: unknown }
    | { readonly type: "failed" | "timed-out"; readonly error: unknown }
  );

/** A renderer-side rejection that completes before a physical request identity is allocated. */
export type CodexRequestLifecycleQueueFullEvent = CodexRequestLifecycleTiming & {
  readonly type: "background-queue-full";
  readonly hostId: string;
  readonly endedAtMs: number;
};

export type CodexRequestLifecyclePerformanceEvent =
  | CodexRequestLifecycleTerminalEvent
  | CodexRequestLifecycleQueueFullEvent;

export type CodexRequestLifecycleEvent =
  | (CodexRequestLifecycleIdentity & {
      readonly type: "started";
      readonly method: string;
      readonly params: unknown;
      readonly conversationId: string | null;
      readonly priority: CodexRequestLifecycleTiming["priority"];
      readonly source: string;
      readonly queueWaitMs: number;
      readonly startedAtMs: number;
      readonly timeoutMs: number;
    })
  | CodexRequestLifecyclePerformanceEvent
  | {
      readonly type: "late-response";
      readonly hostId: string;
      readonly id: RequestId;
      readonly hostMetrics: CodexAppServerRequestMetrics;
    };

/** Thread coordinates retain their wire spelling; they are not display labels. */
export function codexRequestConversationId(params: unknown): string | null {
  if (!params || typeof params !== "object") return null;
  const value = params as { threadId?: unknown; thread?: unknown; conversationId?: unknown };
  if (typeof value.threadId === "string") return value.threadId;
  if (value.thread && typeof value.thread === "object" && "id" in value.thread) {
    if (typeof value.thread.id === "string") return value.thread.id;
  }
  return typeof value.conversationId === "string" ? value.conversationId : null;
}
