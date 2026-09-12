/** Caller identity and deadline survive queueing and host readiness. */
export interface CodexRendererRequestCaller {
  readonly requestId: string;
  readonly timeoutMs: number;
  readonly expiresAtMs: number | null;
  readonly retainResponse?: boolean;
}

export function codexRequestCanRetainOutcome(method: string): boolean {
  return (
    method === "thread/start" ||
    method === "thread/startAeon" ||
    method === "thread/fork" ||
    method === "thread/inject_items" ||
    method === "turn/start" ||
    method === "turn/steer"
  );
}

/** Main's direct request client terminally rejects an uncertain context injection. */
export function codexHostRequestCanRetainOutcome(method: string): boolean {
  return method !== "thread/inject_items" && codexRequestCanRetainOutcome(method);
}

export interface CodexRendererNativeRequestOptions {
  readonly priority?: "background" | "interactive" | "critical";
  readonly source?: string;
}

export interface CodexRendererNativeRequestInput {
  readonly hostId: string;
  readonly request: import("@nodex/codex-app-server-protocol").ClientRequest & {
    readonly trace?: import("./codex-request-lifecycle").CodexRequestTraceContext | null;
  };
  readonly caller: CodexRendererRequestCaller;
  readonly scheduling?: CodexRendererNativeRequestOptions;
}

export interface CodexRendererRequestAbandonment {
  readonly requestId: string;
  readonly reason: "timeout" | "disposed";
}
