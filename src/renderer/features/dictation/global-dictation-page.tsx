import { deliverGlobalDictation } from "./global-dictation-delivery";
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
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
        Hold <ShortcutHint accelerator={configuredHotkey} /> or press
        <ShortcutHint accelerator={configuredToggleHotkey} /> to dictate
      </span>
    );
  }
  if (configuredHotkey) {
    return (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
        Hold <ShortcutHint accelerator={configuredHotkey} /> to dictate
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
  const levelsRef = useRef(levels);
  const paintRef = useRef<() => void>(() => undefined);
  levelsRef.current = levels;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const paint = (): void => {
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
      for (const rect of resolveGlobalDictationCompactBarRects(
        width,
        height,
        ratio,
        levelsRef.current,
      )) {
        context.globalAlpha = rect.alpha;
        context.beginPath();
        context.roundRect(rect.x, rect.y, rect.width, rect.height, rect.radius);
        context.fill();
      }
      context.globalAlpha = 1;
    };
    paintRef.current = paint;
    paint();
    const observer = new ResizeObserver(paint);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useEffect(() => paintRef.current(), [levels]);

  return <canvas ref={canvasRef} className="h-4 min-w-0 flex-1 text-white" aria-hidden="true" />;
}

export function GlobalDictationBar({
  state,
  waveform,
  error,
  canRetry = error?.retryable ?? false,
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
  const interactiveRegionRef = useRef<HTMLElement>(null);
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const hasConfiguredShortcut = configuredHotkey !== null || configuredToggleHotkey !== null;
  useFloatingWindowPointerInteractivity({
    activationNonce,
    interactiveRegionRef,
    onInteractiveChange: publishPointerInteractivity,
  });

  useEffect(() => {
    if (state !== "idle") setTooltipOpen(false);
  }, [state]);

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
            {canRetry ? (
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

export function GlobalDictationRoot() {
  const activeSessionIdRef = useRef<string | null>(null);
  const completionReportedRef = useRef(false);
  const lastStateEventRef = useRef<string | null>(null);
  const appliedCompletionIdsRef = useRef(new Set<string>());
  const captureSettingsRef = useRef(DEFAULT_DICTATION_SETTINGS);
  const playSoundsRef = useRef(false);
  const recoveryRef = useRef<DictationRecovery | null>(null);
  const pasteRecoveryRef = useRef(false);
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
        lease: {
          acquire: async (sessionId, surface) =>
            await globalDictationTransport.acquireMicrophoneLease({ sessionId, surface }),
          release: async (sessionId) => {
            await globalDictationTransport.releaseMicrophoneLease(sessionId);
          },
        },
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
              selectedDeviceId: captureSettingsRef.current.microphoneInputDeviceId,
              builtInMicrophoneLabelHint,
            });
          },
        },
        recorder: browserDictationRecorderFactory,
        waveform: browserGlobalDictationCompactWaveformPort,
        streaming: createBrowserDictationStreamingPort(
          globalDictationTransport.readStreamingConnectInfo,
        ),
        buffered: { transcribe },
        cleanup: { enabled: false, transcript: async (text) => text },
        onRecoveryChange: (next) => {
          const sessionId = activeSessionIdRef.current;
          if (!sessionId || pasteRecoveryRef.current) return;
          recoveryRef.current = next;
          setRecovery(next);
          setPresentationState("error");
          void sendEvent({
            type: "failed",
            sessionId,
            error: { kind: "transcription-service", operation: "transcribe", retryable: true },
          });
        },
        onStopRequested: () => {
          const sessionId = activeSessionIdRef.current;
          if (sessionId) void sendEvent({ type: "recording-stopped", sessionId });
        },
        onRecordingStarted: () => {
          if (playSoundsRef.current) playDictationSound("start");
        },
        onRecordingStopped: () => {
          if (playSoundsRef.current) playDictationSound("stop");
        },
        history: createGlobalHistoryPort(),
        completion: {
          apply: async ({ sessionId: recordingSessionId, transcript, signal }) => {
            if (appliedCompletionIdsRef.current.has(recordingSessionId)) return;
            const sessionId = activeSessionIdRef.current;
            if (!sessionId) throw new DOMException("Dictation was cancelled", "AbortError");
            completionReportedRef.current = true;
            const bridge = window.globalDictation;
            if (!bridge) throw new Error("Global dictation bridge is unavailable");
            const delivered = await deliverGlobalDictation({
              sessionId,
              transcript,
              signal,
              sendEvent,
              onCommand: bridge.onCommand,
            });
            appliedCompletionIdsRef.current.add(recordingSessionId);
            return delivered;
          },
        },
        clock: defaultClock,
        createId: () => crypto.randomUUID(),
      }),
  );
  const snapshot = useDictationSession(controller);

  useEffect(() => {
    void sendEvent({ type: "ready" });
  }, [controller]);

  useEffect(() => {
    const bridge = window.globalDictation;
    if (!bridge) return;
    return bridge.onCommand((command) => {
      if (command.type === "paste-failed") {
        pasteRecoveryRef.current = true;
        setPasteRecovery({ sessionId: command.sessionId, failure: command.failure });
        return;
      }
      if (command.type === "idle") {
        activeSessionIdRef.current = null;
        setConfiguredHotkey(command.configuredHotkey);
        setConfiguredToggleHotkey(command.configuredToggleHotkey);
        setExternalError(null);
        setPasteRecovery(null);
        pasteRecoveryRef.current = false;
        recoveryRef.current = null;
        setRecovery(null);
        setActivationNonce((nonce) => nonce + 1);
        setPresentationState(
          command.configuredHotkey || command.configuredToggleHotkey ? "idle" : "initializing",
        );
        return;
      }
      if (command.type === "start") {
        if (controller.getSnapshot().kind !== "idle") {
          if (!recoveryRef.current && !pasteRecoveryRef.current) return;
          controller.cancel();
        }
        activeSessionIdRef.current = command.sessionId;
        completionReportedRef.current = false;
        setExternalError(null);
        setPasteRecovery(null);
        pasteRecoveryRef.current = false;
        recoveryRef.current = null;
        setRecovery(null);
        setActivationNonce((nonce) => nonce + 1);
        setPresentationState("listening");
        lastStateEventRef.current = null;
        void sendEvent({
          type: "accepted",
          sessionId: command.sessionId,
          requestId: command.requestId,
          targetId: "global-overlay",
        }).then(async (accepted) => {
          if (!accepted || activeSessionIdRef.current !== command.sessionId) {
            if (activeSessionIdRef.current === command.sessionId) activeSessionIdRef.current = null;
            return;
          }
          const [settings, capabilities] = await Promise.all([
            globalDictationTransport.readSettings().catch(() => DEFAULT_DICTATION_SETTINGS),
            globalDictationTransport.readCapabilities().catch(() => null),
          ]);
          if (activeSessionIdRef.current !== command.sessionId) return;
          captureSettingsRef.current = settings;
          playSoundsRef.current = capabilities?.capabilities.sounds === true;
          await controller.start({
            surface: "global",
            gesture: command.gesture,
            activationStartedAtMs: command.activationStartedAtMs,
            streamingEnabled: capabilities?.capabilities.streaming === "available",
          });
        });
        return;
      }
      if (command.sessionId !== activeSessionIdRef.current) return;
      if (command.type === "paste-completed") return;
      if (command.type === "finish") {
        activeSessionIdRef.current = null;
        setExternalError(null);
        return;
      }
      if (command.type === "stop") {
        if (recoveryRef.current) return;
        if (controller.getSnapshot().kind === "idle") {
          activeSessionIdRef.current = null;
          void sendEvent({ type: "cancelled", sessionId: command.sessionId });
          return;
        }
        setPresentationState("transcribing");
        controller.stop("insert");
      } else {
        controller.cancel();
        recoveryRef.current = null;
        setRecovery(null);
      }
    });
  }, [controller]);

  useEffect(() => {
    const sessionId = activeSessionIdRef.current;
    if (!sessionId) return;
    const nextEvent =
      snapshot.kind === "recording"
        ? "listening"
        : snapshot.kind === "transcribing" || snapshot.kind === "stopping"
          ? "transcribing"
          : null;
    if (nextEvent) setPresentationState(nextEvent);
    if (nextEvent && lastStateEventRef.current !== nextEvent) {
      lastStateEventRef.current = nextEvent;
      void sendEvent({ type: "state", sessionId, state: nextEvent });
      return;
    }
    if (snapshot.kind === "retryable-error") {
      if (pasteRecoveryRef.current) return;
      const identity = `failed:${snapshot.error.kind}`;
      setPresentationState("error");
      if (lastStateEventRef.current === identity) return;
      lastStateEventRef.current = identity;
      if (playSoundsRef.current) playDictationSound("error");
      void sendEvent({ type: "failed", sessionId, error: snapshot.error });
      return;
    }
    if (snapshot.kind === "idle" && !completionReportedRef.current && !recoveryRef.current) {
      activeSessionIdRef.current = null;
      void sendEvent({ type: "cancelled", sessionId });
    }
  }, [snapshot]);

  const retry = (): void => {
    if (externalError) setExternalError(null);
    if (snapshot.kind !== "retryable-error") return;
    if (!snapshot.canRetryRecording) return;
    setPresentationState("transcribing");
    void controller.retry();
  };

  const dismiss = (): void => {
    const sessionId = activeSessionIdRef.current;
    controller.cancel();
    const recovering = recoveryRef.current !== null;
    recoveryRef.current = null;
    setRecovery(null);
    if (!sessionId) return;
    activeSessionIdRef.current = null;
    void sendEvent({ type: externalError || recovering ? "dismiss" : "cancelled", sessionId });
  };

  const close = (): void => {
    void sendEvent({ type: "close", sessionId: activeSessionIdRef.current });
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
          activeSessionIdRef.current = null;
          pasteRecoveryRef.current = false;
          setPasteRecovery(null);
          recoveryRef.current = null;
          setRecovery(null);
          void sendEvent({ type: "close", sessionId });
        }}
      />
    );
  }

  if (recovery) {
    const sessionId = activeSessionIdRef.current;
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
