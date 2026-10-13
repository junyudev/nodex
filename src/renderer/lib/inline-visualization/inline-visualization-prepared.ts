import {
  deriveMcpAppSandboxIdentity,
  parseMcpAppSandboxSourceUrl,
  type McpAppSandboxIdentity,
} from "../../../shared/mcp-app/mcp-app-sandbox-contract";
import { invokeRendererControl } from "../renderer-command";
import {
  connectMcpAppSandbox,
  type ConnectedMcpAppSandbox,
  type McpAppHostApiHandlers,
} from "../mcp-app/mcp-app-port-rpc";

export interface InlineVisualizationPreparedLease {
  readonly locale: string;
  readonly element: HTMLElement;
  readonly identity: Readonly<McpAppSandboxIdentity>;
  readonly isReady: boolean;
  readonly presentationRevision: number;
  readonly prepare: (container: HTMLElement) => Promise<void>;
  readonly activate: (input: {
    readonly handlers: McpAppHostApiHandlers;
    readonly signal: AbortSignal;
    readonly onSkybridgeCacheState?: (state: "cold" | "warming" | "warm") => void;
  }) => Promise<ConnectedMcpAppSandbox>;
  /** Revokes delegates and detaches the guest synchronously before awaiting native cleanup. */
  readonly dispose: () => Promise<void>;
}

/** A blank connection is a resource of the window owner, then of its one claiming Frame. */
export function createInlineVisualizationPreparedLease(
  locale: string,
  onDispose: (lease: InlineVisualizationPreparedLease) => void,
): InlineVisualizationPreparedLease {
  const element = document.createElement("webview");
  const controller = new AbortController();
  const scopeId = `standby:${crypto.randomUUID()}`;
  let identity: McpAppSandboxIdentity | null = null;
  let connected: ConnectedMcpAppSandbox | null = null;
  let handlers: McpAppHostApiHandlers | null = null;
  let consumerSignal: AbortSignal | null = null;
  let consumerCacheState: ((state: "cold" | "warming" | "warm") => void) | undefined;
  let cacheState: "cold" | "warming" | "warm" | undefined;
  let activated = false;
  let disposed = false;
  let prepared = false;
  let preparationStarted = false;
  let presentationRevision = 0;
  let disposePromise: Promise<void> | null = null;
  element.inert = true;
  element.setAttribute("tabindex", "-1");
  element.setAttribute("title", "Interactive response");
  element.setAttribute("data-inline-visualization-standby", "warming");

  const forward = (name: keyof McpAppHostApiHandlers, required: boolean, args: unknown[]) => {
    if (handlers) return handlers[name](...args);
    if (required) throw new Error("The prepared interactive response is inactive");
    return undefined;
  };
  const delegates: McpAppHostApiHandlers = {
    callMcp: (...args) => forward("callMcp", true, args),
    callTool: (...args) => forward("callTool", true, args),
    notifyBackgroundColor: (...args) => forward("notifyBackgroundColor", false, args),
    notifyEnvironmentError: (...args) => {
      if (handlers) return handlers.notifyEnvironmentError(...args);
      void dispose();
      return undefined;
    },
    notifyIntrinsicHeight: (...args) => forward("notifyIntrinsicHeight", false, args),
    notifyIntrinsicWidth: (...args) => forward("notifyIntrinsicWidth", false, args),
    notifyNavigation: (...args) => forward("notifyNavigation", false, args),
    notifySecurityPolicyViolation: (...args) =>
      forward("notifySecurityPolicyViolation", false, args),
    openExternal: (...args) => forward("openExternal", true, args),
    requestDisplayMode: (...args) => forward("requestDisplayMode", true, args),
    sendFollowUpMessage: (...args) => forward("sendFollowUpMessage", true, args),
    sendInstrument: (...args) => forward("sendInstrument", false, args),
    updateWidgetState: (...args) => forward("updateWidgetState", false, args),
  };
  const guestExited = () => {
    if (!activated) void dispose();
  };
  const exitEvents = ["render-process-gone", "destroyed"];
  exitEvents.forEach((name) => element.addEventListener(name, guestExited));

  const dispose = (): Promise<void> => {
    if (disposePromise) return disposePromise;
    if (disposed) return Promise.resolve();
    disposed = true;
    prepared = false;
    handlers = null;
    consumerSignal?.removeEventListener("abort", abortConsumer);
    consumerSignal = null;
    consumerCacheState = undefined;
    const api = connected;
    const initId =
      api?.initId ?? parseMcpAppSandboxSourceUrl(element.getAttribute("src") ?? "")?.initId;
    const releaseInput = identity && initId ? { sandboxId: identity.sandboxId, initId } : null;
    const teardown =
      activated && api
        ? api.api.requestMcpAppsResourceTeardown({ timeoutMs: 500 }).catch(() => undefined)
        : Promise.resolve();
    controller.abort();
    exitEvents.forEach((name) => element.removeEventListener(name, guestExited));
    api?.dispose();
    connected = null;
    // The native child must leave the DOM before a consumer removes its ancestor.
    element.remove();
    element.removeAttribute("src");
    const release = releaseInput
      ? invokeRendererControl("codex:visualization:release", releaseInput).catch(() => undefined)
      : Promise.resolve();
    onDispose(lease);
    disposePromise = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled([release, teardown]),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 500);
        }),
      ]);
      if (timer) clearTimeout(timer);
    })();
    return disposePromise;
  };
  const abortConsumer = () => {
    void dispose();
  };
  const lease: InlineVisualizationPreparedLease = {
    locale,
    element,
    get identity() {
      if (!identity) throw new Error("The prepared interactive response is unavailable");
      return identity;
    },
    get isReady() {
      return prepared && !disposed && !controller.signal.aborted;
    },
    get presentationRevision() {
      return presentationRevision;
    },
    prepare: async (container) => {
      if (disposed || preparationStarted)
        throw new Error("The prepared interactive response is unavailable");
      preparationStarted = true;
      identity = await deriveMcpAppSandboxIdentity({
        locale,
        originScope: { kind: "inline_visualization", scopeId },
        widgetDomain: null,
      });
      if (disposed) return;
      element.setAttribute("partition", identity.partition);
      const connection = connectMcpAppSandbox({
        expectedOrigin: identity.origin,
        expectedSandboxId: identity.sandboxId,
        handlers: delegates,
        onSkybridgeCacheState: (state) => {
          cacheState = state;
          consumerCacheState?.(state);
        },
        signal: controller.signal,
        sourceUrl: identity.sourceUrl,
        webview: element,
      });
      container.append(element);
      const value = await connection;
      if (disposed) {
        value.dispose();
        return;
      }
      connected = value;
      if (!value.initId)
        throw new Error("The prepared interactive response has no connection identity");
      const accepted = await invokeRendererControl("codex:visualization:set-presentation", {
        sandboxId: identity.sandboxId,
        initId: value.initId,
        active: false,
        revision: 1,
      });
      if (disposed) return;
      if (!accepted) throw new Error("The prepared interactive response is unavailable");
      presentationRevision = 1;
      prepared = true;
      element.setAttribute("data-inline-visualization-standby", "ready");
    },
    activate: async (input) => {
      if (activated || !lease.isReady || !connected)
        throw new Error("The prepared interactive response is unavailable");
      if (input.signal.aborted) {
        void dispose();
        input.signal.throwIfAborted();
      }
      activated = true;
      handlers = input.handlers;
      consumerSignal = input.signal;
      consumerCacheState = input.onSkybridgeCacheState;
      consumerSignal.addEventListener("abort", abortConsumer, { once: true });
      if (cacheState) input.onSkybridgeCacheState?.(cacheState);
      element.removeAttribute("data-inline-visualization-standby");
      return connected;
    },
    dispose,
  };
  return lease;
}
