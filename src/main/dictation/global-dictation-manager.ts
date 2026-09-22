import { randomUUID } from "node:crypto";
import type { BrowserWindow } from "electron";
import {
  DEFAULT_KEYBOARD_LAYOUT_SNAPSHOT,
  getPrimaryCommandAccelerator,
  type CommandKeybindingRejection,
  type CommandKeymapState,
  type KeyboardLayoutSnapshot,
  type MacNativeHotkeySpec,
} from "../../shared/command-keybindings";
import type { DictationError, GlobalDictationPermissionSnapshot } from "../../shared/dictation";
import {
  GLOBAL_DICTATION_COMMAND_CHANNEL,
  type GlobalDictationManagerSnapshot,
  type GlobalDictationPasteFailure,
  type GlobalDictationRendererEvent,
  type GlobalDictationTarget,
} from "../../shared/global-dictation";
import {
  DictationNativeHelperRequestError,
  type DictationNativeHelperEvent,
  type DictationNativeHelperPort,
} from "./dictation-native-helper-port";
import type { ClipboardSafePasteService } from "./clipboard-safe-paste-service";
import type { GlobalDictationWindowController } from "./global-dictation-window-controller";
import {
  acquireGlobalDictationOwnership,
  type GlobalDictationOwnershipLease,
} from "./global-dictation-ownership-lock";

const IN_APP_ACCEPT_TIMEOUT_MS = 150;
const HOLD_ACTIVATION_DELAY_MS = 250;
const DOUBLE_TAP_WINDOW_MS = 400;
const GLOBAL_BINDINGS = [
  { commandId: "globalDictationHold", bindingId: "global-dictation-hold", mode: "hold" },
  { commandId: "globalDictationToggle", bindingId: "global-dictation-toggle", mode: "toggle" },
] as const;

interface ActiveGlobalSession {
  readonly sessionId: string;
  readonly requestId: string;
  readonly target?: GlobalDictationTarget;
  readonly gesture: "hold" | "toggle";
  owner: "pending-in-app" | "in-app" | "overlay";
  senderWebContentsId: number | null;
  acceptTimer: ReturnType<typeof setTimeout> | null;
  transcript: string | null;
  stopRequested: boolean;
  isStarting: boolean;
  readonly activationStartedAtMs?: number;
  clipboardFingerprint?: Promise<string>;
  recordingStoppedAtMs?: number;
  releaseWindowListeners?: () => void;
}

type RuntimeHealth = "starting" | "ready" | "degraded" | "stopped";

type GlobalDictationBinding = Pick<MacNativeHotkeySpec, "bindingId" | "mode">;

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
  | "showPasteFailure"
  | "showRecovery"
  | "subscribeTerminal"
>;

const helperRejection = (error: unknown): CommandKeybindingRejection | null => {
  if (!(error instanceof DictationNativeHelperRequestError)) return null;
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
export type GlobalDictationManagerInterface = Pick<
  GlobalDictationManager,
  keyof GlobalDictationManager
>;

type CompileHotkey<Binding> = (input: {
  readonly accelerator: string;
  readonly bindingId: string;
  readonly mode: "hold" | "toggle";
  readonly layout: KeyboardLayoutSnapshot;
}) =>
  | { readonly type: "compiled"; readonly spec: Binding }
  | { readonly type: "rejected"; readonly reason: CommandKeybindingRejection };

export class GlobalDictationManager<Binding extends GlobalDictationBinding = MacNativeHotkeySpec> {
  readonly #helper: DictationNativeHelperPort<Binding>;
  readonly #compileHotkey: CompileHotkey<Binding>;
  readonly #isBareHotkey: (binding: Binding) => boolean;
  readonly #windowController: GlobalDictationWindowPort;
  readonly #pasteService: Pick<
    ClipboardSafePasteService,
    "paste" | "copy" | "captureClipboardFingerprint"
  >;
  readonly #openAccessibilitySettings: () => Promise<void>;
  readonly #openRecording: (recordingId: string) => Promise<void>;
  readonly #acquireOwnership: (onLost: () => void) => GlobalDictationOwnershipLease | null;
  readonly #getFocusedAppWindow: () => BrowserWindow | null;
  readonly #getAppWindowByWebContentsId: (webContentsId: number) => BrowserWindow | null;
  readonly #onRecoveryNeeded: () => void;
  readonly #platform: NodeJS.Platform;
  readonly #listeners = new Set<() => void>();
  readonly #appliedBindings = new Map<string, Binding>();
  #snapshot: GlobalDictationManagerSnapshot = { kind: "idle" };
  #active: ActiveGlobalSession | null = null;
  #pendingPaste: { readonly sessionId: string; readonly abort: AbortController } | null = null;
  #pasteFailure: {
    readonly sessionId: string;
    readonly failure: GlobalDictationPasteFailure;
  } | null = null;
  #holdPressedAtMs: number | null = null;
  #togglePressedAtMs: number | null = null;
  #toggleStopsSession = false;
  #lastToggleTapAtMs: number | null = null;
  #pendingActivation: ReturnType<typeof setTimeout> | null = null;
  #escapeEnabled = false;
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
    readonly helper: DictationNativeHelperPort<Binding>;
    readonly compileHotkey: CompileHotkey<Binding>;
    readonly isBareHotkey: (binding: Binding) => boolean;
    readonly windowController: GlobalDictationWindowPort;
    readonly pasteService: Pick<
      ClipboardSafePasteService,
      "paste" | "copy" | "captureClipboardFingerprint"
    >;
    readonly openAccessibilitySettings: () => Promise<void>;
    readonly openRecording: (recordingId: string) => Promise<void>;
    readonly acquireOwnership?: (onLost: () => void) => GlobalDictationOwnershipLease | null;
    readonly getFocusedAppWindow: () => BrowserWindow | null;
    readonly getAppWindowByWebContentsId: (webContentsId: number) => BrowserWindow | null;
    readonly onRecoveryNeeded?: () => void;
    readonly platform?: NodeJS.Platform;
  }) {
    this.#helper = options.helper;
    this.#compileHotkey = options.compileHotkey;
    this.#isBareHotkey = options.isBareHotkey;
    this.#windowController = options.windowController;
    this.#pasteService = options.pasteService;
    this.#openAccessibilitySettings = options.openAccessibilitySettings;
    this.#openRecording = options.openRecording;
    this.#acquireOwnership =
      options.acquireOwnership ?? ((onLost) => acquireGlobalDictationOwnership({ onLost }));
    this.#getFocusedAppWindow = options.getFocusedAppWindow;
    this.#getAppWindowByWebContentsId = options.getAppWindowByWebContentsId;
    this.#onRecoveryNeeded = options.onRecoveryNeeded ?? (() => undefined);
    this.#platform = options.platform ?? process.platform;
    this.#health = this.#supportsGlobalDictation() ? "starting" : "stopped";
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

  readonly isAvailable = (): boolean => this.#supportsGlobalDictation() && this.#health === "ready";

  readonly ownsRenderer = (webContentsId: number): boolean =>
    this.#windowController.ownsWebContents(webContentsId);

  async initialize(state: CommandKeymapState): Promise<CommandKeybindingRejection | null> {
    return await this.#withConfigurationLease(async () => {
      if (!this.#supportsGlobalDictation() || this.#disposed) return null;
      this.#desiredCommandKeymap = state;
      const rejection = await this.#applyDesiredBindings();
      this.#syncIdlePresentation();
      return rejection;
    });
  }

  async syncCommandKeymap(state: CommandKeymapState): Promise<CommandKeybindingRejection | null> {
    return await this.#withConfigurationLease(async () => {
      if (!this.#supportsGlobalDictation() || this.#disposed) return null;
      const compiled = this.#compileBindings(state);
      if (compiled.type === "rejected") return compiled.reason;
      const changedHotkeys = GLOBAL_BINDINGS.filter(({ commandId }) => {
        const previous = this.#desiredCommandKeymap
          ? getPrimaryCommandAccelerator(this.#desiredCommandKeymap, commandId)
          : null;
        return getPrimaryCommandAccelerator(state, commandId) !== previous;
      });
      if (changedHotkeys.length === 0 && this.#health === "ready") {
        this.#desiredCommandKeymap = state;
        return null;
      }
      if (
        this.#platform === "darwin" &&
        changedHotkeys.some(({ commandId }) => getPrimaryCommandAccelerator(state, commandId))
      ) {
        await this.#helper.requestInputMonitoring();
        await this.#helper.requestAccessibility();
      }
      const hasConfiguredHotkey = compiled.bindings.length > 0;
      if (!this.#enabled) {
        this.#desiredCommandKeymap = state;
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
      return null;
    });
  }

  /** Makes a durable rollback authoritative even when the helper cannot apply it immediately. */
  async restoreCommandKeymap(state: CommandKeymapState): Promise<void> {
    await this.#withConfigurationLease(async () => {
      if (!this.#supportsGlobalDictation() || this.#disposed) return;
      this.#desiredCommandKeymap = state;
      if (this.#enabled) {
        const rejection = await this.#applyDesiredBindings();
        if (rejection) throw new Error(rejection.message);
      }
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
      if (this.#disposed || !this.#supportsGlobalDictation() || !this.#enabled) return;
      this.#health = "starting";
      this.#publish(this.#snapshot);
      const rejection = await this.#applyDesiredBindings(false);
      if (rejection) {
        this.#health = "degraded";
        this.#publish(this.#snapshot);
      }
    });
  }

  async captureBareModifierHotkey(
    signal: AbortSignal,
    capture: () => Promise<string | null>,
    allowsBareModifiers: boolean,
  ): Promise<string | null> {
    return await this.#withConfigurationLease(async () => {
      signal.throwIfAborted();
      if (this.#disposed) throw new Error("Global dictation was disposed");
      this.#cancelDictation();
      const generation = this.#configurationGeneration + 1;
      await this.#helper.replaceBindings({ generation, bindings: [] });
      this.#configurationGeneration = generation;
      this.#appliedBindings.clear();
      try {
        signal.throwIfAborted();
        if (allowsBareModifiers && this.#platform === "darwin") return await capture();
        return await new Promise<string | null>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      } finally {
        if (!this.#disposed) await this.#applyDesiredBindings();
      }
    });
  }

  queryBuiltInMicrophoneName(): Promise<string | null> {
    if (this.#platform !== "darwin") return Promise.resolve(null);
    return this.#helper.queryBuiltInMicrophoneName();
  }

  #supportsGlobalDictation(): boolean {
    return this.#platform === "darwin" || this.#platform === "win32";
  }

  async readPermissions(): Promise<GlobalDictationPermissionSnapshot> {
    if (!this.#supportsGlobalDictation()) {
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
      if (event.sessionId !== (this.#active?.sessionId ?? this.#pasteFailure?.sessionId ?? null))
        return false;
      this.#cancelDictation();
      this.#windowController.close();
      return true;
    }
    const failure = this.#pasteFailure;
    if (failure && "sessionId" in event && event.sessionId === failure.sessionId) {
      if (!this.#windowController.ownsWebContents(senderWebContentsId)) return false;
      if (event.type === "copy-transcript") {
        void this.#copyFailure(failure);
        return true;
      }
      if (event.type === "open-accessibility-settings") {
        void this.#openAccessibilitySettings().catch(() => undefined);
        return true;
      }
      if (event.type === "dismiss") {
        this.#pasteFailure = null;
        this.#publish({ kind: "idle" });
        this.#windowController.hide();
        return true;
      }
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
        active.isStarting = false;
        this.#publish({ kind: "recording", sessionId: active.sessionId, owner: "in-app" });
        return true;
      }
      if (
        active.owner === "overlay" &&
        this.#windowController.ownsWebContents(senderWebContentsId)
      ) {
        active.isStarting = false;
        this.#publish({ kind: "recording", sessionId: active.sessionId, owner: "overlay" });
        return true;
      }
      return false;
    }
    if (senderWebContentsId !== active.senderWebContentsId) return false;
    if (event.type === "view-recording" || event.type === "copy-recovered-text") {
      if (active.owner !== "overlay" || this.#snapshot.kind !== "retryable-error") return false;
      if (event.type === "view-recording") {
        void this.#openRecording(event.recordingId).catch(() => undefined);
      } else {
        void this.#pasteService.copy(event.text).catch(() => undefined);
      }
      return true;
    }
    if (event.type === "recording-stopped") {
      active.stopRequested = true;
      if (active.owner === "overlay") {
        this.#captureClipboardAtStop(active);
        active.recordingStoppedAtMs = Date.now();
      }
      return true;
    }
    if (event.type === "stop-requested") {
      if (active.owner !== "overlay") return false;
      this.#stopActive();
      return true;
    }
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
      if (event.error.operation !== "transcribe") {
        this.#finishActive();
        return true;
      }
      this.#publish({ kind: "retryable-error", sessionId: active.sessionId, error: event.error });
      if (active.owner === "overlay") this.#windowController.showRecovery();
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
        this.#cancelDictation();
        const generation = this.#configurationGeneration + 1;
        await this.#helper.replaceBindings({ generation, bindings: [] });
        this.#adoptBindings([], generation);
        this.#windowController.close();
        return;
      }
      if (!this.#desiredCommandKeymap) return;
      const rejection = await this.#applyDesiredBindings();
      if (rejection) throw new Error(rejection.message);
    });
  }

  handleWebContentsGone(webContentsId: number): void {
    const active = this.#active;
    if (active?.senderWebContentsId !== webContentsId) return;
    this.#cancelDictation();
    this.#syncIdlePresentation();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#health = "stopped";
    this.#unsubscribeHelper();
    this.#unsubscribeWindowTerminal();
    this.#cancelDictation();
    this.#holdPressedAtMs = null;
    this.#togglePressedAtMs = null;
    this.#appliedBindings.clear();
    this.#publish({ kind: "idle" });
    this.#listeners.clear();
    this.#releaseOwnership();
    this.#windowController.close();
  }

  #compileBindings(
    state: CommandKeymapState,
  ):
    | { readonly type: "compiled"; readonly bindings: readonly Binding[] }
    | { readonly type: "rejected"; readonly reason: CommandKeybindingRejection } {
    const bindings: Binding[] = [];
    for (const binding of GLOBAL_BINDINGS) {
      const accelerator = getPrimaryCommandAccelerator(state, binding.commandId);
      if (!accelerator) continue;
      if (
        binding.mode === "toggle" &&
        accelerator === getPrimaryCommandAccelerator(state, "globalDictationHold")
      )
        continue;
      const compiled = this.#compileHotkey({
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

  #adoptBindings(bindings: readonly Binding[], generation: number): void {
    if (this.#disposed) return;
    this.#cancelDictation();
    this.#holdPressedAtMs = null;
    this.#togglePressedAtMs = null;
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
    this.#cancelDictation();
    this.#holdPressedAtMs = null;
    this.#togglePressedAtMs = null;
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
        this.#cancelDictation();
        this.#holdPressedAtMs = null;
        this.#togglePressedAtMs = null;
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

  #onHelperEvent(event: DictationNativeHelperEvent): void {
    if (this.#disposed) return;
    if (event.type === "crashed") {
      this.#markDegraded();
      return;
    }
    if (event.type === "escape") {
      if (this.#escapeEnabled) this.#cancelDictation();
      return;
    }
    if (event.configurationGeneration !== this.#configurationGeneration) return;
    const binding = this.#appliedBindings.get(event.bindingId);
    if (!binding || binding.mode !== event.mode) return;
    if (event.type === "cancelled") {
      this.#lastToggleTapAtMs = null;
      if (binding.mode === "toggle") {
        this.#togglePressedAtMs = null;
        return;
      }
      this.#holdPressedAtMs = null;
      this.#clearPendingActivation();
      if (this.#active?.gesture === "hold") this.#cancelDictation();
      return;
    }
    if (!this.#enabled) return;
    if (binding.mode === "toggle") {
      this.#handleToggleEvent(event);
      return;
    }
    if (event.type === "released") {
      const pressedAt = this.#holdPressedAtMs;
      if (pressedAt === null) return;
      this.#holdPressedAtMs = null;
      const wasPending = this.#pendingActivation !== null;
      this.#clearPendingActivation();
      if (this.#active?.gesture === "hold") this.#stopActive();
      else if (wasPending && this.#hasSharedHotkey()) {
        this.#handleToggleTap(pressedAt, event.target);
      }
      return;
    }
    if (this.#holdPressedAtMs !== null) return;
    this.#holdPressedAtMs = Date.now();
    if (this.#active) {
      if (this.#hasSharedHotkey() && this.#active.gesture === "toggle") this.#stopActive();
      return;
    }
    const target = event.target;
    const focused = this.#getFocusedAppWindow();
    if (this.#hasSharedHotkey() || (focused && this.#isBareHotkey(binding))) {
      this.#pendingActivation = setTimeout(() => {
        this.#pendingActivation = null;
        this.#lastToggleTapAtMs = null;
        this.#begin({ target, gesture: "hold" });
      }, HOLD_ACTIVATION_DELAY_MS);
      this.#syncEscapeRegistration();
      return;
    }
    this.#begin({ target, gesture: "hold" });
  }

  #handleToggleEvent(
    event: Extract<DictationNativeHelperEvent, { readonly bindingId: string }>,
  ): void {
    if (event.type === "pressed") {
      if (this.#togglePressedAtMs !== null) return;
      this.#togglePressedAtMs = Date.now();
      this.#toggleStopsSession = this.#active !== null || this.#pendingActivation !== null;
      if (this.#active?.gesture === "toggle") this.#stopActive();
      else if (!this.#active && this.#toggleStopsSession) this.#cancelDictation();
      return;
    }
    const pressedAt = this.#togglePressedAtMs;
    this.#togglePressedAtMs = null;
    if (pressedAt === null || this.#toggleStopsSession) return;
    this.#handleToggleTap(pressedAt, event.target);
  }

  #handleToggleTap(pressedAt: number, target?: GlobalDictationTarget): void {
    const now = Date.now();
    const previousTap = this.#lastToggleTapAtMs;
    this.#lastToggleTapAtMs = null;
    if (now - pressedAt >= HOLD_ACTIVATION_DELAY_MS) return;
    if (previousTap !== null && now - previousTap <= DOUBLE_TAP_WINDOW_MS) {
      this.#begin({ target, gesture: "toggle" });
      return;
    }
    this.#lastToggleTapAtMs = now;
  }

  #hasSharedHotkey(): boolean {
    const state = this.#desiredCommandKeymap;
    if (!state) return false;
    const hold = getPrimaryCommandAccelerator(state, "globalDictationHold");
    return hold !== null && hold === getPrimaryCommandAccelerator(state, "globalDictationToggle");
  }

  #clearPendingActivation(): void {
    if (this.#pendingActivation) clearTimeout(this.#pendingActivation);
    this.#pendingActivation = null;
    this.#syncEscapeRegistration();
  }

  #syncEscapeRegistration(): void {
    const enabled =
      !this.#disposed &&
      (this.#active !== null || this.#pendingActivation !== null || this.#pendingPaste !== null);
    if (enabled === this.#escapeEnabled) return;
    this.#escapeEnabled = enabled;
    void this.#helper.setEscapeEnabled(enabled).catch(() => undefined);
  }

  #cancelPendingPaste(): void {
    this.#pendingPaste?.abort.abort();
    this.#pendingPaste = null;
    this.#pasteFailure = null;
    this.#syncEscapeRegistration();
  }

  #cancelDictation(): void {
    this.#clearPendingActivation();
    this.#lastToggleTapAtMs = null;
    this.#cancelPendingPaste();
    const active = this.#active;
    if (active) this.#sendToOwner(active, { type: "cancel", sessionId: active.sessionId });
    this.#finishActive();
    this.#publish({ kind: "idle" });
    this.#windowController.hide();
  }

  #begin(input: {
    readonly target?: GlobalDictationTarget;
    readonly gesture: "hold" | "toggle";
  }): void {
    if (this.#active || this.#disposed || !this.#enabled) return;
    this.#cancelPendingPaste();
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
      isStarting: true,
      ...(input.gesture === "hold" && this.#holdPressedAtMs !== null
        ? { activationStartedAtMs: this.#holdPressedAtMs }
        : {}),
    };
    this.#active = session;
    this.#syncEscapeRegistration();
    const focused = this.#getFocusedAppWindow();
    if (focused && !focused.isDestroyed()) {
      session.owner = "pending-in-app";
      session.senderWebContentsId = focused.webContents.id;
      const cancel = (): void => {
        if (this.#active === session) this.#cancelDictation();
      };
      const onNavigation = (
        details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
      ): void => {
        if (details.isMainFrame && !details.isSameDocument) cancel();
      };
      focused.webContents.on("did-start-navigation", onNavigation);
      focused.webContents.once("destroyed", cancel);
      focused.webContents.once("render-process-gone", cancel);
      session.releaseWindowListeners = () => {
        focused.webContents.removeListener("did-start-navigation", onNavigation);
        focused.webContents.removeListener("destroyed", cancel);
        focused.webContents.removeListener("render-process-gone", cancel);
      };
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
    if (session.stopRequested) {
      this.#finishActive();
      return;
    }
    if (session.acceptTimer) clearTimeout(session.acceptTimer);
    session.acceptTimer = null;
    session.releaseWindowListeners?.();
    session.releaseWindowListeners = undefined;
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
      activationStartedAtMs: session.activationStartedAtMs,
    });
    if (this.#active !== session || session.owner !== "overlay") return;
    if (!shown) {
      this.#finishActive();
      return;
    }
    session.isStarting = false;
  }

  #stopActive(): void {
    const active = this.#active;
    if (!active || active.stopRequested) return;
    active.stopRequested = true;
    if (active.owner === "overlay" && active.isStarting) {
      this.#sendToOwner(active, { type: "cancel", sessionId: active.sessionId });
      this.#finishActive();
      return;
    }
    if (active.owner === "overlay") this.#captureClipboardAtStop(active);
    this.#sendToOwner(active, { type: "stop", sessionId: active.sessionId });
  }

  #captureClipboardAtStop(active: ActiveGlobalSession): void {
    active.clipboardFingerprint ??= this.#pasteService.captureClipboardFingerprint();
    // Keep a rejected native read observed until completion handles it as a paste failure.
    void active.clipboardFingerprint.catch(() => undefined);
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
    if (this.#active !== active) return;
    const transcript = active.transcript?.trim();
    const pending = { sessionId: active.sessionId, abort: new AbortController() };
    if (transcript) this.#pendingPaste = pending;
    this.#finishActive();
    if (!transcript) return;
    this.#publish({ kind: "pasting", sessionId: active.sessionId });
    let failure: GlobalDictationPasteFailure | undefined;
    try {
      const clipboardFingerprint = await active.clipboardFingerprint;
      if (this.#pendingPaste !== pending) return;
      const result = await this.#pasteService.paste(transcript, active.target, {
        clipboardFingerprint,
        recordingStoppedAtMs: active.recordingStoppedAtMs,
        signal: pending.abort.signal,
      });
      if (this.#pendingPaste !== pending) return;
      failure = result.failure;
      if (!failure)
        this.#windowController.send({
          type: "paste-completed",
          sessionId: active.sessionId,
          clipboardRestoreMs: result.clipboardRestoreMs,
        });
    } catch {
      if (this.#pendingPaste !== pending) return;
      failure = { text: `${transcript} `, copied: false, reason: "paste" };
    }
    if (failure) {
      this.#pasteFailure = { sessionId: active.sessionId, failure };
      await this.#showPasteFailure(this.#pasteFailure);
    }
    if (this.#pendingPaste !== pending) return;
    this.#pendingPaste = null;
    this.#syncEscapeRegistration();
    if (!failure) this.#publish({ kind: "idle" });
  }

  async #showPasteFailure(presentation: {
    readonly sessionId: string;
    readonly failure: GlobalDictationPasteFailure;
  }): Promise<void> {
    const error: DictationError = {
      kind:
        presentation.failure.reason === "accessibility" ? "accessibility-denied" : "paste-failed",
      operation: "paste",
      retryable: true,
    };
    this.#publish({ kind: "retryable-error", sessionId: presentation.sessionId, error });
    await this.#windowController.showPasteFailure({ type: "paste-failed", ...presentation, error });
  }

  async #copyFailure(presentation: {
    readonly sessionId: string;
    readonly failure: GlobalDictationPasteFailure;
  }): Promise<void> {
    try {
      await this.#pasteService.copy(presentation.failure.text);
    } catch {
      return;
    }
    if (this.#pasteFailure !== presentation) return;
    this.#pasteFailure = { ...presentation, failure: { ...presentation.failure, copied: true } };
    await this.#showPasteFailure(this.#pasteFailure);
  }

  #finishActive(): void {
    const active = this.#active;
    if (!active) return;
    if (active.acceptTimer) clearTimeout(active.acceptTimer);
    active.releaseWindowListeners?.();
    this.#active = null;
    this.#lastToggleTapAtMs = null;
    this.#syncEscapeRegistration();
    this.#publish({ kind: "idle" });
    if (active.owner !== "overlay") return;
    this.#windowController.send({ type: "finish", sessionId: active.sessionId });
    this.#windowController.hide();
  }

  #syncIdlePresentation(): void {
    if (this.#disposed || this.#active || this.#pasteFailure || this.#pendingPaste) return;
    if (!this.#enabled || this.#appliedBindings.size === 0) {
      this.#windowController.close();
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
