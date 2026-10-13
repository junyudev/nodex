import { deriveMcpAppSandboxIdentity } from "../../../shared/mcp-app/mcp-app-sandbox-contract";
import {
  defineRendererCommand,
  invokePlainCommand,
  invokeRendererControl,
  invokeRendererQuery,
} from "../renderer-command";
import { parseMcpAppFollowUpMessage } from "../mcp-app/mcp-app-follow-up";
import { readDocumentTheme } from "../use-document-theme";
import type { McpAppFollowUpHandler } from "../mcp-app/mcp-app-follow-up-context";
import type { McpAppFollowUpMessage } from "../mcp-app/mcp-app-follow-up";
import type { InlineVisualizationFollowUpHandler } from "./inline-visualization-follow-up-context";
import { sendInlineVisualizationFollowUp } from "./inline-visualization-follow-up";
import {
  createInlineVisualizationAnnotations,
  type InlineVisualizationAnnotations,
} from "./inline-visualization-annotations";
import {
  VISUALIZATION_ANNOTATION_TOOL,
  type VisualizationAnnotationCommand,
} from "../../../shared/codex-visualization-annotations";
import {
  parseCodexVisualizationInteractionState,
  codexVisualizationStateEntryKey,
} from "../../../shared/codex-visualization-state";
import type { InlineVisualizationAnnotationSubmitHandler } from "./inline-visualization-follow-up-context";
import type { InlineVisualizationVariant } from "./inline-visualization-presentation";
import { createVisualizationDownloadHandler } from "./inline-visualization-download";
import {
  inlineVisualizationContentBounds,
  inlineVisualizationContentWidth,
} from "./inline-visualization-presentation";
import { readInlineVisualizationStyleVariables } from "./inline-visualization-style-variables";
import {
  createInlineVisualizationStateUpdateHandler,
  type InlineVisualizationWidgetStateOwner,
} from "./inline-visualization-widget-state";
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
const copyImageCommand = defineRendererCommand({
  key: "inline_visualization.copy_image",
  channel: "codex:visualization:copy-image",
  authority: "external",
  owner: "InlineVisualizationRuntime",
  protocol: { kind: "pending_operation" },
});

export interface InlineVisualizationSnapshot {
  readonly status: "loading" | "ready" | "error";
  readonly height: number;
  readonly fullscreenHeight: number | null;
  readonly displayMode: "inline" | "fullscreen";
  readonly error: Error | null;
}

export interface InlineVisualizationRuntime {
  readonly element: HTMLElement;
  readonly getSnapshot: () => InlineVisualizationSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly setDisplayMode: (mode: "inline" | "fullscreen") => void;
  readonly captureImage: () => Promise<Uint8Array>;
  readonly copyAsImage: () => Promise<void>;
  readonly dispose: () => Promise<void>;
  readonly annotations: InlineVisualizationAnnotations;
  readonly setActive: (active: boolean) => void;
}

interface HostCallbacks {
  readonly ready: () => void;
  readonly fail: (value: unknown) => void;
  readonly height: (value: unknown) => void;
  readonly interact: () => void;
  readonly mode: (mode: "inline" | "fullscreen") => "inline" | "fullscreen";
  readonly openExternal: (href: string) => Promise<void>;
  readonly followUp?: McpAppFollowUpHandler;
  readonly download?: (value: unknown) => Promise<void>;
  readonly updateWidgetState?: McpAppHostApiHandlers["updateWidgetState"];
  readonly annotations?: (value: unknown) => unknown;
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
      if (name === VISUALIZATION_ANNOTATION_TOOL) {
        if (!callbacks.annotations) return deny();
        return callbacks.annotations(args);
      }
      if (name === "__codex_inline_visualization_download__") {
        if (!callbacks.download) return deny();
        return callbacks.download(args);
      }
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
    updateWidgetState: callbacks.updateWidgetState ?? (() => ({ ok: false, retryable: false })),
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

function visualizationUserAgent() {
  const platform = navigator.platform.toLowerCase();
  return {
    capabilities: {
      hover:
        window.matchMedia?.("(any-hover: hover)")?.matches ||
        window.matchMedia?.("(hover: hover)")?.matches ||
        false,
      touch:
        window.matchMedia?.("(any-pointer: coarse)")?.matches ||
        window.matchMedia?.("(pointer: coarse)")?.matches ||
        false,
    },
    device: {
      os: platform.includes("mac") ? "macos" : platform.includes("win") ? "windows" : "unknown",
      platform: "native",
      type: "desktop",
    },
  };
}

/** One retained guest stays mounted through inline/fullscreen changes and is disposed with its consumer. */
export function createInlineVisualizationRuntime(input: {
  readonly scopeId: string;
  readonly html: string;
  readonly initialHeight?: number;
  readonly active?: boolean;
  readonly onInlineHeight?: (height: number) => void;
  readonly widgetState?: InlineVisualizationWidgetStateOwner;
  readonly variant?: InlineVisualizationVariant;
  readonly allowInteractions?: boolean;
  readonly annotationsEnabled?: boolean;
  readonly onSubmitAnnotations?: InlineVisualizationAnnotationSubmitHandler;
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
  const widgetId = input.widgetState?.identity.path ?? crypto.randomUUID();
  const followUp = input.followUp;
  const allowAnnotations =
    input.allowInteractions !== false &&
    input.annotationsEnabled !== false &&
    input.variant !== "live";
  let active = input.active !== false;
  element.inert = !active;
  let actionController = new AbortController();
  if (!active) actionController.abort();
  let presentationRevision = 0;
  let annotationCommand: VisualizationAnnotationCommand | null = null;
  let environmentReady = false;
  let hasMeasurement = false;
  let connected: ConnectedMcpAppSandbox | null = null;
  let activeSandboxId: string | null = null;
  let snapshot: InlineVisualizationSnapshot = {
    status: "loading",
    height:
      parseInlineVisualizationHeight(input.initialHeight) ?? INLINE_VISUALIZATION_INITIAL_HEIGHT,
    fullscreenHeight: null,
    displayMode: "inline",
    error: null,
  };
  let disposePromise: Promise<void> | null = null;
  let styleSnapshot = readInlineVisualizationStyleVariables();
  let styleTheme = theme();
  const bodyStyleVariables = () =>
    JSON.stringify(
      Array.from(document.body.style)
        .filter((name) => name.startsWith("--"))
        .sort()
        .map((name) => [
          name,
          document.body.style.getPropertyValue(name),
          document.body.style.getPropertyPriority(name),
        ]),
    );
  let bodyStyleSnapshot = bodyStyleVariables();
  let contextWidth = inlineVisualizationContentWidth(element.clientWidth);
  const publish = (next: InlineVisualizationSnapshot) => {
    if (controller.signal.aborted) return;
    snapshot = next;
    annotations.setPresentation({
      active,
      preview: snapshot.displayMode === "fullscreen",
      ready: snapshot.status === "ready",
    });
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
      maxWidth: inlineVisualizationContentWidth(element.clientWidth),
    },
    deviceCapabilities: visualizationUserAgent().capabilities,
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
    contextWidth = inlineVisualizationContentWidth(element.clientWidth);
    await Promise.allSettled([
      connected.api.setTheme({ theme: theme() }),
      connected.api.setAdditionalGlobals({
        additionalGlobals: {
          displayMode: snapshot.displayMode,
          maxHeight: INLINE_VISUALIZATION_MAX_HEIGHT,
          maxWidth: inlineVisualizationContentWidth(element.clientWidth),
          visualizationTheme: theme(),
          visualizationStyleVariables: styleSnapshot,
          visualizationAnnotation: annotationCommand,
        },
      }),
      connected.api.notifyMcpAppsHostContext({ hostContext: context() }),
    ]);
  };
  const syncPresentation = async () => {
    const initId = connected?.initId;
    const sandboxId = activeSandboxId;
    if (!initId || !sandboxId || controller.signal.aborted) return;
    const revision = Math.max(1, presentationRevision);
    presentationRevision = revision;
    const accepted = await invokeRendererControl("codex:visualization:set-presentation", {
      sandboxId,
      initId,
      active,
      revision,
    });
    if (!accepted && !controller.signal.aborted && revision === presentationRevision)
      throw new Error("The response presentation is unavailable");
  };
  const setDisplayMode = (mode: "inline" | "fullscreen") => {
    const admittedMode =
      mode === "fullscreen" && (!active || !input.canExpand?.()) ? "inline" : mode;
    if (admittedMode !== snapshot.displayMode) publish({ ...snapshot, displayMode: admittedMode });
    void updateContext();
    return snapshot.displayMode;
  };
  const annotations = createInlineVisualizationAnnotations({
    allowed: allowAnnotations,
    globals: (command) => {
      annotationCommand = command;
      if (!connected || controller.signal.aborted) return;
      void connected.api
        .setAdditionalGlobals({ additionalGlobals: { visualizationAnnotation: command } })
        .catch(() => undefined);
    },
    ...(input.widgetState
      ? {
          persist: (context) => {
            const parsed = parseCodexVisualizationInteractionState({
              modelContent: context ?? null,
            });
            return parsed.ok
              ? input.widgetState!.writeInteraction(parsed.state)
              : Promise.resolve(parsed);
          },
        }
      : {}),
    ...(input.onSubmitAnnotations
      ? {
          submit: async (message) => {
            if (controller.signal.aborted || !active || snapshot.displayMode !== "inline")
              throw new Error("The interactive response has ended");
            await input.onSubmitAnnotations!({
              ...message,
              sourceId: input.widgetState
                ? codexVisualizationStateEntryKey(input.widgetState.identity)
                : input.scopeId,
            });
          },
        }
      : {}),
  });
  annotations.setPresentation({ active, preview: false, ready: false });
  const imageCaptureInput = () => {
    if (
      controller.signal.aborted ||
      !active ||
      snapshot.status !== "ready" ||
      !connected?.initId ||
      !activeSandboxId ||
      !element.isConnected
    )
      throw new Error("The response image is unavailable");
    const bounds = webview.getBoundingClientRect();
    const captureRect = inlineVisualizationContentBounds(bounds);
    if (!captureRect) throw new Error("The response image is empty");
    return {
      sandboxId: activeSandboxId,
      initId: connected.initId,
      captureRect,
      viewportSize: { width: bounds.width, height: bounds.height },
    };
  };
  const resize = new ResizeObserver(() => {
    if (controller.signal.aborted) return;
    const nextWidth = inlineVisualizationContentWidth(element.clientWidth);
    if (nextWidth === contextWidth) return;
    contextWidth = nextWidth;
    void updateContext();
  });
  resize.observe(element);
  const themeObserver = new MutationObserver((records) => {
    const nextTheme = theme();
    const nextBodyStyle = bodyStyleVariables();
    const bodyLayoutOnly =
      nextBodyStyle === bodyStyleSnapshot &&
      nextTheme === styleTheme &&
      records.every(
        ({ target, attributeName }) => target === document.body && attributeName === "style",
      );
    bodyStyleSnapshot = nextBodyStyle;
    // Native drag cursors and selection guards do not change the widget's custom properties.
    if (bodyLayoutOnly) return;
    const nextStyle = readInlineVisualizationStyleVariables();
    if (
      nextTheme === styleTheme &&
      Object.keys(nextStyle).length === Object.keys(styleSnapshot).length &&
      Object.entries(nextStyle).every(([name, value]) => styleSnapshot[name] === value)
    )
      return;
    styleTheme = nextTheme;
    styleSnapshot = nextStyle;
    void updateContext();
  });
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "data-theme", "style"],
  });
  themeObserver.observe(document.body, {
    attributes: true,
    attributeFilter: ["class", "style"],
  });
  const onFailure = () => fail(new Error("This response couldn’t load"));
  const failureEvents = ["crashed", "did-fail-load", "render-process-gone"];
  const configureGuest = () => {
    webview.setAttribute("title", "Interactive response");
    webview.setAttribute("tabindex", "0");
    webview.className = "flex h-full min-h-0 w-full border-0 bg-transparent";
    failureEvents.forEach((name) => webview.addEventListener(name, onFailure));
  };
  const releaseConnectedGuest = () =>
    activeSandboxId && connected?.initId
      ? invokeRendererControl("codex:visualization:release", {
          sandboxId: activeSandboxId,
          initId: connected.initId,
        }).catch(() => undefined)
      : Promise.resolve();
  configureGuest();
  const start = async (attempt = 0): Promise<void> => {
    const attemptController = new AbortController();
    const signal = AbortSignal.any([controller.signal, attemptController.signal]);
    const downloadCapability = crypto.randomUUID();
    if (attempt > 0) annotations.resetDocument();
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
      activeSandboxId = identity.sandboxId;
      webview.setAttribute("partition", identity.partition);
      element.append(webview);
      const handlers = fenceHostHandlers(
        createInlineVisualizationHostHandlers({
          annotations: annotations.handleMessage,
          download: (value) =>
            createVisualizationDownloadHandler({
              capability: downloadCapability,
              signal: AbortSignal.any([signal, actionController.signal]),
              consumeGesture: () =>
                invokeRendererControl("codex:visualization:consume-gesture", {
                  sandboxId: identity.sandboxId,
                  initId: connected?.initId,
                }),
            })(value),
          ready: () => {
            settleReady();
          },
          fail,
          height: (value) => {
            const height = parseInlineVisualizationHeight(value);
            if (height === null || !active) return;
            hasMeasurement = true;
            if (snapshot.displayMode === "fullscreen") {
              if (height !== snapshot.fullscreenHeight)
                publish({ ...snapshot, fullscreenHeight: height });
            } else {
              input.onInlineHeight?.(height);
              if (height !== snapshot.height) publish({ ...snapshot, height });
            }
            settleReady();
          },
          interact: input.onInteraction ?? (() => undefined),
          updateWidgetState: createInlineVisualizationStateUpdateHandler({
            owner: input.widgetState,
            widgetId,
            signal,
          }),
          mode: setDisplayMode,
          openExternal: async (href) => {
            if (!active) throw new Error("The interactive response is inactive");
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
                  signal: AbortSignal.any([signal, actionController.signal]),
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
      await syncPresentation();
      if (signal.aborted) return;
      await updateContext();
      const widgetState = (await input.widgetState?.read()) ?? null;
      if (signal.aborted) return;
      const generator = connected.api.runWidgetCode({
        csp: INLINE_VISUALIZATION_CSP,
        displayMode: "inline",
        features: [],
        hostHandlesFollowUpMessageAuthorization: true,
        html: buildInlineVisualizationDocument(input.html, {
          statePersistence: input.widgetState ? "host" : "none",
          downloadCapability,
          allowAnnotations,
          lockDocumentOverflow: input.variant === "live",
        }),
        isFirstParty: false,
        isSidebarOpen: false,
        isTombstone: false,
        maxHeight: INLINE_VISUALIZATION_MAX_HEIGHT,
        maxWidth: inlineVisualizationContentWidth(element.clientWidth),
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
        userAgent: visualizationUserAgent(),
        viewParams: null,
        widgetId,
        widgetState,
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
        failureEvents.forEach((name) => webview.removeEventListener(name, onFailure));
        webview.remove();
        const release = releaseConnectedGuest();
        connected = null;
        presentationRevision = 0;
        webview = document.createElement("webview");
        environmentReady = false;
        hasMeasurement = false;
        publish({
          ...snapshot,
          height: INLINE_VISUALIZATION_INITIAL_HEIGHT,
          fullscreenHeight: null,
          status: "loading",
          error: null,
        });
        configureGuest();
        await release;
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
    annotations,
    setActive: (value) => {
      if (controller.signal.aborted || active === value) return;
      active = value;
      presentationRevision += 1;
      actionController.abort();
      if (active) actionController = new AbortController();
      element.inert = !active;
      if (!active) setDisplayMode("inline");
      void syncPresentation().catch(fail);
      annotations.setPresentation({
        active,
        preview: snapshot.displayMode === "fullscreen",
        ready: snapshot.status === "ready",
      });
    },
    captureImage: async () => {
      const signal = actionController.signal;
      const image = await invokeRendererQuery(
        "codex:visualization:capture-image",
        imageCaptureInput(),
      );
      if (signal.aborted) throw new Error("The response presentation has ended");
      return image;
    },
    copyAsImage: async () => {
      const signal = actionController.signal;
      await invokePlainCommand(copyImageCommand, imageCaptureInput());
      if (signal.aborted) throw new Error("The response presentation has ended");
    },
    dispose: () => {
      disposePromise ??= (async () => {
        const teardown = connected?.api
          .requestMcpAppsResourceTeardown({ timeoutMs: 500 })
          .catch(() => undefined);
        controller.abort();
        actionController.abort();
        annotations.dispose();
        resize.disconnect();
        themeObserver.disconnect();
        failureEvents.forEach((name) => webview.removeEventListener(name, onFailure));
        connected?.dispose();
        // Detach the native guest before its ancestor; Main close is a fallback.
        webview.remove();
        element.remove();
        webview.removeAttribute("src");
        const release = releaseConnectedGuest();
        listeners.clear();
        // Teardown is best effort; it must never retain an interactive retired document.
        if (teardown) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([
            Promise.allSettled([teardown, release]),
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, 500);
            }),
          ]);
          if (timer) clearTimeout(timer);
          return;
        }
        await release;
      })();
      return disposePromise;
    },
  };
}
