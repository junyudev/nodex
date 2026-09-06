import type { DictationStreamDiagnostics } from "../../../shared/dictation-diagnostics";
import {
  DICTATION_STREAM_START_TIMEOUT_MS,
  DICTATION_STREAM_FINISH_TIMEOUT_MS,
  buildDictationStreamingSessionStartMessage,
  parseDictationStreamingServerEvent,
  validateDictationStreamingConnectInfo,
  type DictationStreamingConnectInfo,
  type DictationStreamingServerEvent,
} from "../../../shared/dictation-streaming";

type FailureCode = NonNullable<DictationStreamDiagnostics["failureCode"]>;
export class DictationStreamingError extends Error {
  constructor(readonly code: FailureCode) {
    super(`Dictation streaming failed: ${code}`);
    this.name = "DictationStreamingError";
  }
}

/** The recording renderer owns the socket. Connection credentials never enter diagnostics. */
export class DictationWebSocketClient {
  #socket: WebSocket | null = null;
  #pendingAudio: Array<{ type: "audio.append"; audio: string; byteLength: number }> | null = [];
  #finishPromise: Promise<void> | null = null;
  #resolveFinish: (() => void) | null = null;
  #rejectFinish: ((error: Error) => void) | null = null;
  #rejectPreparation: ((error: Error) => void) | null = null;
  #sessionClosed = false;
  #terminalError: Error | null = null;

  constructor(
    private readonly readConnectInfo: () => Promise<DictationStreamingConnectInfo>,
    private readonly onEvent: (event: DictationStreamingServerEvent) => void,
    private readonly diagnostics: DictationStreamDiagnostics,
  ) {}

  async connect(sampleRateHz: number, receiveSegments = false): Promise<void> {
    this.#terminalError = null;
    this.#sessionClosed = false;
    this.diagnostics.attempted = true;
    const preparingAt = performance.now();
    const cancelled = new Promise<never>((_resolve, reject) => {
      this.#rejectPreparation = reject;
    });
    let info: DictationStreamingConnectInfo;
    try {
      info = await Promise.race([this.readConnectInfo(), cancelled]);
    } catch (error) {
      this.diagnostics.failureCode ??= "connect-info-failed";
      throw error;
    } finally {
      this.diagnostics.connectInfoMs = performance.now() - preparingAt;
      this.#rejectPreparation = null;
    }
    const validated = validateDictationStreamingConnectInfo(info);
    if (!validated.ok) throw this.failure("invalid-connect-info");
    const connectingAt = performance.now();
    const socket = new WebSocket(validated.value.websocketUrl, [...validated.value.protocols]);
    this.#socket = socket;
    return await new Promise<void>((resolve, reject) => {
      let started = false;
      let settled = false;
      let error: Error | null = null;
      let openedAt: number | null = null;
      const rejectStart = (cause: Error): void => {
        if (settled) return;
        settled = true;
        reject(cause);
      };
      const startTimer = setTimeout(() => {
        error = this.failure("start-timeout");
        socket.close();
        rejectStart(error);
      }, DICTATION_STREAM_START_TIMEOUT_MS);
      socket.addEventListener(
        "open",
        () => {
          openedAt = performance.now();
          this.diagnostics.opened = true;
          this.diagnostics.handshakeMs = openedAt - connectingAt;
          this.diagnostics.selectedProtocol =
            socket.protocol === "chatgpt-dictation" || socket.protocol === "codex-desktop"
              ? socket.protocol
              : socket.protocol
                ? "other"
                : "none";
          this.send(buildDictationStreamingSessionStartMessage(sampleRateHz, receiveSegments));
        },
        { once: true },
      );
      socket.addEventListener("message", (message) => {
        const event = parseDictationStreamingServerEvent(message.data);
        if (!event) {
          error = this.failure("invalid-server-event");
          rejectStart(error);
          socket.close();
          return;
        }
        this.onEvent(event);
        if (event.type === "session.started") {
          started = true;
          this.diagnostics.started = true;
          this.diagnostics.providerMode = event.session.config.provider_mode;
          this.diagnostics.sessionStartMs = performance.now() - (openedAt ?? connectingAt);
          if (settled) return;
          clearTimeout(startTimer);
          this.drainAudio();
          settled = true;
          resolve();
          return;
        }
        if (event.type === "session.updated" && event.session.status === "closed") {
          this.#sessionClosed = true;
          socket.close();
          this.#resolveFinish?.();
          return;
        }
        if (event.type !== "transcript.failed" && !(event.type === "session.error" && event.fatal))
          return;
        error = this.failure(
          event.type === "transcript.failed" ? "transcript-failed" : "fatal-session-error",
        );
        this.#rejectFinish?.(error);
        rejectStart(error);
        socket.close();
      });
      socket.addEventListener(
        "error",
        () => {
          error ??= this.failure("websocket-failed");
        },
        { once: true },
      );
      socket.addEventListener(
        "close",
        (event) => {
          clearTimeout(startTimer);
          this.#socket = null;
          this.diagnostics.closeCode = event.code;
          const closeError =
            error ??
            (started && event.code === 1000
              ? null
              : this.failure(started ? "abnormal-close" : "closed-before-start"));
          if (this.#finishPromise) {
            if (closeError && !this.#sessionClosed) this.#rejectFinish?.(closeError);
            else this.#resolveFinish?.();
          } else if (closeError && !this.#sessionClosed) this.#terminalError = closeError;
          if (!settled) rejectStart(closeError ?? this.failure("closed-before-start"));
          this.#finishPromise = null;
          this.#resolveFinish = null;
          this.#rejectFinish = null;
        },
        { once: true },
      );
    });
  }

  appendPCM16(pcm16: ArrayBuffer): void {
    const audio = btoa(String.fromCharCode(...new Uint8Array(pcm16)));
    const message = { type: "audio.append", audio, byteLength: pcm16.byteLength } as const;
    if (!this.#sessionClosed && this.#pendingAudio !== null) {
      this.#pendingAudio.push(message);
      return;
    }
    this.sendAudio(message);
  }

  finish(): Promise<void> {
    if (!this.#socket)
      return this.#terminalError ? Promise.reject(this.#terminalError) : Promise.resolve();
    if (this.#finishPromise) return this.#finishPromise;
    const finishingAt = performance.now();
    this.#finishPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const error = this.failure("finish-timeout");
        this.#socket?.close();
        this.#rejectFinish?.(error);
      }, DICTATION_STREAM_FINISH_TIMEOUT_MS);
      this.#resolveFinish = () => {
        this.#resolveFinish = null;
        this.#rejectFinish = null;
        clearTimeout(timeout);
        this.diagnostics.finishMs = performance.now() - finishingAt;
        resolve();
      };
      this.#rejectFinish = (error) => {
        this.#resolveFinish = null;
        this.#rejectFinish = null;
        clearTimeout(timeout);
        this.diagnostics.finishMs = performance.now() - finishingAt;
        reject(error);
      };
    });
    this.send({ type: "session.close" });
    return this.#finishPromise;
  }

  close(): void {
    this.#pendingAudio = null;
    this.#rejectPreparation?.(new DictationStreamingError("aborted"));
    this.#rejectPreparation = null;
    this.#socket?.close();
    this.#socket = null;
  }

  private failure(code: FailureCode): Error {
    this.diagnostics.failureCode ??= code;
    return new DictationStreamingError(code);
  }
  private drainAudio(): void {
    const pending = this.#pendingAudio ?? [];
    this.#pendingAudio = null;
    for (const message of pending) this.sendAudio(message);
  }
  private sendAudio(message: { type: "audio.append"; audio: string; byteLength: number }): void {
    if (this.#socket?.readyState !== WebSocket.OPEN) return;
    this.send({ type: message.type, audio: message.audio });
    this.diagnostics.sentAudioBytes += message.byteLength;
    this.diagnostics.sentAudioFrames += 1;
  }
  private send(message: unknown): void {
    if (this.#socket?.readyState === WebSocket.OPEN) this.#socket.send(JSON.stringify(message));
  }
}
