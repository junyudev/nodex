import {
  emptyDictationStreamDiagnostics,
  type DictationStreamDiagnostics,
} from "../../shared/dictation-diagnostics";
import {
  DICTATION_STREAM_FINISH_TIMEOUT_MS,
  DICTATION_STREAM_MAX_OUTSTANDING_AUDIO_BYTES,
  DICTATION_STREAM_START_TIMEOUT_MS,
  applyDictationStreamingServerEvent,
  buildDictationStreamingSessionStartMessage,
  createDictationStreamingTranscriptState,
  parseDictationStreamingServerEvent,
  readDictationStreamingFinalText,
  validateDictationStreamingConnectInfo,
  type DictationStreamingClientMessage,
  type DictationStreamingConnectInfo,
  type DictationStreamingFailure,
  type DictationStreamingFailureCode,
  type DictationStreamingHostMessage,
  type DictationStreamingPort,
  type DictationStreamingTranscriptState,
} from "../../shared/dictation-streaming";

export interface DictationStreamingClock {
  readonly now?: () => number;
  readonly scheduleTimeout: (callback: () => void, delayMs: number) => () => void;
}

export interface DictationStreamingSocketClose {
  readonly code: number;
  readonly reason: string;
  readonly wasClean: boolean;
}

export interface DictationStreamingSocketHandlers {
  readonly open: () => void;
  readonly message: (payload: unknown) => void;
  readonly error: (error?: unknown) => void;
  readonly close: (event: DictationStreamingSocketClose) => void;
}

/** A small adapter over browser-compatible WebSocket implementations; it is Electron-free. */
export interface DictationStreamingSocket {
  readonly protocol?: string;
  readonly bufferedAmount: number;
  readonly send: (payload: string) => void;
  readonly close: (code?: number, reason?: string) => void;
  readonly listen: (handlers: DictationStreamingSocketHandlers) => () => void;
}

export interface DictationStreamingLogger {
  readonly warn: (message: string, metadata?: Readonly<Record<string, unknown>>) => void;
}

export interface DictationStreamingSessionServiceDependencies {
  readonly readConnectInfo: (input: {
    readonly signal: AbortSignal;
  }) => Promise<DictationStreamingConnectInfo>;
  readonly createWebSocket: (
    websocketUrl: string,
    protocols: readonly string[],
  ) => DictationStreamingSocket;
  readonly clock?: DictationStreamingClock;
  readonly logger?: DictationStreamingLogger;
}

export interface PrepareDictationStreamingSessionInput {
  readonly ownerId: string;
  readonly sessionId: string;
  readonly sampleRateHz: number;
  readonly port: DictationStreamingPort;
}

export interface DictationStreamingSessionHandle {
  readonly abort: () => void;
}

interface PendingAudioFrame {
  readonly sequence: number;
  readonly pcm16: ArrayBuffer;
}

interface DictationStreamingAttemptDependencies extends Required<
  Pick<DictationStreamingSessionServiceDependencies, "readConnectInfo" | "createWebSocket">
> {
  readonly clock: DictationStreamingClock;
  readonly logger: DictationStreamingLogger;
  readonly onTerminal: () => void;
}

const NOOP_LOGGER: DictationStreamingLogger = { warn: () => {} };

export function createDictationStreamingClock(): DictationStreamingClock {
  return {
    scheduleTimeout: (callback, delayMs) => {
      const timeout = setTimeout(callback, delayMs);
      return () => clearTimeout(timeout);
    },
  };
}

/**
 * Owns all active stream attempts. The caller binds each attempt to one trusted renderer owner and
 * can tear down either a single token or every session belonging to a destroyed webContents.
 */
export class DictationStreamingSessionService {
  private readonly sessions = new Map<string, DictationStreamingAttempt>();
  private readonly clock: DictationStreamingClock;
  private readonly logger: DictationStreamingLogger;

  constructor(private readonly deps: DictationStreamingSessionServiceDependencies) {
    this.clock = deps.clock ?? createDictationStreamingClock();
    this.logger = deps.logger ?? NOOP_LOGGER;
  }

  prepare(input: PrepareDictationStreamingSessionInput): DictationStreamingSessionHandle {
    validatePrepareInput(input);
    if (this.sessions.has(input.sessionId)) {
      throw new Error(`Dictation streaming session '${input.sessionId}' already exists.`);
    }

    const attempt = new DictationStreamingAttempt(input, {
      readConnectInfo: this.deps.readConnectInfo,
      createWebSocket: this.deps.createWebSocket,
      clock: this.clock,
      logger: this.logger,
      onTerminal: () => {
        if (this.sessions.get(input.sessionId) !== attempt) return;
        this.sessions.delete(input.sessionId);
      },
    });
    this.sessions.set(input.sessionId, attempt);
    attempt.prepare();

    return {
      abort: () => attempt.abort(),
    };
  }

  teardownSession(ownerId: string, sessionId: string): boolean {
    const attempt = this.sessions.get(sessionId);
    if (attempt === undefined || attempt.ownerId !== ownerId) return false;
    attempt.abort();
    return true;
  }

  teardownOwner(ownerId: string): void {
    const ownedAttempts = [...this.sessions.values()].filter(
      (attempt) => attempt.ownerId === ownerId,
    );
    for (const attempt of ownedAttempts) attempt.abort();
  }

  dispose(): void {
    const attempts = [...this.sessions.values()];
    for (const attempt of attempts) attempt.abort();
  }
}

class DictationStreamingAttempt {
  readonly ownerId: string;

  private readonly sessionId: string;
  private readonly sampleRateHz: number;
  private readonly port: DictationStreamingPort;
  private readonly abortController = new AbortController();
  private readonly transcriptState: DictationStreamingTranscriptState =
    createDictationStreamingTranscriptState();
  private readonly pendingAudioFrames: PendingAudioFrame[] = [];
  private socket: DictationStreamingSocket | null = null;
  private cancelSocketListeners: (() => void) | null = null;
  private cancelPortListener: (() => void) | null = null;
  private cancelStartTimeout: (() => void) | null = null;
  private cancelFinishTimeout: (() => void) | null = null;
  private nextAudioSequence = 0;
  private outstandingAudioBytes = 0;
  private opened = false;
  private started = false;
  private finishRequested = false;
  private closeSent = false;
  private terminal = false;
  private readonly diagnostics: DictationStreamDiagnostics = emptyDictationStreamDiagnostics();
  private preparedAt = 0;
  private socketCreatedAt: number | null = null;
  private socketOpenedAt: number | null = null;
  private finishAt: number | null = null;

  private now(): number {
    return this.deps.clock.now?.() ?? performance.now();
  }

  private reportDiagnostics(): void {
    if (this.terminal && this.diagnostics.connectInfoMs === undefined) {
      this.diagnostics.connectInfoMs = Math.max(0, this.now() - this.preparedAt);
    }
    if (this.terminal && this.socketCreatedAt !== null && this.socketOpenedAt === null) {
      this.diagnostics.handshakeMs = Math.max(0, this.now() - this.socketCreatedAt);
    }
    if (this.terminal && this.socketOpenedAt !== null && !this.started) {
      this.diagnostics.sessionStartMs = Math.max(0, this.now() - this.socketOpenedAt);
    }
    if (this.finishAt !== null) this.diagnostics.finishMs = Math.max(0, this.now() - this.finishAt);
    this.post({ type: "diagnostics", diagnostics: { ...this.diagnostics } });
  }

  constructor(
    input: PrepareDictationStreamingSessionInput,
    private readonly deps: DictationStreamingAttemptDependencies,
  ) {
    this.ownerId = input.ownerId;
    this.sessionId = input.sessionId;
    this.sampleRateHz = input.sampleRateHz;
    this.port = input.port;
  }

  prepare(): void {
    this.preparedAt = this.now();
    this.cancelPortListener = this.port.onMessage((message) => this.handlePortMessage(message));
    this.cancelStartTimeout = this.deps.clock.scheduleTimeout(
      () =>
        this.fail("start-timeout", "Dictation stream timed out before session.start completed."),
      DICTATION_STREAM_START_TIMEOUT_MS,
    );
    void this.connect();
  }

  abort(): void {
    if (this.terminal) return;
    this.terminal = true;
    this.diagnostics.failureCode = "aborted";
    this.reportDiagnostics();
    this.post({ type: "closed", outcome: { kind: "aborted", shouldFallback: false } });
    this.release();
  }

  private async connect(): Promise<void> {
    let connectInfo: DictationStreamingConnectInfo;
    try {
      connectInfo = await this.deps.readConnectInfo({ signal: this.abortController.signal });
    } catch (error) {
      if (this.terminal) return;
      this.deps.logger.warn("Unable to read dictation streaming connection info", {
        sessionId: this.sessionId,
        errorName: readErrorName(error),
      });
      this.fail("connect-info-failed", "Unable to prepare the dictation stream.");
      return;
    }
    if (this.terminal) return;

    this.diagnostics.connectInfoMs = Math.max(0, this.now() - this.preparedAt);
    const validated = validateDictationStreamingConnectInfo(connectInfo);
    if (!validated.ok) {
      this.deps.logger.warn("Invalid dictation streaming connection info", {
        sessionId: this.sessionId,
        reason: validated.reason,
      });
      this.fail("invalid-connect-info", "The dictation streaming endpoint is invalid.");
      return;
    }

    let socket: DictationStreamingSocket;
    try {
      this.diagnostics.attempted = true;
      this.socketCreatedAt = this.now();
      socket = this.deps.createWebSocket(validated.value.websocketUrl, validated.value.protocols);
    } catch (error) {
      this.deps.logger.warn("Unable to create dictation streaming websocket", {
        sessionId: this.sessionId,
        errorName: readErrorName(error),
      });
      this.fail("websocket-failed", "Unable to open the dictation stream.");
      return;
    }
    if (this.terminal) {
      closeSocket(socket);
      return;
    }

    this.socket = socket;
    try {
      this.cancelSocketListeners = socket.listen({
        open: () => this.handleSocketOpen(),
        message: (payload) => this.handleSocketMessage(payload),
        error: (error) => this.handleSocketError(error),
        close: (event) => this.handleSocketClose(event),
      });
    } catch (error) {
      this.deps.logger.warn("Unable to listen to dictation streaming websocket", {
        sessionId: this.sessionId,
        errorName: readErrorName(error),
      });
      this.fail("websocket-failed", "Unable to open the dictation stream.");
      return;
    }
    this.reportDiagnostics();
    if (!this.post({ type: "prepared" })) this.closeWithoutNotification();
  }

  private handleSocketOpen(): void {
    if (this.terminal || this.opened) return;
    this.opened = true;
    this.diagnostics.opened = true;
    this.socketOpenedAt = this.now();
    this.diagnostics.handshakeMs = Math.max(
      0,
      this.socketOpenedAt - (this.socketCreatedAt ?? this.socketOpenedAt),
    );
    const protocol = this.socket?.protocol;
    this.diagnostics.selectedProtocol = !protocol
      ? "none"
      : protocol === "chatgpt-dictation" || protocol === "codex-desktop"
        ? protocol
        : "other";
    this.reportDiagnostics();
    this.sendJson(buildDictationStreamingSessionStartMessage(this.sampleRateHz));
  }

  private handleSocketMessage(payload: unknown): void {
    if (this.terminal) return;
    const event = parseDictationStreamingServerEvent(payload);
    if (event === null) {
      this.fail("invalid-server-event", "Dictation stream returned an invalid event payload.");
      return;
    }

    if (event.type === "session.started" || event.type === "session.updated") {
      this.diagnostics.providerMode = event.session.config.provider_mode;
    }
    if (
      event.type === "transcript.delta" ||
      event.type === "transcript.segment" ||
      event.type === "transcript.final"
    ) {
      this.diagnostics.transcriptEvents += 1;
      if (event.type === "transcript.final") this.diagnostics.finalReceived = true;
    }
    applyDictationStreamingServerEvent(this.transcriptState, event);
    switch (event.type) {
      case "session.started":
        this.handleSessionStarted();
        return;
      case "session.updated":
        if (event.session.status !== "closed") return;
        if (!this.started) {
          this.fail(
            "closed-before-start",
            "Dictation stream closed before session.start completed.",
          );
          return;
        }
        if (!this.finishRequested) {
          this.fail("unexpected-close", "Dictation stream closed before dictation finished.");
          return;
        }
        this.complete();
        return;
      case "transcript.failed":
        this.fail("transcript-failed", "The dictation stream could not transcribe the audio.");
        return;
      case "session.error":
        if (event.fatal) {
          this.fail("fatal-session-error", "The dictation streaming session failed.");
        }
        return;
      default:
        return;
    }
  }

  private handleSessionStarted(): void {
    if (this.started || this.terminal) return;
    this.started = true;
    this.diagnostics.started = true;
    this.diagnostics.sessionStartMs = Math.max(0, this.now() - (this.socketOpenedAt ?? this.now()));
    this.cancelStartDeadline();
    this.flushPendingAudioFrames();
    if (this.terminal) return;
    this.reportDiagnostics();
    if (!this.post({ type: "started" })) {
      this.closeWithoutNotification();
      return;
    }
    if (this.finishRequested) this.sendSessionClose();
  }

  private handleSocketError(error?: unknown): void {
    if (this.terminal) return;
    this.deps.logger.warn("Dictation streaming websocket failed", {
      sessionId: this.sessionId,
      errorName: readErrorName(error),
    });
    this.fail("websocket-failed", "Dictation stream websocket failed.");
  }

  private handleSocketClose(event: DictationStreamingSocketClose): void {
    if (this.terminal) return;
    this.diagnostics.closeCode = event.code;
    this.socket = null;
    this.cancelSocketListeners?.();
    this.cancelSocketListeners = null;

    if (!this.started) {
      this.fail("closed-before-start", "Dictation stream closed before session.start completed.");
      return;
    }
    if (event.code !== 1_000 || !event.wasClean) {
      this.deps.logger.warn("Dictation streaming websocket closed abnormally", {
        sessionId: this.sessionId,
        code: event.code,
      });
      this.fail("abnormal-close", "Dictation stream closed unexpectedly.");
      return;
    }
    if (this.finishRequested) {
      this.complete();
      return;
    }
    this.fail("unexpected-close", "Dictation stream closed before dictation finished.");
  }

  private handlePortMessage(message: DictationStreamingClientMessage): void {
    if (this.terminal) return;
    switch (message.type) {
      case "audio-frame":
        this.handleAudioFrame(message);
        return;
      case "finish":
        this.requestFinish();
        return;
      case "abort":
        this.abort();
        return;
      default:
        this.fail("invalid-audio-frame", "Dictation stream received an invalid client message.");
    }
  }

  private handleAudioFrame(
    message: Extract<DictationStreamingClientMessage, { type: "audio-frame" }>,
  ): void {
    if (
      !Number.isSafeInteger(message.sequence) ||
      message.sequence !== this.nextAudioSequence ||
      !(message.pcm16 instanceof ArrayBuffer) ||
      message.pcm16.byteLength === 0 ||
      message.pcm16.byteLength % 2 !== 0
    ) {
      this.fail("invalid-audio-frame", "Dictation stream received an invalid PCM16 audio frame.");
      return;
    }

    this.nextAudioSequence += 1;
    if (this.finishRequested) {
      this.acknowledgeAudioFrame(message.sequence, message.pcm16.byteLength);
      return;
    }

    const nextOutstandingBytes = this.outstandingAudioBytes + message.pcm16.byteLength;
    if (nextOutstandingBytes > DICTATION_STREAM_MAX_OUTSTANDING_AUDIO_BYTES) {
      this.fail("backpressure-overflow", "Dictation streaming audio exceeded its buffer limit.");
      return;
    }

    this.outstandingAudioBytes = nextOutstandingBytes;
    const frame: PendingAudioFrame = {
      sequence: message.sequence,
      pcm16: message.pcm16,
    };
    if (!this.started) {
      this.pendingAudioFrames.push(frame);
      return;
    }
    this.sendAudioFrame(frame);
  }

  private flushPendingAudioFrames(): void {
    const frames = this.pendingAudioFrames.splice(0);
    for (const frame of frames) {
      if (this.terminal) return;
      this.sendAudioFrame(frame);
    }
  }

  private sendAudioFrame(frame: PendingAudioFrame): void {
    const didSend = this.sendJson({
      type: "audio.append",
      audio: Buffer.from(frame.pcm16).toString("base64"),
    });
    if (!didSend || this.terminal) return;
    this.diagnostics.sentAudioBytes += frame.pcm16.byteLength;
    this.diagnostics.sentAudioFrames += 1;
    if (this.diagnostics.sentAudioFrames === 1) this.reportDiagnostics();
    this.outstandingAudioBytes -= frame.pcm16.byteLength;
    this.acknowledgeAudioFrame(frame.sequence, frame.pcm16.byteLength);
  }

  private acknowledgeAudioFrame(sequence: number, byteLength: number): void {
    if (
      !this.post({
        type: "audio-ack",
        sequence,
        byteLength,
        outstandingBytes: this.outstandingAudioBytes,
      })
    ) {
      this.closeWithoutNotification();
    }
  }

  private requestFinish(): void {
    if (this.finishRequested) return;
    this.finishRequested = true;
    this.finishAt = this.now();
    if (this.started) this.sendSessionClose();
  }

  private sendSessionClose(): void {
    if (this.closeSent || this.terminal) return;
    this.closeSent = true;
    if (!this.sendJson({ type: "session.close" })) return;
    this.cancelFinishTimeout = this.deps.clock.scheduleTimeout(
      () => this.fail("finish-timeout", "Dictation stream timed out while closing the session."),
      DICTATION_STREAM_FINISH_TIMEOUT_MS,
    );
  }

  private complete(): void {
    if (this.terminal) return;
    const text = readDictationStreamingFinalText(this.transcriptState);
    if (text.length === 0) {
      this.fail("empty-final", "Dictation stream returned an empty final transcript.");
      return;
    }

    this.terminal = true;
    this.reportDiagnostics();
    this.post({ type: "final", text });
    this.post({ type: "closed", outcome: { kind: "completed" } });
    this.release();
  }

  private fail(code: DictationStreamingFailureCode, message: string): void {
    if (this.terminal) return;
    this.terminal = true;
    this.diagnostics.failureCode = code;
    this.reportDiagnostics();
    const error: DictationStreamingFailure = { code, message, shouldFallback: true };
    this.post({ type: "failed", error });
    this.post({ type: "closed", outcome: { kind: "failed" } });
    this.release();
  }

  private sendJson(payload: unknown): boolean {
    if (this.terminal || this.socket === null || !this.opened) return false;
    try {
      const encoded = JSON.stringify(payload);
      if (
        this.socket.bufferedAmount + Buffer.byteLength(encoded, "utf8") >
        DICTATION_STREAM_MAX_OUTSTANDING_AUDIO_BYTES
      ) {
        this.fail(
          "backpressure-overflow",
          "Dictation streaming websocket exceeded its buffer limit.",
        );
        return false;
      }
      this.socket.send(encoded);
      return true;
    } catch (error) {
      this.deps.logger.warn("Unable to send dictation streaming websocket message", {
        sessionId: this.sessionId,
        errorName: readErrorName(error),
      });
      this.fail("send-failed", "Unable to send audio to the dictation stream.");
      return false;
    }
  }

  private post(message: DictationStreamingHostMessage): boolean {
    try {
      this.port.postMessage(message, []);
      return true;
    } catch (error) {
      this.deps.logger.warn("Unable to send dictation streaming port message", {
        sessionId: this.sessionId,
        errorName: readErrorName(error),
      });
      return false;
    }
  }

  private closeWithoutNotification(): void {
    if (this.terminal) return;
    this.terminal = true;
    this.release();
  }

  private release(): void {
    this.cancelStartDeadline();
    this.cancelFinishTimeout?.();
    this.cancelFinishTimeout = null;
    this.cancelPortListener?.();
    this.cancelPortListener = null;
    this.cancelSocketListeners?.();
    this.cancelSocketListeners = null;
    this.abortController.abort();

    const socket = this.socket;
    this.socket = null;
    if (socket !== null) closeSocket(socket);
    this.pendingAudioFrames.length = 0;
    this.outstandingAudioBytes = 0;

    try {
      this.port.close();
    } catch (error) {
      this.deps.logger.warn("Unable to close dictation streaming port", {
        sessionId: this.sessionId,
        errorName: readErrorName(error),
      });
    }
    this.deps.onTerminal();
  }

  private cancelStartDeadline(): void {
    this.cancelStartTimeout?.();
    this.cancelStartTimeout = null;
  }
}

function validatePrepareInput(input: PrepareDictationStreamingSessionInput): void {
  if (input.ownerId.trim().length === 0 || input.sessionId.trim().length === 0) {
    throw new TypeError("Dictation streaming owner and session IDs are required.");
  }
  if (
    !Number.isSafeInteger(input.sampleRateHz) ||
    input.sampleRateHz <= 0 ||
    input.sampleRateHz > 384_000
  ) {
    throw new RangeError("Dictation streaming sample rate is invalid.");
  }
}

function closeSocket(socket: DictationStreamingSocket): void {
  try {
    socket.close();
  } catch {
    // Teardown is already terminal; the adapter cannot provide another useful recovery action.
  }
}

function readErrorName(error: unknown): string {
  if (typeof error !== "object" || error === null || !("name" in error)) return "UnknownError";
  const name = error.name;
  return typeof name === "string" && name.length > 0 ? name : "UnknownError";
}
