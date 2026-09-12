import { codexTransportValue } from "@nodex/effect-codex-app-server/transport-values";
import type {
  CodexNativeRequestOutcome,
  CodexNativeResponseEnvelope,
} from "../../shared/codex-native-request-outcome";
import { codexNativeIpcMethod, type CodexNativeIpcChannel } from "../../shared/codex-native-ipc";
import type { IpcApi } from "../../shared/ipc-api";
import { codexRequestCanRetainOutcome } from "../../shared/codex-renderer-request";
import { defaultCodexRequestPriority } from "../codex-runtime/CodexRequestSchedulerPolicy";

const DROPPED_ORPHAN_RESPONSE_ID_PREFIXES = [
  "thread/list:",
  "thread/read:",
  "thread/resume:",
  "plugin/list:",
] as const;

const DETACHED_TIMEOUT_METHODS = new Set(["plugin/list", "thread/resume"]);

export function codexNativeResponseDropsOrphan(requestId: string): boolean {
  return DROPPED_ORPHAN_RESPONSE_ID_PREFIXES.some((prefix) => requestId.startsWith(prefix));
}

export function codexNativeRequestDetachesOnTimeout(method: string): boolean {
  return DETACHED_TIMEOUT_METHODS.has(method);
}

export type CodexNativeResponseRoute =
  | "direct"
  | "broadcast-fallback"
  | "broadcast-orphan"
  | "drop";

/** Logical abandonment may outlive a physical RPC; route its eventual reply without reviving the caller. */
export function codexNativeResponseRoute(input: {
  readonly requestId: string;
  readonly abandonmentReason?: "timeout" | "disposed";
  readonly senderDestroyed: boolean;
}): CodexNativeResponseRoute {
  if (input.abandonmentReason === "disposed") {
    return codexNativeResponseDropsOrphan(input.requestId) ? "drop" : "broadcast-orphan";
  }
  if (!input.senderDestroyed) return "direct";
  return codexNativeResponseDropsOrphan(input.requestId) ? "drop" : "broadcast-fallback";
}

/** Fallback broadcasts deliberately omit delivery-time and request-trace metadata. */
export function codexNativeUntracedResponseMessage(
  input: { readonly hostId: string; readonly caller: { readonly requestId: string } },
  outcome: CodexNativeRequestOutcome<unknown>,
): CodexNativeResponseEnvelope {
  const {
    abandonmentReason: _abandonmentReason,
    receivedAtMs: _receivedAtMs,
    requestMethod: _requestMethod,
    trace: _trace,
    ...bareOutcome
  } = outcome;
  return codexNativeResponseMessage(input, bareOutcome);
}

/** Preparation and admission failures have a definite delivery outcome before the transport write. */
export function codexNativePredispatchOutcome<T>(
  channel: CodexNativeIpcChannel,
  input: IpcApi[CodexNativeIpcChannel]["args"][0],
  outcome: CodexNativeRequestOutcome<T>,
  dispatched: boolean,
): CodexNativeRequestOutcome<T> {
  if (
    outcome.type !== "error" ||
    dispatched ||
    outcome.error.delivery ||
    !input.caller?.retainResponse
  )
    return outcome;
  const method = codexNativeIpcMethod(channel, input);
  if (!codexRequestCanRetainOutcome(method)) return outcome;
  return {
    ...outcome,
    error: {
      ...outcome.error,
      delivery: { requestId: input.caller.requestId, method, stage: "not-sent" },
    },
  };
}

export function codexNativeResponseIsCritical(
  channel: CodexNativeIpcChannel,
  input: IpcApi[CodexNativeIpcChannel]["args"][0],
): boolean {
  const method = codexNativeIpcMethod(channel, input);
  const priority = "scheduling" in input ? input.scheduling?.priority : undefined;
  return defaultCodexRequestPriority(method, priority) === "critical";
}

/** Window delivery recovers segmented values without serializing an internal decoded projection. */
export function codexNativeResponseMessage(
  input: { readonly hostId: string; readonly caller: { readonly requestId: string } },
  outcome: CodexNativeRequestOutcome<unknown>,
  metadata?: {
    readonly receivedAtMs?: number;
    readonly requestMethod?: string;
    readonly trace?: import("../../shared/codex-request-lifecycle").CodexRequestTraceContext | null;
  },
): CodexNativeResponseEnvelope {
  if (outcome.type === "error" && outcome.error.delivery) {
    return {
      type: "mcp-request-delivery",
      hostId: outcome.hostId ?? input.hostId,
      update: { type: "failed", delivery: outcome.error.delivery, message: outcome.error.message },
    };
  }
  return {
    type: "mcp-response",
    hostId: outcome.hostId ?? input.hostId,
    hostMetrics: outcome.hostMetrics,
    ...((metadata?.receivedAtMs ?? outcome.receivedAtMs) === undefined
      ? {}
      : { receivedAtMs: metadata?.receivedAtMs ?? outcome.receivedAtMs }),
    ...((metadata?.requestMethod ?? outcome.requestMethod) === undefined
      ? {}
      : { requestMethod: metadata?.requestMethod ?? outcome.requestMethod }),
    ...((metadata?.trace ?? outcome.trace) === undefined
      ? {}
      : { trace: metadata?.trace ?? outcome.trace }),
    message: {
      id: input.caller.requestId,
      ...(outcome.type === "result"
        ? { result: codexTransportValue(outcome.result) }
        : { error: outcome.error }),
    },
  };
}
