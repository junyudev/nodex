import { deliverGlobalDictation } from "./global-dictation-delivery";
import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  ActivitySpinnerIcon,
  DictationDismissIcon,
  DictationMicrophoneIcon,
  DictationRetryIcon,
} from "@/components/shared/icons";
import { ShortcutKeycaps } from "@/components/ui/shortcut-keycaps";
import { NodexButton } from "@/components/ui/button";
import { NodexTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { formatAcceleratorLabel } from "../../../shared/command-keybindings";
import type { DictationError } from "../../../shared/dictation";
import { DEFAULT_DICTATION_SETTINGS } from "../../../shared/dictation";
import type {
  GlobalDictationPasteFailure,
  GlobalDictationRendererEvent,
} from "../../../shared/global-dictation";
import { transcribeDictationBlob } from "./dictation-buffered-client";
import { createDictationHistoryPort } from "./dictation-history-client";
import { browserDictationRecorderFactory } from "./dictation-recorder";
import {
  createDictationMicrophoneLeaseClient,
  subscribeDictationMicrophoneRelinquish,
} from "./dictation-microphone-lease-client";
import {
  DictationSessionController,
  type DictationControllerPorts,
  type DictationRecovery,
} from "./dictation-session-controller";
import { createBrowserDictationStreamingPort } from "./dictation-streaming-client";
import {
  browserGlobalDictationCompactWaveformPort,
  GLOBAL_DICTATION_COMPACT_BAR_COUNT,
  GLOBAL_DICTATION_COMPACT_SAMPLE_FLOOR,
  resolveGlobalDictationCompactBarRects,
} from "./global-dictation-compact-waveform";
import { acquireMicrophone } from "./microphone-acquirer";
import { useDictationSession } from "./use-dictation-session";
import { useFloatingWindowPointerInteractivity } from "./use-floating-window-pointer-interactivity";
import { globalDictationTransport } from "./global-dictation-transport";
import { playDictationSound } from "./dictation-sounds";

const sendEvent = (event: GlobalDictationRendererEvent): Promise<boolean> =>
  window.globalDictation?.sendEvent(event) ?? Promise.resolve(false);

const publishPointerInteractivity = (enabled: boolean): void => {
  void sendEvent({ type: "interactive", enabled });
};

const defaultClock: DictationControllerPorts["clock"] = {
  now: () => performance.now(),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (timer) => globalThis.clearTimeout(timer),
};

const createGlobalHistoryPort = (): DictationControllerPorts["history"] =>
  createDictationHistoryPort({
    create: globalDictationTransport.createHistory,
    append: globalDictationTransport.appendHistory,
    finalize: globalDictationTransport.finalizeHistory,
    setTranscript: globalDictationTransport.setHistoryTranscript,
    setDiagnostics: globalDictationTransport.setHistoryDiagnostics,
  });

const transcribe: DictationControllerPorts["buffered"]["transcribe"] = async (
  blob,
  signal,
  _sessionId,
  onDiagnostics,
) =>
  await transcribeDictationBlob(blob, {
    signal,
    onDiagnostics,
    transcribe: async (input) => {
      const requestId = crypto.randomUUID();
      const cancel = (): void => {
        void globalDictationTransport.cancelTranscription(requestId).catch(() => undefined);
      };
      signal.addEventListener("abort", cancel, { once: true });
      try {
        return await globalDictationTransport.transcribe({ ...input, requestId });
      } finally {
        signal.removeEventListener("abort", cancel);
      }
    },
  });

const errorMessage = (kind: string): string => {
  if (kind === "microphone-permission-denied" || kind === "microphone-restricted") {
    return "Microphone access is blocked";
  }
  if (kind === "microphone-not-found") return "No microphone found";
  if (kind === "microphone-busy") return "Microphone is busy";
  if (kind.startsWith("transcription-")) return "Couldn’t transcribe audio";
  if (kind === "accessibility-denied") return "Accessibility access is required";
  if (kind === "paste-failed") return "Couldn’t paste text";
  return "Dictation stopped unexpectedly";
};

export type GlobalDictationBarState =
  | "initializing"
  | "idle"
  | "listening"
  | "transcribing"
  | "error";

function ShortcutHint({ accelerator }: { readonly accelerator: string }) {
  return (
    <ShortcutKeycaps
      keys={[formatAcceleratorLabel(accelerator, "macOS")]}
      density="compact"
      tone="current"
    />
  );
}

function GlobalDictationReadyTooltip({
  configuredHotkey,
  configuredToggleHotkey,
}: {
  readonly configuredHotkey: string | null;
  readonly configuredToggleHotkey: string | null;
}) {
  if (configuredHotkey && configuredToggleHotkey) {
    return (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
        Hold or double-tap <ShortcutHint accelerator={configuredHotkey} />, or press
        <ShortcutHint accelerator={configuredToggleHotkey} /> to dictate
      </span>
    );
  }
  if (configuredHotkey) {
    return (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
        Hold or double-tap <ShortcutHint accelerator={configuredHotkey} /> to dictate
      </span>
    );
  }
  if (configuredToggleHotkey) {
    return (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
        Press <ShortcutHint accelerator={configuredToggleHotkey} /> to dictate
      </span>
    );
  }
  return null;
}

function GlobalDictationCompactCanvas({ levels }: { readonly levels: readonly number[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const paint = useEffectEvent((paintLevels: readonly number[] = levels): void => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context || canvas.clientWidth === 0 || canvas.clientHeight === 0) return;
    const ratio = window.devicePixelRatio || 1;
    const width = Math.floor(canvas.clientWidth * ratio);
    const height = Math.floor(canvas.clientHeight * ratio);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, width, height);
    context.fillStyle = getComputedStyle(canvas).color || "#fff";
    for (const rect of resolveGlobalDictationCompactBarRects(width, height, ratio, paintLevels)) {
      context.globalAlpha = rect.alpha;
      context.beginPath();
      context.roundRect(rect.x, rect.y, rect.width, rect.height, rect.radius);
      context.fill();
    }
    context.globalAlpha = 1;
  });
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(() => paint());
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);
  useEffect(() => paint(levels), [levels]);

  return <canvas ref={canvasRef} className="h-4 min-w-0 flex-1 text-white" aria-hidden="true" />;
}

export function GlobalDictationBar({
  state,
  waveform,
  error,
  canRetry,
  configuredHotkey = null,
  configuredToggleHotkey = null,
  activationNonce = 0,
  onDismiss,
  onRetry,
  onClose,
}: {
  readonly state: GlobalDictationBarState;
  readonly waveform: readonly number[];
  readonly error?: DictationError | null;
  readonly canRetry?: boolean;
  readonly configuredHotkey?: string | null;
  readonly configuredToggleHotkey?: string | null;
  readonly activationNonce?: number;
  readonly onDismiss: () => void;
  readonly onRetry: () => void;
  readonly onClose: () => void;
}) {
  const retryAvailable = canRetry ?? error?.retryable ?? false;
  const interactiveRegionRef = useRef<HTMLElement>(null);
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const hasConfiguredShortcut = configuredHotkey !== null || configuredToggleHotkey !== null;
  useFloatingWindowPointerInteractivity({
    activationNonce,
    interactiveRegionRef,
    onInteractiveChange: publishPointerInteractivity,
  });

  const [previousState, setPreviousState] = useState(state);
  if (previousState !== state) {
    setPreviousState(state);
    if (state !== "idle") setTooltipOpen(false);
  }

  const contextMenu = async (event: ReactMouseEvent): Promise<void> => {
    event.preventDefault();
    const selected = await window.globalDictation?.showContextMenu().catch(() => null);
    if (selected === "close-window") onClose();
  };
  const accessibleLabel =
    state === "initializing"
      ? undefined
      : state === "idle"
        ? "Global dictation ready"
        : "Global dictation waveform";
  const status =
    state === "idle"
      ? "Dictation ready"
      : state === "listening"
        ? "Listening"
        : state === "transcribing"
          ? "Transcribing…"
          : state === "error"
            ? errorMessage(error?.kind ?? "unknown")
            : null;
  const mini = state === "initializing" || state === "idle";
  const active = state === "listening" || state === "transcribing";
  const errorState = state === "error";
  const readyTooltip = (
    <GlobalDictationReadyTooltip
      configuredHotkey={configuredHotkey}
      configuredToggleHotkey={configuredToggleHotkey}
    />
  );

  const hitbox = (
    <div
      data-testid="global-dictation-hitbox"
      className={cn(
        "group flex items-end justify-center",
        errorState ? "w-fit" : "h-[30px] w-[120px]",
      )}
      data-state={tooltipOpen ? "delayed-open" : "closed"}
    >
      <section
        ref={interactiveRegionRef}
        aria-live="polite"
        aria-label={accessibleLabel}
        onContextMenu={(event) => void contextMenu(event)}
        className={cn(
          "flex items-center overflow-hidden border-[0.5px] shadow-[0_4px_8px_-2px_rgba(0,0,0,0.2)] transition-[width,height,border-radius] duration-150 [transition-timing-function:cubic-bezier(0.77,0,0.175,1)] [@media(forced-colors:active)]:bg-[Canvas] [@media(forced-colors:active)]:backdrop-blur-none motion-reduce:transition-none",
          errorState ? "draggable" : "no-drag",
          mini &&
            "h-2 w-10 justify-center rounded-[4px] border-white/45 bg-black/70 px-0 backdrop-blur-[4px] [@media(prefers-reduced-transparency:reduce)]:bg-black/85 [@media(prefers-reduced-transparency:reduce)]:backdrop-blur-none",
          state === "idle" &&
            "group-hover:h-[30px] group-hover:w-[72px] group-hover:rounded-full group-hover:border-white/[0.063] group-hover:bg-black group-data-[state=delayed-open]:h-[30px] group-data-[state=delayed-open]:w-[72px] group-data-[state=delayed-open]:rounded-full group-data-[state=delayed-open]:border-white/[0.063] group-data-[state=delayed-open]:bg-black",
          active &&
            "h-[30px] w-[72px] justify-center rounded-full border-white/[0.063] bg-black px-2",
          errorState &&
            "h-8 w-fit max-w-[304px] gap-2 rounded-2xl border-white/[0.063] bg-black px-2",
        )}
      >
        {state === "idle" ? (
          <span className="relative flex h-full w-full items-center justify-center text-white/65">
            <DictationMicrophoneIcon className="absolute size-4 scale-75 opacity-0 transition-transform duration-150 [transition-timing-function:cubic-bezier(0.77,0,0.175,1)] group-hover:scale-100 group-hover:opacity-100 group-data-[state=delayed-open]:scale-100 group-data-[state=delayed-open]:opacity-100 motion-reduce:transition-none" />
          </span>
        ) : null}
        {state === "transcribing" ? (
          <ActivitySpinnerIcon className="size-4 text-white/65" animationDurationMs={1_000} />
        ) : null}
        {state === "listening" ? (
          <GlobalDictationCompactCanvas
            levels={
              waveform.length === GLOBAL_DICTATION_COMPACT_BAR_COUNT
                ? waveform
                : Array.from(
                    { length: GLOBAL_DICTATION_COMPACT_BAR_COUNT },
                    () => GLOBAL_DICTATION_COMPACT_SAMPLE_FLOOR,
                  )
            }
          />
        ) : null}
        {errorState ? (
          <>
            <span className="max-w-[252px] min-w-0 truncate text-xs font-medium text-[#ffa495]">
              {status}
            </span>
            {retryAvailable ? (
              <button
                type="button"
                className="no-drag flex size-5 shrink-0 items-center justify-center rounded-full text-white/65 hover:bg-white/8 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
                aria-label="Retry"
                onClick={onRetry}
              >
                <DictationRetryIcon className="size-3.5" />
              </button>
            ) : null}
            <button
              type="button"
              className="no-drag flex size-5 shrink-0 items-center justify-center rounded-full text-white/65 hover:bg-white/8 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
              aria-label="Dismiss"
              onClick={onDismiss}
            >
              <DictationDismissIcon className="size-3.5" />
            </button>
          </>
        ) : null}
        {status ? <span className="sr-only">{status}</span> : null}
      </section>
    </div>
  );

  return (
    <NodexTooltip
      tooltipContent={readyTooltip}
      disabled={state !== "idle" || !hasConfiguredShortcut}
      delay={250}
      side="top"
      sideOffset={10}
      open={state === "idle" && tooltipOpen}
      onOpenChange={(open) => setTooltipOpen(state === "idle" && open)}
      tooltipClassName="rounded-full border-white/[0.063] bg-black px-4 py-2 text-white [@media(forced-colors:active)]:bg-[Canvas]"
    >
      {hitbox}
    </NodexTooltip>
  );
}

/** Imperative capture coordination has one lifetime; rendered status is React state. */
class GlobalDictationSessionState {
  #activeSessionId: string | null = null;
  readonly #listeners = new Set<() => void>();
  readonly getActiveSessionId = () => this.#activeSessionId;
  readonly subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  get activeSessionId(): string | null {
    return this.#activeSessionId;
  }
  completionReported = false;
  lastStateEvent: string | null = null;
  readonly appliedCompletionIds = new Set<string>();
  captureSettings = DEFAULT_DICTATION_SETTINGS;
  playSounds = false;
  recovery: DictationRecovery | null = null;
  pasteRecovery = false;

  setActiveSessionId(value: GlobalDictationSessionState["activeSessionId"]): void {
    if (this.#activeSessionId === value) return;
    this.#activeSessionId = value;
    for (const listener of this.#listeners) listener();
  }

  setCompletionReported(value: GlobalDictationSessionState["completionReported"]): void {
    this.completionReported = value;
  }

  setLastStateEvent(value: GlobalDictationSessionState["lastStateEvent"]): void {
    this.lastStateEvent = value;
  }

  setCaptureSettings(value: GlobalDictationSessionState["captureSettings"]): void {
    this.captureSettings = value;
  }

  setPlaySounds(value: GlobalDictationSessionState["playSounds"]): void {
    this.playSounds = value;
  }

  setRecovery(value: GlobalDictationSessionState["recovery"]): void {
    this.recovery = value;
  }

  setPasteRecovery(value: GlobalDictationSessionState["pasteRecovery"]): void {
    this.pasteRecovery = value;
  }
}

export function GlobalDictationRoot() {
  const [session] = useState(() => new GlobalDictationSessionState());
  const [recovery, setRecovery] = useState<DictationRecovery | null>(null);
  const [presentationState, setPresentationState] =
    useState<GlobalDictationBarState>("initializing");
  const [configuredHotkey, setConfiguredHotkey] = useState<string | null>(null);
  const [configuredToggleHotkey, setConfiguredToggleHotkey] = useState<string | null>(null);
  const [activationNonce, setActivationNonce] = useState(0);
  const [externalError, setExternalError] = useState<DictationError | null>(null);
  const [pasteRecovery, setPasteRecovery] = useState<{
    readonly sessionId: string;
    readonly failure: GlobalDictationPasteFailure;
  } | null>(null);
  const [controller] = useState(
    () =>
      new DictationSessionController({
        recordingDurationLimitMs: null,
        lease: createDictationMicrophoneLeaseClient({
          acquire: async (sessionId, surface) =>
            await globalDictationTransport.acquireMicrophoneLease({ sessionId, surface }),
          release: async (sessionId) => {
            await globalDictationTransport.releaseMicrophoneLease(sessionId);
          },
          subscribeRelinquish: subscribeDictationMicrophoneRelinquish,
        }),
        permissions: {
          request: globalDictationTransport.requestMicrophoneAccess,
        },
        devices: {
          acquire: async () => {
            const builtInMicrophoneLabelHint = await globalDictationTransport
              .readMicrophoneRouteHint()
              .catch(() => null);
            return await acquireMicrophone({
              mediaDevices: navigator.mediaDevices,
              selectedDeviceId: session.captureSettings.microphoneInputDeviceId,
              builtInMicrophoneLabelHint,
            });
          },
        },
        recorder: browserDictationRecorderFactory,
        waveform: browserGlobalDictationCompactWaveformPort,
        streaming: createBrowserDictationStreamingPort("global"),
        buffered: { transcribe },
        cleanup: { enabled: false, transcript: async (text) => text },
        onRecoveryChange: (next) => {
          const sessionId = session.activeSessionId;
          if (!sessionId || session.pasteRecovery) return;
          session.setRecovery(next);
          setRecovery(next);
          setPresentationState("error");
          void sendEvent({
            type: "failed",
            sessionId,
            error: { kind: "transcription-service", operation: "transcribe", retryable: true },
          });
        },
        onStopRequested: () => {
          const sessionId = session.activeSessionId;
          if (sessionId) void sendEvent({ type: "recording-stopped", sessionId });
        },
        onRecordingStarted: () => {
          if (session.playSounds) playDictationSound("start");
        },
        onRecordingStopped: () => {
          if (session.playSounds) playDictationSound("stop");
        },
        history: createGlobalHistoryPort(),
        completion: {
          apply: async ({ sessionId: recordingSessionId, transcript, signal }) => {
            if (session.appliedCompletionIds.has(recordingSessionId)) return;
            const sessionId = session.activeSessionId;
            if (!sessionId) throw new DOMException("Dictation was cancelled", "AbortError");
            session.setCompletionReported(true);
            const bridge = window.globalDictation;
            if (!bridge) throw new Error("Global dictation bridge is unavailable");
            const delivered = await deliverGlobalDictation({
              sessionId,
              transcript,
              signal,
              sendEvent,
              onCommand: bridge.onCommand,
            });
            session.appliedCompletionIds.add(recordingSessionId);
            return delivered;
          },
        },
        clock: defaultClock,
        createId: () => crypto.randomUUID(),
      }),
  );
  const snapshot = useDictationSession(controller);
  const activeSessionId = useSyncExternalStore(session.subscribe, session.getActiveSessionId);
  const [presentationInput, setPresentationInput] = useState({
    kind: snapshot.kind,
    activeSessionId,
    pasteRecovery: pasteRecovery !== null,
  });
  if (
    presentationInput.kind !== snapshot.kind ||
    presentationInput.activeSessionId !== activeSessionId ||
    presentationInput.pasteRecovery !== (pasteRecovery !== null)
  ) {
    setPresentationInput({
      kind: snapshot.kind,
      activeSessionId,
      pasteRecovery: pasteRecovery !== null,
    });
    if (activeSessionId && snapshot.kind === "recording") setPresentationState("listening");
    if (activeSessionId && (snapshot.kind === "transcribing" || snapshot.kind === "stopping"))
      setPresentationState("transcribing");
    if (activeSessionId && snapshot.kind === "retryable-error" && !pasteRecovery)
      setPresentationState("error");
  }

  useEffect(() => {
    void sendEvent({ type: "ready" });
  }, []);

  useEffect(() => {
    const bridge = window.globalDictation;
    if (!bridge) return;
    return bridge.onCommand((command) => {
      if (command.type === "paste-failed") {
        session.setPasteRecovery(true);
        setPasteRecovery({ sessionId: command.sessionId, failure: command.failure });
        return;
      }
      if (command.type === "idle") {
        session.setActiveSessionId(null);
        setConfiguredHotkey(command.configuredHotkey);
        setConfiguredToggleHotkey(command.configuredToggleHotkey);
        setExternalError(null);
        setPasteRecovery(null);
        session.setPasteRecovery(false);
        session.setRecovery(null);
        setRecovery(null);
        setActivationNonce((nonce) => nonce + 1);
        setPresentationState(
          command.configuredHotkey || command.configuredToggleHotkey ? "idle" : "initializing",
        );
        return;
      }
      if (command.type === "start") {
        if (controller.getSnapshot().kind !== "idle") {
          if (!session.recovery && !session.pasteRecovery) return;
          controller.cancel();
        }
        session.setActiveSessionId(command.sessionId);
        session.setCompletionReported(false);
        setExternalError(null);
        setPasteRecovery(null);
        session.setPasteRecovery(false);
        session.setRecovery(null);
        setRecovery(null);
        setActivationNonce((nonce) => nonce + 1);
        setPresentationState("listening");
        session.setLastStateEvent(null);
        void sendEvent({
          type: "accepted",
          sessionId: command.sessionId,
          requestId: command.requestId,
          targetId: "global-overlay",
        }).then(async (accepted) => {
          if (!accepted || session.activeSessionId !== command.sessionId) {
            if (session.activeSessionId === command.sessionId) session.setActiveSessionId(null);
            return;
          }
          const [settings, capabilities] = await Promise.all([
            globalDictationTransport.readSettings().catch(() => DEFAULT_DICTATION_SETTINGS),
            globalDictationTransport.readCapabilities().catch(() => null),
          ]);
          if (session.activeSessionId !== command.sessionId) return;
          session.setCaptureSettings(settings);
          session.setPlaySounds(
            settings.dictationSoundsEnabled && capabilities?.capabilities.sounds === true,
          );
          await controller.start({
            surface: "global",
            gesture: command.gesture,
            activationStartedAtMs: command.activationStartedAtMs,
            streamingAvailability: capabilities?.capabilities.streaming ?? "read-failed",
          });
        });
        return;
      }
      if (command.sessionId !== session.activeSessionId) return;
      if (command.type === "paste-completed") return;
      if (command.type === "finish") {
        session.setActiveSessionId(null);
        setExternalError(null);
        return;
      }
      if (command.type === "stop") {
        if (session.recovery) return;
        if (controller.getSnapshot().kind === "idle") {
          session.setActiveSessionId(null);
          void sendEvent({ type: "cancelled", sessionId: command.sessionId });
          return;
        }
        setPresentationState("transcribing");
        controller.stop("insert");
      } else {
        controller.cancel();
        session.setRecovery(null);
        setRecovery(null);
      }
    });
  }, [controller, session]);

  useEffect(() => {
    const sessionId = session.activeSessionId;
    if (!sessionId) return;
    const nextEvent =
      snapshot.kind === "recording"
        ? "listening"
        : snapshot.kind === "transcribing" || snapshot.kind === "stopping"
          ? "transcribing"
          : null;
    if (nextEvent && session.lastStateEvent !== nextEvent) {
      session.setLastStateEvent(nextEvent);
      void sendEvent({ type: "state", sessionId, state: nextEvent });
      return;
    }
    if (snapshot.kind === "retryable-error") {
      if (session.pasteRecovery) return;
      const identity = `failed:${snapshot.error.kind}`;
      if (session.lastStateEvent === identity) return;
      session.setLastStateEvent(identity);
      if (session.playSounds) playDictationSound("error");
      void sendEvent({ type: "failed", sessionId, error: snapshot.error });
      return;
    }
    if (snapshot.kind === "idle" && !session.completionReported && !session.recovery) {
      session.setActiveSessionId(null);
      void sendEvent({ type: "cancelled", sessionId });
    }
  }, [snapshot, session]);

  const retry = (): void => {
    if (externalError) setExternalError(null);
    if (snapshot.kind !== "retryable-error") return;
    if (!snapshot.canRetryRecording) return;
    setPresentationState("transcribing");
    void controller.retry();
  };

  const dismiss = (): void => {
    const sessionId = session.activeSessionId;
    controller.cancel();
    const recovering = session.recovery !== null;
    session.setRecovery(null);
    setRecovery(null);
    if (!sessionId) return;
    session.setActiveSessionId(null);
    void sendEvent({ type: externalError || recovering ? "dismiss" : "cancelled", sessionId });
  };

  const close = (): void => {
    void sendEvent({ type: "close", sessionId: session.activeSessionId });
  };

  const waveform = snapshot.kind === "recording" ? snapshot.waveform : [];
  const visibleError =
    externalError ?? (snapshot.kind === "retryable-error" ? snapshot.error : null);
  const canRetry = externalError
    ? externalError.retryable
    : snapshot.kind === "retryable-error" && snapshot.canRetryRecording;
  const barState = visibleError ? "error" : presentationState;

  if (pasteRecovery) {
    const { sessionId, failure } = pasteRecovery;
    return (
      <GlobalDictationPasteRecovery
        failure={failure}
        onCopy={() => void sendEvent({ type: "copy-transcript", sessionId })}
        onOpenSettings={() => void sendEvent({ type: "open-accessibility-settings", sessionId })}
        onDismiss={() => {
          controller.cancel();
          session.setActiveSessionId(null);
          session.setPasteRecovery(false);
          setPasteRecovery(null);
          session.setRecovery(null);
          setRecovery(null);
          void sendEvent({ type: "close", sessionId });
        }}
      />
    );
  }

  if (recovery) {
    const sessionId = activeSessionId;
    return (
      <GlobalDictationTranscriptionRecovery
        recovery={recovery}
        onCopy={() => {
          if (sessionId && recovery.text)
            void sendEvent({ type: "copy-recovered-text", sessionId, text: recovery.text });
        }}
        onViewRecording={() => {
          if (sessionId && recovery.recordingId)
            void sendEvent({
              type: "view-recording",
              sessionId,
              recordingId: recovery.recordingId,
            });
        }}
        onRetry={retry}
        onDismiss={dismiss}
      />
    );
  }

  return (
    <main
      className={cn(
        "flex h-screen w-screen items-end justify-center overflow-hidden bg-transparent text-white",
        barState === "error" && "p-1",
      )}
    >
      <GlobalDictationBar
        state={barState}
        waveform={waveform}
        error={visibleError}
        canRetry={canRetry}
        configuredHotkey={configuredHotkey}
        configuredToggleHotkey={configuredToggleHotkey}
        activationNonce={activationNonce}
        onDismiss={dismiss}
        onRetry={retry}
        onClose={close}
      />
    </main>
  );
}

export function GlobalDictationPasteRecovery({
  failure,
  onCopy,
  onOpenSettings,
  onDismiss,
}: {
  readonly failure: GlobalDictationPasteFailure;
  readonly onCopy: () => void;
  readonly onOpenSettings: () => void;
  readonly onDismiss: () => void;
}) {
  const interactiveRegionRef = useRef<HTMLDivElement>(null);
  useFloatingWindowPointerInteractivity({
    activationNonce: 0,
    interactiveRegionRef,
    onInteractiveChange: publishPointerInteractivity,
  });
  return (
    <main className="flex h-screen w-screen items-end justify-center overflow-hidden bg-transparent text-token-text-primary">
      <div ref={interactiveRegionRef} className="w-full max-w-xl p-2 select-none">
        <section
          role="status"
          aria-live="polite"
          className="flex items-center gap-3 rounded-xl border-[0.5px] border-token-border bg-token-dropdown-background p-3 shadow-lg"
        >
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">
              {failure.copied ? (
                <span className="flex items-center gap-1">
                  Text copied — <ShortcutHint accelerator="Command+V" /> to paste
                </span>
              ) : (
                "Your clipboard changed"
              )}
            </div>
            <div className="text-xs text-token-text-secondary">
              {!failure.copied
                ? "Copy your transcript to paste it"
                : failure.reason === "accessibility"
                  ? "Enable Accessibility to paste automatically"
                  : "Couldn't paste automatically"}
            </div>
          </div>
          {failure.reason === "accessibility" ? (
            <NodexButton size="xs" variant="secondary" onClick={onOpenSettings}>
              Open Settings
            </NodexButton>
          ) : null}
          {!failure.copied ? (
            <NodexButton size="xs" variant="secondary" onClick={onCopy}>
              Copy transcript
            </NodexButton>
          ) : null}
          <NodexButton size="icon-xs" variant="ghost" aria-label="Dismiss" onClick={onDismiss}>
            <DictationDismissIcon className="size-3.5" />
          </NodexButton>
        </section>
      </div>
    </main>
  );
}

export function GlobalDictationTranscriptionRecovery({
  recovery,
  onCopy,
  onViewRecording,
  onRetry,
  onDismiss,
}: {
  readonly recovery: DictationRecovery;
  readonly onCopy: () => void;
  readonly onViewRecording: () => void;
  readonly onRetry: () => void;
  readonly onDismiss: () => void;
}) {
  const interactiveRegionRef = useRef<HTMLDivElement>(null);
  useFloatingWindowPointerInteractivity({
    activationNonce: 0,
    interactiveRegionRef,
    onInteractiveChange: publishPointerInteractivity,
  });
  return (
    <main className="flex h-screen w-screen items-end justify-center overflow-hidden bg-transparent text-token-text-primary">
      <div ref={interactiveRegionRef} className="w-full max-w-xl p-2 select-none">
        <section
          role="status"
          aria-live="polite"
          className="flex flex-wrap items-center gap-2 rounded-xl border-[0.5px] border-token-border bg-token-dropdown-background p-3 shadow-lg"
        >
          {recovery.phase === "recovering" ? <ActivitySpinnerIcon className="size-4" /> : null}
          <span className="min-w-0 flex-1 text-sm font-medium">
            {recovery.phase === "recovering"
              ? "Recovering text…"
              : recovery.phase === "recovered"
                ? "Text recovered"
                : "Dictation stopped"}
          </span>
          {recovery.phase === "recovered" && recovery.text ? (
            <NodexButton size="xs" variant="secondary" onClick={onCopy}>
              Copy text
            </NodexButton>
          ) : null}
          {recovery.phase === "failed" ? (
            <NodexButton size="xs" variant="secondary" onClick={onRetry}>
              Retry
            </NodexButton>
          ) : null}
          {recovery.recordingId && recovery.saveState === "saved" ? (
            <NodexButton size="xs" variant="ghost" onClick={onViewRecording}>
              View recording
            </NodexButton>
          ) : null}
          <NodexButton size="icon-xs" variant="ghost" aria-label="Dismiss" onClick={onDismiss}>
            <DictationDismissIcon className="size-3.5" />
          </NodexButton>
        </section>
      </div>
    </main>
  );
}
