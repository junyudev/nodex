import { randomUUID } from "node:crypto";
import type { BrowserWindow } from "electron";
import {
  compileMacNativeHotkey,
  DEFAULT_KEYBOARD_LAYOUT_SNAPSHOT,
  getPrimaryCommandAccelerator,
  type CommandKeybindingRejection,
  type CommandKeymapState,
  type KeyboardLayoutSnapshot,
  type MacNativeHotkeySpec,
} from "../../shared/command-keybindings";
import type {
  DictationError,
  DictationSettings,
  GlobalDictationPermissionSnapshot,
} from "../../shared/dictation";
import {
  GLOBAL_DICTATION_COMMAND_CHANNEL,
  type GlobalDictationManagerSnapshot,
  type GlobalDictationRendererCommand,
  type GlobalDictationRendererEvent,
  type GlobalDictationTarget,
} from "../../shared/global-dictation";
import type {
  MacDictationHelperEvent,
  MacDictationNativeHelperClient,
} from "./mac-dictation-native-helper-client";
import { MacDictationHelperRequestError } from "./mac-dictation-native-helper-client";
import type { ClipboardSafePasteService } from "./clipboard-safe-paste-service";
import { ClipboardSafePasteError } from "./clipboard-safe-paste-service";
import type { GlobalDictationWindowController } from "./global-dictation-window-controller";
import {
  acquireGlobalDictationOwnership,
  type GlobalDictationOwnershipLease,
} from "./global-dictation-ownership-lock";

const IN_APP_ACCEPT_TIMEOUT_MS = 150;
const GLOBAL_BINDINGS = [
  { commandId: "globalDictationHold", bindingId: "global-dictation-hold", mode: "hold" },
  { commandId: "globalDictationToggle", bindingId: "global-dictation-toggle", mode: "toggle" },
] as const;

interface ActiveGlobalSession {
  readonly sessionId: string;
  readonly requestId: string;
  readonly target: GlobalDictationTarget;
  readonly gesture: "hold" | "toggle";
  owner: "pending-in-app" | "in-app" | "overlay";
  senderWebContentsId: number | null;
  acceptTimer: ReturnType<typeof setTimeout> | null;
  transcript: string | null;
  stopRequested: boolean;
}

type RuntimeHealth = "starting" | "ready" | "degraded" | "stopped";

type GlobalDictationHelperPort = Pick<
  MacDictationNativeHelperClient,
  | "captureFn"
  | "queryBuiltInMicrophoneName"
  | "capabilities"
  | "requestAccessibility"
  | "requestInputMonitoring"
  | "replaceBindings"
  | "subscribe"
>;

type GlobalDictationWindowPort = Pick<
  GlobalDictationWindowController,
  | "ensureWindow"
  | "close"
  | "hide"
  | "markRendererReady"
  | "ownsWebContents"
  | "prewarm"
  | "send"
  | "setInteractive"
  | "showAndStart"
  | "showIdle"
  | "subscribeTerminal"
>;

const helperRejection = (error: unknown): CommandKeybindingRejection | null => {
  if (!(error instanceof MacDictationHelperRequestError)) return null;
  if (error.code === "input-monitoring-denied") {
    return {
      kind: "permission-required",
      message: "Input Monitoring permission is required for global shortcuts.",
    };
  }
  if (error.code === "hotkey-conflict") {
    return { kind: "conflict", message: "This shortcut is already in use." };
  }
  if (error.code === "invalid-hotkey") {
    return { kind: "unsupported-key", message: "This shortcut key is not supported." };
  }
  return null;
};

/** Owns global-dictation policy; helper/window lifetimes belong to the surrounding Effect Scope. */
export class GlobalDictationManager {
  readonly #helper: GlobalDictationHelperPort;
  readonly #windowController: GlobalDictationWindowPort;
  readonly #pasteService: Pick<ClipboardSafePasteService, "paste">;
  readonly #readKeepVisiblePreference: () => Promise<boolean | null>;
  readonly #writeKeepVisiblePreference: (value: boolean) => Promise<void>;
  readonly #acquireOwnership: (onLost: () => void) => GlobalDictationOwnershipLease | null;
  readonly #getFocusedAppWindow: () => BrowserWindow | null;
  readonly #getAppWindowByWebContentsId: (webContentsId: number) => BrowserWindow | null;
  readonly #onRecoveryNeeded: () => void;
  readonly #platform: NodeJS.Platform;
  readonly #listeners = new Set<() => void>();
  readonly #appliedBindings = new Map<string, MacNativeHotkeySpec>();
  #snapshot: GlobalDictationManagerSnapshot = { kind: "idle" };
  #active: ActiveGlobalSession | null = null;
  #keepVisible = false;
  #health: RuntimeHealth;
  #enabled = false;
  #desiredCommandKeymap: CommandKeymapState | null = null;
  #keyboardLayout = DEFAULT_KEYBOARD_LAYOUT_SNAPSHOT;
  #configurationGeneration = 0;
  #configurationTail: Promise<void> = Promise.resolve();
  #ownership: GlobalDictationOwnershipLease | null = null;
  #disposed = false;
  readonly #unsubscribeHelper: () => void;
  readonly #unsubscribeWindowTerminal: () => void;

  constructor(options: {
    readonly helper: GlobalDictationHelperPort;
    readonly windowController: GlobalDictationWindowPort;
    readonly pasteService: Pick<ClipboardSafePasteService, "paste">;
    readonly readSettings: () => Promise<DictationSettings>;
    readonly readKeepVisiblePreference?: () => Promise<boolean | null>;
    readonly writeKeepVisiblePreference?: (value: boolean) => Promise<void>;
    readonly acquireOwnership?: (onLost: () => void) => GlobalDictationOwnershipLease | null;
    readonly getFocusedAppWindow: () => BrowserWindow | null;
    readonly getAppWindowByWebContentsId: (webContentsId: number) => BrowserWindow | null;
    readonly onRecoveryNeeded?: () => void;
    readonly platform?: NodeJS.Platform;
  }) {
    this.#helper = options.helper;
    this.#windowController = options.windowController;
    this.#pasteService = options.pasteService;
    this.#readKeepVisiblePreference =
      options.readKeepVisiblePreference ??
      (async () => (await options.readSettings()).keepGlobalBarVisible);
    this.#writeKeepVisiblePreference =
      options.writeKeepVisiblePreference ?? (async () => undefined);
    this.#acquireOwnership =
      options.acquireOwnership ?? ((onLost) => acquireGlobalDictationOwnership({ onLost }));
    this.#getFocusedAppWindow = options.getFocusedAppWindow;
    this.#getAppWindowByWebContentsId = options.getAppWindowByWebContentsId;
    this.#onRecoveryNeeded = options.onRecoveryNeeded ?? (() => undefined);
    this.#platform = options.platform ?? process.platform;
    this.#health = this.#platform === "darwin" ? "starting" : "stopped";
    this.#unsubscribeHelper = this.#helper.subscribe((event) => this.#onHelperEvent(event));
    this.#unsubscribeWindowTerminal = this.#windowController.subscribeTerminal(
      (webContentsId, reason) => {
        this.handleWebContentsGone(webContentsId);
        if (reason === "unexpected") this.#syncIdlePresentation();
      },
    );
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  readonly getSnapshot = (): GlobalDictationManagerSnapshot => this.#snapshot;

  readonly isAvailable = (): boolean => this.#platform === "darwin" && this.#health === "ready";

  readonly ownsRenderer = (webContentsId: number): boolean =>
    this.#windowController.ownsWebContents(webContentsId);

  async initialize(state: CommandKeymapState): Promise<CommandKeybindingRejection | null> {
    return await this.#withConfigurationLease(async () => {
      if (this.#platform !== "darwin" || this.#disposed) return null;
      this.#desiredCommandKeymap = state;
      this.#keepVisible =
        (await this.#readKeepVisiblePreference()) ?? this.#hasConfiguredHotkey(state);
      const rejection = await this.#applyDesiredBindings();
      this.#syncIdlePresentation();
      return rejection;
    });
  }

  async syncCommandKeymap(state: CommandKeymapState): Promise<CommandKeybindingRejection | null> {
    return await this.#withConfigurationLease(async () => {
      if (this.#platform !== "darwin" || this.#disposed) return null;
      const compiled = this.#compileBindings(state);
      if (compiled.type === "rejected") return compiled.reason;
      const hadConfiguredHotkey = this.#hasConfiguredHotkey(this.#desiredCommandKeymap);
      const hasConfiguredHotkey = compiled.bindings.length > 0;
      if (!this.#enabled) {
        this.#desiredCommandKeymap = state;
        await this.#syncKeepVisibleForHotkeyTransition(hadConfiguredHotkey, hasConfiguredHotkey);
        return null;
      }
      if (hasConfiguredHotkey && !this.#ensureOwnership()) {
        return this.#ownershipConflict();
      }
      const generation = this.#configurationGeneration + 1;
      try {
        await this.#helper.replaceBindings({ generation, bindings: compiled.bindings });
      } catch (error) {
        const rejection = helperRejection(error);
        if (rejection) {
          if (this.#appliedBindings.size === 0) this.#releaseOwnership();
          return rejection;
        }
        this.#markDegraded();
        return {
          kind: "runtime-degraded",
          message: "Global dictation is recovering. Try the shortcut again in a moment.",
        };
      }
      this.#desiredCommandKeymap = state;
      this.#adoptBindings(compiled.bindings, generation);
      await this.#syncKeepVisibleForHotkeyTransition(hadConfiguredHotkey, hasConfiguredHotkey);
      return null;
    });
  }

  /** Makes a durable rollback authoritative even when the helper cannot apply it immediately. */
  async restoreCommandKeymap(state: CommandKeymapState): Promise<void> {
    await this.#withConfigurationLease(async () => {
      if (this.#platform !== "darwin" || this.#disposed) return;
      const hadConfiguredHotkey = this.#hasConfiguredHotkey(this.#desiredCommandKeymap);
      const hasConfiguredHotkey = this.#hasConfiguredHotkey(state);
      this.#desiredCommandKeymap = state;
      if (this.#enabled) {
        const rejection = await this.#applyDesiredBindings();
        if (rejection) throw new MacDictationHelperRequestError(rejection.kind, rejection.message);
      }
      await this.#syncKeepVisibleForHotkeyTransition(hadConfiguredHotkey, hasConfiguredHotkey);
    });
  }

  async updateKeyboardLayout(snapshot: KeyboardLayoutSnapshot): Promise<boolean> {
    return await this.#withConfigurationLease(async () => {
      if (this.#disposed || this.#hasKeyboardLayout(snapshot)) return false;
      this.#keyboardLayout = snapshot;
      if (!this.#enabled || !this.#desiredCommandKeymap) return true;
      const rejection = await this.#applyDesiredBindings();
      return rejection === null;
    });
  }

  /** Recreates helper transport state from durable desired configuration after a crash. */
  async recover(): Promise<void> {
    await this.#withConfigurationLease(async () => {
      if (this.#disposed || this.#platform !== "darwin" || !this.#enabled) return;
      this.#health = "starting";
      this.#publish(this.#snapshot);
      const rejection = await this.#applyDesiredBindings(false);
      if (rejection) {
        this.#health = "degraded";
        this.#publish(this.#snapshot);
      }
    });
  }

  captureFnHotkey(): Promise<"Fn"> {
    if (this.#platform !== "darwin") {
      return Promise.reject(new Error("Global dictation is macOS-only"));
    }
    return this.#helper.captureFn();
  }

  queryBuiltInMicrophoneName(): Promise<string | null> {
    if (this.#platform !== "darwin") return Promise.resolve(null);
    return this.#helper.queryBuiltInMicrophoneName();
  }

  async readPermissions(): Promise<GlobalDictationPermissionSnapshot> {
    if (this.#platform !== "darwin") {
      return { available: false, inputMonitoring: false, accessibility: false };
    }
    const capabilities = await this.#helper.capabilities(false);
    return { available: true, ...capabilities };
  }

  async requestInputMonitoring(): Promise<GlobalDictationPermissionSnapshot> {
    if (this.#platform !== "darwin") return await this.readPermissions();
    await this.#withConfigurationLease(async () => {
      const granted = await this.#helper.requestInputMonitoring();
      if (granted && this.#desiredCommandKeymap) await this.#applyDesiredBindings();
    });
    return await this.readPermissions();
  }

  async requestAccessibility(): Promise<GlobalDictationPermissionSnapshot> {
    if (this.#platform !== "darwin") return await this.readPermissions();
    await this.#helper.requestAccessibility();
    return await this.readPermissions();
  }

  handleRendererEvent(senderWebContentsId: number, event: GlobalDictationRendererEvent): boolean {
    if (this.#disposed) return false;
    if (event.type === "ready") {
      const accepted = this.#windowController.markRendererReady(senderWebContentsId);
      if (accepted && !this.#active) this.#syncIdlePresentation();
      return accepted;
    }
    if (event.type === "interactive") {
      if (this.#windowController.ownsWebContents(senderWebContentsId)) {
        this.#windowController.setInteractive(event.enabled);
      }
      return this.#windowController.ownsWebContents(senderWebContentsId);
    }
    if (event.type === "close") {
      if (!this.#windowController.ownsWebContents(senderWebContentsId)) return false;
      const active = this.#active;
      if (event.sessionId !== (active?.sessionId ?? null)) return false;
      if (active) {
        this.#sendToOwner(active, { type: "cancel", sessionId: active.sessionId });
        if (active.acceptTimer) clearTimeout(active.acceptTimer);
        this.#active = null;
        this.#publish({ kind: "idle" });
      }
      this.#windowController.close();
      return true;
    }
    const active = this.#active;
    if (!active || ("sessionId" in event && event.sessionId !== active.sessionId)) return false;
    if (event.type === "declined") {
      if (
        active.owner !== "pending-in-app" ||
        senderWebContentsId !== active.senderWebContentsId ||
        event.requestId !== active.requestId
      ) {
        return false;
      }
      this.#routeToOverlay(active);
      return true;
    }
    if (event.type === "accepted") {
      if (event.requestId !== active.requestId) return false;
      if (active.owner === "pending-in-app" && senderWebContentsId === active.senderWebContentsId) {
        if (active.acceptTimer) clearTimeout(active.acceptTimer);
        active.acceptTimer = null;
        active.owner = "in-app";
        this.#publish({ kind: "recording", sessionId: active.sessionId, owner: "in-app" });
        return true;
      }
      if (
        active.owner === "overlay" &&
        this.#windowController.ownsWebContents(senderWebContentsId)
      ) {
        this.#publish({ kind: "recording", sessionId: active.sessionId, owner: "overlay" });
        return true;
      }
      return false;
    }
    if (senderWebContentsId !== active.senderWebContentsId) return false;
    if (event.type === "state") {
      this.#publish({
        kind: event.state === "listening" ? "recording" : "transcribing",
        sessionId: active.sessionId,
        owner: active.owner === "in-app" ? "in-app" : "overlay",
      });
      return true;
    }
    if (event.type === "completed" && this.#snapshot.kind === "pasting") return false;
    if (event.type === "completed") {
      if (active.owner === "in-app") {
        this.#finishActive();
        return true;
      }
      active.transcript = event.transcript;
      void this.#pasteActive(active);
      return true;
    }
    if (event.type === "failed") {
      this.#publish({ kind: "retryable-error", sessionId: active.sessionId, error: event.error });
      return true;
    }
    if (event.type === "cancelled" || event.type === "dismiss") {
      this.#finishActive();
      return true;
    }
    return false;
  }

  async setEnabled(enabled: boolean): Promise<void> {
    await this.#withConfigurationLease(async () => {
      if (this.#disposed || this.#enabled === enabled) return;
      this.#enabled = enabled;
      if (!enabled) {
        if (this.#active) {
          this.#sendToOwner(this.#active, { type: "cancel", sessionId: this.#active.sessionId });
          this.#finishActive();
        }
        const generation = this.#configurationGeneration + 1;
        await this.#helper.replaceBindings({ generation, bindings: [] });
        this.#adoptBindings([], generation);
        this.#windowController.close();
        return;
      }
      if (!this.#desiredCommandKeymap) return;
      const rejection = await this.#applyDesiredBindings();
      if (rejection) throw new MacDictationHelperRequestError(rejection.kind, rejection.message);
    });
  }

  syncSettings(settings: DictationSettings): void {
    if (this.#disposed || this.#platform !== "darwin") return;
    this.#keepVisible = settings.keepGlobalBarVisible;
    this.#syncIdlePresentation();
  }

  handleWebContentsGone(webContentsId: number): void {
    const active = this.#active;
    if (active?.senderWebContentsId !== webContentsId) return;
    if (active.acceptTimer) clearTimeout(active.acceptTimer);
    this.#active = null;
    this.#publish({ kind: "idle" });
    this.#syncIdlePresentation();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#health = "stopped";
    this.#unsubscribeHelper();
    this.#unsubscribeWindowTerminal();
    const active = this.#active;
    if (active?.acceptTimer) clearTimeout(active.acceptTimer);
    if (active) this.#sendToOwner(active, { type: "cancel", sessionId: active.sessionId });
    this.#active = null;
    this.#appliedBindings.clear();
    this.#publish({ kind: "idle" });
    this.#listeners.clear();
    this.#releaseOwnership();
    this.#windowController.close();
  }

  #compileBindings(
    state: CommandKeymapState,
  ):
    | { readonly type: "compiled"; readonly bindings: readonly MacNativeHotkeySpec[] }
    | { readonly type: "rejected"; readonly reason: CommandKeybindingRejection } {
    const bindings: MacNativeHotkeySpec[] = [];
    for (const binding of GLOBAL_BINDINGS) {
      const accelerator = getPrimaryCommandAccelerator(state, binding.commandId);
      if (!accelerator) continue;
      const compiled = compileMacNativeHotkey({
        accelerator,
        bindingId: binding.bindingId,
        mode: binding.mode,
        layout: this.#keyboardLayout,
      });
      if (compiled.type === "rejected") return compiled;
      bindings.push(compiled.spec);
    }
    return { type: "compiled", bindings };
  }

  async #applyDesiredBindings(requestRecovery = true): Promise<CommandKeybindingRejection | null> {
    const desired = this.#desiredCommandKeymap;
    if (!desired || !this.#enabled) {
      this.#health = "ready";
      this.#publish(this.#snapshot);
      return null;
    }
    const compiled = this.#compileBindings(desired);
    if (compiled.type === "rejected") return compiled.reason;
    if (compiled.bindings.length > 0 && !this.#ensureOwnership()) {
      return this.#ownershipConflict();
    }
    const generation = this.#configurationGeneration + 1;
    try {
      await this.#helper.replaceBindings({ generation, bindings: compiled.bindings });
    } catch (error) {
      const rejection = helperRejection(error);
      if (rejection) {
        if (this.#appliedBindings.size === 0) this.#releaseOwnership();
        return rejection;
      }
      this.#markDegraded(requestRecovery);
      throw error;
    }
    this.#adoptBindings(compiled.bindings, generation);
    return null;
  }

  #adoptBindings(bindings: readonly MacNativeHotkeySpec[], generation: number): void {
    if (this.#disposed) return;
    if (this.#active) {
      this.#sendToOwner(this.#active, { type: "cancel", sessionId: this.#active.sessionId });
      this.#finishActive();
    }
    this.#configurationGeneration = generation;
    this.#appliedBindings.clear();
    for (const binding of bindings) this.#appliedBindings.set(binding.bindingId, binding);
    if (bindings.length === 0) this.#releaseOwnership();
    this.#health = "ready";
    this.#publish(this.#snapshot);
    this.#syncIdlePresentation();
  }

  #markDegraded(requestRecovery = true): void {
    if (this.#disposed) return;
    this.#health = "degraded";
    this.#appliedBindings.clear();
    if (this.#active) {
      this.#sendToOwner(this.#active, { type: "cancel", sessionId: this.#active.sessionId });
      this.#finishActive();
    }
    this.#publish(this.#snapshot);
    if (requestRecovery) this.#onRecoveryNeeded();
  }

  #ensureOwnership(): boolean {
    if (this.#ownership?.isOwner()) return true;
    this.#ownership?.dispose();
    this.#ownership = this.#acquireOwnership(() => {
      this.#ownership = null;
      void this.#withConfigurationLease(async () => {
        if (this.#disposed) return;
        const active = this.#active;
        if (active?.acceptTimer) clearTimeout(active.acceptTimer);
        if (active) this.#sendToOwner(active, { type: "cancel", sessionId: active.sessionId });
        this.#active = null;
        const generation = this.#configurationGeneration + 1;
        try {
          await this.#helper.replaceBindings({ generation, bindings: [] });
        } catch {
          // Ownership is already gone; local teardown must still converge immediately.
        }
        this.#configurationGeneration = generation;
        this.#appliedBindings.clear();
        this.#health = "degraded";
        this.#publish({ kind: "idle" });
        this.#windowController.close();
      });
    });
    return this.#ownership !== null;
  }

  #releaseOwnership(): void {
    this.#ownership?.dispose();
    this.#ownership = null;
  }

  #ownershipConflict(): CommandKeybindingRejection {
    this.#markDegraded(false);
    this.#windowController.close();
    return {
      kind: "conflict",
      message: "Global dictation is already active in another Nodex instance.",
    };
  }

  #hasConfiguredHotkey(state: CommandKeymapState | null): boolean {
    if (!state) return false;
    return GLOBAL_BINDINGS.some(
      ({ commandId }) => getPrimaryCommandAccelerator(state, commandId) !== null,
    );
  }

  async #syncKeepVisibleForHotkeyTransition(
    hadConfiguredHotkey: boolean,
    hasConfiguredHotkey: boolean,
  ): Promise<void> {
    const nextKeepVisible =
      !hadConfiguredHotkey && hasConfiguredHotkey
        ? true
        : hasConfiguredHotkey
          ? this.#keepVisible
          : false;
    if (nextKeepVisible === this.#keepVisible) return;
    this.#keepVisible = nextKeepVisible;
    this.#syncIdlePresentation();
    await this.#writeKeepVisiblePreference(nextKeepVisible);
  }

  #hasKeyboardLayout(snapshot: KeyboardLayoutSnapshot): boolean {
    const currentEntries = this.#keyboardLayout.entries;
    const nextEntries = snapshot.entries;
    const currentKeys = Object.keys(currentEntries);
    const nextKeys = Object.keys(nextEntries);
    return (
      currentKeys.length === nextKeys.length &&
      currentKeys.every((key) =>
        Object.prototype.hasOwnProperty.call(nextEntries, key)
          ? nextEntries[key as keyof typeof nextEntries] ===
            currentEntries[key as keyof typeof currentEntries]
          : false,
      )
    );
  }

  #onHelperEvent(event: MacDictationHelperEvent): void {
    if (this.#disposed) return;
    if (event.type === "crashed") {
      this.#markDegraded();
      return;
    }
    if (event.configurationGeneration !== this.#configurationGeneration) return;
    const binding = this.#appliedBindings.get(event.bindingId);
    if (!binding || binding.mode !== event.mode) return;
    if (event.type === "pressed") {
      if (binding.mode === "toggle" && this.#active) {
        this.#stopActive();
        return;
      }
      if (!this.#enabled || this.#active || !event.target) return;
      this.#begin({ target: event.target, gesture: binding.mode });
      return;
    }
    if (binding.mode === "hold") this.#stopActive();
  }

  #begin(input: {
    readonly target: GlobalDictationTarget;
    readonly gesture: "hold" | "toggle";
  }): void {
    const session: ActiveGlobalSession = {
      sessionId: randomUUID(),
      requestId: randomUUID(),
      target: input.target,
      gesture: input.gesture,
      owner: "overlay",
      senderWebContentsId: null,
      acceptTimer: null,
      transcript: null,
      stopRequested: false,
    };
    this.#active = session;
    const focused = input.target.pid === process.pid ? this.#getFocusedAppWindow() : null;
    if (focused && !focused.isDestroyed()) {
      session.owner = "pending-in-app";
      session.senderWebContentsId = focused.webContents.id;
      this.#publish({ kind: "routing-in-app", sessionId: session.sessionId });
      focused.webContents.send(GLOBAL_DICTATION_COMMAND_CHANNEL, {
        type: "start",
        sessionId: session.sessionId,
        requestId: session.requestId,
        deadlineAtMs: Date.now() + IN_APP_ACCEPT_TIMEOUT_MS,
        gesture: session.gesture,
      });
      session.acceptTimer = setTimeout(() => {
        if (this.#active !== session || session.owner !== "pending-in-app") return;
        this.#routeToOverlay(session);
      }, IN_APP_ACCEPT_TIMEOUT_MS);
      return;
    }
    this.#routeToOverlay(session);
  }

  #routeToOverlay(session: ActiveGlobalSession): void {
    if (session.owner === "pending-in-app" && session.senderWebContentsId !== null) {
      this.#sendToOwner(session, { type: "cancel", sessionId: session.sessionId });
      if (this.#active !== session) return;
    }
    if (session.acceptTimer) clearTimeout(session.acceptTimer);
    session.acceptTimer = null;
    session.owner = "overlay";
    let window: BrowserWindow;
    try {
      window = this.#windowController.ensureWindow();
    } catch {
      this.#finishActive();
      return;
    }
    session.senderWebContentsId = window.webContents.id;
    this.#publish({ kind: "overlay-starting", sessionId: session.sessionId });
    void this.#startOverlay(session);
  }

  async #startOverlay(session: ActiveGlobalSession): Promise<void> {
    if (this.#active !== session || session.owner !== "overlay") return;
    const shown = await this.#windowController.showAndStart({
      type: "start",
      sessionId: session.sessionId,
      requestId: session.requestId,
      deadlineAtMs: Number.MAX_SAFE_INTEGER,
      gesture: session.gesture,
    });
    if (this.#active !== session || session.owner !== "overlay") return;
    if (!shown) {
      this.#finishActive();
      return;
    }
    if (session.stopRequested) {
      this.#windowController.send({ type: "stop", sessionId: session.sessionId });
    }
  }

  #stopActive(): void {
    const active = this.#active;
    if (!active) return;
    active.stopRequested = true;
    if (active.owner === "pending-in-app") {
      this.#routeToOverlay(active);
      return;
    }
    if (active.owner !== "overlay" || active.senderWebContentsId !== null) {
      this.#sendToOwner(active, { type: "stop", sessionId: active.sessionId });
    }
  }

  #sendToOwner(
    active: ActiveGlobalSession,
    command: { readonly type: "stop" | "cancel"; readonly sessionId: string },
  ): void {
    if (active.owner === "overlay") {
      this.#windowController.send(command);
      return;
    }
    if (active.senderWebContentsId === null) return;
    const window = this.#getAppWindowByWebContentsId(active.senderWebContentsId);
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
    try {
      window.webContents.send(GLOBAL_DICTATION_COMMAND_CHANNEL, command);
    } catch {
      // Window lifecycle observers release the route; a racing send failure is already terminal.
    }
  }

  async #pasteActive(active: ActiveGlobalSession): Promise<void> {
    if (this.#active !== active || !active.transcript) return;
    this.#publish({ kind: "pasting", sessionId: active.sessionId });
    try {
      const result = await this.#pasteService.paste(active.transcript, active.target);
      if (this.#active !== active) return;
      this.#windowController.send({
        type: "paste-completed",
        sessionId: active.sessionId,
        clipboardRestoreMs: result.clipboardRestoreMs,
      });
      this.#finishActive();
    } catch (error) {
      if (this.#active !== active) return;
      const dictationError: DictationError =
        error instanceof ClipboardSafePasteError
          ? error.dictationError
          : { kind: "paste-failed", operation: "paste", retryable: true };
      this.#publish({
        kind: "retryable-error",
        sessionId: active.sessionId,
        error: dictationError,
      });
      this.#windowController.send({
        type: "paste-failed",
        sessionId: active.sessionId,
        error: dictationError,
      });
    }
  }

  #finishActive(): void {
    const active = this.#active;
    if (!active) return;
    if (active.acceptTimer) clearTimeout(active.acceptTimer);
    this.#active = null;
    this.#publish({ kind: "idle" });
    if (active.owner !== "overlay") return;
    if (this.#enabled && this.#keepVisible && this.#appliedBindings.size > 0) {
      void this.#windowController.showIdle(this.#idleCommand());
      return;
    }
    this.#windowController.send({ type: "finish", sessionId: active.sessionId });
    this.#windowController.hide();
  }

  #idleCommand(): Extract<GlobalDictationRendererCommand, { type: "idle" }> {
    const state = this.#desiredCommandKeymap;
    return {
      type: "idle",
      configuredHotkey: state ? getPrimaryCommandAccelerator(state, "globalDictationHold") : null,
      configuredToggleHotkey: state
        ? getPrimaryCommandAccelerator(state, "globalDictationToggle")
        : null,
    };
  }

  #syncIdlePresentation(): void {
    if (this.#disposed || this.#active) return;
    if (!this.#enabled || this.#appliedBindings.size === 0) {
      this.#windowController.close();
      return;
    }
    if (this.#keepVisible) {
      void this.#windowController.showIdle(this.#idleCommand());
      return;
    }
    this.#windowController.prewarm();
    this.#windowController.hide();
  }

  #publish(snapshot: GlobalDictationManagerSnapshot): void {
    this.#snapshot = snapshot;
    for (const listener of this.#listeners) listener();
  }

  #withConfigurationLease<A>(operation: () => Promise<A>): Promise<A> {
    const result = this.#configurationTail.then(operation, operation);
    this.#configurationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
