import { useEffect, useRef, useState, type RefObject } from "react";
import {
  createCommandKeymapState,
  matchesKeyboardEventToCommand,
  type CommandKeymapState,
} from "../../../../../shared/command-keybindings";
import type { DictationError, DictationStopAction } from "../../../../../shared/dictation";
import type {
  GlobalDictationDeclineReason,
  GlobalDictationRendererEvent,
} from "../../../../../shared/global-dictation";
import {
  acquireDictationMicrophoneLease,
  readBuiltInMicrophoneRouteHint,
  readDictationSettings,
  requestMicrophoneAccess,
  releaseDictationMicrophoneLease,
} from "@/lib/api";
import { acquireMicrophone } from "@/features/dictation/microphone-acquirer";
import { browserDictationRecorderFactory } from "@/features/dictation/dictation-recorder";
import { mainDictationHistoryPort } from "@/features/dictation/dictation-history-client";
import { mainDictationStreamingPort } from "@/features/dictation/dictation-streaming-client";
import {
  DictationSessionController,
  type DictationControllerPorts,
} from "@/features/dictation/dictation-session-controller";
import { browserDictationWaveformPort } from "@/features/dictation/dictation-waveform";
import { useDictationSession } from "@/features/dictation/use-dictation-session";
import { transcribeDictationBlob } from "@/features/dictation/dictation-buffered-client";
import { useInAppDictationTarget } from "@/features/dictation/in-app-dictation-router";
import { reportGlobalDictationEvent } from "@/features/dictation/dictation-command-runtime";
import {
  COMPOSER_DICTATION_WAVEFORM_ADVANCE_INTERVAL_MS,
  drawComposerDictationWaveform,
} from "./composer-dictation-waveform";

type DictationStopMode = Extract<DictationStopAction, "insert" | "send">;

export interface ComposerDictationController {
  readonly isDictating: boolean;
  readonly isTranscribing: boolean;
  readonly transcriptionAction: DictationStopMode | null;
  readonly recordingDurationMs: number;
  readonly waveformCanvasRef: RefObject<HTMLCanvasElement | null>;
  readonly startDictation: () => Promise<void>;
  readonly stopDictation: (mode: DictationStopMode) => void;
  readonly retryDictation: () => Promise<void>;
  readonly cancelDictation: () => void;
  readonly retryableError: DictationError | null;
}

interface UseComposerDictationInput {
  readonly enabled: boolean;
  readonly globalTarget: {
    readonly id: string;
    readonly priority: number;
    readonly admission: () => GlobalDictationDeclineReason | null;
  };
  readonly onTranscriptInsert: (text: string) => void;
  readonly onTranscriptSend: (text: string) => void;
  readonly onStartError: (error: DictationError) => void;
  readonly onTranscribeError: (error: DictationError) => void;
  readonly onUnsupported: () => void;
}

export function isComposerDictationShortcut(
  event: globalThis.KeyboardEvent,
  commandKeymapState: CommandKeymapState = createCommandKeymapState(),
): boolean {
  if (event.defaultPrevented) return false;
  return matchesKeyboardEventToCommand(event, commandKeymapState, "composerDictationHold");
}

export function isComposerDictationShortcutTargetBlocked(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest("[data-codex-terminal]"));
}

export function formatComposerDictationDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

const defaultClock: DictationControllerPorts["clock"] = {
  now: () => performance.now(),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (timer) => globalThis.clearTimeout(timer),
};

const invokeGlobalDictationEvent = async (event: GlobalDictationRendererEvent): Promise<boolean> =>
  await reportGlobalDictationEvent(event);

export function useComposerDictation(
  input: UseComposerDictationInput,
): ComposerDictationController {
  const callbacksRef = useRef(input);
  callbacksRef.current = input;
  const waveformCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const waveformLevelsRef = useRef<readonly number[]>([]);
  const waveformAdvancedAtRef = useRef(0);
  const reportedErrorRef = useRef<string | null>(null);
  const globalSessionIdRef = useRef<string | null>(null);
  const globalCompletionReportedRef = useRef(false);
  const releaseGlobalRouteRef = useRef<(() => void) | null>(null);
  const lastGlobalStateRef = useRef<string | null>(null);
  const appliedCompletionIdsRef = useRef(new Set<string>());
  const [controller] = useState(
    () =>
      new DictationSessionController({
        lease: {
          acquire: acquireDictationMicrophoneLease,
          release: async (sessionId) => void (await releaseDictationMicrophoneLease(sessionId)),
        },
        permissions: { request: requestMicrophoneAccess },
        devices: {
          acquire: async () => {
            const [settings, builtInMicrophoneLabelHint] = await Promise.all([
              readDictationSettings().catch(() => ({
                microphoneInputDeviceId: null,
                keepGlobalBarVisible: false,
                playStartSound: true,
                playStopSound: true,
                globalShortcutNudgeDismissed: false,
                dictionary: [],
              })),
              readBuiltInMicrophoneRouteHint().catch(() => null),
            ]);
            return await acquireMicrophone({
              mediaDevices: navigator.mediaDevices,
              selectedDeviceId: settings.microphoneInputDeviceId,
              builtInMicrophoneLabelHint,
            });
          },
        },
        recorder: browserDictationRecorderFactory,
        waveform: browserDictationWaveformPort,
        streaming: mainDictationStreamingPort,
        buffered: {
          transcribe: async (blob, signal, _sessionId, onDiagnostics) => {
            if (signal.aborted) throw new DOMException("Dictation was aborted", "AbortError");
            const result = await transcribeDictationBlob(blob, { signal, onDiagnostics });
            if (signal.aborted) throw new DOMException("Dictation was aborted", "AbortError");
            return result;
          },
        },
        // Current Codex Composer intentionally bypasses semantic cleanup; the shared
        // controller keeps the seam so global dictation and recording recovery can use it.
        cleanup: { enabled: false, transcript: async (transcript) => transcript },
        history: mainDictationHistoryPort,
        completion: {
          apply: async ({ sessionId, action, transcript }) => {
            if (appliedCompletionIdsRef.current.has(sessionId)) return;
            appliedCompletionIdsRef.current.add(sessionId);
            const globalSessionId = globalSessionIdRef.current;
            if (globalSessionId) {
              callbacksRef.current.onTranscriptInsert(transcript);
              globalCompletionReportedRef.current = true;
              await invokeGlobalDictationEvent({
                type: "completed",
                sessionId: globalSessionId,
                transcript,
              }).catch(() => false);
              globalSessionIdRef.current = null;
              releaseGlobalRouteRef.current?.();
              releaseGlobalRouteRef.current = null;
              return;
            }
            if (action === "send") {
              callbacksRef.current.onTranscriptSend(transcript);
              return;
            }
            callbacksRef.current.onTranscriptInsert(transcript);
          },
        },
        clock: defaultClock,
        createId: () => crypto.randomUUID(),
      }),
  );
  const snapshot = useDictationSession(controller);

  useEffect(() => {
    if (input.enabled) return;
    controller.cancel();
  }, [controller, input.enabled]);

  useInAppDictationTarget({
    id: input.globalTarget.id,
    priority: input.globalTarget.priority,
    admission: () => {
      if (!callbacksRef.current.enabled) return "unavailable";
      if (controller.getSnapshot().kind !== "idle") return "busy";
      return callbacksRef.current.globalTarget.admission();
    },
    start: async ({ sessionId, gesture, release }) => {
      globalSessionIdRef.current = sessionId;
      releaseGlobalRouteRef.current = release;
      globalCompletionReportedRef.current = false;
      lastGlobalStateRef.current = null;
      await controller.start({ surface: "global", gesture });
    },
    stop: () => controller.stop("insert"),
    cancel: () => controller.cancel(),
  });

  useEffect(() => {
    if (snapshot.kind !== "recording") return;
    if (waveformLevelsRef.current === snapshot.waveform) return;
    waveformLevelsRef.current = snapshot.waveform;
    waveformAdvancedAtRef.current = performance.now();
  }, [snapshot]);

  useEffect(() => {
    if (snapshot.kind !== "recording") return;
    let animationFrame: number | null = null;
    const draw = (): void => {
      const canvas = waveformCanvasRef.current;
      if (canvas) {
        const elapsedMs = Math.max(0, performance.now() - waveformAdvancedAtRef.current);
        drawComposerDictationWaveform(
          canvas,
          waveformLevelsRef.current,
          elapsedMs / COMPOSER_DICTATION_WAVEFORM_ADVANCE_INTERVAL_MS,
        );
      }
      animationFrame = requestAnimationFrame(draw);
    };
    waveformAdvancedAtRef.current = performance.now();
    animationFrame = requestAnimationFrame(draw);
    return () => {
      if (animationFrame !== null) cancelAnimationFrame(animationFrame);
    };
  }, [snapshot.kind]);

  useEffect(() => {
    if (snapshot.kind !== "retryable-error") {
      reportedErrorRef.current = null;
      return;
    }
    const identity = `${snapshot.sessionId}:${snapshot.error.kind}:${snapshot.canRetryRecording}`;
    if (reportedErrorRef.current === identity) return;
    reportedErrorRef.current = identity;
    if (!snapshot.canRetryRecording) {
      callbacksRef.current.onStartError(snapshot.error);
      return;
    }
    callbacksRef.current.onTranscribeError(snapshot.error);
  }, [snapshot]);

  useEffect(() => {
    const sessionId = globalSessionIdRef.current;
    if (!sessionId) return;
    const nextState =
      snapshot.kind === "recording"
        ? "listening"
        : snapshot.kind === "transcribing"
          ? "transcribing"
          : null;
    if (nextState && lastGlobalStateRef.current !== nextState) {
      lastGlobalStateRef.current = nextState;
      void invokeGlobalDictationEvent({ type: "state", sessionId, state: nextState });
      return;
    }
    if (snapshot.kind === "retryable-error") {
      const identity = `failed:${snapshot.error.kind}`;
      if (lastGlobalStateRef.current === identity) return;
      lastGlobalStateRef.current = identity;
      void invokeGlobalDictationEvent({ type: "failed", sessionId, error: snapshot.error });
      return;
    }
    if (snapshot.kind === "idle" && !globalCompletionReportedRef.current) {
      globalSessionIdRef.current = null;
      releaseGlobalRouteRef.current?.();
      releaseGlobalRouteRef.current = null;
      void invokeGlobalDictationEvent({ type: "cancelled", sessionId });
    }
  }, [snapshot]);

  const startDictation = async (): Promise<void> => {
    if (
      !callbacksRef.current.enabled ||
      typeof navigator.mediaDevices?.getUserMedia !== "function" ||
      typeof MediaRecorder === "undefined"
    ) {
      callbacksRef.current.onUnsupported();
      return;
    }
    globalSessionIdRef.current = null;
    await controller.start({ surface: "composer", gesture: "click" });
  };

  const isDictating = ["requesting-permission", "acquiring-stream", "recording"].includes(
    snapshot.kind,
  );
  const recordingDurationMs =
    snapshot.kind === "recording" ||
    snapshot.kind === "stopping" ||
    snapshot.kind === "transcribing"
      ? snapshot.durationMs
      : 0;

  return {
    isDictating,
    isTranscribing: snapshot.kind === "stopping" || snapshot.kind === "transcribing",
    transcriptionAction:
      snapshot.kind === "stopping" || snapshot.kind === "transcribing" ? snapshot.action : null,
    recordingDurationMs,
    waveformCanvasRef,
    startDictation,
    stopDictation: (mode) => controller.stop(mode),
    retryDictation: () => controller.retry(),
    cancelDictation: () => controller.cancel(),
    retryableError: snapshot.kind === "retryable-error" ? snapshot.error : null,
  };
}
