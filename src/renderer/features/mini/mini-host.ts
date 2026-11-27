import type { MobileParams, MobileResult, RpcError } from "@nodex/mobile-protocol";
import {
  defineRendererCommand,
  invokePlainCommand,
  invokeRendererControl,
} from "@/lib/renderer-command";
import {
  MINI_COMPANION_EVENT_CHANNEL,
  MINI_PRESENTATION_CHANNEL,
  type MiniCompanionEvent,
  type MiniCompanionMethod,
  type MiniCoverage,
  type MiniOpenTarget,
  type MiniPresentationEvent,
} from "../../../shared/mini";

const ignore = (): void => undefined;

/** A companion call the Host refused, with the reason it would give the phone. */
export class MiniCompanionError extends Error {
  readonly code: RpcError["code"];
  readonly retryable: boolean;
  constructor(error: RpcError) {
    super(error.message);
    this.name = "MiniCompanionError";
    this.code = error.code;
    this.retryable = error.retryable;
  }
}

export type { MiniCompanionEvent } from "../../../shared/mini";

/**
 * Mini's window, as Main presents it, and its companion session. Presentation requests are wishes
 * Main may already have overtaken, so they never fail the renderer; companion calls report what
 * the Host said.
 */
export const miniHost = {
  ready: () => void invokeRendererControl("mini:ready").catch(ignore),
  pointer: (overContent: boolean) =>
    void invokeRendererControl("mini:pointer", overContent).catch(ignore),
  activity: (coverage: MiniCoverage) =>
    void invokeRendererControl("mini:activity", coverage).catch(ignore),
  focus: () => void invokeRendererControl("mini:focus").catch(ignore),
  release: (generation: number) =>
    void invokeRendererControl("mini:release", generation).catch(ignore),
  open: (target: MiniOpenTarget) => void invokeRendererControl("mini:open", target).catch(ignore),
  onPresentation: (listener: (event: MiniPresentationEvent) => void): (() => void) =>
    window.api?.on(MINI_PRESENTATION_CHANNEL, (event) => {
      if (isPresentation(event)) listener(event);
    }) ?? ignore,
  onCompanionEvent: (listener: (event: MiniCompanionEvent) => void): (() => void) =>
    window.api?.on(MINI_COMPANION_EVENT_CHANNEL, (payload) => {
      if (isCompanionEvent(payload)) listener(payload);
    }) ?? ignore,
};

const companionCommand = defineRendererCommand({
  authority: "main",
  channel: "mini:companion:invoke",
  key: "mini.companion.invoke",
  owner: "mini-panel",
  protocol: { kind: "returned_value" },
});

/** One Member companion call, as the phone would make it; throws what the Host refused. */
export async function companion<Method extends MiniCompanionMethod>(
  method: Method,
  params: MobileParams<Method>,
): Promise<MobileResult<Method>> {
  const result = await invokePlainCommand(companionCommand, method, params);
  if (!result.ok) throw new MiniCompanionError(result.error);
  return result.value as MobileResult<Method>;
}

function isPresentation(value: unknown): value is MiniPresentationEvent {
  if (typeof value !== "object" || value === null) return false;
  const { kind, generation } = value as { kind?: unknown; generation?: unknown };
  return (
    typeof generation === "number" &&
    (kind === "focused" || kind === "resting" || kind === "hidden")
  );
}

function isCompanionEvent(value: unknown): value is MiniCompanionEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { event?: unknown }).event === "string" &&
    "data" in value
  );
}
