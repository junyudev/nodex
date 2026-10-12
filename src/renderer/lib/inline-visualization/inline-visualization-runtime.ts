import { deriveMcpAppSandboxIdentity } from "../../../shared/mcp-app/mcp-app-sandbox-contract";
import {
  defineRendererCommand,
  invokePlainCommand,
  invokeRendererControl,
} from "../renderer-command";
import { parseMcpAppFollowUpMessage } from "../mcp-app/mcp-app-follow-up";
import { readDocumentTheme } from "../use-document-theme";
import type { McpAppFollowUpHandler } from "../mcp-app/mcp-app-follow-up-context";
import type { McpAppFollowUpMessage } from "../mcp-app/mcp-app-follow-up";
import type { InlineVisualizationFollowUpHandler } from "./inline-visualization-follow-up-context";
import { sendInlineVisualizationFollowUp } from "./inline-visualization-follow-up";
import {
  connectMcpAppSandbox,
  type ConnectedMcpAppSandbox,
  type McpAppHostApiHandlers,
} from "../mcp-app/mcp-app-port-rpc";
import {
  buildInlineVisualizationDocument,
  INLINE_VISUALIZATION_CSP,
  INLINE_VISUALIZATION_INITIAL_HEIGHT,
  INLINE_VISUALIZATION_MAX_HEIGHT,
  parseInlineVisualizationHeight,
} from "./inline-visualization-document";

const openExternalCommand = defineRendererCommand({
  key: "inline_visualization.open_external",
  channel: "codex:visualization:open-external",
  authority: "external",
  owner: "InlineVisualizationRuntime",
  protocol: { kind: "pending_operation" },
});

export interface InlineVisualizationSnapshot {
  readonly status: "loading" | "ready" | "error";
  readonly height: number;
  readonly displayMode: "inline" | "fullscreen";
  readonly error: Error | null;
}

export interface InlineVisualizationRuntime {
  readonly element: HTMLElement;
  readonly getSnapshot: () => InlineVisualizationSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly setDisplayMode: (mode: "inline" | "fullscreen") => void;
  readonly dispose: () => Promise<void>;
}

interface HostCallbacks {
  readonly ready: () => void;
  readonly fail: (value: unknown) => void;
  readonly height: (value: unknown) => void;
  readonly interact: () => void;
  readonly mode: (mode: "inline" | "fullscreen") => "inline" | "fullscreen";
  readonly openExternal: (href: string) => Promise<void>;
  readonly followUp?: McpAppFollowUpHandler;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** HTML widgets may report presentation state; they never acquire tool capabilities. */
export function createInlineVisualizationHostHandlers(
  callbacks: HostCallbacks,
): McpAppHostApiHandlers {
  let explicitHeight = false;
  const deny = () => {
    throw new Error("Inline visualizations cannot call tools");
  };
  return {
    callMcp: deny,
    callTool: (name, args) => {
      if (name === "__codex_inline_visualization_ready__") return callbacks.ready();
      if (name === "__codex_inline_visualization_error__") return callbacks.fail(args);
      if (name === "__codex_inline_visualization_height__") {
        if (
          typeof asRecord(args)?.width !== "number" ||
          parseInlineVisualizationHeight(args) === null
        )
          return deny();
        explicitHeight = true;
        return callbacks.height(args);
      }
      if (name === "__codex_inline_visualization_click__") {
        if (typeof asRecord(args)?.isInteractive !== "boolean") return deny();
        return callbacks.interact();
      }
      if (name === "__codex_inline_visualization_hover__") return undefined;
      if (name === "__codex_inline_visualization_preview_key__") {
        if (asRecord(args)?.key === "Escape") callbacks.mode("inline");
        return undefined;
      }
      return deny();
    },
    notifyBackgroundColor: () => undefined,
    notifyEnvironmentError: callbacks.fail,
    notifyIntrinsicHeight: (value) => {
      if (!explicitHeight && typeof value === "number") callbacks.height(value);
    },
    notifyIntrinsicWidth: () => undefined,
    notifyNavigation: () => undefined,
    notifySecurityPolicyViolation: () => undefined,
    openExternal: (value) => {
      const href = asRecord(value)?.href;
      if (typeof href !== "string") return deny();
      callbacks.interact();
      return callbacks.openExternal(href);
    },
    requestDisplayMode: (value) => {
      const mode = asRecord(value)?.mode;
      if (mode !== "inline" && mode !== "fullscreen") return { mode: "inline" };
      callbacks.interact();
      return { mode: callbacks.mode(mode) };
    },
    sendFollowUpMessage: (value) => {
      const message = parseMcpAppFollowUpMessage(value);
      if (!callbacks.followUp || !message) return deny();
      callbacks.interact();
      return callbacks.followUp(message);
    },
    sendInstrument: () => undefined,
    updateWidgetState: () => undefined,
  };
}

function fenceHostHandlers(
  handlers: McpAppHostApiHandlers,
  signal: AbortSignal,
): McpAppHostApiHandlers {
  return {
    ...handlers,
    ...Object.fromEntries(
      (Object.keys(handlers) as (keyof McpAppHostApiHandlers)[]).map((name) => [
        name,
        (...args: unknown[]) => {
          if (signal.aborted) throw new Error("The interactive response has ended");
          return handlers[name](...args);
        },
      ]),
    ),
  };
}

function theme() {
  return readDocumentTheme();
}

function styleVariables(): Record<string, string> {
  const style = getComputedStyle(document.documentElement);
  return {
    "--color-text-primary": style.getPropertyValue("--foreground").trim(),
    "--color-text-secondary": style.getPropertyValue("--foreground-secondary").trim(),
    "--color-background-primary": style.getPropertyValue("--background").trim(),
    "--color-border-primary": style.getPropertyValue("--border").trim(),
  };
}

/** One retained guest stays mounted through inline/fullscreen changes and is disposed with its consumer. */
export function createInlineVisualizationRuntime(input: {
  readonly scopeId: string;
  readonly html: string;
  readonly onInteraction?: () => void;
  readonly canExpand?: () => boolean;
  readonly followUp?: InlineVisualizationFollowUpHandler;
  readonly reviewFollowUp?: (
    message: McpAppFollowUpMessage,
    signal: AbortSignal,
  ) => Promise<string | null>;
}): InlineVisualizationRuntime {
  const element = document.createElement("div");
  element.className = "flex h-full min-h-0 w-full";
  let webview = document.createElement("webview");
  const controller = new AbortController();
  const listeners = new Set<() => void>();
  const widgetId = crypto.randomUUID();
  const followUp = input.followUp;
  let environmentReady = false;
  let hasMeasurement = false;
  let connected: ConnectedMcpAppSandbox | null = null;
  let snapshot: InlineVisualizationSnapshot = {
    status: "loading",
    height: INLINE_VISUALIZATION_INITIAL_HEIGHT,
    displayMode: "inline",
    error: null,
  };
  let disposePromise: Promise<void> | null = null;
  const publish = (next: InlineVisualizationSnapshot) => {
    if (controller.signal.aborted) return;
    snapshot = next;
    listeners.forEach((listener) => listener());
  };
  const fail = (value: unknown) => {
    const error =
      value instanceof Error
        ? value
        : new Error(String(asRecord(value)?.message ?? "This response couldn’t load"));
    publish({ ...snapshot, status: "error", error });
  };
  const settleReady = () => {
    if (snapshot.status === "error" || !environmentReady || !hasMeasurement) return;
    if (snapshot.status !== "ready") publish({ ...snapshot, status: "ready", error: null });
  };
  const context = () => ({
    availableDisplayModes: input.canExpand?.() ? ["inline", "fullscreen"] : ["inline"],
    containerDimensions: {
      maxHeight: INLINE_VISUALIZATION_MAX_HEIGHT,
      maxWidth: element.clientWidth,
    },
    displayMode: snapshot.displayMode,
    locale: navigator.language,
    platform: "desktop",
    safeAreaInsets: { bottom: 0, left: 0, right: 0, top: 0 },
    theme: theme(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    userAgent: "nodex",
  });
  const updateContext = async () => {
    if (!connected || controller.signal.aborted) return;
    await Promise.allSettled([
      connected.api.setTheme({ theme: theme() }),
      connected.api.setAdditionalGlobals({
        additionalGlobals: {
          displayMode: snapshot.displayMode,
          maxHeight: INLINE_VISUALIZATION_MAX_HEIGHT,
          maxWidth: element.clientWidth,
          visualizationTheme: theme(),
          visualizationStyleVariables: styleVariables(),
        },
      }),
      connected.api.notifyMcpAppsHostContext({ hostContext: context() }),
    ]);
  };
  const setDisplayMode = (mode: "inline" | "fullscreen") => {
    const admittedMode = mode === "fullscreen" && !input.canExpand?.() ? "inline" : mode;
    if (admittedMode !== snapshot.displayMode) publish({ ...snapshot, displayMode: admittedMode });
    void updateContext();
    return snapshot.displayMode;
  };
  const resize = new ResizeObserver(() => {
    void updateContext();
  });
  resize.observe(element);
  const themeObserver = new MutationObserver(() => {
    void updateContext();
  });
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "data-theme"],
  });
  const onFailure = () => fail(new Error("This response couldn’t load"));
  const failureEvents = ["crashed", "did-fail-load", "render-process-gone"];
  const configureGuest = () => {
    webview.setAttribute("title", "Interactive response");
    webview.setAttribute("tabindex", "0");
    webview.className = "flex h-full min-h-0 w-full border-0 bg-transparent";
    failureEvents.forEach((name) => webview.addEventListener(name, onFailure));
  };
  configureGuest();
  const start = async (attempt = 0): Promise<void> => {
    const attemptController = new AbortController();
    const signal = AbortSignal.any([controller.signal, attemptController.signal]);
    try {
      const identity = await deriveMcpAppSandboxIdentity({
        locale: navigator.language,
        originScope: {
          kind: "inline_visualization",
          scopeId: attempt === 0 ? input.scopeId : `${input.scopeId}:retry`,
        },
        widgetDomain: null,
      });
      if (signal.aborted) return;
      webview.setAttribute("partition", identity.partition);
      element.append(webview);
      const handlers = fenceHostHandlers(
        createInlineVisualizationHostHandlers({
          ready: () => {
            settleReady();
          },
          fail,
          height: (value) => {
            const height = parseInlineVisualizationHeight(value);
            if (height === null) return;
            hasMeasurement = true;
            if (snapshot.displayMode !== "fullscreen" && height !== snapshot.height)
              publish({ ...snapshot, height });
            settleReady();
          },
          interact: input.onInteraction ?? (() => undefined),
          mode: setDisplayMode,
          openExternal: async (href) => {
            await invokePlainCommand(openExternalCommand, {
              sandboxId: identity.sandboxId,
              initId: connected?.initId,
              href,
            });
          },
          followUp: followUp
            ? (message) =>
                sendInlineVisualizationFollowUp({
                  message,
                  sourceId: input.scopeId,
                  signal,
                  consumeGesture: () =>
                    invokeRendererControl("codex:visualization:consume-gesture", {
                      sandboxId: identity.sandboxId,
                      initId: connected?.initId,
                    }),
                  review: input.reviewFollowUp ?? (async () => null),
                  send: followUp,
                })
            : undefined,
        }),
        signal,
      );
      connected = await connectMcpAppSandbox({
        expectedOrigin: identity.origin,
        expectedSandboxId: identity.sandboxId,
        signal,
        sourceUrl: identity.sourceUrl,
        webview,
        handlers,
      });
      if (signal.aborted) {
        connected.dispose();
        return;
      }
      await updateContext();
      const generator = connected.api.runWidgetCode({
        csp: INLINE_VISUALIZATION_CSP,
        displayMode: "inline",
        features: [],
        hostHandlesFollowUpMessageAuthorization: true,
        html: buildInlineVisualizationDocument(input.html),
        isFirstParty: false,
        isSidebarOpen: false,
        isTombstone: false,
        maxHeight: INLINE_VISUALIZATION_MAX_HEIGHT,
        maxWidth: element.clientWidth,
        measureWidth: false,
        mcpApps: {
          hostCapabilities: {
            openLinks: {},
            ...(input.followUp ? { message: {} } : {}),
            sandbox: { csp: INLINE_VISUALIZATION_CSP },
          },
          hostContext: context(),
          hostInfo: { name: "nodex" },
        },
        safeArea: { insets: { bottom: 0, left: 0, right: 0, top: 0 } },
        theme: theme(),
        toolInput: null,
        toolOutput: null,
        toolResponseMetadata: null,
        viewParams: null,
        widgetId,
        widgetState: null,
      });
      for await (const status of generator) {
        if (signal.aborted) break;
        const record = asRecord(status);
        if (record?.type !== "environment_status" || record.status !== 2) continue;
        environmentReady = true;
        await updateContext();
        settleReady();
      }
    } catch (error) {
      if (signal.aborted) return;
      if (asRecord(error)?.name === "TimeoutError" && attempt === 0) {
        attemptController.abort();
        connected?.dispose();
        connected = null;
        failureEvents.forEach((name) => webview.removeEventListener(name, onFailure));
        webview.remove();
        webview = document.createElement("webview");
        environmentReady = false;
        hasMeasurement = false;
        publish({
          ...snapshot,
          height: INLINE_VISUALIZATION_INITIAL_HEIGHT,
          status: "loading",
          error: null,
        });
        configureGuest();
        await start(1);
        return;
      }
      fail(error);
    }
  };
  void start();
  return {
    element,
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setDisplayMode,
    dispose: () => {
      disposePromise ??= (async () => {
        controller.abort();
        resize.disconnect();
        themeObserver.disconnect();
        failureEvents.forEach((name) => webview.removeEventListener(name, onFailure));
        if (connected) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([
            connected.api.requestMcpAppsResourceTeardown({ timeoutMs: 500 }).catch(() => undefined),
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, 500);
            }),
          ]);
          if (timer) clearTimeout(timer);
        }
        connected?.dispose();
        webview.removeAttribute("src");
        element.remove();
        listeners.clear();
      })();
      return disposePromise;
    },
  };
}
