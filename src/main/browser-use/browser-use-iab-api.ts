import { randomUUID } from "node:crypto";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import { z } from "zod";
import {
  type BrowserSidebarTabIdentity,
  type BrowserSidebarTabSnapshot,
  type BrowserSidebarCommand,
  type BrowserSidebarCommandResult,
  type BrowserSidebarViewport,
  type BrowserUseTabState,
} from "../../shared/browser-sidebar";
import { isAllowedBrowserNavigationUrl } from "../../shared/browser-url";
import type { BrowserAutomationHost } from "../browser-application/BrowserApplication";
import type { BrowserWebContentsLike } from "../platform/electron/BrowserElectronPlatform";
import {
  buildBrowserUseInputTranslationScript,
  isSupportedBrowserUseInputMethod,
  type BrowserUseInputTranslationResult,
} from "./browser-use-input-translation";
import type { BrowserUsePolicyReader } from "./browser-use-policy-store";

const DEFAULT_CDP_COMMAND_TIMEOUT_MS = 20_000;
const DEFAULT_PAGE_READY_TIMEOUT_MS = 15_000;
const DEFAULT_CURSOR_ARRIVAL_TIMEOUT_MS = 1_500;
const CAPTURE_SURFACE_READY_TIMEOUT_MS = 1_000;
const CAPTURE_SURFACE_POLL_INTERVAL_MS = 16;
const MIN_BROWSER_USE_VIEWPORT_WIDTH = 240;
const MIN_BROWSER_USE_VIEWPORT_HEIGHT = 160;
const MAX_BROWSER_USE_VIEWPORT_DIMENSION = 4_096;

const BrowserUseSessionParamsSchema = z
  .object({
    session_id: z.string().trim().min(1).max(512),
    turn_id: z.string().trim().min(1).max(512).optional(),
    session_context: z.enum(["live", "cached"]).optional(),
  })
  .passthrough();

const BrowserUseTabIdSchema = z.number().int().positive();
const BrowserUseTargetSchema = z
  .object({
    tabId: BrowserUseTabIdSchema,
    sessionId: z.string().trim().min(1).max(512).optional(),
    targetId: z.string().trim().min(1).max(512).optional(),
  })
  .strict()
  .refine(
    (target) => !(target.sessionId && target.targetId),
    "CDP target must use either sessionId or targetId",
  );

const BrowserUseCdpParamsSchema = BrowserUseSessionParamsSchema.extend({
  target: BrowserUseTargetSchema,
  method: z.string().trim().min(1).max(256),
  commandParams: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

const BrowserUseTabParamsSchema = BrowserUseSessionParamsSchema.extend({
  tabId: BrowserUseTabIdSchema,
}).passthrough();

export interface BrowserUseRoute {
  browserConversationId: string;
  browserViewScopeId: string;
  codexSessionId: string;
  ownerWebContentsId: number;
  projectId: string | null;
}

export interface BrowserUseIabApiOptions {
  appSessionId: string;
  appVersion: string;
  asyncRuntime: BrowserUseIabAsyncRuntime;
  applyCommand: (command: BrowserSidebarCommand) => Promise<BrowserSidebarCommandResult>;
  browser: BrowserAutomationHost;
  buildFlavor: string;
  cdpCommandTimeoutMs?: number;
  route: BrowserUseRoute;
  cursorArrivalTimeoutMs?: number;
  grantDownload?: (identity: BrowserSidebarTabIdentity, sourceUrl: string, ttlMs?: number) => void;
  pageReadyTimeoutMs?: number;
  policyStore?: BrowserUsePolicyReader;
  subscribeWebviewAttached: (listener: (event: BrowserSidebarTabIdentity) => void) => () => void;
}

export interface BrowserUseIabAsyncRuntime {
  readonly deadline: <A>(
    task: () => Promise<A>,
    timeoutMs: number,
    timeoutMessage: string,
  ) => Promise<A>;
  readonly now: () => Promise<number>;
  readonly sleep: (delayMs: number) => Promise<void>;
  readonly waitFor: <A>(
    register: (succeed: (value: A) => void) => () => void,
    timeoutMs: number,
    onTimeout: () => A,
  ) => Promise<A>;
}

export interface BrowserUseIabTabInfo {
  active: boolean;
  id: number;
  title: string;
  url: string;
}

interface ControlledBrowserUseTab {
  browserTabId: string;
  id: number;
  mark: {
    status: "handoff" | "deliverable";
    turnId: string;
  } | null;
  origin: "agent" | "user";
}

export interface BrowserUseCdpEvent {
  method: string;
  params?: Record<string, unknown>;
  source: {
    sessionId?: string;
    tabId: number;
    targetId?: string;
  };
}

type CdpEventListener = (event: BrowserUseCdpEvent) => void;

export interface BrowserUseIabApi {
  readonly addCdpEventListener: (listener: CdpEventListener) => () => void;
  readonly dispatch: (method: string, rawParams: unknown) => Promise<unknown>;
  readonly getInfo: (rawParams: unknown) => Record<string, unknown>;
  readonly hasActiveControl: () => boolean;
  readonly notifyCursorArrived: (moveSequence: number) => void;
  readonly ping: () => string;
  readonly turnEnded: (rawParams: unknown) => Promise<void>;
}

function clampDimension(value: number, minimum: number): number {
  return Math.min(MAX_BROWSER_USE_VIEWPORT_DIMENSION, Math.max(minimum, Math.round(value)));
}

function makeBrowserUseViewport(width = 1_280, height = 720): BrowserSidebarViewport {
  return {
    width: clampDimension(width, MIN_BROWSER_USE_VIEWPORT_WIDTH),
    height: clampDimension(height, MIN_BROWSER_USE_VIEWPORT_HEIGHT),
    presetId: "browser-use",
    zoomPercent: 100,
  };
}

function toIdentity(route: BrowserUseRoute, browserTabId: string): BrowserSidebarTabIdentity {
  return {
    browserConversationId: route.browserConversationId,
    browserViewScopeId: route.browserViewScopeId,
    browserTabId,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readCaptureSurfaceSize(
  method: string,
  commandParams: Record<string, unknown> | undefined,
): { height: number; width: number } | null {
  if (
    method !== "Page.captureScreenshot" ||
    commandParams?.captureBeyondViewport !== true ||
    !isRecord(commandParams.clip)
  ) {
    return null;
  }
  const { height, width } = commandParams.clip;
  if (
    typeof height !== "number" ||
    typeof width !== "number" ||
    !Number.isFinite(height) ||
    !Number.isFinite(width) ||
    height <= 0 ||
    width <= 0
  ) {
    return null;
  }
  return {
    height: Math.ceil(height),
    width: Math.ceil(width),
  };
}

function isCaptureSurfaceReady(
  metrics: unknown,
  target: { height: number; width: number },
): boolean {
  if (!isRecord(metrics)) return false;
  const viewport = isRecord(metrics.cssVisualViewport)
    ? metrics.cssVisualViewport
    : isRecord(metrics.visualViewport)
      ? metrics.visualViewport
      : null;
  if (!viewport) return false;
  const width =
    typeof viewport.clientWidth === "number"
      ? viewport.clientWidth
      : typeof viewport.width === "number"
        ? viewport.width
        : 0;
  const height =
    typeof viewport.clientHeight === "number"
      ? viewport.clientHeight
      : typeof viewport.height === "number"
        ? viewport.height
        : 0;
  return width >= target.width && height >= target.height;
}

function assertAllowedBrowserUseNavigationUrl(value: unknown): string {
  if (typeof value !== "string" || !isAllowedBrowserNavigationUrl(value)) {
    throw new Error("Browser Use navigation URL is not allowed");
  }
  const parsed = new URL(value);
  if (!["http:", "https:"].includes(parsed.protocol) && value !== "about:blank") {
    throw new Error("Browser Use navigation URL is not allowed");
  }
  return value;
}

class BrowserUseIabApiState implements BrowserUseIabApi {
  private readonly appSessionId: string;
  private readonly appVersion: string;
  private readonly applyCommand: BrowserUseIabApiOptions["applyCommand"];
  private readonly asyncRuntime: BrowserUseIabAsyncRuntime;
  private readonly browser: BrowserAutomationHost;
  private readonly buildFlavor: string;
  private readonly cdpCommandTimeoutMs: number;
  private readonly controlledTabs = new Map<number, ControlledBrowserUseTab>();
  private readonly cdpDisposers = new Map<number, () => void>();
  private readonly cursorArrivalTimeoutMs: number;
  private readonly debuggerTargetIdsBySessionId = new Map<string, string>();
  private readonly debuggerTargetSessionsByTabId = new Map<number, Map<string, string>>();
  private readonly expressionCache = new Map<string, string>();
  private readonly grantDownload: NonNullable<BrowserUseIabApiOptions["grantDownload"]>;
  private readonly cdpEventListeners = new Set<CdpEventListener>();
  private readonly cursorArrivalWaiters = new Map<number, () => void>();
  private readonly pageReadyTimeoutMs: number;
  private readonly policyStore: BrowserUsePolicyReader | null;
  private readonly route: BrowserUseRoute;
  private readonly subscribeWebviewAttached: BrowserUseIabApiOptions["subscribeWebviewAttached"];
  private readonly userTabIdsByBrowserTabId = new Map<string, number>();
  private nextTabId = 1;
  private nextCursorMoveSequence = 1;
  private pendingVisibility = false;
  private pendingViewport: BrowserSidebarViewport | null = null;
  private selectedTabId: number | null = null;
  private recordedTurnId: string | null = null;
  private disposed = false;

  constructor(options: BrowserUseIabApiOptions) {
    this.appSessionId = options.appSessionId;
    this.appVersion = options.appVersion;
    this.applyCommand = options.applyCommand;
    this.asyncRuntime = options.asyncRuntime;
    this.browser = options.browser;
    this.buildFlavor = options.buildFlavor;
    this.cdpCommandTimeoutMs = Math.max(
      1,
      Math.floor(options.cdpCommandTimeoutMs ?? DEFAULT_CDP_COMMAND_TIMEOUT_MS),
    );
    this.cursorArrivalTimeoutMs =
      options.cursorArrivalTimeoutMs ?? DEFAULT_CURSOR_ARRIVAL_TIMEOUT_MS;
    this.grantDownload = options.grantDownload ?? (() => undefined);
    this.pageReadyTimeoutMs = options.pageReadyTimeoutMs ?? DEFAULT_PAGE_READY_TIMEOUT_MS;
    this.policyStore = options.policyStore ?? null;
    this.route = options.route;
    this.subscribeWebviewAttached = options.subscribeWebviewAttached;
  }

  ping(): string {
    return "pong";
  }

  getInfo(rawParams: unknown): Record<string, unknown> {
    this.requireSession(rawParams);
    const fullCdpAccessEnabled = this.policyStore?.snapshot().fullCdpAccessEnabled === true;
    return {
      apiSupportOverrides: {
        "BrowserUser.claimTab": true,
        "Tab.cdpCall": fullCdpAccessEnabled,
        "Tab.markDeliverable": true,
        "Tab.markHandoff": true,
        "Tabs.finalize": true,
      },
      name: "Nodex In-app Browser",
      version: this.appVersion,
      type: "iab",
      capabilities: {
        browser: [
          {
            id: "visibility",
            description: "Show or hide the in-app browser.",
          },
          {
            id: "viewport",
            description: "Control the in-app browser viewport.",
          },
        ],
        tab: [
          {
            id: "pageAssets",
            description: "Inspect assets observed in the current page.",
          },
          ...(fullCdpAccessEnabled
            ? [
                {
                  id: "cdp",
                  description: "Call the Chrome DevTools Protocol directly.",
                },
              ]
            : []),
        ],
      },
      metadata: {
        codexAppBuildFlavor: this.buildFlavor,
        codexAppSessionId: this.appSessionId,
        codexSessionId: this.route.codexSessionId,
      },
    };
  }

  async dispatch(method: string, rawParams: unknown): Promise<unknown> {
    if (this.disposed) throw new Error("Browser Use backend is disposed");
    if (method === "ping") return this.ping();
    if (method === "getInfo") return this.getInfo(rawParams);
    if (method === "getTabs") return this.getTabs(rawParams);
    if (method === "getUserTabs") return this.getUserTabs(rawParams);
    if (method === "getUserHistory") return this.getUserHistory(rawParams);
    if (method === "createTab") return await this.createTab(rawParams);
    if (method === "claimUserTab") return await this.claimUserTab(rawParams);
    if (method === "focusTab") return this.focusTab(rawParams);
    if (method === "nameSession") return this.nameSession(rawParams);
    if (method === "attach") return await this.attach(rawParams);
    if (method === "detach") return await this.detach(rawParams);
    if (method === "attachTarget") return await this.attachTarget(rawParams);
    if (method === "detachTarget") return await this.detachTarget(rawParams);
    if (method === "executeCdp") return await this.executeCdp(rawParams);
    if (method === "executeCdpWithCachedExpression") {
      return await this.executeCdpWithCachedExpression(rawParams);
    }
    if (method === "executeUnhandledCommand") {
      return this.executeUnhandledCommand(rawParams);
    }
    if (method === "allowDownload") return this.allowDownload(rawParams);
    if (method === "markTab") return this.markTab(rawParams);
    if (method === "finalizeTabs") return await this.finalizeTabs(rawParams);
    if (method === "moveMouse") return await this.moveMouse(rawParams);
    if (method === "turnEnded") return await this.turnEnded(rawParams);
    throw new Error(`No handler registered for method: ${method}`);
  }

  addCdpEventListener(listener: CdpEventListener): () => void {
    this.cdpEventListeners.add(listener);
    return () => this.cdpEventListeners.delete(listener);
  }

  hasActiveControl(): boolean {
    return this.controlledTabs.size > 0;
  }

  private async releaseSessionControl(): Promise<void> {
    const failures: unknown[] = [];
    for (const tabId of [...this.cdpDisposers.keys()]) {
      try {
        await this.detachTabBestEffort(tabId);
      } catch (error) {
        failures.push(error);
      }
    }
    for (const tab of this.controlledTabs.values()) {
      try {
        this.browser.releaseTab(toIdentity(this.route, tab.browserTabId));
      } catch (error) {
        failures.push(error);
      }
    }
    this.controlledTabs.clear();
    this.selectedTabId = null;
    this.clearPendingCapabilityIntents();
    try {
      this.browser.setActiveTab(this.route, null);
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "Browser Use session control release failed");
    }
  }

  async release(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const failures: unknown[] = [];
    for (const resolve of this.cursorArrivalWaiters.values()) {
      try {
        resolve();
      } catch (error) {
        failures.push(error);
      }
    }
    this.cursorArrivalWaiters.clear();
    try {
      await this.releaseSessionControl();
    } catch (error) {
      failures.push(error);
    } finally {
      this.cdpEventListeners.clear();
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "Browser Use IAB release failed");
    }
  }

  private requireSession(rawParams: unknown): Record<string, unknown> {
    const params = BrowserUseSessionParamsSchema.parse(rawParams ?? {});
    if (params.session_id !== this.route.codexSessionId) {
      throw new Error("Browser Use request session does not own this backend");
    }
    return params;
  }

  private recordTurn(params: Record<string, unknown>): void {
    if (typeof params.turn_id === "string") this.recordedTurnId = params.turn_id;
  }

  private getTabs(rawParams: unknown): BrowserUseIabTabInfo[] {
    this.requireSession(rawParams);
    this.refreshControlledTabs();
    return [...this.controlledTabs.values()].map((tab) => this.serializeTab(tab));
  }

  private getUserTabs(rawParams: unknown): Array<{
    id: number;
    providerTabId: string;
    title: string;
    url: string;
  }> {
    this.requireSession(rawParams);
    const controlledBrowserTabIds = new Set(
      [...this.controlledTabs.values()].map((tab) => tab.browserTabId),
    );
    return this.browser
      .listTabs(this.route.browserConversationId, this.route.browserViewScopeId)
      .filter((snapshot) => !controlledBrowserTabIds.has(snapshot.browserTabId))
      .map((snapshot) => ({
        id: this.getOrCreateUserTabId(snapshot.browserTabId),
        providerTabId: snapshot.browserTabId,
        title: snapshot.title,
        url: snapshot.url,
      }));
  }

  private getUserHistory(rawParams: unknown): never {
    this.requireSession(rawParams);
    throw new Error("browser.user.history is unavailable in this build.");
  }

  private async createTab(rawParams: unknown): Promise<BrowserUseIabTabInfo> {
    const params = this.requireSession(rawParams);
    this.recordTurn(params);
    const browserTabId = `browser-use:${randomUUID()}`;
    const tab: ControlledBrowserUseTab = {
      browserTabId,
      id: this.nextTabId++,
      mark: null,
      origin: "agent",
    };
    this.controlledTabs.set(tab.id, tab);
    this.selectedTabId = tab.id;
    this.publishControlledTab(tab, {
      title: "New tab",
      url: "about:blank",
      webContentsId: null,
      viewport: makeBrowserUseViewport(),
    });
    this.browser.setActiveTab(this.route, browserTabId);
    await this.applyPendingCapabilityIntents(tab);
    await this.waitForLiveTab(tab);
    return this.serializeTab(tab);
  }

  private async claimUserTab(rawParams: unknown): Promise<BrowserUseIabTabInfo> {
    const params = BrowserUseTabParamsSchema.parse(rawParams);
    this.requireSession(params);
    this.recordTurn(params);
    if (![...this.userTabIdsByBrowserTabId.values()].includes(params.tabId)) {
      this.getUserTabs(params);
    }
    const resolvedEntry = [...this.userTabIdsByBrowserTabId.entries()].find(
      ([, userTabId]) => userTabId === params.tabId,
    );
    if (!resolvedEntry) throw new Error(`Unknown tab: ${params.tabId}`);
    const snapshot = this.browser.getTab(toIdentity(this.route, resolvedEntry[0]));
    if (!snapshot) throw new Error(`Unknown tab: ${params.tabId}`);

    const existing = [...this.controlledTabs.values()].find(
      (tab) => tab.browserTabId === snapshot.browserTabId,
    );
    const tab = existing ?? {
      browserTabId: snapshot.browserTabId,
      id: params.tabId,
      mark: null,
      origin: "user" as const,
    };
    this.controlledTabs.set(tab.id, tab);
    this.selectedTabId = tab.id;
    this.publishControlledTab(tab, snapshot);
    this.browser.setActiveTab(this.route, snapshot.browserTabId);
    await this.waitForLiveTab(tab);
    return this.serializeTab(tab);
  }

  private focusTab(rawParams: unknown): void {
    const params = z
      .object({
        tabId: BrowserUseTabIdSchema,
      })
      .strict()
      .parse(rawParams);
    const tab = this.requireControlledTab(params.tabId);
    this.selectedTabId = tab.id;
    this.browser.setActiveTab(this.route, tab.browserTabId);
  }

  private nameSession(rawParams: unknown): void {
    const params = BrowserUseSessionParamsSchema.extend({
      name: z.string().trim().min(1).max(512),
    })
      .passthrough()
      .parse(rawParams);
    this.requireSession(params);
    this.recordTurn(params);
  }

  private async attach(rawParams: unknown): Promise<void> {
    const params = BrowserUseTabParamsSchema.parse(rawParams);
    this.requireSession(params);
    this.recordTurn(params);
    const tab = this.requireControlledTab(params.tabId);
    const contents = await this.waitForLiveTab(tab);
    const debuggerPort = contents.debugger;
    if (!debuggerPort) throw new Error("Browser debugger is unavailable");
    if (!debuggerPort.isAttached()) debuggerPort.attach("1.3");
    this.registerCdpListener(tab, contents);
  }

  private async detach(rawParams: unknown): Promise<void> {
    const params = BrowserUseTabParamsSchema.parse(rawParams);
    this.requireSession(params);
    this.recordTurn(params);
    this.requireControlledTab(params.tabId);
    await this.detachTabBestEffort(params.tabId);
  }

  private async attachTarget(rawParams: unknown): Promise<void> {
    const params = BrowserUseTabParamsSchema.extend({
      targetId: z.string().trim().min(1).max(512),
    })
      .passthrough()
      .parse(rawParams);
    await this.attach(params);
    const tab = this.requireControlledTab(params.tabId);
    if (params.targetId === this.topLevelTargetId(tab)) return;
    if (this.debuggerSessionIdForTarget(tab, params.targetId)) return;
    const contents = await this.waitForLiveTab(tab);
    const result = await contents.debugger?.sendCommand("Target.attachToTarget", {
      flatten: true,
      targetId: params.targetId,
    });
    if (!isRecord(result) || typeof result.sessionId !== "string") {
      throw new Error("Target.attachToTarget did not return a sessionId");
    }
    this.rememberDebuggerTargetSession(tab, params.targetId, result.sessionId);
  }

  private async detachTarget(rawParams: unknown): Promise<void> {
    const params = BrowserUseTabParamsSchema.extend({
      targetId: z.string().trim().min(1).max(512),
    })
      .passthrough()
      .parse(rawParams);
    this.requireSession(params);
    const tab = this.requireControlledTab(params.tabId);
    if (params.targetId === this.topLevelTargetId(tab)) {
      await this.detach(params);
      return;
    }
    const sessionId = this.debuggerSessionIdForTarget(tab, params.targetId);
    if (!sessionId) return;
    const contents = await this.waitForLiveTab(tab);
    try {
      await contents.debugger?.sendCommand("Target.detachFromTarget", {
        sessionId,
      });
    } finally {
      this.forgetDebuggerTargetSession(sessionId);
    }
  }

  private async executeCdp(rawParams: unknown): Promise<unknown> {
    const params = BrowserUseCdpParamsSchema.parse(rawParams);
    this.requireSession(params);
    this.recordTurn(params);
    const tab = this.requireControlledTab(params.target.tabId);
    if (params.method === "Target.getTargets") {
      return await this.getTargetInfos(tab);
    }
    if (params.method === "Target.closeTarget") {
      const targetId =
        isRecord(params.commandParams) && typeof params.commandParams.targetId === "string"
          ? params.commandParams.targetId
          : null;
      if (targetId !== this.topLevelTargetId(tab)) {
        throw new Error("Target.closeTarget can only close the current in-app browser tab");
      }
      await this.closeControlledTab(tab);
      return { success: true };
    }
    if (params.method === "Page.close") {
      await this.closeControlledTab(tab);
      return {};
    }
    if (
      params.method.startsWith("Target.") &&
      ![
        "Target.getTargets",
        "Target.setAutoAttach",
        "Target.attachToTarget",
        "Target.detachFromTarget",
      ].includes(params.method)
    ) {
      throw new Error(`Unsupported Browser Use target command: ${params.method}`);
    }
    const contents = await this.waitForLiveTab(tab);
    const debuggerPort = contents.debugger;
    if (!debuggerPort) throw new Error("Browser debugger is unavailable");
    if (!debuggerPort.isAttached()) debuggerPort.attach("1.3");
    this.registerCdpListener(tab, contents);
    const targetSessionId =
      params.target.sessionId ??
      (params.target.targetId && params.target.targetId !== this.topLevelTargetId(tab)
        ? this.debuggerSessionIdForTarget(tab, params.target.targetId)
        : undefined);
    if (
      params.target.targetId &&
      params.target.targetId !== this.topLevelTargetId(tab) &&
      !targetSessionId
    ) {
      throw new Error(
        `No in-app browser debugger session is attached for target ${params.target.targetId}`,
      );
    }
    if (params.method === "Page.navigate") {
      const url = assertAllowedBrowserUseNavigationUrl(params.commandParams?.url);
      this.assertPolicyAllows("origin", url);
    }
    if (params.method === "Page.navigateToHistoryEntry") {
      const entryId = params.commandParams?.entryId;
      if (!Number.isInteger(entryId)) {
        throw new Error("Page.navigateToHistoryEntry requires an integer entryId");
      }
      const history = await this.asyncRuntime.deadline(
        () => debuggerPort.sendCommand("Page.getNavigationHistory", undefined, targetSessionId),
        this.cdpCommandTimeoutMs,
        "Timed out validating Browser Use navigation history",
      );
      const entries = isRecord(history) && Array.isArray(history.entries) ? history.entries : [];
      const selectedEntry = entries.find((entry) => isRecord(entry) && entry.id === entryId);
      assertAllowedBrowserUseNavigationUrl(isRecord(selectedEntry) ? selectedEntry.url : undefined);
      this.assertPolicyAllows(
        "origin",
        isRecord(selectedEntry) && typeof selectedEntry.url === "string" ? selectedEntry.url : "",
      );
    }
    if (params.method === "DOM.setFileInputFiles") {
      this.assertPolicyAllows("upload", contents.getURL());
    }
    const shouldTranslateInput =
      params.method.startsWith("Input.") &&
      !targetSessionId &&
      (!params.target.targetId || params.target.targetId === this.topLevelTargetId(tab));
    if (shouldTranslateInput) {
      if (!isSupportedBrowserUseInputMethod(params.method)) {
        throw new Error(
          `${params.method} is not supported in the in-app browser because top-level input commands preserve guest focus`,
        );
      }
      const translated = await this.asyncRuntime.deadline(
        () =>
          contents.executeJavaScript(
            buildBrowserUseInputTranslationScript(params.method, params.commandParams ?? {}),
            params.method === "Input.dispatchMouseEvent" &&
              params.commandParams?.type === "mouseReleased",
          ) as Promise<BrowserUseInputTranslationResult>,
        this.cdpCommandTimeoutMs,
        `Timed out translating Browser Use input command ${params.method}`,
      );
      if (translated.ok) return {};
      if (translated.error?.includes("Input targets inside cross-origin or inaccessible iframes")) {
        // Cross-origin frames cannot be reached from the top-level main world.
        // Let Chromium target the frame through CDP instead.
      } else {
        throw new Error(
          `Unable to translate ${params.method} in the in-app browser: ${
            translated.error ?? "unknown translation failure"
          }`,
        );
      }
    }
    const captureSurfaceSize = readCaptureSurfaceSize(params.method, params.commandParams);
    if (captureSurfaceSize) {
      this.browser.setCaptureSurface({
        ...toIdentity(this.route, tab.browserTabId),
        surfaceSize: captureSurfaceSize,
      });
    }
    try {
      if (captureSurfaceSize) {
        await this.waitForCaptureSurface(debuggerPort, captureSurfaceSize);
      }
      return await this.asyncRuntime.deadline(
        () => debuggerPort.sendCommand(params.method, params.commandParams, targetSessionId),
        this.cdpCommandTimeoutMs,
        `Timed out executing Browser Use CDP command ${params.method}`,
      );
    } finally {
      if (captureSurfaceSize) {
        this.browser.setCaptureSurface({
          ...toIdentity(this.route, tab.browserTabId),
          surfaceSize: null,
        });
      }
    }
  }

  private async executeCdpWithCachedExpression(
    rawParams: unknown,
  ): Promise<{ kind: "cache-miss" } | { kind: "executed"; result: unknown }> {
    const params = BrowserUseCdpParamsSchema.extend({
      expressionCacheKey: z.string().trim().min(1).max(512),
    })
      .passthrough()
      .parse(rawParams);
    this.requireSession(params);
    this.recordTurn(params);
    const commandParams = params.commandParams ?? {};
    const suppliedExpression =
      typeof commandParams.expression === "string" ? commandParams.expression : null;
    if (suppliedExpression) {
      this.expressionCache.set(params.expressionCacheKey, suppliedExpression);
    }
    const expression = suppliedExpression ?? this.expressionCache.get(params.expressionCacheKey);
    if (!expression) return { kind: "cache-miss" };
    return {
      kind: "executed",
      result: await this.executeCdp({
        ...params,
        commandParams: {
          ...commandParams,
          expression,
        },
      }),
    };
  }

  private async executeUnhandledCommand(rawParams: unknown): Promise<Record<string, unknown>> {
    const params = this.requireSession(rawParams);
    this.recordTurn(params);
    const type = typeof params.type === "string" ? params.type : "";
    const selected =
      this.selectedTabId === null ? null : (this.controlledTabs.get(this.selectedTabId) ?? null);
    if (type === "browser_visibility_get") {
      return {
        visible: selected !== null && this.browser.isVisible(this.route, selected.browserTabId),
      };
    }
    if (type === "browser_visibility_set") {
      const visible = params.visible === true;
      if (!selected) {
        this.pendingVisibility = visible;
        return {};
      }
      this.browser.setVisible(this.route, selected.browserTabId, visible);
      return {};
    }
    if (type === "browser_viewport_set") {
      const width = z.number().finite().parse(params.width);
      const height = z.number().finite().parse(params.height);
      const viewport = makeBrowserUseViewport(width, height);
      if (!selected) {
        this.pendingViewport = viewport;
        return {};
      }
      await this.applyViewport(selected, viewport);
      return {};
    }
    if (type === "browser_viewport_reset") {
      if (!selected) {
        this.pendingViewport = null;
        return {};
      }
      this.browser.setViewport({
        ...toIdentity(this.route, selected.browserTabId),
        viewportSize: null,
      });
      return {};
    }
    throw new Error(`Unsupported Browser Use command: ${type}`);
  }

  private allowDownload(rawParams: unknown): void {
    const params = BrowserUseTabParamsSchema.extend({
      url: z.string().trim().min(1).max(16_384),
    })
      .passthrough()
      .parse(rawParams);
    this.requireSession(params);
    this.recordTurn(params);
    const tab = this.requireControlledTab(params.tabId);
    this.assertPolicyAllows("download", params.url);
    this.grantDownload(toIdentity(this.route, tab.browserTabId), params.url, 10_000);
  }

  private assertPolicyAllows(
    resource: "origin" | "download" | "upload" | "fullCdp",
    url: string,
  ): void {
    if (!this.policyStore?.isExplicitlyDenied(resource, url)) return;
    throw new Error(
      `Browser Use rejected this ${resource} action because the origin is denied by Browser policy`,
    );
  }

  private markTab(rawParams: unknown): void {
    const params = BrowserUseTabParamsSchema.extend({
      status: z.enum(["handoff", "deliverable"]),
      turn_id: z.string().trim().min(1).max(512),
    })
      .passthrough()
      .parse(rawParams);
    this.requireSession(params);
    const tab = this.requireControlledTab(params.tabId);
    tab.mark = {
      status: params.status,
      turnId: params.turn_id,
    };
    this.recordTurn(params);
  }

  private async finalizeTabs(rawParams: unknown): Promise<void> {
    const params = BrowserUseSessionParamsSchema.extend({
      keep: z
        .array(
          z
            .object({
              tabId: BrowserUseTabIdSchema,
              status: z.enum(["handoff", "deliverable"]),
            })
            .strict(),
        )
        .max(128),
    })
      .passthrough()
      .parse(rawParams);
    this.requireSession(params);
    this.recordTurn(params);
    const keep = new Map(params.keep.map((entry) => [entry.tabId, entry.status]));
    await this.finalizeControlledTabs(keep, params.turn_id ?? null);
    this.recordedTurnId = null;
  }

  private async moveMouse(rawParams: unknown): Promise<void> {
    const params = BrowserUseTabParamsSchema.extend({
      x: z.number().finite(),
      y: z.number().finite(),
      waitForArrival: z.boolean().optional(),
    })
      .passthrough()
      .parse(rawParams);
    this.requireSession(params);
    this.recordTurn(params);
    const tab = this.requireControlledTab(params.tabId);
    const moveSequence = this.nextCursorMoveSequence++;
    const shouldWaitForArrival = this.browser.setCursor({
      ...toIdentity(this.route, tab.browserTabId),
      moveSequence,
      x: params.x,
      y: params.y,
      visible: true,
      updatedAt: Date.now(),
    });
    if (params.waitForArrival === false || !shouldWaitForArrival) return;
    await this.asyncRuntime.waitFor<void>(
      (succeed) => {
        this.cursorArrivalWaiters.set(moveSequence, () => succeed());
        return () => this.cursorArrivalWaiters.delete(moveSequence);
      },
      this.cursorArrivalTimeoutMs,
      () => undefined,
    );
  }

  notifyCursorArrived(moveSequence: number): void {
    if (!Number.isInteger(moveSequence) || moveSequence <= 0) return;
    this.cursorArrivalWaiters.get(moveSequence)?.();
  }

  async turnEnded(rawParams: unknown): Promise<void> {
    const params = BrowserUseSessionParamsSchema.extend({
      turn_id: z.string().trim().min(1).max(512),
    })
      .passthrough()
      .parse(rawParams);
    this.requireSession(params);
    if (this.recordedTurnId !== params.turn_id) return;
    const keep = new Map<number, "handoff" | "deliverable">();
    for (const tab of this.controlledTabs.values()) {
      if (tab.mark?.turnId === params.turn_id) {
        keep.set(tab.id, tab.mark.status);
      }
    }
    await this.finalizeControlledTabs(keep, params.turn_id);
    this.recordedTurnId = null;
  }

  private async finalizeControlledTabs(
    keep: ReadonlyMap<number, "handoff" | "deliverable">,
    turnId: string | null,
  ): Promise<void> {
    for (const tab of [...this.controlledTabs.values()]) {
      await this.detachTabBestEffort(tab.id);
      const status = keep.get(tab.id) ?? (tab.mark?.turnId === turnId ? tab.mark.status : null);
      if (status === "handoff" && tab.origin === "agent") {
        tab.mark = null;
        continue;
      }
      if (status || tab.origin === "user") {
        this.releaseControlledTab(tab);
        continue;
      }
      await this.closeControlledTab(tab);
    }
    const selected =
      this.selectedTabId === null ? null : (this.controlledTabs.get(this.selectedTabId) ?? null);
    this.browser.setActiveTab(this.route, selected?.browserTabId ?? null);
    this.clearPendingCapabilityIntents();
  }

  private publishControlledTab(
    tab: ControlledBrowserUseTab,
    snapshot: Pick<BrowserSidebarTabSnapshot, "title" | "url" | "webContentsId" | "viewport">,
  ): void {
    const state: BrowserUseTabState = {
      ...toIdentity(this.route, tab.browserTabId),
      codexSessionId: this.route.codexSessionId,
      projectId: this.route.projectId,
      title: snapshot.title,
      url: snapshot.url,
      webContentsId: snapshot.webContentsId,
      viewport: snapshot.viewport,
      captureActive: false,
      released: false,
      updatedAt: Date.now(),
    };
    this.browser.upsertTab(state);
  }

  private refreshControlledTabs(): void {
    for (const tab of this.controlledTabs.values()) {
      const snapshot = this.browser.getTab(toIdentity(this.route, tab.browserTabId));
      if (snapshot) this.publishControlledTab(tab, snapshot);
    }
  }

  private serializeTab(tab: ControlledBrowserUseTab): BrowserUseIabTabInfo {
    const snapshot = this.browser.getTab(toIdentity(this.route, tab.browserTabId));
    return {
      active: tab.id === this.selectedTabId,
      id: tab.id,
      title: snapshot?.title ?? "New tab",
      url: snapshot?.url ?? "about:blank",
    };
  }

  private getOrCreateUserTabId(browserTabId: string): number {
    const existing = this.userTabIdsByBrowserTabId.get(browserTabId);
    if (existing !== undefined) return existing;
    const id = this.nextTabId++;
    this.userTabIdsByBrowserTabId.set(browserTabId, id);
    return id;
  }

  private requireControlledTab(tabId: number): ControlledBrowserUseTab {
    const tab = this.controlledTabs.get(tabId);
    if (!tab) throw new Error(`Unknown tab: ${tabId}`);
    return tab;
  }

  private async waitForLiveTab(tab: ControlledBrowserUseTab): Promise<BrowserWebContentsLike> {
    const identity = toIdentity(this.route, tab.browserTabId);
    const readReadyContents = (): BrowserWebContentsLike | null => {
      const snapshot = this.browser.getTab(identity);
      const contents = this.browser.getWebContents(identity);
      if (!snapshot || !contents || contents.isDestroyed()) return null;
      if (snapshot.webContentsId !== contents.id) return null;
      if (
        snapshot.lifecycleState !== "live-attached" &&
        snapshot.lifecycleState !== "live-detached"
      ) {
        return null;
      }
      return contents;
    };
    const existing = readReadyContents();
    if (existing) return existing;

    return await this.asyncRuntime.waitFor<BrowserWebContentsLike>(
      (succeed) => {
        const onAttached = (event: BrowserSidebarTabIdentity) => {
          if (
            event.browserConversationId !== identity.browserConversationId ||
            event.browserViewScopeId !== identity.browserViewScopeId ||
            event.browserTabId !== identity.browserTabId
          ) {
            return;
          }
          const contents = readReadyContents();
          if (!contents) return;
          succeed(contents);
        };
        const unsubscribe = this.subscribeWebviewAttached(onAttached);
        const attachedDuringSubscription = readReadyContents();
        if (attachedDuringSubscription) succeed(attachedDuringSubscription);
        return unsubscribe;
      },
      this.pageReadyTimeoutMs,
      () => {
        throw new Error(`Timed out waiting for Browser Use tab ${tab.id}`);
      },
    );
  }

  private registerCdpListener(
    tab: ControlledBrowserUseTab,
    contents: BrowserWebContentsLike,
  ): void {
    if (this.cdpDisposers.has(tab.id)) return;
    const debuggerPort = contents.debugger;
    if (!debuggerPort?.on || !debuggerPort.removeListener) return;
    const listener = (_event: unknown, method: unknown, params: unknown, sessionId: unknown) => {
      if (typeof method !== "string") return;
      const normalizedSessionId =
        typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;
      if (
        method === "Target.attachedToTarget" &&
        isRecord(params) &&
        typeof params.sessionId === "string" &&
        isRecord(params.targetInfo) &&
        typeof params.targetInfo.targetId === "string"
      ) {
        this.rememberDebuggerTargetSession(tab, params.targetInfo.targetId, params.sessionId);
      } else if (
        method === "Target.detachedFromTarget" &&
        isRecord(params) &&
        typeof params.sessionId === "string"
      ) {
        this.forgetDebuggerTargetSession(params.sessionId);
      }
      const event: BrowserUseCdpEvent = {
        source: {
          tabId: tab.id,
          ...(normalizedSessionId ? { sessionId: normalizedSessionId } : {}),
          ...(normalizedSessionId && this.debuggerTargetIdsBySessionId.has(normalizedSessionId)
            ? {
                targetId: this.debuggerTargetIdsBySessionId.get(normalizedSessionId),
              }
            : {}),
        },
        method,
        ...(isRecord(params) ? { params } : {}),
      };
      for (const cdpEventListener of this.cdpEventListeners) cdpEventListener(event);
    };
    debuggerPort.on("message", listener);
    this.cdpDisposers.set(tab.id, () => {
      debuggerPort.removeListener?.("message", listener);
    });
  }

  private async detachTabBestEffort(tabId: number): Promise<void> {
    this.cdpDisposers.get(tabId)?.();
    this.cdpDisposers.delete(tabId);
    this.forgetDebuggerTargetSessionsForTab(tabId);
    const tab = this.controlledTabs.get(tabId);
    if (!tab) return;
    const contents = this.browser.getWebContents(toIdentity(this.route, tab.browserTabId));
    if (!contents?.debugger?.isAttached()) return;
    this.browser.releaseDebugger(contents);
  }

  private releaseControlledTab(tab: ControlledBrowserUseTab): void {
    this.browser.releaseTab(toIdentity(this.route, tab.browserTabId));
    this.controlledTabs.delete(tab.id);
    if (this.selectedTabId === tab.id) this.selectedTabId = null;
  }

  private async applyPendingCapabilityIntents(tab: ControlledBrowserUseTab): Promise<void> {
    const viewport = this.pendingViewport;
    this.pendingViewport = null;
    if (viewport) await this.applyViewport(tab, viewport);
    if (!this.pendingVisibility) return;
    this.pendingVisibility = false;
    this.browser.setVisible(this.route, tab.browserTabId, true);
  }

  private async applyViewport(
    tab: ControlledBrowserUseTab,
    viewport: BrowserSidebarViewport,
  ): Promise<void> {
    const identity = toIdentity(this.route, tab.browserTabId);
    this.browser.setViewport({
      ...identity,
      viewportSize: {
        width: viewport.width,
        height: viewport.height,
      },
    });
    await this.applyCommand({
      type: "set-viewport",
      ...identity,
      viewport,
    });
  }

  private clearPendingCapabilityIntents(): void {
    this.pendingVisibility = false;
    this.pendingViewport = null;
  }

  private async closeControlledTab(tab: ControlledBrowserUseTab): Promise<void> {
    const identity = toIdentity(this.route, tab.browserTabId);
    const result = await this.applyCommand({ type: "close-tab", ...identity });
    if (!result.ok) throw new Error(result.message);
    this.controlledTabs.delete(tab.id);
    if (this.selectedTabId === tab.id) this.selectedTabId = null;
  }

  private topLevelTargetId(tab: ControlledBrowserUseTab): string {
    return `browser-use-iab-tab:${tab.id}`;
  }

  private debuggerSessionIdForTarget(
    tab: ControlledBrowserUseTab,
    targetId: string,
  ): string | undefined {
    return this.debuggerTargetSessionsByTabId.get(tab.id)?.get(targetId);
  }

  private rememberDebuggerTargetSession(
    tab: ControlledBrowserUseTab,
    targetId: string,
    sessionId: string,
  ): void {
    const sessions = this.debuggerTargetSessionsByTabId.get(tab.id) ?? new Map();
    sessions.set(targetId, sessionId);
    this.debuggerTargetSessionsByTabId.set(tab.id, sessions);
    this.debuggerTargetIdsBySessionId.set(sessionId, targetId);
  }

  private forgetDebuggerTargetSession(sessionId: string): void {
    this.debuggerTargetIdsBySessionId.delete(sessionId);
    for (const sessions of this.debuggerTargetSessionsByTabId.values()) {
      for (const [targetId, candidateSessionId] of sessions) {
        if (candidateSessionId === sessionId) sessions.delete(targetId);
      }
    }
  }

  private forgetDebuggerTargetSessionsForTab(tabId: number): void {
    const sessions = this.debuggerTargetSessionsByTabId.get(tabId);
    if (!sessions) return;
    for (const sessionId of sessions.values()) {
      this.debuggerTargetIdsBySessionId.delete(sessionId);
    }
    this.debuggerTargetSessionsByTabId.delete(tabId);
  }

  private async getTargetInfos(
    tab: ControlledBrowserUseTab,
  ): Promise<{ targetInfos: Array<Record<string, unknown>> }> {
    const topLevelTargets = [...this.controlledTabs.values()].map((candidate) => {
      const serialized = this.serializeTab(candidate);
      return {
        attached: this.cdpDisposers.has(candidate.id),
        browserContextId: this.route.codexSessionId,
        canAccessOpener: false,
        targetId: this.topLevelTargetId(candidate),
        title: serialized.title,
        type: "page",
        url: serialized.url,
        tabId: candidate.id,
      };
    });
    const contents = await this.waitForLiveTab(tab);
    const raw = await contents.debugger?.sendCommand("Target.getTargets", {});
    const frameTargets =
      isRecord(raw) && Array.isArray(raw.targetInfos)
        ? raw.targetInfos.flatMap((entry): Array<Record<string, unknown>> =>
            isRecord(entry) && entry.type === "iframe" ? [{ ...entry, tabId: tab.id }] : [],
          )
        : [];
    return { targetInfos: [...topLevelTargets, ...frameTargets] };
  }

  private async waitForCaptureSurface(
    debuggerPort: NonNullable<BrowserWebContentsLike["debugger"]>,
    target: { height: number; width: number },
  ): Promise<void> {
    const deadline = (await this.asyncRuntime.now()) + CAPTURE_SURFACE_READY_TIMEOUT_MS;
    do {
      try {
        const now = await this.asyncRuntime.now();
        const metrics = await this.asyncRuntime.deadline(
          () => debuggerPort.sendCommand("Page.getLayoutMetrics", {}),
          Math.max(1, deadline - now),
          "Timed out waiting for the Browser Use capture surface",
        );
        if (isCaptureSurfaceReady(metrics, target)) return;
      } catch {
        return;
      }
      await this.asyncRuntime.sleep(CAPTURE_SURFACE_POLL_INTERVAL_MS);
    } while ((await this.asyncRuntime.now()) < deadline);
  }
}

export const makeBrowserUseIabApi = (
  options: BrowserUseIabApiOptions,
): Effect.Effect<BrowserUseIabApi, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => new BrowserUseIabApiState(options)),
    (api) =>
      Effect.promise(() => api.release()).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Browser Use IAB release failed").pipe(
            Effect.annotateLogs({ cause: Cause.pretty(cause) }),
          ),
        ),
      ),
  );
