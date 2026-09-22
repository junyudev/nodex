import {
  emptyDictationStreamDiagnostics,
  type DictationDiagnostics,
  type DictationHttpDiagnostics,
  type DictationStreamDiagnostics,
} from "../../../shared/dictation-diagnostics";
import { DictationDiagnosticsRecorder } from "./dictation-diagnostics-recorder";
import type {
  DictationError,
  DictationGesture,
  DictationStopAction,
  DictationStopReason,
  DictationSurface,
  MicrophoneAccessResult,
} from "../../../shared/dictation";
import {
  classifyDictationCaptureError,
  classifyDictationTranscriptionError,
} from "./dictation-errors";

export const MINIMUM_DICTATION_DURATION_MS = 250;
export const MAXIMUM_DICTATION_DURATION_MS = 595_000;
export const DICTATION_HISTORY_CHUNK_INTERVAL_MS = 5_000;

type Timer = ReturnType<typeof globalThis.setTimeout>;

export type DictationSessionSnapshot =
  | { readonly kind: "idle" }
  | {
      readonly kind: "requesting-permission" | "acquiring-stream";
      readonly sessionId: string;
    }
  | {
      readonly kind: "recording";
      readonly sessionId: string;
      readonly durationMs: number;
      readonly waveform: readonly number[];
    }
  | {
      readonly kind: "stopping" | "transcribing";
      readonly sessionId: string;
      readonly durationMs: number;
      readonly action: Exclude<DictationStopAction, "abort">;
    }
  | {
      readonly kind: "retryable-error";
      readonly sessionId: string;
      readonly error: DictationError;
      readonly canRetryRecording: boolean;
    };

export interface DictationRecorderHandle {
  readonly mimeType: string;
  readonly state: "inactive" | "paused" | "recording";
  start(timesliceMs: number): void;
  stop(): void;
  dispose(): void;
}

export interface DictationRecorderFactory {
  create(
    stream: MediaStream,
    callbacks: {
      readonly onChunk: (chunk: Blob) => void;
      readonly onError: (error: unknown) => void;
      readonly onStop: () => void;
    },
  ): DictationRecorderHandle;
}

export interface DictationWaveformSession {
  dispose(): void;
}

export interface DictationStreamingAttempt {
  diagnostics?(): DictationStreamDiagnostics;
  start(
    stream: MediaStream | Promise<MediaStream>,
    confirmed?: Promise<boolean>,
    onReady?: () => void,
  ): Promise<void>;
  split(): number | null;
  hasBoundaries(): boolean;
  recover(transcribe: (blob: Blob) => Promise<string>, signal: AbortSignal): Promise<string>;
  stopAndFlush(): Promise<void>;
  finish(): Promise<string | null>;
  abort(): void;
}

export interface DictationRecovery {
  readonly recordingId: string | null;
  readonly saveState: "saving" | "saved" | "unavailable";
  readonly phase: "recovering" | "recovered" | "failed";
  readonly text: string | null;
}

export interface DictationControllerPorts {
  readonly lease: {
    acquire(sessionId: string, surface: DictationSurface): Promise<boolean>;
    release(sessionId: string): Promise<void>;
  };
  readonly permissions: {
    request(): Promise<MicrophoneAccessResult>;
  };
  readonly devices: {
    acquire(): Promise<MediaStream>;
  };
  readonly recorder: DictationRecorderFactory;
  readonly waveform: {
    start(
      stream: MediaStream,
      onSamples: (samples: readonly number[]) => void,
    ): DictationWaveformSession;
  };
  readonly streaming: {
    prepare(
      sessionId: string,
      options?: {
        readonly onTranscript?: (
          text: string,
          segment?: { readonly id: number; readonly text: string },
        ) => void;
      },
    ): Promise<DictationStreamingAttempt>;
  };
  readonly transcript?: {
    start(split: (() => number | null) | undefined): void;
    update(text: string, segment?: { readonly id: number; readonly text: string }): void;
    cancel(): void;
    preserve?(): void;
  };
  readonly buffered: {
    transcribe(
      blob: Blob,
      signal: AbortSignal,
      sessionId: string,
      onDiagnostics: (value: DictationHttpDiagnostics) => void,
      language?: string,
    ): Promise<string>;
  };
  readonly cleanup: {
    readonly enabled: boolean;
    transcript(
      transcript: string,
      signal: AbortSignal,
      sessionId: string,
      onDiagnostics: (value: DictationHttpDiagnostics) => void,
    ): Promise<string>;
  };
  readonly history: {
    diagnostics(sessionId: string, diagnostics: DictationDiagnostics): Promise<void>;
    create(input: {
      readonly sessionId: string;
      readonly surface: DictationSurface;
      readonly mimeType: string;
      readonly createdAtMs: number;
    }): Promise<void>;
    append(sessionId: string, chunk: Blob): Promise<void>;
    finalize(input: {
      readonly sessionId: string;
      readonly status: "cancelled" | "completed";
      readonly durationMs: number;
      readonly transcript?: string;
    }): Promise<void>;
  };
  readonly completion: {
    apply(input: {
      readonly sessionId: string;
      readonly signal: AbortSignal;
      readonly action: Exclude<DictationStopAction, "abort">;
      readonly transcript: string;
      readonly append?: boolean;
    }): Promise<{ readonly clipboardRestoreMs: number } | void> | void;
  };
  readonly onRecordingStarted?: (sessionId: string) => void;
  /** Stop intent is accepted before asynchronous recorder/PCM teardown. */
  readonly onStopRequested?: (sessionId: string) => void;
  /** Capture has stopped and the PCM tail is flushed. */
  readonly onRecordingStopped?: (sessionId: string) => void;
  readonly onRecoveryChange?: (recovery: DictationRecovery) => void;
  readonly clock: {
    now(): number;
    wallNow?(): number;
    setTimeout(callback: () => void, delayMs: number): Timer;
    clearTimeout(timer: Timer): void;
  };
  readonly createId: () => string;
}

interface ActiveSession {
  readonly id: string;
  readonly surface: DictationSurface;
  readonly gesture: DictationGesture;
  readonly generation: number;
  readonly chunks: Blob[];
  language: string | undefined;
  streamingEnabled: boolean;
  stream: MediaStream | null;
  recorder: DictationRecorderHandle | null;
  waveform: DictationWaveformSession | null;
  streaming: DictationStreamingAttempt | null;
  streamingFinish: Promise<string | null> | null;
  streamingStartFailed: boolean;
  transcriptStarted: boolean;
  startedAtMs: number | null;
  stoppedAtMs: number | null;
  diagnostics: DictationDiagnosticsRecorder;
  finishRecordingPhase: (() => void) | null;
  finishStopPhase: (() => void) | null;
  stopAction: Exclude<DictationStopAction, "abort">;
  durationTimer: Timer | null;
  maximumTimer: Timer | null;
  transcriptAbort: AbortController | null;
  historyQueue: Promise<void>;
  historyAvailable: boolean;
  retainedAudio: Blob | null;
  retainedTranscript: string | null;
  completed: boolean;
  captureError: DictationError | null;
  leaseAcquired: boolean;
  recovery: DictationRecovery | null;
  confirmed: boolean;
  confirmationTimer: Timer | null;
  confirmStreaming: (confirmed: boolean) => void;
  recordingNotified: boolean;
  audioReady: boolean;
  detached: boolean;
}

const IDLE: DictationSessionSnapshot = { kind: "idle" };

const permissionError = (
  result: Exclude<MicrophoneAccessResult, { kind: "granted" }>,
): DictationError => {
  if (result.kind === "failed") return result.error;
  if (result.kind === "blocked") {
    return {
      kind:
        result.status === "restricted" ? "microphone-restricted" : "microphone-permission-denied",
      operation: "permission",
      retryable: false,
    };
  }
  return { kind: "capture-unsupported", operation: "permission", retryable: false };
};

const stopTracks = (stream: MediaStream | null): void => {
  if (!stream) return;
  for (const track of stream.getTracks()) track.stop();
};

/**
 * Owns every transient dictation resource. All async completions are generation-checked,
 * making start/stop/dispose safe under React StrictMode and late browser promises.
 */
export class DictationSessionController {
  readonly #ports: DictationControllerPorts;
  readonly #listeners = new Set<() => void>();
  #snapshot: DictationSessionSnapshot = IDLE;
  #active: ActiveSession | null = null;
  #generation = 0;
  #disposed = false;

  constructor(ports: DictationControllerPorts) {
    this.#ports = ports;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  readonly getSnapshot = (): DictationSessionSnapshot => this.#snapshot;

  async start(input: {
    readonly surface: DictationSurface;
    readonly gesture: DictationGesture;
    readonly language?: string;
    readonly getLanguage?: () => Promise<string | undefined>;
    readonly streamingEnabled?: boolean;
    readonly activationStartedAtMs?: number;
  }): Promise<void> {
    if (this.#disposed) return;
    if (this.#active && this.#snapshot.kind === "retryable-error") {
      this.#invalidateAndRelease(this.#active, "cancelled");
    }
    if (this.#active) return;
    const generation = ++this.#generation;
    const language = input.language && input.language !== "auto" ? input.language : undefined;
    let confirmStreaming: (value: boolean) => void = () => undefined;
    const confirmation = new Promise<boolean>((resolve) => {
      confirmStreaming = resolve;
    });
    const session: ActiveSession = {
      id: this.#ports.createId(),
      surface: input.surface,
      gesture: input.gesture,
      generation,
      chunks: [],
      language,
      streamingEnabled: input.streamingEnabled !== false && language === undefined,
      stream: null,
      recorder: null,
      waveform: null,
      streaming: null,
      streamingFinish: null,
      streamingStartFailed: false,
      transcriptStarted: false,
      startedAtMs: null,
      stoppedAtMs: null,
      diagnostics: new DictationDiagnosticsRecorder(this.#ports.clock.now, input.surface),
      finishRecordingPhase: null,
      finishStopPhase: null,
      stopAction: "insert",
      durationTimer: null,
      maximumTimer: null,
      transcriptAbort: null,
      historyQueue: Promise.resolve(),
      historyAvailable: true,
      retainedAudio: null,
      retainedTranscript: null,
      completed: false,
      captureError: null,
      leaseAcquired: false,
      recovery: null,
      confirmed: false,
      confirmationTimer: null,
      confirmStreaming,
      recordingNotified: false,
      audioReady: false,
      detached: false,
    };
    this.#active = session;
    this.#publish({ kind: "requesting-permission", sessionId: session.id });

    let leaseAcquired = false;
    try {
      leaseAcquired = await this.#ports.lease.acquire(session.id, session.surface);
    } catch {
      if (this.#isCurrent(session)) {
        this.#failWithoutAudio(session, {
          kind: "microphone-busy",
          operation: "capture",
          retryable: true,
        });
      }
      return;
    }
    if (!this.#isCurrent(session)) {
      if (leaseAcquired) void this.#ports.lease.release(session.id).catch(() => undefined);
      return;
    }
    if (!leaseAcquired) {
      this.#failWithoutAudio(session, {
        kind: "microphone-busy",
        operation: "capture",
        retryable: true,
      });
      return;
    }
    session.leaseAcquired = true;

    if (input.getLanguage) {
      try {
        const selectedLanguage = await input.getLanguage();
        if (!this.#isCurrent(session)) return;
        session.language = selectedLanguage === "auto" ? undefined : selectedLanguage;
        session.streamingEnabled =
          input.streamingEnabled !== false && session.language === undefined;
      } catch (error) {
        this.#failWithoutAudio(session, classifyDictationTranscriptionError(error));
        return;
      }
    }

    const streamingPromise = session.streamingEnabled
      ? this.#ports.streaming
          .prepare(session.id, {
            onTranscript: this.#ports.transcript
              ? (text, segment) => {
                  if (!this.#isCurrent(session) || !session.transcriptStarted) return;
                  this.#ports.transcript?.update(text, segment);
                }
              : undefined,
          })
          .then((attempt) => {
            if (!this.#isCurrent(session)) {
              attempt.abort();
              return null;
            }
            session.streaming = attempt;
            return attempt;
          })
          .catch(() => null)
      : Promise.resolve(null);
    let permission: MicrophoneAccessResult;
    try {
      permission = await session.diagnostics.measure("permission", () =>
        this.#ports.permissions.request(),
      );
    } catch (error) {
      if (!this.#isCurrent(session)) return;
      void streamingPromise.then((attempt) => attempt?.abort());
      this.#failWithoutAudio(session, {
        kind: "unknown",
        operation: "permission",
        retryable: true,
        nativeName:
          error && typeof error === "object" && "name" in error
            ? String((error as { readonly name: unknown }).name)
            : undefined,
      });
      return;
    }
    if (!this.#isCurrent(session)) return;
    if (!permission || typeof permission !== "object" || !("kind" in permission)) {
      void streamingPromise.then((attempt) => attempt?.abort());
      this.#failWithoutAudio(session, {
        kind: "unknown",
        operation: "permission",
        retryable: true,
        nativeName: "InvalidPermissionResult",
      });
      return;
    }
    if (permission.kind !== "granted") {
      void streamingPromise.then((attempt) => attempt?.abort());
      this.#failWithoutAudio(session, permissionError(permission));
      return;
    }

    this.#publish({ kind: "acquiring-stream", sessionId: session.id });
    let stream: MediaStream;
    try {
      stream = await session.diagnostics.measure("microphone", () => this.#ports.devices.acquire());
    } catch (error) {
      if (!this.#isCurrent(session)) return;
      void streamingPromise.then((attempt) => attempt?.abort());
      this.#failWithoutAudio(session, classifyDictationCaptureError(error));
      return;
    }
    if (!this.#isCurrent(session)) {
      stopTracks(stream);
      return;
    }
    session.stream = stream;
    session.streaming = await streamingPromise;
    if (!this.#isCurrent(session)) {
      session.streaming?.abort();
      stopTracks(stream);
      return;
    }

    try {
      const recorder = this.#ports.recorder.create(stream, {
        onChunk: (chunk) => this.#onChunk(session, chunk),
        onError: (error) => this.#onRecorderError(session, error),
        onStop: () => void this.#onRecorderStopped(session),
      });
      session.recorder = recorder;
      session.startedAtMs = this.#ports.clock.now();
      session.finishRecordingPhase = session.diagnostics.phase("recording");
      session.waveform = this.#ports.waveform.start(stream, (waveform) => {
        if (!this.#isCurrent(session) || this.#snapshot.kind !== "recording") return;
        this.#publish({ ...this.#snapshot, waveform: [...waveform] });
      });
      const ready = () => this.#audioReady(session);
      void session.streaming?.start(stream, confirmation, ready).then(ready, () => {
        session.streamingStartFailed = true;
        session.streaming?.abort();
        ready();
        // Keep the terminal attempt so its failure evidence survives buffered recovery.
      });
      recorder.start(DICTATION_HISTORY_CHUNK_INTERVAL_MS);
      if (!session.streaming || session.surface === "global") this.#audioReady(session);
      const confirmationDelay =
        input.activationStartedAtMs === undefined
          ? 0
          : Math.max(
              0,
              100 - ((this.#ports.clock.wallNow?.() ?? Date.now()) - input.activationStartedAtMs),
            );
      if (confirmationDelay > 0) {
        session.confirmationTimer = this.#ports.clock.setTimeout(
          () => this.#confirmRecording(session),
          confirmationDelay,
        );
      } else this.#confirmRecording(session);
      if (session.streamingEnabled && this.#ports.transcript) {
        session.transcriptStarted = true;
        this.#ports.transcript.start(
          session.streaming
            ? () => {
                if (!this.#isCurrent(session) || session.stoppedAtMs !== null || !session.recorder)
                  return null;
                return session.streaming?.split() ?? null;
              }
            : undefined,
        );
      }
      session.maximumTimer = this.#ports.clock.setTimeout(() => {
        this.stop("insert", "max-duration");
      }, MAXIMUM_DICTATION_DURATION_MS);
    } catch (error) {
      session.streaming?.abort();
      this.#releaseCapture(session);
      this.#failWithoutAudio(session, classifyDictationCaptureError(error));
    }
  }

  stop(action: DictationStopAction, reason: DictationStopReason = "user"): void {
    const session = this.#active;
    if (!session || this.#disposed) return;
    if (action === "abort") {
      this.cancel();
      return;
    }
    if (session.stopAction === "insert" && action === "send") session.stopAction = "send";

    if (
      this.#snapshot.kind === "requesting-permission" ||
      (this.#snapshot.kind === "acquiring-stream" && !session.recorder)
    ) {
      this.#invalidateAndRelease(session, "cancelled");
      return;
    }
    if (this.#snapshot.kind === "stopping" || this.#snapshot.kind === "transcribing") return;
    if (this.#snapshot.kind !== "recording" && !session.recorder) return;
    this.#markStopped(session);
    const durationMs = this.#duration(session);
    this.#publish({
      kind: "stopping",
      sessionId: session.id,
      durationMs,
      action: session.stopAction,
    });
    this.#clearCaptureTimers(session);
    void this.#finishStreaming(session);
    if (!session.recorder || session.recorder.state === "inactive") {
      void this.#onRecorderStopped(session);
      return;
    }
    try {
      session.recorder.stop();
    } catch {
      void this.#onRecorderStopped(session);
    }
    void reason;
  }

  async retry(): Promise<void> {
    const session = this.#active;
    if (
      !session ||
      this.#snapshot.kind !== "retryable-error" ||
      !session.retainedAudio ||
      this.#disposed
    ) {
      return;
    }
    const previous = this.#snapshot;
    this.#publish({
      kind: "transcribing",
      sessionId: session.id,
      durationMs: this.#duration(session),
      action: session.stopAction,
    });
    const acquired = await this.#ports.lease
      .acquire(session.id, session.surface)
      .catch(() => false);
    if (!this.#isCurrent(session)) {
      if (acquired) void this.#ports.lease.release(session.id).catch(() => undefined);
      return;
    }
    if (!acquired) {
      this.#publish(previous);
      return;
    }
    session.leaseAcquired = true;
    session.diagnostics = new DictationDiagnosticsRecorder(
      this.#ports.clock.now,
      session.surface,
      "retry",
      session.diagnostics.attempt + 1,
    );
    await this.#transcribe(session, session.retainedAudio);
  }

  cancel(): void {
    const session = this.#active;
    if (!session) return;
    this.#invalidateAndRelease(session, "cancelled");
  }

  /** A detached surface finishes captured speech; incomplete activation has nothing to deliver. */
  detach(): void {
    if (this.#active) this.#active.detached = true;
    if (this.#snapshot.kind === "recording" || this.#active?.recorder?.state === "recording") {
      this.stop("insert");
      return;
    }
    if (
      this.#snapshot.kind === "requesting-permission" ||
      this.#snapshot.kind === "acquiring-stream"
    )
      this.cancel();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const session = this.#active;
    if (session) this.#invalidateAndRelease(session, "cancelled");
    this.#listeners.clear();
  }

  #onChunk(session: ActiveSession, chunk: Blob): void {
    if (!this.#isCurrent(session) || chunk.size <= 0) return;
    session.chunks.push(chunk);
    if (!session.confirmed) return;
    session.historyQueue = session.historyQueue
      .then(() => this.#ports.history.append(session.id, chunk))
      .catch(() => {
        session.historyAvailable = false;
      });
  }

  #onRecorderError(session: ActiveSession, error: unknown): void {
    if (!this.#isCurrent(session)) return;
    session.captureError = {
      ...classifyDictationCaptureError(error),
      kind: "capture-interrupted",
      retryable: true,
    };
    if (session.recorder && session.recorder.state !== "inactive") {
      try {
        session.recorder.stop();
      } catch {
        // Native MediaRecorder still dispatches its terminal dataavailable/stop events.
      }
    }
  }

  async #onRecorderStopped(session: ActiveSession): Promise<void> {
    if (!this.#isCurrent(session) || session.completed) return;
    const interrupted = session.stoppedAtMs === null;
    session.completed = true;
    this.#markStopped(session);
    await session.streaming?.stopAndFlush().catch(() => undefined);
    if (!this.#isCurrent(session)) return;
    session.finishStopPhase?.();
    const durationMs = this.#duration(session);
    const recorder = session.recorder;
    const mimeType = recorder?.mimeType || session.chunks[0]?.type || "application/octet-stream";
    const chunks = session.chunks.splice(0);
    this.#releaseCapture(session);

    if (!session.confirmed || durationMs < MINIMUM_DICTATION_DURATION_MS || chunks.length === 0) {
      session.streaming?.abort();
      this.#cancelTranscript(session);
      this.#releaseMicrophoneLease(session);
      await session.historyQueue;
      await this.#ports.history
        .finalize({ sessionId: session.id, status: "cancelled", durationMs })
        .catch(() => undefined);
      void this.#saveDiagnostics(session, "cancelled");
      if (this.#isCurrent(session)) {
        this.#active = null;
        this.#publish(IDLE);
      }
      return;
    }

    const audio = new Blob(chunks, { type: mimeType });
    if (audio.size <= 0) {
      this.#cancelTranscript(session);
      this.#releaseMicrophoneLease(session);
      this.#active = null;
      this.#publish(IDLE);
      return;
    }
    session.retainedAudio = audio;
    if ((interrupted || session.captureError) && this.#ports.onRecoveryChange) {
      session.streaming?.abort();
      this.#recoveryChanged(session, "recovering");
    } else if (session.captureError) {
      session.streaming?.abort();
      this.#releaseMicrophoneLease(session);
      void this.#saveDiagnostics(session, "failed");
      this.#publish({
        kind: "retryable-error",
        sessionId: session.id,
        error: session.captureError,
        canRetryRecording: true,
      });
      return;
    }
    await this.#transcribe(session, audio);
  }

  async #transcribe(session: ActiveSession, audio: Blob): Promise<void> {
    if (!this.#isCurrent(session)) return;
    if (session.recovery) this.#recoveryChanged(session, "recovering");
    const durationMs = this.#duration(session);
    this.#publish({
      kind: "transcribing",
      sessionId: session.id,
      durationMs,
      action: session.stopAction,
    });
    session.transcriptAbort?.abort();
    const abortController = new AbortController();
    session.transcriptAbort = abortController;
    const attemptGeneration = session.generation;
    try {
      const streamingTranscript =
        !session.recovery &&
        session.retainedTranscript === null &&
        session.diagnostics.attempt === 1
          ? await this.#finishStreaming(session)
          : null;
      const recoveringFailedStream =
        session.streaming !== null &&
        !session.streamingStartFailed &&
        streamingTranscript === null &&
        session.diagnostics.attempt === 1;
      if (!this.#isCurrent(session) || abortController.signal.aborted) return;
      let transcript = session.retainedTranscript ?? streamingTranscript?.trim() ?? "";
      if (session.retainedTranscript !== null) session.diagnostics.useTransport("retained");
      else if (streamingTranscript !== null) session.diagnostics.useTransport("websocket");
      if (session.retainedTranscript === null && streamingTranscript === null) {
        const transcribe = (blob: Blob): Promise<string> =>
          this.#ports.buffered.transcribe(
            blob,
            abortController.signal,
            session.id,
            session.diagnostics.request,
            session.language,
          );
        transcript = (
          await session.diagnostics.measure("buffered", async () => {
            try {
              if (!session.recovery && session.streaming?.hasBoundaries()) {
                this.#recoveryChanged(session, "recovering");
                return await session.streaming.recover(transcribe, abortController.signal);
              }
              return await transcribe(audio);
            } catch (error) {
              if (
                abortController.signal.aborted ||
                session.recovery ||
                !this.#ports.onRecoveryChange
              )
                throw error;
              this.#recoveryChanged(session, "recovering");
              return await transcribe(audio);
            }
          })
        ).trim();
        if (transcript) session.diagnostics.useTransport("buffered");
      }
      if (transcript && !session.retainedTranscript && this.#ports.cleanup.enabled) {
        transcript = (
          await session.diagnostics
            .measure("cleanup", () =>
              this.#ports.cleanup.transcript(
                transcript,
                abortController.signal,
                session.id,
                session.diagnostics.request,
              ),
            )
            .catch(() => transcript)
        ).trim();
      }
      if (!this.#ports.cleanup.enabled || session.retainedTranscript)
        session.diagnostics.phase("cleanup")("skipped");
      if (
        !this.#isCurrent(session) ||
        session.generation !== attemptGeneration ||
        abortController.signal.aborted
      ) {
        return;
      }
      if (!session.retainedTranscript)
        await session.diagnostics
          .measure("history", async () => {
            await session.historyQueue;
            await this.#ports.history.finalize({
              sessionId: session.id,
              status: "completed",
              durationMs,
              transcript,
            });
          })
          .catch(() => {
            session.historyAvailable = false;
          });
      if (!this.#isCurrent(session) || abortController.signal.aborted) return;
      if (!transcript) {
        if (session.recovery || (recoveringFailedStream && this.#ports.onRecoveryChange)) {
          this.#recoveryChanged(session, "failed");
          this.#publish({
            kind: "retryable-error",
            sessionId: session.id,
            error: { kind: "transcription-service", operation: "transcribe", retryable: true },
            canRetryRecording: true,
          });
          void this.#saveDiagnostics(session, "failed");
          return;
        }
        this.#cancelTranscript(session);
        session.retainedAudio = null;
        void this.#saveDiagnostics(session, "completed");
        this.#active = null;
        this.#publish(IDLE);
        return;
      }
      session.retainedTranscript = transcript;
      if (session.recovery && this.#ports.onRecoveryChange) {
        this.#recoveryChanged(session, "recovered", transcript);
        if (
          session.surface === "composer" &&
          session.diagnostics.attempt > 1 &&
          !session.detached
        ) {
          await session.diagnostics.measure("delivery", async () => {
            await this.#ports.completion.apply({
              sessionId: session.id,
              signal: abortController.signal,
              action: "insert",
              transcript,
              append: true,
            });
          });
          session.diagnostics.delivered();
        }
        void this.#saveDiagnostics(session, "completed");
        if (!this.#isCurrent(session)) return;
        session.retainedAudio = null;
        this.#active = null;
        this.#publish(IDLE);
        return;
      }
      const action = session.stopAction;
      const delivery = await session.diagnostics.measure("delivery", async () => {
        const result = await this.#ports.completion.apply({
          sessionId: session.id,
          signal: abortController.signal,
          action,
          transcript,
        });
        if (
          this.#isCurrent(session) &&
          !abortController.signal.aborted &&
          action === "insert" &&
          session.stopAction === "send"
        ) {
          await this.#ports.completion.apply({
            sessionId: session.id,
            signal: abortController.signal,
            action: "send",
            transcript: "",
          });
        }
        return result;
      });
      session.diagnostics.delivered(delivery?.clipboardRestoreMs);
      void this.#saveDiagnostics(session, "completed");
      if (!this.#isCurrent(session)) return;
      session.retainedAudio = null;
      this.#active = null;
      this.#publish(IDLE);
    } catch (error) {
      if (!this.#isCurrent(session) || abortController.signal.aborted) return;
      if (error instanceof DOMException && error.name === "AbortError") {
        this.#invalidateAndRelease(session, "cancelled");
        return;
      }
      void this.#saveDiagnostics(session, "failed");
      this.#recoveryChanged(session, "failed");
      this.#publish({
        kind: "retryable-error",
        sessionId: session.id,
        error: session.retainedTranscript
          ? { kind: "paste-failed", operation: "paste", retryable: true }
          : classifyDictationTranscriptionError(error),
        canRetryRecording: true,
      });
    } finally {
      this.#releaseMicrophoneLease(session);
      if (session.transcriptAbort === abortController) session.transcriptAbort = null;
    }
  }

  #recoveryChanged(
    session: ActiveSession,
    phase: DictationRecovery["phase"],
    text: string | null = null,
  ): void {
    if (!this.#ports.onRecoveryChange || !this.#isCurrent(session)) return;
    if (!session.recovery) this.#ports.transcript?.preserve?.();
    const recovery: DictationRecovery = {
      recordingId: session.id,
      saveState:
        phase === "recovered"
          ? session.historyAvailable
            ? "saved"
            : "unavailable"
          : (session.recovery?.saveState ?? "saving"),
      phase,
      text,
    };
    session.recovery = recovery;
    this.#ports.onRecoveryChange(recovery);
    void session.historyQueue.then(() => {
      if (!this.#isCurrent(session) || session.recovery !== recovery) return;
      session.recovery = {
        ...recovery,
        saveState: session.historyAvailable ? "saved" : "unavailable",
      };
      this.#ports.onRecoveryChange?.(session.recovery);
    });
  }

  #markStopped(session: ActiveSession): void {
    if (session.stoppedAtMs !== null) return;
    session.stoppedAtMs = this.#ports.clock.now();
    this.#ports.onStopRequested?.(session.id);
    session.diagnostics.stopped();
    session.finishRecordingPhase?.();
    session.finishStopPhase = session.diagnostics.phase("recorder-stop");
  }

  async #saveDiagnostics(
    session: ActiveSession,
    outcome: DictationDiagnostics["outcome"],
  ): Promise<void> {
    const streaming =
      session.diagnostics.attempt === 1
        ? (session.streaming?.diagnostics?.() ?? {
            ...emptyDictationStreamDiagnostics(),
            ...(session.streamingEnabled ? { failureCode: "stream-unavailable" as const } : {}),
          })
        : undefined;
    const report = session.diagnostics.snapshot(outcome, streaming);
    await session.historyQueue;
    await this.#ports.history.diagnostics(session.id, report).catch(() => undefined);
  }

  #scheduleDuration(session: ActiveSession): void {
    session.durationTimer = this.#ports.clock.setTimeout(() => {
      if (!this.#isCurrent(session) || this.#snapshot.kind !== "recording") return;
      this.#publish({ ...this.#snapshot, durationMs: this.#duration(session) });
      this.#scheduleDuration(session);
    }, 1_000);
  }

  #duration(session: ActiveSession): number {
    return session.startedAtMs === null
      ? 0
      : Math.max(0, (session.stoppedAtMs ?? this.#ports.clock.now()) - session.startedAtMs);
  }

  #failWithoutAudio(session: ActiveSession, error: DictationError): void {
    if (!this.#isCurrent(session)) return;
    this.#cancelTranscript(session);
    this.#releaseMicrophoneLease(session);
    this.#publish({
      kind: "retryable-error",
      sessionId: session.id,
      error,
      canRetryRecording: false,
    });
  }

  #invalidateAndRelease(session: ActiveSession, historyStatus: "cancelled"): void {
    ++this.#generation;
    this.#markStopped(session);
    session.transcriptAbort?.abort();
    session.streaming?.abort();
    this.#cancelTranscript(session);
    this.#releaseCapture(session);
    this.#releaseMicrophoneLease(session);
    this.#active = null;
    this.#publish(IDLE);
    void session.historyQueue.then(async () => {
      await this.#ports.history
        .finalize({
          sessionId: session.id,
          status: historyStatus,
          durationMs: this.#duration(session),
        })
        .catch(() => undefined);
      await this.#saveDiagnostics(session, "cancelled");
    });
  }

  #releaseCapture(session: ActiveSession): void {
    this.#clearCaptureTimers(session);
    const recorder = session.recorder;
    session.recorder = null;
    recorder?.dispose();
    const waveform = session.waveform;
    session.waveform = null;
    waveform?.dispose();
    const stream = session.stream;
    session.stream = null;
    stopTracks(stream);
    if (session.recordingNotified) {
      session.recordingNotified = false;
      try {
        this.#ports.onRecordingStopped?.(session.id);
      } catch {
        // Optional sound feedback must not interrupt capture cleanup or delivery.
      }
    }
  }

  #confirmRecording(session: ActiveSession): void {
    if (
      !this.#isCurrent(session) ||
      session.stoppedAtMs !== null ||
      session.confirmed ||
      !session.recorder
    )
      return;
    session.confirmationTimer = null;
    session.confirmed = true;
    session.confirmStreaming(true);
    const pendingChunks = [...session.chunks];
    session.historyQueue = this.#ports.history
      .create({
        sessionId: session.id,
        surface: session.surface,
        mimeType: session.recorder.mimeType,
        createdAtMs: this.#ports.clock.wallNow?.() ?? Date.now(),
      })
      .then(async () => {
        for (const chunk of pendingChunks) await this.#ports.history.append(session.id, chunk);
      })
      .catch(() => {
        session.historyAvailable = false;
      });
    this.#notifyRecordingStarted(session);
  }

  #audioReady(session: ActiveSession): void {
    if (!this.#isCurrent(session) || session.stoppedAtMs !== null || session.audioReady) return;
    session.audioReady = true;
    this.#publish({
      kind: "recording",
      sessionId: session.id,
      durationMs: this.#duration(session),
      waveform: [],
    });
    this.#scheduleDuration(session);
    this.#notifyRecordingStarted(session);
  }

  #notifyRecordingStarted(session: ActiveSession): void {
    if (!session.confirmed || !session.audioReady || session.recordingNotified) return;
    session.recordingNotified = true;
    try {
      this.#ports.onRecordingStarted?.(session.id);
    } catch {
      // Recording remains usable when optional sound feedback is unavailable.
    }
  }

  #finishStreaming(session: ActiveSession): Promise<string | null> {
    session.streamingFinish ??= session.diagnostics
      .measure("stream-finalize", async () => (await session.streaming?.finish()) ?? null)
      .catch(() => null);
    return session.streamingFinish;
  }

  #cancelTranscript(session: ActiveSession): void {
    if (!session.transcriptStarted) return;
    session.transcriptStarted = false;
    this.#ports.transcript?.cancel();
  }

  #clearCaptureTimers(session: ActiveSession): void {
    if (session.confirmationTimer) this.#ports.clock.clearTimeout(session.confirmationTimer);
    session.confirmationTimer = null;
    if (!session.confirmed) session.confirmStreaming(false);
    if (session.durationTimer) this.#ports.clock.clearTimeout(session.durationTimer);
    if (session.maximumTimer) this.#ports.clock.clearTimeout(session.maximumTimer);
    session.durationTimer = null;
    session.maximumTimer = null;
  }

  #releaseMicrophoneLease(session: ActiveSession): void {
    if (!session.leaseAcquired) return;
    session.leaseAcquired = false;
    void this.#ports.lease.release(session.id).catch(() => undefined);
  }

  #isCurrent(session: ActiveSession): boolean {
    return !this.#disposed && this.#active === session && session.generation === this.#generation;
  }

  #publish(snapshot: DictationSessionSnapshot): void {
    if (Object.is(this.#snapshot, snapshot)) return;
    this.#snapshot = snapshot;
    for (const listener of this.#listeners) listener();
  }
}

export const createNoopDictationStreamingPort = (): DictationControllerPorts["streaming"] => ({
  prepare: async () => ({
    start: async () => undefined,
    stopAndFlush: async () => undefined,
    finish: async () => null,
    split: () => null,
    hasBoundaries: () => false,
    recover: async () => "",
    abort: () => undefined,
  }),
});

export const createNoopDictationHistoryPort = (): DictationControllerPorts["history"] => ({
  create: async () => undefined,
  append: async () => undefined,
  finalize: async () => undefined,
  diagnostics: async () => undefined,
});
