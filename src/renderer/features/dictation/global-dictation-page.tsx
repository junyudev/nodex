import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  ActivitySpinnerIcon,
  DictationDismissIcon,
  DictationMicrophoneIcon,
  DictationRetryIcon,
} from "@/components/shared/icons";
import { ShortcutKeycaps } from "@/components/ui/shortcut-keycaps";
import { NodexTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { formatAcceleratorLabel } from "../../../shared/command-keybindings";
import type { DictationError, DictationSettings } from "../../../shared/dictation";
import { DEFAULT_DICTATION_SETTINGS } from "../../../shared/dictation";
import type { GlobalDictationRendererEvent } from "../../../shared/global-dictation";
import { cleanupDictationTranscript } from "./dictation-cleanup-client";
import { transcribeDictationBlob } from "./dictation-buffered-client";
import { createDictationHistoryPort } from "./dictation-history-client";
import { browserDictationRecorderFactory } from "./dictation-recorder";
import {
  DictationSessionController,
  type DictationControllerPorts,
} from "./dictation-session-controller";
import { mainDictationStreamingPort } from "./dictation-streaming-client";
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
  });

const transcribe = async (blob: Blob, signal: AbortSignal): Promise<string> =>
  await transcribeDictationBlob(blob, {
    signal,
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

const playFeedbackTone = (frequency: number): void => {
  try {
    const context = new AudioContext();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const startAt = context.currentTime;
    const stopAt = startAt + 0.09;
    oscillator.frequency.setValueAtTime(frequency, startAt);
    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.exponentialRampToValueAtTime(0.08, startAt + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, stopAt);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.addEventListener("ended", () => void context.close(), { once: true });
    oscillator.start(startAt);
    oscillator.stop(stopAt);
  } catch {
    // Capture does not depend on best-effort audible feedback.
  }
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
  const previousSnapshotKindRef = useRef("idle");
  const appliedCompletionIdsRef = useRef(new Set<string>());
  const [settings, setSettings] = useState<DictationSettings>(DEFAULT_DICTATION_SETTINGS);
  const [presentationState, setPresentationState] =
    useState<GlobalDictationBarState>("initializing");
  const [configuredHotkey, setConfiguredHotkey] = useState<string | null>(null);
  const [configuredToggleHotkey, setConfiguredToggleHotkey] = useState<string | null>(null);
  const [activationNonce, setActivationNonce] = useState(0);
  const [externalError, setExternalError] = useState<DictationError | null>(null);
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
            const [nextSettings, builtInMicrophoneLabelHint] = await Promise.all([
              globalDictationTransport.readSettings().catch(() => DEFAULT_DICTATION_SETTINGS),
              globalDictationTransport.readMicrophoneRouteHint().catch(() => null),
            ]);
            setSettings(nextSettings);
            return await acquireMicrophone({
              mediaDevices: navigator.mediaDevices,
              selectedDeviceId: nextSettings.microphoneInputDeviceId,
              builtInMicrophoneLabelHint,
            });
          },
        },
        recorder: browserDictationRecorderFactory,
        waveform: browserGlobalDictationCompactWaveformPort,
        streaming: mainDictationStreamingPort,
        buffered: { transcribe },
        cleanup: {
          transcript: async (transcript, signal) =>
            await cleanupDictationTranscript(transcript, {
              signal,
              cleanup: globalDictationTransport.cleanup,
              cancel: globalDictationTransport.cancelTranscription,
            }),
        },
        history: createGlobalHistoryPort(),
        completion: {
          apply: async ({ sessionId: recordingSessionId, transcript }) => {
            if (appliedCompletionIdsRef.current.has(recordingSessionId)) return;
            appliedCompletionIdsRef.current.add(recordingSessionId);
            const sessionId = activeSessionIdRef.current;
            if (!sessionId) return;
            completionReportedRef.current = true;
            await sendEvent({ type: "completed", sessionId, transcript }).catch(() => false);
          },
        },
        clock: defaultClock,
        createId: () => crypto.randomUUID(),
      }),
  );
  const snapshot = useDictationSession(controller);

  useEffect(() => {
    void globalDictationTransport
      .readSettings()
      .then(setSettings)
      .catch(() => undefined);
    void sendEvent({ type: "ready" });
    return () => controller.dispose();
  }, [controller]);

  useEffect(() => {
    const bridge = window.globalDictation;
    if (!bridge) return;
    return bridge.onCommand((command) => {
      if (command.type === "idle") {
        activeSessionIdRef.current = null;
        setConfiguredHotkey(command.configuredHotkey);
        setConfiguredToggleHotkey(command.configuredToggleHotkey);
        setExternalError(null);
        setActivationNonce((nonce) => nonce + 1);
        setPresentationState(
          command.configuredHotkey || command.configuredToggleHotkey ? "idle" : "initializing",
        );
        return;
      }
      if (command.type === "start") {
        if (controller.getSnapshot().kind !== "idle") return;
        activeSessionIdRef.current = command.sessionId;
        completionReportedRef.current = false;
        setExternalError(null);
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
          await controller.start({ surface: "global", gesture: command.gesture });
        });
        return;
      }
      if (command.sessionId !== activeSessionIdRef.current) return;
      if (command.type === "paste-failed") {
        setExternalError(command.error);
        setPresentationState("error");
        return;
      }
      if (command.type === "finish") {
        activeSessionIdRef.current = null;
        setExternalError(null);
        return;
      }
      if (command.type === "stop") {
        setPresentationState("transcribing");
        controller.stop("insert");
      } else {
        controller.cancel();
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
      const identity = `failed:${snapshot.error.kind}`;
      setPresentationState("error");
      if (lastStateEventRef.current === identity) return;
      lastStateEventRef.current = identity;
      void sendEvent({ type: "failed", sessionId, error: snapshot.error });
      return;
    }
    if (snapshot.kind === "idle" && !completionReportedRef.current) {
      activeSessionIdRef.current = null;
      void sendEvent({ type: "cancelled", sessionId });
    }
  }, [snapshot]);

  useEffect(() => {
    const previousKind = previousSnapshotKindRef.current;
    previousSnapshotKindRef.current = snapshot.kind;
    if (snapshot.kind === "recording" && previousKind !== "recording") {
      if (settings.playStartSound) playFeedbackTone(660);
      return;
    }
    if (snapshot.kind !== "recording" && previousKind === "recording" && settings.playStopSound) {
      playFeedbackTone(440);
    }
  }, [settings.playStartSound, settings.playStopSound, snapshot.kind]);

  const retry = (): void => {
    if (externalError) {
      const sessionId = activeSessionIdRef.current;
      if (sessionId) {
        setPresentationState("transcribing");
        void sendEvent({ type: "retry-paste", sessionId });
      }
      return;
    }
    if (snapshot.kind !== "retryable-error") return;
    if (!snapshot.canRetryRecording) return;
    setPresentationState("transcribing");
    void controller.retry();
  };

  const dismiss = (): void => {
    const sessionId = activeSessionIdRef.current;
    controller.cancel();
    if (!sessionId) return;
    activeSessionIdRef.current = null;
    void sendEvent({ type: externalError ? "dismiss" : "cancelled", sessionId });
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
