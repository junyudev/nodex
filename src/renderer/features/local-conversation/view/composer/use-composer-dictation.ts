import { useEffect, useRef, useState, type RefObject } from "react";
import {
  createCommandKeymapState,
  matchesKeyboardEventToCommand,
  type CommandKeymapState,
} from "../../../../../shared/command-keybindings";
import {
  DEFAULT_DICTATION_SETTINGS,
  type DictationError,
  type DictationGesture,
  type DictationStopAction,
} from "../../../../../shared/dictation";
import type {
  GlobalDictationDeclineReason,
  GlobalDictationRendererEvent,
} from "../../../../../shared/global-dictation";
import {
  acquireDictationMicrophoneLease,
  readBuiltInMicrophoneRouteHint,
  readDictationSettings,
  readDictationStreamingConnectInfo,
  requestMicrophoneAccess,
  releaseDictationMicrophoneLease,
} from "@/lib/api";
import { acquireMicrophone } from "@/features/dictation/microphone-acquirer";
import { browserDictationRecorderFactory } from "@/features/dictation/dictation-recorder";
import { mainDictationHistoryPort } from "@/features/dictation/dictation-history-client";
import { createBrowserDictationStreamingPort } from "@/features/dictation/dictation-streaming-client";
import {
  DictationSessionController,
  type DictationControllerPorts,
  type DictationRecovery,
} from "@/features/dictation/dictation-session-controller";
import { playDictationSound } from "@/features/dictation/dictation-sounds";
import { browserDictationWaveformPort } from "@/features/dictation/dictation-waveform";
import { useDictationSession } from "@/features/dictation/use-dictation-session";
import { transcribeDictationBlob } from "@/features/dictation/dictation-buffered-client";
import { useInAppDictationTarget } from "@/features/dictation/in-app-dictation-router";
import { reportGlobalDictationEvent } from "@/features/dictation/dictation-command-runtime";
import {
  COMPOSER_DICTATION_WAVEFORM_ADVANCE_INTERVAL_MS,
  drawComposerDictationWaveform,
} from "./composer-dictation-waveform";

import {
  browserInlineDictationWaveformPort,
  drawInlineDictationWaveform,
} from "./composer-inline-dictation-waveform";

type DictationStopMode = Extract<DictationStopAction, "insert" | "send">;

export interface ComposerDictationController {
  readonly isDictating: boolean;
  readonly isStarting: boolean;
  readonly canRetryDictation: boolean;
  readonly isTranscribing: boolean;
  readonly transcriptionAction: DictationStopMode | null;
  readonly recordingDurationMs: number;
  readonly waveformCanvasRef: RefObject<HTMLCanvasElement | null>;
  readonly startDictation: (gesture?: DictationGesture) => Promise<void>;
  readonly stopDictation: (mode: DictationStopMode) => void;
  readonly retryDictation: () => Promise<void>;
  readonly cancelDictation: () => void;
  readonly retryableError: DictationError | null;
  readonly recovery: DictationRecovery | null;
  readonly dismissRecovery: () => void;
  readonly appendRecoveredText: () => Promise<void>;
}

interface UseComposerDictationInput {
  readonly enabled: boolean;
  readonly streamingEnabled?: boolean;
  readonly soundsEnabled?: boolean;
  readonly globalTarget: {
    readonly id: string;
    readonly priority: number;
    readonly admission: () => GlobalDictationDeclineReason | null;
  };
  readonly transcript: NonNullable<DictationControllerPorts["transcript"]>;
  readonly getLanguage?: () => Promise<string | undefined>;
  readonly onTranscriptInsert: (text: string) => void | Promise<void>;
  readonly onTranscriptSend: (text: string) => void | Promise<void>;
  readonly onTranscriptAppend: (text: string) => void | Promise<void>;
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
  const [recovery, setRecovery] = useState<DictationRecovery | null>(null);
  const dismissedRecoveryRef = useRef(false);
  const playRecordingSoundsRef = useRef(false);
  const recordingSettingsRef = useRef(DEFAULT_DICTATION_SETTINGS);
  const callbacksRef = useRef(input);
  callbacksRef.current = input;
  const transcriptCallbacksRef = useRef(input.transcript);
  const completionCallbacksRef = useRef<UseComposerDictationInput | null>(null);
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
        permissions: {
          request: async () => {
            const soundsEnabled = callbacksRef.current.soundsEnabled === true;
            const settings = await readDictationSettings().catch(() => DEFAULT_DICTATION_SETTINGS);
            recordingSettingsRef.current = settings;
            playRecordingSoundsRef.current = soundsEnabled && settings.dictationSoundsEnabled;
            return requestMicrophoneAccess();
          },
        },
        devices: {
          acquire: async () => {
            const settings = recordingSettingsRef.current;
            const builtInMicrophoneLabelHint = await readBuiltInMicrophoneRouteHint().catch(
              () => null,
            );
            return await acquireMicrophone({
              mediaDevices: navigator.mediaDevices,
              selectedDeviceId: settings.microphoneInputDeviceId,
              builtInMicrophoneLabelHint,
            });
          },
        },
        recorder: browserDictationRecorderFactory,
        waveform: {
          start: (stream, onSamples) =>
            (callbacksRef.current.streamingEnabled === true
              ? browserInlineDictationWaveformPort
              : browserDictationWaveformPort
            ).start(stream, onSamples),
        },
        streaming: createBrowserDictationStreamingPort(readDictationStreamingConnectInfo),
        buffered: {
          transcribe: async (blob, signal, _sessionId, onDiagnostics, language) => {
            if (signal.aborted) throw new DOMException("Dictation was aborted", "AbortError");
            const result = await transcribeDictationBlob(blob, { signal, onDiagnostics, language });
            if (signal.aborted) throw new DOMException("Dictation was aborted", "AbortError");
            return result;
          },
        },
        // Composer inserts the recognized text without semantic rewriting.
        cleanup: { enabled: false, transcript: async (transcript) => transcript },
        history: mainDictationHistoryPort,
        transcript: {
          start: (split) => {
            transcriptCallbacksRef.current = callbacksRef.current.transcript;
            transcriptCallbacksRef.current.start(split);
          },
          update: (text, segment) => transcriptCallbacksRef.current.update(text, segment),
          cancel: () => transcriptCallbacksRef.current.cancel(),
          preserve: () => transcriptCallbacksRef.current.preserve?.(),
        },
        onRecordingStarted: () => {
          if (playRecordingSoundsRef.current) playDictationSound("start");
        },
        onRecordingStopped: () => {
          if (playRecordingSoundsRef.current) playDictationSound("stop");
        },
        onRecoveryChange: (recovery) => {
          transcriptCallbacksRef.current.preserve?.();
          if (!dismissedRecoveryRef.current) setRecovery(recovery);
        },
        completion: {
          apply: async ({ sessionId, action, transcript, append }) => {
            const completionId = `${sessionId}:${append ? "append" : action}`;
            if (appliedCompletionIdsRef.current.has(completionId)) return;
            const callbacks = completionCallbacksRef.current ?? callbacksRef.current;
            if (append) {
              await callbacks.onTranscriptAppend(transcript);
              appliedCompletionIdsRef.current.add(completionId);
              dismissedRecoveryRef.current = true;
              setRecovery(null);
              return;
            }
            const globalSessionId = globalSessionIdRef.current;
            if (globalSessionId) {
              await callbacks.onTranscriptInsert(transcript);
              appliedCompletionIdsRef.current.add(completionId);
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
              await callbacks.onTranscriptSend(transcript);
              appliedCompletionIdsRef.current.add(completionId);
              return;
            }
            await callbacks.onTranscriptInsert(transcript);
            appliedCompletionIdsRef.current.add(completionId);
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
      completionCallbacksRef.current = null;
      dismissedRecoveryRef.current = false;
      setRecovery(null);
      await controller.start({
        surface: "global",
        gesture,
        streamingEnabled: callbacksRef.current.streamingEnabled,
      });
    },
    stop: () => {
      completionCallbacksRef.current = callbacksRef.current;
      controller.stop("insert");
    },
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
        if (callbacksRef.current.streamingEnabled === true) {
          drawInlineDictationWaveform(canvas, waveformLevelsRef.current);
        } else
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
    if (playRecordingSoundsRef.current) playDictationSound("error");
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

  const startDictation = async (gesture: DictationGesture = "click"): Promise<void> => {
    if (
      !callbacksRef.current.enabled ||
      typeof navigator.mediaDevices?.getUserMedia !== "function" ||
      typeof MediaRecorder === "undefined"
    ) {
      callbacksRef.current.onUnsupported();
      return;
    }
    globalSessionIdRef.current = null;
    completionCallbacksRef.current = null;
    dismissedRecoveryRef.current = false;
    setRecovery(null);
    await controller.start({
      surface: "composer",
      gesture,
      streamingEnabled: callbacksRef.current.streamingEnabled,
      getLanguage: callbacksRef.current.getLanguage,
    });
  };

  const isStarting =
    snapshot.kind === "requesting-permission" || snapshot.kind === "acquiring-stream";
  const isDictating = snapshot.kind === "recording";
  const recordingDurationMs =
    snapshot.kind === "recording" ||
    snapshot.kind === "stopping" ||
    snapshot.kind === "transcribing"
      ? snapshot.durationMs
      : 0;

  return {
    isDictating,
    isStarting,
    canRetryDictation: snapshot.kind === "retryable-error" && snapshot.canRetryRecording,
    isTranscribing: snapshot.kind === "stopping" || snapshot.kind === "transcribing",
    transcriptionAction:
      snapshot.kind === "stopping" || snapshot.kind === "transcribing" ? snapshot.action : null,
    recordingDurationMs,
    waveformCanvasRef,
    startDictation,
    stopDictation: (mode) => {
      completionCallbacksRef.current ??= callbacksRef.current;
      controller.stop(mode);
    },
    retryDictation: () => {
      dismissedRecoveryRef.current = false;
      return controller.retry();
    },
    cancelDictation: () => controller.cancel(),
    retryableError: snapshot.kind === "retryable-error" ? snapshot.error : null,
    recovery,
    dismissRecovery: () => {
      dismissedRecoveryRef.current = true;
      setRecovery(null);
    },
    appendRecoveredText: async () => {
      if (recovery?.phase !== "recovered" || !recovery.text) return;
      await callbacksRef.current.onTranscriptAppend(recovery.text);
      dismissedRecoveryRef.current = true;
      setRecovery(null);
    },
  };
}
