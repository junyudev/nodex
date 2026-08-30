import { deriveMcpAppSandboxIdentity } from "../../../shared/mcp-app/mcp-app-sandbox-contract";
import {
  MCP_APP_MAX_HEIGHT,
  MCP_APP_MIN_HEIGHT,
  type McpRenderableResource,
} from "../../../shared/mcp-app/mcp-app-resource-contract";
import {
  createMcpAppScopeSnapshot,
  resolveMcpAppSandboxOriginScope,
} from "../../../shared/mcp-app/mcp-app-scope";
import type { ProtocolListMcpServerStatusResponse } from "../../../shared/types";
import { invokeRendererQuery as invoke } from "../renderer-command";
import { McpAppHostDispatcher } from "./mcp-app-host-dispatcher";
import type { McpAppFollowUpHandler } from "./mcp-app-follow-up-context";
import { connectMcpAppSandbox, type ConnectedMcpAppSandbox } from "./mcp-app-port-rpc";

type McpAppDisplayMode = "inline" | "side-panel" | "fullscreen";
export type McpAppRuntimeStatus = "error" | "loading" | "ready";

export interface McpAppRuntimeConfig {
  capabilityId: string;
  currentToolName: string;
  resource: McpRenderableResource;
  server: string;
  sendFollowUpMessage?: McpAppFollowUpHandler;
  statuses: ProtocolListMcpServerStatusResponse;
  threadId: string;
  toolInput: unknown;
  toolResult: unknown;
}

export interface McpAppRuntimeSnapshot {
  diagnostic: { code: string; value: unknown } | null;
  error: Error | null;
  requestedDisplayMode: "fullscreen" | "inline" | null;
  status: McpAppRuntimeStatus;
}

function resolveTheme(): "dark" | "light" {
  return getComputedStyle(document.documentElement).colorScheme === "dark" ? "dark" : "light";
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function resolveToolRuntimeData(toolInput: unknown, toolResult: unknown) {
  const result = asObject(toolResult);
  const content = Array.isArray(result?.content) ? result.content : [];
  const structuredContent = result?.structuredContent;
  let toolOutput = asObject(structuredContent);
  if (!toolOutput && content.length === 1) {
    const textBlock = asObject(content[0]);
    if (textBlock?.type === "text" && typeof textBlock.text === "string") {
      try {
        toolOutput = asObject(JSON.parse(textBlock.text));
      } catch {
        toolOutput = null;
      }
    }
  }
  const toolResponseMetadata = asObject(result?._meta);
  return {
    toolInput: asObject(toolInput),
    toolOutput,
    toolResponseMetadata,
    toolResult: {
      content,
      ...(structuredContent == null ? {} : { structuredContent }),
      ...(toolResponseMetadata === null ? {} : { _meta: toolResponseMetadata }),
    },
  };
}

function widgetUserAgent() {
  const platform = navigator.platform.toLowerCase();
  return {
    capabilities: {
      hover: window.matchMedia?.("(hover: hover)")?.matches ?? false,
      touch: window.matchMedia?.("(pointer: coarse)")?.matches ?? false,
    },
    device: {
      os: platform.includes("mac") ? "macos" : platform.includes("win") ? "windows" : "unknown",
      platform: "native",
      type: "desktop",
    },
  };
}

function clampHeight(value: unknown): number | null {
  const record =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  const rawHeight = record?.height ?? value;
  if (typeof rawHeight !== "number" || !Number.isFinite(rawHeight)) return null;
  return Math.min(Math.max(rawHeight, MCP_APP_MIN_HEIGHT), MCP_APP_MAX_HEIGHT);
}

function hostContext(element: HTMLElement, mode: McpAppDisplayMode) {
  const rect = element.getBoundingClientRect();
  return {
    availableDisplayModes: ["inline", "fullscreen"],
    containerDimensions: {
      height: rect.height,
      maxHeight: rect.height,
      maxWidth: rect.width,
      width: rect.width,
    },
    deviceCapabilities: widgetUserAgent().capabilities,
    displayMode: mode === "side-panel" ? "inline" : mode,
    locale: navigator.language,
    platform: "desktop",
    safeAreaInsets: { bottom: 0, left: 0, right: 0, top: 0 },
    styles: { variables: {} },
    theme: resolveTheme(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    userAgent: "nodex",
  };
}

function isEnvironmentReadyStatus(value: unknown): boolean {
  const status = asObject(value);
  return status?.type === "environment_status" && status.status === 2;
}

export class McpAppRuntime {
  readonly element: HTMLDivElement;
  readonly webview: HTMLElement;
  readonly #abortController = new AbortController();
  readonly #cleanupListeners: Array<() => void> = [];
  readonly #listeners = new Set<() => void>();
  #config: McpAppRuntimeConfig;
  #connected: ConnectedMcpAppSandbox | null = null;
  #displayMode: McpAppDisplayMode = "inline";
  #disposePromise: Promise<void> | null = null;
  #resizeAnimationFrame: number | null = null;
  #resizeObserver: ResizeObserver | null = null;
  #snapshot: McpAppRuntimeSnapshot = {
    diagnostic: null,
    error: null,
    requestedDisplayMode: null,
    status: "loading",
  };
  #themeObserver: MutationObserver | null = null;
  #widgetId = crypto.randomUUID();
  #widgetState: unknown = null;

  constructor(config: McpAppRuntimeConfig) {
    this.#config = config;
    this.element = document.createElement("div");
    this.element.dataset.mcpAppRuntime = config.capabilityId;
    Object.assign(this.element.style, {
      display: "flex",
      height: "100%",
      minHeight: "0",
      minWidth: "0",
      width: "100%",
    });
    this.webview = document.createElement("webview");
    this.webview.setAttribute("title", config.resource.uri);
    Object.assign(this.webview.style, {
      background: "transparent",
      border: "0",
      display: "flex",
      height: "100%",
      minHeight: "0",
      width: "100%",
    });
    const handleGuestFailure = (event: Event) => {
      if (this.#abortController.signal.aborted) return;
      this.#setSnapshot({
        ...this.#snapshot,
        diagnostic: { code: event.type, value: null },
        error: new Error("The MCP App sandbox stopped unexpectedly."),
        status: "error",
      });
    };
    for (const eventName of ["crashed", "did-fail-load", "render-process-gone"]) {
      this.webview.addEventListener(eventName, handleGuestFailure);
      this.#cleanupListeners.push(() => {
        this.webview.removeEventListener(eventName, handleGuestFailure);
      });
    }
    void this.#start();
  }

  getSnapshot(): McpAppRuntimeSnapshot {
    return this.#snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  setDisplayMode(mode: McpAppDisplayMode): void {
    this.#displayMode = mode;
    const connected = this.#connected;
    if (!connected) return;
    void connected.api
      .setWidgetView({
        displayMode: mode === "side-panel" ? "inline" : mode,
        isTombstone: false,
        viewParams: null,
        widgetId: this.#widgetId,
      })
      .catch(() => undefined);
    void connected.api
      .notifyMcpAppsHostContext({
        hostContext: hostContext(this.element, mode),
      })
      .catch(() => undefined);
  }

  update(config: McpAppRuntimeConfig): void {
    const inputChanged = config.toolInput !== this.#config.toolInput;
    const resultChanged = config.toolResult !== this.#config.toolResult;
    this.#config = config;
    if (!this.#connected || (!inputChanged && !resultChanged)) return;
    const data = resolveToolRuntimeData(config.toolInput, config.toolResult);

    if (inputChanged) {
      void this.#connected.api
        .notifyMcpAppsToolInput({
          arguments: data.toolInput,
        })
        .catch(() => undefined);
    }
    if (resultChanged) {
      void this.#connected.api.notifyMcpAppsToolResult(data.toolResult).catch(() => undefined);
    }
    void this.#connected.api
      .setWidgetData({
        toolInput: data.toolInput,
        toolOutput: data.toolOutput,
        toolResponseMetadata: data.toolResponseMetadata,
        widgetId: this.#widgetId,
        widgetState: this.#widgetState,
      })
      .catch(() => undefined);
  }

  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    this.#disposePromise = this.#dispose();
    return this.#disposePromise;
  }

  async #start(): Promise<void> {
    try {
      const identity = await deriveMcpAppSandboxIdentity({
        locale: navigator.language,
        originScope: resolveMcpAppSandboxOriginScope({
          currentToolName: this.#config.currentToolName,
          instanceFallbackId: this.#config.capabilityId,
          server: this.#config.server,
          statuses: this.#config.statuses,
        }),
        widgetDomain: this.#config.resource.metadata.domain,
      });
      if (this.#abortController.signal.aborted) return;
      this.webview.setAttribute("partition", identity.partition);
      this.element.append(this.webview);
      const scope = createMcpAppScopeSnapshot({
        currentToolName: this.#config.currentToolName,
        originResourceUri: this.#config.resource.uri,
        server: this.#config.server,
        statuses: this.#config.statuses,
        threadId: this.#config.threadId,
      });
      const dispatcher = new McpAppHostDispatcher({
        getScope: async () =>
          createMcpAppScopeSnapshot({
            currentToolName: this.#config.currentToolName,
            originResourceUri: this.#config.resource.uri,
            server: this.#config.server,
            statuses: await invoke("codex:mcp-server-statuses:list"),
            threadId: this.#config.threadId,
          }),
        scope,
        onBackgroundColor: (value) => {
          if (typeof value !== "string" || typeof CSS === "undefined") return;
          if (CSS.supports("color", value)) this.webview.style.backgroundColor = value;
        },
        onDisplayMode: (value) => {
          const record =
            typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
          const mode = record?.mode;
          if (mode !== "fullscreen" && mode !== "inline") return { mode: "inline" };
          this.#setSnapshot({
            ...this.#snapshot,
            requestedDisplayMode: mode,
          });
          return { mode };
        },
        onEnvironmentError: (value) => {
          this.#setSnapshot({
            ...this.#snapshot,
            diagnostic: { code: "environment-error", value },
            error: new Error("The MCP App reported a sandbox error."),
            status: "error",
          });
        },
        onIntrinsicHeight: (value) => {
          const height = clampHeight(value);
          if (height !== null && this.#displayMode === "inline") {
            this.element.style.height = `${height}px`;
          }
        },
        onNavigation: (value) => {
          this.#setSnapshot({
            ...this.#snapshot,
            diagnostic: { code: "navigation", value },
          });
        },
        onSecurityPolicyViolation: (value) => {
          this.#setSnapshot({
            ...this.#snapshot,
            diagnostic: { code: "security-policy-violation", value },
          });
        },
        onWidgetState: (value) => {
          this.#widgetState = value;
        },
        sendFollowUpMessage: this.#config.sendFollowUpMessage,
      });
      const connectedPromise = connectMcpAppSandbox({
        expectedOrigin: identity.origin,
        expectedSandboxId: identity.sandboxId,
        handlers: dispatcher.handlers(),
        onSkybridgeCacheState: (state) => {
          this.element.dataset.skybridgeCacheState = state;
        },
        signal: this.#abortController.signal,
        sourceUrl: identity.sourceUrl,
        webview: this.webview,
      });
      this.#connected = await connectedPromise;
      if (this.#abortController.signal.aborted) return;
      this.#startContextObservers();

      const theme = resolveTheme();
      const toolData = resolveToolRuntimeData(this.#config.toolInput, this.#config.toolResult);
      const generator = this.#connected.api.runWidgetCode({
        csp: this.#config.resource.metadata.csp,
        displayMode: "inline",
        features: ["fullscreen"],
        html: this.#config.resource.html,
        isFirstParty: false,
        isSidebarOpen: false,
        isTombstone: false,
        maxHeight: this.element.clientHeight,
        maxWidth: this.element.clientWidth,
        measureWidth: false,
        mcpApps: {
          forwardedRequestMethods: [],
          hostCapabilities: {
            logging: {},
            ...(this.#config.sendFollowUpMessage ? { message: {} } : {}),
            openLinks: {},
            serverResources: {},
            serverTools: {},
            sandbox: { csp: this.#config.resource.metadata.csp },
          },
          hostContext: hostContext(this.element, this.#displayMode),
          hostInfo: { name: "nodex", version: "1" },
        },
        safeArea: { insets: { bottom: 0, left: 0, right: 0, top: 0 } },
        theme,
        toolInput: toolData.toolInput,
        toolOutput: toolData.toolOutput,
        toolResponseMetadata: toolData.toolResponseMetadata,
        userAgent: widgetUserAgent(),
        viewParams: null,
        widgetId: this.#widgetId,
        widgetState: this.#widgetState,
      });
      for await (const status of generator) {
        if (this.#abortController.signal.aborted) break;
        if (!isEnvironmentReadyStatus(status)) continue;
        this.#setSnapshot({
          ...this.#snapshot,
          error: null,
          status: "ready",
        });
        await Promise.allSettled([
          this.#connected.api.setWidgetView({
            displayMode: "inline",
            isTombstone: false,
            viewParams: null,
            widgetId: this.#widgetId,
          }),
          this.#connected.api.setTheme({ theme }),
          this.#connected.api.setSafeArea({
            safeArea: { insets: { bottom: 0, left: 0, right: 0, top: 0 } },
          }),
          this.#connected.api.setAdditionalGlobals({
            additionalGlobals: {
              isSidebarOpen: false,
              maxHeight: this.element.clientHeight,
              maxWidth: this.element.clientWidth,
              surfaceBackgroundColor: null,
            },
          }),
          this.#connected.api.notifyMcpAppsHostContext({
            hostContext: hostContext(this.element, this.#displayMode),
          }),
        ]);
      }
    } catch (error) {
      if (this.#abortController.signal.aborted) return;
      this.#setSnapshot({
        ...this.#snapshot,
        error: error instanceof Error ? error : new Error(String(error)),
        status: "error",
      });
    }
  }

  async #dispose(): Promise<void> {
    this.#stopContextObservers();
    for (const cleanup of this.#cleanupListeners.splice(0)) cleanup();
    const connected = this.#connected;
    if (connected) {
      await connected.api.requestMcpAppsResourceTeardown({ timeoutMs: 500 }).catch(() => undefined);
    }
    this.#abortController.abort();
    connected?.dispose();
    this.webview.removeAttribute("src");
    this.element.remove();
    this.#listeners.clear();
  }

  #startContextObservers(): void {
    const notify = () => {
      const connected = this.#connected;
      if (!connected || this.#abortController.signal.aborted) return;
      void connected.api
        .notifyMcpAppsHostContext({
          hostContext: hostContext(this.element, this.#displayMode),
        })
        .catch(() => undefined);
    };
    if (typeof ResizeObserver === "function") {
      this.#resizeObserver = new ResizeObserver(() => {
        if (this.#resizeAnimationFrame !== null) return;
        this.#resizeAnimationFrame = requestAnimationFrame(() => {
          this.#resizeAnimationFrame = null;
          notify();
        });
      });
      this.#resizeObserver.observe(this.element);
    }
    if (typeof MutationObserver === "function") {
      this.#themeObserver = new MutationObserver(() => {
        const connected = this.#connected;
        if (!connected || this.#abortController.signal.aborted) return;
        const theme = resolveTheme();
        void connected.api.setTheme({ theme }).catch(() => undefined);
        notify();
      });
      this.#themeObserver.observe(document.documentElement, {
        attributeFilter: ["class", "data-theme"],
        attributes: true,
      });
    }
  }

  #stopContextObservers(): void {
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = null;
    this.#themeObserver?.disconnect();
    this.#themeObserver = null;
    if (this.#resizeAnimationFrame !== null) {
      cancelAnimationFrame(this.#resizeAnimationFrame);
      this.#resizeAnimationFrame = null;
    }
  }

  #setSnapshot(snapshot: McpAppRuntimeSnapshot): void {
    this.#snapshot = snapshot;
    for (const listener of this.#listeners) listener();
  }
}
