import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { CodexRendererRequestCaller } from "../../shared/codex-renderer-request";
import type { CodexNativeDeliveryMessage } from "../../shared/codex-native-request-outcome";
import type { CodexRequestTraceContext } from "../../shared/codex-request-lifecycle";
import type { CodexRuntimeError } from "./CodexRuntimeError";

/** The invoking window receives delivery updates independently of the native response. */
export const CodexRendererDeliverySink = Context.Reference<
  ((message: CodexNativeDeliveryMessage) => Effect.Effect<void>) | null
>("nodex/main/codex-runtime/CodexRendererDeliverySink", { defaultValue: () => null });

export type CodexDetachedPhysicalResponse =
  | { readonly type: "result"; readonly result: unknown }
  | { readonly type: "error"; readonly error: CodexRuntimeError };

export interface CodexRendererDispatchStateValue {
  dispatched: boolean;
  detachOnTimeout?: boolean;
  isCoalescedFollower?: boolean;
  /** Physical work outlives a destroyed renderer; route its eventual orphan response independently. */
  onDetachedPhysicalResponse?: (response: CodexDetachedPhysicalResponse) => Effect.Effect<void>;
}

/** Only the matching physical request may invalidate a predispatch failure classification. */
export const CodexRendererDispatchState = Context.Reference<CodexRendererDispatchStateValue | null>(
  "nodex/main/codex-runtime/CodexRendererDispatchState",
  { defaultValue: () => null },
);

export interface CodexRendererNativeRequestOrigin extends CodexRendererRequestCaller {
  readonly destinationId?: string;
  readonly abandonment?: () => "timeout" | "disposed" | undefined;
  readonly method: string;
  readonly conversationId: string;
  readonly wireTrace?: CodexRequestTraceContext | null;
}

/** Ancillary application reads and descendant operations retain their own Main lifetimes. */
export const CodexRendererRequestOrigin =
  Context.Reference<CodexRendererNativeRequestOrigin | null>(
    "nodex/main/codex-runtime/CodexRendererRequestOrigin",
    { defaultValue: () => null },
  );

export function matchesRendererNativeRequest(
  origin: CodexRendererNativeRequestOrigin,
  method: string,
  params: unknown,
): boolean {
  if (origin.method !== method) return false;
  if (!origin.conversationId) return true;
  return (
    params !== null &&
    typeof params === "object" &&
    Reflect.get(params, "threadId") === origin.conversationId
  );
}
