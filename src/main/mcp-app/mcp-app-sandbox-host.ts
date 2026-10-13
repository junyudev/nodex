import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import type {
  IpcMainEvent,
  NativeImage,
  Net,
  Session,
  WebContents,
  WebPreferences,
} from "electron";
import type { BackendLogger } from "../logging/logger";
import {
  MCP_APP_SANDBOX_HOST_MESSAGE_CHANNEL,
  MCP_APP_SANDBOX_REMOTE_HOST,
  MCP_APP_SANDBOX_SCHEME,
  parseMcpAppSandboxGuestInitMessage,
  parseMcpAppSandboxSourceUrl,
  type McpAppSandboxHostInitMessage,
} from "../../shared/mcp-app/mcp-app-sandbox-contract";
import {
  type McpAppSandboxCacheState,
  type McpAppSandboxProtocolCache,
} from "./mcp-app-sandbox-protocol";
import {
  decideMcpAppWebviewAttachment,
  isMcpAppSandboxPartition,
  type McpAppPendingAttachment,
} from "./mcp-app-webview-attachment-policy";

const PENDING_ATTACHMENT_TTL_MS = 30_000;

export class McpAppSandboxCaptureError extends Schema.TaggedError<McpAppSandboxCaptureError>()(
  "McpAppSandboxCaptureError",
  {
    reason: Schema.Literals(["unavailable", "failed", "retired"]),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

interface OwnedMcpAppAttachment extends McpAppPendingAttachment {
  ownerWebContents: WebContents;
}

interface AttachedMcpAppGuest extends OwnedMcpAppAttachment {
  guest: WebContents;
  lastUserGestureAt?: number;
  active: boolean;
  presentationRevision: number;
}

interface PendingMcpAppAttachment {
  cancelExpiration: () => void;
  state: OwnedMcpAppAttachment;
}

export interface McpAppSandboxScheduler {
  readonly schedule: (delayMs: number, task: () => void) => () => void;
}

export interface McpAppSandboxHostOptions {
  allowLocalDevelopment: boolean;
  applicationName: string;
  fetch?: Net["fetch"];
  guestPreloadPath: string;
  locale: string;
  logger: BackendLogger;
  platform: NodeJS.Platform;
  preferredSystemLanguages: readonly string[];
}

export interface McpAppSandboxPlatform {
  readonly defaultSession: Session;
  readonly fromPartition: (partition: string) => Session;
  readonly onGuestMessage: (
    listener: (event: IpcMainEvent, rawMessage: unknown) => void,
  ) => () => void;
  readonly showGuestContextMenu: (owner: WebContents, guest: WebContents) => void;
}

export interface McpAppSandboxHost {
  readonly handleDidAttach: (guest: WebContents) => boolean;
  readonly handleWillAttach: (
    event: Electron.Event,
    webPreferences: WebPreferences,
    rawParams: McpWebviewParams,
  ) => void;
  readonly handlesPartition: (partition: string | null | undefined) => boolean;
}

export interface McpAppSandboxController {
  readonly createHost: (owner: WebContents) => McpAppSandboxHost;
  readonly consumeUserGesture: (owner: WebContents, sandboxId: string, initId?: string) => boolean;
  readonly releaseGuest: (owner: WebContents, sandboxId: string, initId: string) => boolean;
  readonly setGuestPresentation: (
    owner: WebContents,
    sandboxId: string,
    initId: string,
    active: boolean,
    revision: number,
  ) => boolean;
  readonly captureImage: (
    owner: WebContents,
    sandboxId: string,
    initId: string,
  ) => Effect.Effect<NativeImage, McpAppSandboxCaptureError>;
}

export interface McpWebviewParams {
  nodeintegration?: string;
  partition?: string;
  preload?: string;
  src?: string;
  webpreferences?: string;
}

function isSandboxHostUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const hostname = new URL(value).hostname;
    return (
      hostname === MCP_APP_SANDBOX_REMOTE_HOST ||
      hostname.endsWith(`.${MCP_APP_SANDBOX_REMOTE_HOST}`)
    );
  } catch {
    return false;
  }
}

function isLoopbackHttpUrl(url: URL): boolean {
  if (url.protocol !== "http:" && url.protocol !== "ws:") return false;
  return url.hostname === "localhost";
}

export function isAllowedMcpAppSandboxRequestUrl(
  value: string,
  options: { allowLocalDevelopment: boolean },
): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === `${MCP_APP_SANDBOX_SCHEME}:`) {
      return (
        url.hostname === MCP_APP_SANDBOX_REMOTE_HOST ||
        url.hostname.endsWith(`.${MCP_APP_SANDBOX_REMOTE_HOST}`)
      );
    }
    if (["about:", "blob:", "data:", "devtools:", "https:", "wss:"].includes(url.protocol)) {
      return true;
    }
    return options.allowLocalDevelopment && isLoopbackHttpUrl(url);
  } catch {
    return false;
  }
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function stripElectronProductTokens(userAgent: string, applicationName: string): string {
  return ["Electron", applicationName]
    .filter(Boolean)
    .reduce(
      (value, product) =>
        value.replace(new RegExp(`\\s${escapeRegularExpression(product)}/[^\\s]+`, "gu"), ""),
      userAgent,
    )
    .replace(/\s{2,}/gu, " ")
    .trim();
}

function preferredAcceptLanguage(
  preferredSystemLanguages: readonly string[],
  locale: string,
): string {
  return (preferredSystemLanguages.length > 0 ? preferredSystemLanguages : [locale])
    .map((language, index) =>
      index === 0 ? language : `${language};q=${Math.max(1 - index * 0.1, 0.1).toFixed(1)}`,
    )
    .join(",");
}

function setRequestHeader(headers: Record<string, string>, name: string, value: string): void {
  const existingName = Object.keys(headers).find(
    (candidate) => candidate.toLowerCase() === name.toLowerCase(),
  );
  if (existingName && existingName !== name) delete headers[existingName];
  headers[name] = value;
}

function rewriteSandboxRequestHeaders(
  headers: Record<string, string>,
  userAgent: string,
  identity: Pick<
    McpAppSandboxHostOptions,
    "applicationName" | "locale" | "platform" | "preferredSystemLanguages"
  >,
): Record<string, string> {
  const rewritten = { ...headers };
  const sanitizedUserAgent = stripElectronProductTokens(userAgent, identity.applicationName);
  setRequestHeader(rewritten, "User-Agent", sanitizedUserAgent);
  setRequestHeader(
    rewritten,
    "Accept-Language",
    preferredAcceptLanguage(identity.preferredSystemLanguages, identity.locale),
  );
  const chromiumMajor = /\b(?:Chrome|Chromium)\/(\d+)\./u.exec(sanitizedUserAgent)?.[1];
  if (chromiumMajor) {
    setRequestHeader(
      rewritten,
      "sec-ch-ua",
      `"Chromium";v="${chromiumMajor}", "Google Chrome";v="${chromiumMajor}", "Not=A?Brand";v="24"`,
    );
  }
  setRequestHeader(rewritten, "sec-ch-ua-mobile", "?0");
  const platform =
    identity.platform === "darwin"
      ? '"macOS"'
      : identity.platform === "win32"
        ? '"Windows"'
        : '"Linux"';
  setRequestHeader(rewritten, "sec-ch-ua-platform", platform);
  return rewritten;
}

function isSameSandboxDocument(expected: string, candidate: string): boolean {
  try {
    const expectedUrl = new URL(expected);
    const candidateUrl = new URL(candidate);
    return (
      candidateUrl.protocol === expectedUrl.protocol &&
      candidateUrl.host === expectedUrl.host &&
      candidateUrl.pathname === expectedUrl.pathname &&
      candidateUrl.search === expectedUrl.search
    );
  } catch {
    return false;
  }
}

function isBlockedSandboxSubframeUrl(value: string): boolean {
  try {
    return !["about:", "blob:", "data:", "http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return true;
  }
}

/** Internal synchronous state machine; only the scoped factory may construct it. */
class McpAppSandboxControllerState {
  readonly #configuredSessions = new Map<
    Session,
    (event: Electron.Event, item: Electron.DownloadItem) => void
  >();
  readonly #hosts = new Set<McpAppSandboxHostState>();
  readonly #hostsByGuestId = new Map<number, McpAppSandboxHostState>();
  readonly #options: McpAppSandboxHostOptions;
  readonly #pendingBySession = new Map<Session, PendingMcpAppAttachment[]>();
  readonly #protocolCache: McpAppSandboxProtocolCache;
  readonly #platform: McpAppSandboxPlatform;
  #installed = false;
  #releaseGuestMessage: (() => void) | null = null;

  readonly #onGuestMessage = (event: IpcMainEvent, rawMessage: unknown): void => {
    this.#hostsByGuestId.get(event.sender.id)?.handleGuestMessage(event, rawMessage);
  };

  constructor(
    options: McpAppSandboxHostOptions,
    protocolCache: McpAppSandboxProtocolCache,
    private readonly scheduler: McpAppSandboxScheduler,
    platform: McpAppSandboxPlatform,
  ) {
    this.#options = options;
    this.#protocolCache = protocolCache;
    this.#platform = platform;
  }

  install(): void {
    if (this.#installed) return;
    this.#installed = true;
    this.#releaseGuestMessage = this.#platform.onGuestMessage(this.#onGuestMessage);
    const defaultSession = this.#platform.defaultSession;
    defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
      const frame = details.frame;
      const requestHeaders = details.requestHeaders;
      const originHeader = Object.entries(requestHeaders).find(
        ([name]) => name.toLowerCase() === "origin",
      )?.[1];
      const refererHeader = Object.entries(requestHeaders).find(
        ([name]) => name.toLowerCase() === "referer",
      )?.[1];
      const belongsToSandbox =
        isSandboxHostUrl(frame?.origin) ||
        isSandboxHostUrl(frame?.url) ||
        isSandboxHostUrl(details.url) ||
        isSandboxHostUrl(originHeader) ||
        isSandboxHostUrl(refererHeader);
      callback({
        requestHeaders: belongsToSandbox
          ? rewriteSandboxRequestHeaders(
              requestHeaders,
              defaultSession.getUserAgent(),
              this.#options,
            )
          : requestHeaders,
      });
    });
  }

  createHost(owner: WebContents): McpAppSandboxHost {
    if (!this.#installed) {
      throw new Error("MCP App sandbox coordinator is not installed");
    }
    const host = new McpAppSandboxHostState(
      this,
      owner,
      this.#options,
      this.#platform.showGuestContextMenu,
    );
    this.#hosts.add(host);
    return host;
  }

  consumeUserGesture(owner: WebContents, sandboxId: string, initId?: string): boolean {
    if (!this.#installed || owner.isDestroyed()) return false;
    for (const host of this.#hosts) {
      if (host.consumeUserGesture(owner, sandboxId, initId)) return true;
    }
    return false;
  }

  captureImage(
    owner: WebContents,
    sandboxId: string,
    initId: string,
  ): Effect.Effect<NativeImage, McpAppSandboxCaptureError> {
    if (!this.#installed || owner.isDestroyed())
      return Effect.fail(new McpAppSandboxCaptureError({ reason: "unavailable" }));
    for (const host of this.#hosts) {
      const capture = host.captureImage(owner, sandboxId, initId);
      if (capture) return capture;
    }
    return Effect.fail(new McpAppSandboxCaptureError({ reason: "unavailable" }));
  }

  releaseGuest(owner: WebContents, sandboxId: string, initId: string): boolean {
    if (!this.#installed || owner.isDestroyed()) return false;
    for (const host of this.#hosts) {
      if (host.releaseGuest(owner, sandboxId, initId)) return true;
    }
    return false;
  }

  setGuestPresentation(
    owner: WebContents,
    sandboxId: string,
    initId: string,
    active: boolean,
    revision: number,
  ): boolean {
    if (!this.#installed || owner.isDestroyed()) return false;
    for (const host of this.#hosts) {
      if (host.setGuestPresentation(owner, sandboxId, initId, active, revision)) return true;
    }
    return false;
  }

  release(): void {
    if (!this.#installed) return;
    this.#installed = false;
    const releaseBestEffort = (release: () => unknown): void => {
      try {
        release();
      } catch {
        // A broken Electron lease must not prevent the remaining sandbox graph from releasing.
      }
    };
    releaseBestEffort(() => this.#releaseGuestMessage?.());
    this.#releaseGuestMessage = null;
    releaseBestEffort(() => this.#platform.defaultSession.webRequest.onBeforeSendHeaders(null));
    for (const host of [...this.#hosts]) releaseBestEffort(() => host.release());
    for (const entries of this.#pendingBySession.values()) {
      for (const pending of entries) pending.cancelExpiration();
    }
    this.#pendingBySession.clear();
    this.#hostsByGuestId.clear();
    for (const [sandboxSession, onWillDownload] of this.#configuredSessions) {
      releaseBestEffort(() => sandboxSession.setPermissionCheckHandler(null));
      releaseBestEffort(() => sandboxSession.setPermissionRequestHandler(null));
      releaseBestEffort(() => sandboxSession.removeListener("will-download", onWillDownload));
      releaseBestEffort(() => sandboxSession.webRequest.onBeforeRequest(null));
      releaseBestEffort(() => sandboxSession.webRequest.onBeforeSendHeaders(null));
      releaseBestEffort(() => sandboxSession.protocol.unhandle(MCP_APP_SANDBOX_SCHEME));
    }
    this.#configuredSessions.clear();
  }

  configureSession(partition: string): Session {
    const sandboxSession = this.#platform.fromPartition(partition);
    if (this.#configuredSessions.has(sandboxSession)) return sandboxSession;
    const onWillDownload = (event: Electron.Event, item: Electron.DownloadItem): void => {
      event.preventDefault();
      item.cancel();
    };
    this.#configuredSessions.set(sandboxSession, onWillDownload);
    sandboxSession.setPermissionCheckHandler(() => false);
    sandboxSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
      callback(false);
    });
    sandboxSession.on("will-download", onWillDownload);
    sandboxSession.webRequest.onBeforeRequest((details, callback) => {
      callback({
        cancel: !isAllowedMcpAppSandboxRequestUrl(details.url, {
          allowLocalDevelopment: this.#options.allowLocalDevelopment,
        }),
      });
    });
    sandboxSession.webRequest.onBeforeSendHeaders((details, callback) => {
      callback({
        requestHeaders: rewriteSandboxRequestHeaders(
          details.requestHeaders,
          sandboxSession.getUserAgent(),
          this.#options,
        ),
      });
    });
    const protocolHandler = this.#protocolCache.createHandler();
    sandboxSession.protocol.handle(MCP_APP_SANDBOX_SCHEME, protocolHandler);
    return sandboxSession;
  }

  isConfiguredSession(sandboxSession: Session): boolean {
    return this.#configuredSessions.has(sandboxSession);
  }

  getProtocolCacheState(sourceUrl: string): McpAppSandboxCacheState {
    return this.#protocolCache.getState(sourceUrl);
  }

  prewarmProtocol(locale: string): Promise<void> {
    return this.#protocolCache.prewarm(locale);
  }

  registerPendingAttachment(state: OwnedMcpAppAttachment): void {
    const pending: PendingMcpAppAttachment = {
      cancelExpiration: () => undefined,
      state,
    };
    pending.cancelExpiration = this.scheduler.schedule(PENDING_ATTACHMENT_TTL_MS, () => {
      const entries = this.#pendingBySession.get(state.session);
      if (!entries) return;
      const remaining = entries.filter((entry) => entry !== pending);
      if (remaining.length === 0) {
        this.#pendingBySession.delete(state.session);
        return;
      }
      this.#pendingBySession.set(state.session, remaining);
    });
    const entries = this.#pendingBySession.get(state.session) ?? [];
    entries.push(pending);
    this.#pendingBySession.set(state.session, entries);
  }

  consumePendingAttachment(input: {
    initId: string | null;
    ownerWebContents: WebContents;
    session: Session;
  }): OwnedMcpAppAttachment | null {
    const entries = this.#pendingBySession.get(input.session);
    if (!entries) return null;
    const index = entries.findIndex(
      ({ state }) =>
        state.ownerWebContents.id === input.ownerWebContents.id &&
        (input.initId === null || state.initId === input.initId),
    );
    if (index < 0) return null;
    const [pending] = entries.splice(index, 1);
    if (!pending) return null;
    pending.cancelExpiration();
    if (entries.length === 0) this.#pendingBySession.delete(input.session);
    return pending.state;
  }

  releaseHost(host: McpAppSandboxHostState, owner: WebContents): void {
    this.#hosts.delete(host);
    for (const [guestId, registeredHost] of this.#hostsByGuestId) {
      if (registeredHost === host) this.#hostsByGuestId.delete(guestId);
    }
    for (const [sandboxSession, entries] of this.#pendingBySession) {
      const remaining = entries.filter((entry) => {
        if (entry.state.ownerWebContents.id !== owner.id) return true;
        entry.cancelExpiration();
        return false;
      });
      if (remaining.length === 0) {
        this.#pendingBySession.delete(sandboxSession);
      } else if (remaining.length !== entries.length) {
        this.#pendingBySession.set(sandboxSession, remaining);
      }
    }
  }

  registerGuest(guestId: number, host: McpAppSandboxHostState): void {
    this.#hostsByGuestId.set(guestId, host);
  }

  unregisterGuest(guestId: number): void {
    this.#hostsByGuestId.delete(guestId);
  }
}

class McpAppSandboxHostState implements McpAppSandboxHost {
  readonly #attachedGuests = new Map<number, AttachedMcpAppGuest>();
  readonly #coordinator: McpAppSandboxControllerState;
  readonly #options: McpAppSandboxHostOptions;
  readonly #owner: WebContents;
  readonly #showContextMenu: (owner: WebContents, guest: WebContents) => void;
  #disposed = false;
  readonly #onOwnerDestroyed = (): void => this.release();

  constructor(
    coordinator: McpAppSandboxControllerState,
    owner: WebContents,
    options: McpAppSandboxHostOptions,
    showContextMenu: (owner: WebContents, guest: WebContents) => void,
  ) {
    this.#coordinator = coordinator;
    this.#owner = owner;
    this.#options = options;
    this.#owner.once("destroyed", this.#onOwnerDestroyed);
    this.#showContextMenu = showContextMenu;
  }

  handlesPartition(partition: string | null | undefined): boolean {
    return isMcpAppSandboxPartition(partition);
  }

  handleWillAttach(
    event: Electron.Event,
    webPreferences: WebPreferences,
    rawParams: McpWebviewParams,
  ): void {
    if (this.#disposed) {
      event.preventDefault();
      return;
    }

    const decision = decideMcpAppWebviewAttachment({
      partition: rawParams.partition,
      src: rawParams.src,
    });
    if (!decision.ok) {
      this.#options.logger.warn("Rejected MCP App webview attachment", {
        ownerWebContentsId: this.#owner.id,
        reason: decision.reason,
      });
      event.preventDefault();
      return;
    }

    const partition = rawParams.partition ?? "";
    const sandboxSession = this.#coordinator.configureSession(partition);
    const sourceUrl = decision.source.sourceUrl;
    const cacheState = this.#coordinator.getProtocolCacheState(sourceUrl);
    this.#coordinator.registerPendingAttachment({
      initId: decision.initId,
      origin: decision.source.origin,
      ownerWebContents: this.#owner,
      partition,
      sandboxId: decision.sandboxId,
      session: sandboxSession,
      skybridgeCacheState: cacheState,
      source: decision.source,
      sourceUrl,
    });
    void this.#coordinator.prewarmProtocol(decision.source.locale).catch((error: unknown) => {
      this.#options.logger.warn("MCP App sandbox prewarm failed", {
        error,
        partition,
      });
    });

    Object.assign(webPreferences, {
      allowRunningInsecureContent: false,
      contextIsolation: true,
      devTools: true,
      disableDialogs: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      plugins: false,
      preload: this.#options.guestPreloadPath,
      sandbox: true,
      session: sandboxSession,
      webSecurity: true,
      webviewTag: false,
    });
    rawParams.partition = partition;
    delete rawParams.nodeintegration;
    delete rawParams.preload;
    delete rawParams.webpreferences;
    delete (webPreferences as WebPreferences & { preloadURL?: string }).preloadURL;
  }

  handleDidAttach(guest: WebContents): boolean {
    const source = parseMcpAppSandboxSourceUrl(guest.getURL());
    const pending = this.#coordinator.consumePendingAttachment({
      initId: source?.initId ?? null,
      ownerWebContents: this.#owner,
      session: guest.session,
    });
    if (!pending) {
      if (!this.#coordinator.isConfiguredSession(guest.session)) return false;
      this.#options.logger.warn("Rejected unmatched MCP App guest", {
        guestWebContentsId: guest.id,
        ownerWebContentsId: this.#owner.id,
      });
      guest.close();
      return true;
    }

    if (
      guest.session !== pending.session ||
      pending.ownerWebContents.id !== this.#owner.id ||
      this.#owner.isDestroyed()
    ) {
      this.#options.logger.warn("Rejected mismatched MCP App guest", {
        guestWebContentsId: guest.id,
        ownerWebContentsId: this.#owner.id,
      });
      guest.close();
      return true;
    }

    const attached: AttachedMcpAppGuest = {
      ...pending,
      guest,
      active: true,
      presentationRevision: 0,
    };
    this.#attachedGuests.set(guest.id, attached);
    this.#coordinator.registerGuest(guest.id, this);
    this.#installGuestPolicy(attached);
    return true;
  }

  release(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#owner.removeListener("destroyed", this.#onOwnerDestroyed);
    for (const attached of this.#attachedGuests.values()) {
      this.#coordinator.unregisterGuest(attached.guest.id);
      if (!attached.guest.isDestroyed()) attached.guest.close();
    }
    this.#attachedGuests.clear();
    this.#coordinator.releaseHost(this, this.#owner);
  }

  consumeUserGesture(owner: WebContents, sandboxId: string, initId?: string): boolean {
    if (this.#disposed || this.#owner.id !== owner.id) return false;
    const attached = [...this.#attachedGuests.values()].find(
      (value) => value.sandboxId === sandboxId && (initId === undefined || value.initId === initId),
    );
    if (!attached || !attached.active || attached.guest.isDestroyed()) return false;
    const timestamp = attached.lastUserGestureAt;
    delete attached.lastUserGestureAt;
    return timestamp !== undefined && performance.now() - timestamp <= 5_000;
  }

  captureImage(
    owner: WebContents,
    sandboxId: string,
    initId: string,
  ): Effect.Effect<NativeImage, McpAppSandboxCaptureError> | null {
    if (this.#disposed || this.#owner.id !== owner.id) return null;
    const attached = [...this.#attachedGuests.values()].find(
      (value) => value.sandboxId === sandboxId && value.initId === initId,
    );
    if (!attached) return null;
    const presentationRevision = attached.presentationRevision;
    const isCurrent = () =>
      !this.#disposed &&
      !owner.isDestroyed() &&
      this.#attachedGuests.get(attached.guest.id) === attached &&
      attached.active &&
      attached.presentationRevision === presentationRevision &&
      !attached.guest.isDestroyed();
    return Effect.suspend(() => {
      if (!isCurrent())
        return Effect.fail(new McpAppSandboxCaptureError({ reason: "unavailable" }));
      return Effect.tryPromise({
        try: () => attached.guest.capturePage(),
        catch: (cause) => new McpAppSandboxCaptureError({ reason: "failed", cause }),
      }).pipe(
        Effect.flatMap((image) =>
          isCurrent()
            ? Effect.succeed(image)
            : Effect.fail(new McpAppSandboxCaptureError({ reason: "retired" })),
        ),
      );
    });
  }

  releaseGuest(owner: WebContents, sandboxId: string, initId: string): boolean {
    if (this.#disposed || this.#owner.id !== owner.id) return false;
    const attached = [...this.#attachedGuests.values()].find(
      (value) => value.sandboxId === sandboxId && value.initId === initId,
    );
    if (!attached) return false;
    this.#attachedGuests.delete(attached.guest.id);
    this.#coordinator.unregisterGuest(attached.guest.id);
    if (!attached.guest.isDestroyed()) attached.guest.close();
    return true;
  }

  setGuestPresentation(
    owner: WebContents,
    sandboxId: string,
    initId: string,
    active: boolean,
    revision: number,
  ): boolean {
    if (this.#disposed || this.#owner.id !== owner.id) return false;
    if (!Number.isSafeInteger(revision) || revision < 1) return false;
    const attached = [...this.#attachedGuests.values()].find(
      (value) => value.sandboxId === sandboxId && value.initId === initId,
    );
    if (!attached || attached.guest.isDestroyed()) return false;
    if (revision < attached.presentationRevision) return false;
    if (revision === attached.presentationRevision) return attached.active === active;
    attached.presentationRevision = revision;
    attached.active = active;
    delete attached.lastUserGestureAt;
    return true;
  }

  #installGuestPolicy(attached: AttachedMcpAppGuest): void {
    const { guest, sourceUrl } = attached;
    guest.on("before-mouse-event", (_event, input) => {
      if (!attached.active) return;
      if (input.type !== "mouseDown") return;
      attached.lastUserGestureAt = performance.now();
      guest.focus();
    });
    guest.on("before-input-event", (_event, input) => {
      if (!attached.active) return;
      if (input.type !== "keyDown" || input.isAutoRepeat || !["Enter", " "].includes(input.key))
        return;
      attached.lastUserGestureAt = performance.now();
    });
    guest.setWindowOpenHandler(() => ({ action: "deny" }));
    guest.on("will-navigate", (event, url) => {
      const navigation = event as Electron.Event & { url?: string };
      const candidate = navigation.url ?? url;
      if (!isSameSandboxDocument(sourceUrl, candidate)) event.preventDefault();
    });
    guest.on("will-frame-navigate", (event) => {
      const navigation = event as Electron.Event & {
        isMainFrame: boolean;
        url: string;
      };
      const shouldBlock = navigation.isMainFrame
        ? !isSameSandboxDocument(sourceUrl, navigation.url)
        : isBlockedSandboxSubframeUrl(navigation.url);
      if (shouldBlock) event.preventDefault();
    });
    guest.on("will-redirect", (event, url, _isInPlace, isMainFrame) => {
      const redirect = event as Electron.Event & {
        isMainFrame?: boolean;
        url?: string;
      };
      const candidate = redirect.url ?? url;
      const redirectIsMainFrame = redirect.isMainFrame ?? isMainFrame;
      const shouldBlock = redirectIsMainFrame
        ? !isSameSandboxDocument(sourceUrl, candidate)
        : isBlockedSandboxSubframeUrl(candidate);
      if (shouldBlock) event.preventDefault();
    });
    guest.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
      if (code === -3) return;
      this.#options.logger.warn("MCP App guest failed to load", {
        code,
        description,
        guestWebContentsId: guest.id,
        isMainFrame,
        url,
      });
    });
    guest.on("preload-error", (_event, preloadPath, error) => {
      this.#options.logger.error("MCP App guest preload failed", {
        error,
        guestWebContentsId: guest.id,
        preloadPath,
      });
    });
    guest.on("render-process-gone", (_event, details) => {
      if (details.reason === "clean-exit") return;
      this.#options.logger.warn("MCP App guest renderer exited", {
        details,
        guestWebContentsId: guest.id,
      });
    });
    guest.on("context-menu", () => {
      this.#showContextMenu(attached.ownerWebContents, guest);
    });
    guest.once("destroyed", () => {
      this.#attachedGuests.delete(guest.id);
      this.#coordinator.unregisterGuest(guest.id);
    });
  }

  handleGuestMessage(event: IpcMainEvent, rawMessage: unknown): void {
    const attached = this.#attachedGuests.get(event.sender.id);
    if (!attached || this.#owner.isDestroyed()) return;

    const message = parseMcpAppSandboxGuestInitMessage(rawMessage);
    if (
      !message ||
      message.initId !== attached.initId ||
      message.origin !== attached.origin ||
      message.portNames.length + 1 !== event.ports.length
    ) {
      this.#options.logger.warn("Rejected MCP App guest port handoff", {
        guestWebContentsId: event.sender.id,
        ownerWebContentsId: this.#owner.id,
      });
      return;
    }

    const hostMessage: McpAppSandboxHostInitMessage = {
      ...message,
      sandboxId: attached.sandboxId,
      ...(attached.skybridgeCacheState
        ? { skybridgeCacheState: attached.skybridgeCacheState }
        : {}),
    };
    this.#owner.postMessage(MCP_APP_SANDBOX_HOST_MESSAGE_CHANNEL, hostMessage, event.ports);
  }
}

/** Acquires the entire process/partition/owner sandbox graph under one Main Scope. */
export const makeMcpAppSandboxController = (
  options: McpAppSandboxHostOptions,
  protocolCache: McpAppSandboxProtocolCache,
  scheduler: McpAppSandboxScheduler,
  platform: McpAppSandboxPlatform,
): Effect.Effect<McpAppSandboxController, never, Scope.Scope> =>
  Effect.gen(function* () {
    const state = new McpAppSandboxControllerState(options, protocolCache, scheduler, platform);
    yield* Effect.addFinalizer(() => Effect.sync(() => state.release()));
    yield* Effect.sync(() => state.install());
    return {
      createHost: (owner) => state.createHost(owner),
      consumeUserGesture: (owner, sandboxId, initId) =>
        state.consumeUserGesture(owner, sandboxId, initId),
      captureImage: (owner, sandboxId, initId) => state.captureImage(owner, sandboxId, initId),
      releaseGuest: (owner, sandboxId, initId) => state.releaseGuest(owner, sandboxId, initId),
      setGuestPresentation: (owner, sandboxId, initId, active, revision) =>
        state.setGuestPresentation(owner, sandboxId, initId, active, revision),
    };
  });
