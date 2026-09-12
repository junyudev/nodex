import * as Context from "effect/Context";
import {
  createCodexAppServerReceiveMetrics,
  createCodexAppServerReceiveMetricsState,
  type CodexAppServerReceiveMetrics,
  type CodexAppServerReceiveMetricsState,
  type CodexAppServerRequestMetrics,
  type CodexAppServerRequestTrace,
} from "@nodex/effect-codex-app-server/protocol";

export interface CodexHostRequestMetricsState {
  readonly hostId: string;
  readonly receiveState: CodexAppServerReceiveMetricsState;
  readonly transportKind: "stdio" | "websocket";
  hostKind: string;
  reconnectAttempt: number;
  receiver: CodexAppServerReceiveMetrics;
}

export function makeCodexHostRequestMetrics(
  hostId: string,
  hostKind: string,
  transportKind: "stdio" | "websocket",
): CodexHostRequestMetricsState {
  const receiveState = createCodexAppServerReceiveMetricsState();
  return {
    hostId,
    hostKind,
    transportKind,
    reconnectAttempt: 0,
    receiveState,
    receiver: createCodexAppServerReceiveMetrics({ hostKind, transportKind, state: receiveState }),
  };
}

/** Endpoint acquisition supplies its persistent counters to each physical transport. */
export const CodexHostRequestMetrics = Context.Reference<CodexHostRequestMetricsState | null>(
  "nodex/main/codex-runtime/CodexHostRequestMetrics",
  { defaultValue: () => null },
);

/** The scheduler supplies the physical leader's trace only while executing that request. */
export const CodexScheduledRequestTrace = Context.Reference<CodexAppServerRequestTrace | null>(
  "nodex/main/codex-runtime/CodexScheduledRequestTrace",
  { defaultValue: () => null },
);

export interface CodexRendererResponseMetricsState {
  abandonmentReason?: "timeout" | "disposed";
  hostId?: string;
  hostMetrics?: CodexAppServerRequestMetrics;
  requestMethod?: string;
  responseReceivedAtMs?: number;
  wireTrace?: import("../../shared/codex-request-lifecycle").CodexRequestTraceContext | null;
}

/** One native window call retains its own metrics even when its physical request is coalesced. */
export const CodexRendererResponseMetrics =
  Context.Reference<CodexRendererResponseMetricsState | null>(
    "nodex/main/codex-runtime/CodexRendererResponseMetrics",
    { defaultValue: () => null },
  );
