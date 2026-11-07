import { recordFeatureUsed } from "@/lib/product-analytics";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { resolveCodexRendererCommandPlatform } from "@/lib/codex-window-runtime";
import {
  createCommandKeymapState,
  matchesKeyboardEventToCommand,
  type CommandKeymapState,
} from "../../../../../shared/command-keybindings";
import {
  DEFAULT_DICTATION_SETTINGS,
  type DictationCapabilitySnapshot,
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
  requestMicrophoneAccess,
  releaseDictationMicrophoneLease,
} from "@/lib/api";
import { acquireMicrophone } from "@/features/dictation/microphone-acquirer";
import {
  createDictationMicrophoneLeaseClient,
  subscribeDictationMicrophoneRelinquish,
} from "@/features/dictation/dictation-microphone-lease-client";
import { browserDictationRecorderFactory } from "@/features/dictation/dictation-recorder";
import { mainDictationHistoryPort } from "@/features/dictation/dictation-history-client";
import { createBrowserDictationStreamingPort } from "@/features/dictation/dictation-streaming-client";
import {
  DictationSessionController,
  MAXIMUM_DICTATION_DURATION_MS,
  type DictationControllerPorts,
  type DictationRecovery,
  type DictationSessionSnapshot,
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
  readonly streamingAvailability?: DictationCapabilitySnapshot["streaming"];
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
  commandKeymapState: CommandKeymapState = createCommandKeymapState(
    {},
    resolveCodexRendererCommandPlatform(),
  ),
): boolean {
  if (event.defaultPrevented) return false;
  return matchesKeyboardEventToCommand(event, commandKeymapState, "composerDictationHold");
}

export function isComposerDictationShortcutTargetBlocked(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest("[data-codex-terminal]"));
}

const defaultClock: DictationControllerPorts["clock"] = {
  now: () => performance.now(),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (timer) => globalThis.clearTimeout(timer),
};

const invokeGlobalDictationEvent = async (event: GlobalDictationRendererEvent): Promise<boolean> =>
  await reportGlobalDictationEvent(event);

/** Owns capture callbacks and completion identity for one mounted composer. */
function createComposerDictationOwner(
  initialInput: UseComposerDictationInput,
  publishRecovery: (recovery: DictationRecovery | null) => void,
) {
  let callbacks = initialInput;
  let transcriptCallbacks = initialInput.transcript;
  let completionCallbacks: UseComposerDictationInput | null = null;
  let dismissedRecovery = false;
  let playRecordingSounds = false;
  let recordingSettings = DEFAULT_DICTATION_SETTINGS;
  let reportedError: string | null = null;
  let globalSessionId: string | null = null;
  let globalCompletionReported = false;
  let releaseGlobalRoute: (() => void) | null = null;
  let lastGlobalState: string | null = null;
  const appliedCompletionIds = new Set<string>();
  const controller = new DictationSessionController({
    recordingDurationLimitMs: MAXIMUM_DICTATION_DURATION_MS,
    lease: createDictationMicrophoneLeaseClient({
      acquire: acquireDictationMicrophoneLease,
      release: async (sessionId) => void (await releaseDictationMicrophoneLease(sessionId)),
      subscribeRelinquish: subscribeDictationMicrophoneRelinquish,
    }),
    permissions: {
      request: async () => {
        const soundsEnabled = callbacks.soundsEnabled === true;
        const settings = await readDictationSettings().catch(() => DEFAULT_DICTATION_SETTINGS);
        recordingSettings = settings;
        playRecordingSounds = soundsEnabled && settings.dictationSoundsEnabled;
        return requestMicrophoneAccess();
      },
    },
    devices: {
      acquire: async () => {
        const settings = recordingSettings;
        const builtInMicrophoneLabelHint = await readBuiltInMicrophoneRouteHint().catch(() => null);
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
        (callbacks.streamingAvailability === "available"
          ? browserInlineDictationWaveformPort
          : browserDictationWaveformPort
        ).start(stream, onSamples),
    },
    streaming: createBrowserDictationStreamingPort("composer"),
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
        transcriptCallbacks = callbacks.transcript;
        transcriptCallbacks.start(split);
      },
      update: (text, segment) => transcriptCallbacks.update(text, segment),
      cancel: () => transcriptCallbacks.cancel(),
      preserve: () => transcriptCallbacks.preserve?.(),
    },
    onRecordingStarted: () => {
      if (playRecordingSounds) playDictationSound("start");
    },
    onRecordingStopped: () => {
      if (playRecordingSounds) playDictationSound("stop");
    },
    onRecoveryChange: (recovery) => {
      transcriptCallbacks.preserve?.();
      if (!dismissedRecovery) publishRecovery(recovery);
    },
    completion: {
      apply: async ({ sessionId, action, transcript, append }) => {
        const completionId = `${sessionId}:${append ? "append" : action}`;
        if (appliedCompletionIds.has(completionId)) return;
        const completion = completionCallbacks ?? callbacks;
        if (append) {
          await completion.onTranscriptAppend(transcript);
          appliedCompletionIds.add(completionId);
          dismissedRecovery = true;
          publishRecovery(null);
          return;
        }
        const completionSessionId = globalSessionId;
        if (completionSessionId) {
          await completion.onTranscriptInsert(transcript);
          appliedCompletionIds.add(completionId);
          globalCompletionReported = true;
          await invokeGlobalDictationEvent({
            type: "completed",
            sessionId: completionSessionId,
            transcript,
          }).catch(() => false);
          globalSessionId = null;
          releaseGlobalRoute?.();
          releaseGlobalRoute = null;
          return;
        }
        if (action === "send") {
          await completion.onTranscriptSend(transcript);
          appliedCompletionIds.add(completionId);
          return;
        }
        await completion.onTranscriptInsert(transcript);
        appliedCompletionIds.add(completionId);
      },
    },
    clock: defaultClock,
    createId: () => crypto.randomUUID(),
  });
  const globalTarget: Omit<Parameters<typeof useInAppDictationTarget>[0], "id" | "priority"> = {
    admission: () => {
      if (!callbacks.enabled) return "unavailable";
      if (controller.getSnapshot().kind !== "idle") return "busy";
      return callbacks.globalTarget.admission();
    },
    start: async ({ sessionId, gesture, release }) => {
      globalSessionId = sessionId;
      releaseGlobalRoute = release;
      globalCompletionReported = false;
      lastGlobalState = null;
      completionCallbacks = null;
      dismissedRecovery = false;
      publishRecovery(null);
      await controller.start({
        surface: "global",
        gesture,
        streamingAvailability: callbacks.streamingAvailability,
      });
    },
    stop: () => {
      completionCallbacks = callbacks;
      controller.stop("insert");
    },
    cancel: () => controller.cancel(),
  };
  const reportError = (snapshot: DictationSessionSnapshot) => {
    if (snapshot.kind !== "retryable-error") {
      reportedError = null;
      return;
    }
    const identity = `${snapshot.sessionId}:${snapshot.error.kind}:${snapshot.canRetryRecording}`;
    if (reportedError === identity) return;
    reportedError = identity;
    if (playRecordingSounds) playDictationSound("error");
    if (!snapshot.canRetryRecording) {
      callbacks.onStartError(snapshot.error);
      return;
    }
    callbacks.onTranscribeError(snapshot.error);
  };
  const reportGlobalState = (snapshot: DictationSessionSnapshot) => {
    const sessionId = globalSessionId;
    if (!sessionId) return;
    const nextState =
      snapshot.kind === "recording"
        ? "listening"
        : snapshot.kind === "transcribing"
          ? "transcribing"
          : null;
    if (nextState && lastGlobalState !== nextState) {
      lastGlobalState = nextState;
      void invokeGlobalDictationEvent({ type: "state", sessionId, state: nextState });
      return;
    }
    if (snapshot.kind === "retryable-error") {
      const identity = `failed:${snapshot.error.kind}`;
      if (lastGlobalState === identity) return;
      lastGlobalState = identity;
      void invokeGlobalDictationEvent({ type: "failed", sessionId, error: snapshot.error });
      return;
    }
    if (snapshot.kind === "idle" && !globalCompletionReported) {
      globalSessionId = null;
      releaseGlobalRoute?.();
      releaseGlobalRoute = null;
      void invokeGlobalDictationEvent({ type: "cancelled", sessionId });
    }
  };
  const startDictation = async (gesture: DictationGesture = "click"): Promise<void> => {
    if (
      !callbacks.enabled ||
      typeof navigator.mediaDevices?.getUserMedia !== "function" ||
      typeof MediaRecorder === "undefined"
    ) {
      callbacks.onUnsupported();
      return;
    }
    recordFeatureUsed("dictation");
    globalSessionId = null;
    completionCallbacks = null;
    dismissedRecovery = false;
    publishRecovery(null);
    await controller.start({
      surface: "composer",
      gesture,
      streamingAvailability: callbacks.streamingAvailability,
      getLanguage: callbacks.getLanguage,
    });
  };
  return {
    controller,
    globalTarget,
    update: (input: UseComposerDictationInput) => {
      callbacks = input;
    },
    streamingAvailability: () => callbacks.streamingAvailability,
    observe: (snapshot: DictationSessionSnapshot) => {
      reportError(snapshot);
      reportGlobalState(snapshot);
    },
    startDictation,
    stopDictation: (mode: DictationStopMode) => {
      completionCallbacks ??= callbacks;
      controller.stop(mode);
    },
    retryDictation: () => {
      dismissedRecovery = false;
      return controller.retry();
    },
    dismissRecovery: () => {
      dismissedRecovery = true;
      publishRecovery(null);
    },
    appendRecoveredText: async (recovery: DictationRecovery | null) => {
      if (recovery?.phase !== "recovered" || !recovery.text) return;
      await callbacks.onTranscriptAppend(recovery.text);
      dismissedRecovery = true;
      publishRecovery(null);
    },
  };
}

export function useComposerDictation(
  input: UseComposerDictationInput,
): ComposerDictationController {
  const [recovery, setRecovery] = useState<DictationRecovery | null>(null);
  const [owner] = useState(() => createComposerDictationOwner(input, setRecovery));
  useLayoutEffect(() => {
    owner.update(input);
  }, [owner, input]);
  const { controller } = owner;
  const snapshot = useDictationSession(controller);
  const waveformCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const waveformLevelsRef = useRef<readonly number[]>([]);
  const waveformAdvancedAtRef = useRef(0);

  useEffect(() => {
    if (input.enabled) return;
    controller.cancel();
  }, [controller, input.enabled]);
  useInAppDictationTarget({
    ...owner.globalTarget,
    id: input.globalTarget.id,
    priority: input.globalTarget.priority,
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
        if (owner.streamingAvailability() === "available") {
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
  }, [owner, snapshot.kind]);

  useEffect(() => {
    owner.observe(snapshot);
  }, [owner, snapshot]);

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
    startDictation: owner.startDictation,
    stopDictation: owner.stopDictation,
    retryDictation: owner.retryDictation,
    cancelDictation: () => controller.cancel(),
    retryableError: snapshot.kind === "retryable-error" ? snapshot.error : null,
    recovery,
    dismissRecovery: owner.dismissRecovery,
    appendRecoveredText: () => owner.appendRecoveredText(recovery),
  };
}
