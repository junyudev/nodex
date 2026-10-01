import type { DictationStreamDiagnostics } from "../../../shared/dictation-diagnostics";
import {
  DICTATION_STREAM_START_TIMEOUT_MS,
  DICTATION_STREAM_FINISH_TIMEOUT_MS,
  buildDictationStreamingSessionStartMessage,
  parseDictationStreamingServerEvent,
  type DictationStreamingServerEvent,
  type DictationStreamingSessionOptions,
} from "../../../shared/dictation-streaming";
import {
  categorizeDictationStreamProtocol,
  DICTATION_STREAM_OPEN,
  type PrepareDictationStreamConnection,
  type DictationStreamSocket,
} from "./dictation-stream-connection";

type FailureCode = NonNullable<DictationStreamDiagnostics["failureCode"]>;
export class DictationStreamingError extends Error {
  constructor(readonly code: FailureCode) {
    super(`Dictation streaming failed: ${code}`);
    this.name = "DictationStreamingError";
  }
}

interface DictationWebSocketOptions extends DictationStreamingSessionOptions {
  readonly finishTimeoutMs?: number;
}

/** The renderer owns session/audio ordering; Main owns authenticated network connections. */
export class DictationWebSocketClient {
  #socket: DictationStreamSocket | null = null;
  #pendingAudio: Array<{ type: "audio.append"; audio: string; byteLength: number }> | null = [];
  #finishPromise: Promise<void> | null = null;
  #resolveFinish: (() => void) | null = null;
  #rejectFinish: ((error: Error) => void) | null = null;
  #rejectPreparation: ((error: Error) => void) | null = null;
  #rejectStart: ((error: Error) => void) | null = null;
  #sessionClosed = false;
  #disposed = false;
  #terminalError: Error | null = null;

  constructor(
    private readonly prepareConnection: PrepareDictationStreamConnection,
    private readonly onEvent: (event: DictationStreamingServerEvent) => void,
    private readonly diagnostics: DictationStreamDiagnostics,
    private readonly onFailure?: (error: DictationStreamingError) => void,
    private readonly options: DictationWebSocketOptions = {},
  ) {}

  async connect(
    sampleRateHz: number,
    receiveSegments = false,
    sendAudio: Promise<boolean> = Promise.resolve(true),
  ): Promise<void> {
    if (this.#disposed) throw new DictationStreamingError("aborted");
    this.diagnostics.attempted = true;
    const preparingAt = performance.now();
    const cancelled = new Promise<never>((_resolve, reject) => {
      this.#rejectPreparation = reject;
    });
    const preparationTimer = setTimeout(() => {
      this.#rejectPreparation?.(this.failure("prepare-timeout"));
    }, DICTATION_STREAM_START_TIMEOUT_MS);
    let createSocket: () => DictationStreamSocket;
    try {
      createSocket = await Promise.race([this.prepareConnection(), cancelled]);
    } catch (error) {
      const cause =
        error instanceof DictationStreamingError ? error : this.failure("prepare-failed");
      this.#terminalError = cause;
      throw cause;
    } finally {
      clearTimeout(preparationTimer);
      this.diagnostics.connectInfoMs = performance.now() - preparingAt;
      this.#rejectPreparation = null;
    }
    if (this.#disposed) throw new DictationStreamingError("aborted");
    const connectingAt = performance.now();
    const socket = createSocket();
    this.#socket = socket;
    return await new Promise<void>((resolve, reject) => {
      let started = false;
      let settled = false;
      let error: Error | null = null;
      let openedAt: number | null = null;
      const rejectStart = (cause: Error): void => {
        if (settled) return;
        settled = true;
        this.#rejectStart = null;
        clearTimeout(startTimer);
        reject(cause);
      };
      this.#rejectStart = rejectStart;
      const fail = (cause: Error): void => {
        Object.assign(this.diagnostics, socket.diagnostics);
        error ??= cause;
        this.#terminalError ??= error;
        this.#pendingAudio = null;
        this.#rejectFinish?.(error);
        rejectStart(error);
        socket.close();
      };
      const startTimer = setTimeout(
        () => fail(this.failure(openedAt === null ? "handshake-timeout" : "session-start-timeout")),
        DICTATION_STREAM_START_TIMEOUT_MS,
      );
      socket.addEventListener(
        "open",
        () => {
          if (this.#disposed || this.#socket !== socket || error) return;
          Object.assign(this.diagnostics, socket.diagnostics);
          openedAt = performance.now();
          this.diagnostics.opened = true;
          this.diagnostics.handshakeMs = openedAt - connectingAt;
          this.diagnostics.selectedProtocol = categorizeDictationStreamProtocol(socket.protocol);
          this.send(
            buildDictationStreamingSessionStartMessage(sampleRateHz, receiveSegments, this.options),
          );
        },
        { once: true },
      );
      socket.addEventListener("message", (message) => {
        if (this.#disposed || this.#socket !== socket || error) return;
        const event = parseDictationStreamingServerEvent((message as MessageEvent).data);
        if (!event) {
          fail(this.failure("invalid-server-event"));
          return;
        }
        this.onEvent(event);
        if (this.#disposed || this.#socket !== socket) return;
        if (event.type === "session.started") {
          started = true;
          this.diagnostics.started = true;
          this.diagnostics.providerMode = event.session.config.provider_mode;
          this.diagnostics.sessionStartMs = performance.now() - (openedAt ?? connectingAt);
          void sendAudio.then(
            (allowed) => {
              if (settled || this.#disposed || this.#socket !== socket) return;
              clearTimeout(startTimer);
              if (allowed) this.drainAudio();
              settled = true;
              this.#rejectStart = null;
              resolve();
              if (!allowed) this.close();
            },
            () => {
              if (settled || this.#disposed || this.#socket !== socket) return;
              fail(new DictationStreamingError("aborted"));
            },
          );
          return;
        }
        if (event.type === "session.updated" && event.session.status === "closed") {
          if (this.onFailure && !this.#finishPromise) {
            fail(this.failure("unexpected-close"));
            return;
          }
          this.#sessionClosed = true;
          socket.close();
          this.#resolveFinish?.();
          return;
        }
        if (event.type !== "transcript.failed" && !(event.type === "session.error" && event.fatal))
          return;
        fail(
          this.failure(
            event.type === "transcript.failed" ? "transcript-failed" : "fatal-session-error",
          ),
        );
      });
      socket.addEventListener(
        "error",
        () => {
          if (this.#disposed || this.#sessionClosed || this.#socket !== socket || error) return;
          const transport = socket.diagnostics;
          if (transport) Object.assign(this.diagnostics, transport);
          fail(this.failure(transport?.failureCode ?? "websocket-failed"));
        },
        { once: true },
      );
      socket.addEventListener(
        "close",
        (event) => {
          clearTimeout(startTimer);
          if (this.#socket !== socket) return;
          this.#socket = null;
          this.#pendingAudio = null;
          this.diagnostics.closeCode = (event as CloseEvent).code;
          if (this.#disposed) return;
          // A transport close is not a transcription receipt, including close code 1000.
          const closeFailure = !started
            ? "closed-before-start"
            : (event as CloseEvent).code === 1000
              ? "unexpected-close"
              : "abnormal-close";
          const closeError = this.#sessionClosed ? null : (error ?? this.failure(closeFailure));
          if (this.#finishPromise) {
            if (closeError) this.#rejectFinish?.(closeError);
            else this.#resolveFinish?.();
          } else if (closeError) this.#terminalError = closeError;
          if (!settled) rejectStart(closeError ?? this.failure("closed-before-start"));
        },
        { once: true },
      );
    });
  }

  appendPCM16(pcm16: ArrayBuffer): void {
    if (this.#disposed || this.#terminalError || this.#sessionClosed) return;
    const audio = btoa(String.fromCharCode(...new Uint8Array(pcm16)));
    const message = { type: "audio.append", audio, byteLength: pcm16.byteLength } as const;
    if (this.#pendingAudio !== null) {
      this.#pendingAudio.push(message);
      return;
    }
    this.sendAudio(message);
  }

  finish(): Promise<void> {
    if (this.#finishPromise) return this.#finishPromise;
    if (this.#terminalError) return Promise.reject(this.#terminalError);
    if (this.#disposed) return Promise.reject(new DictationStreamingError("aborted"));
    if (!this.#socket || this.#sessionClosed) return Promise.resolve();
    const finishingAt = performance.now();
    this.#finishPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const error = this.failure("finish-timeout");
        this.#terminalError ??= error;
        this.#rejectFinish?.(error);
        this.#socket?.close();
      }, this.options.finishTimeoutMs ?? DICTATION_STREAM_FINISH_TIMEOUT_MS);
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
    if (this.#disposed) return;
    this.#disposed = true;
    this.#pendingAudio = null;
    const cancelled = new DictationStreamingError("aborted");
    this.#rejectPreparation?.(cancelled);
    this.#rejectPreparation = null;
    this.#rejectStart?.(cancelled);
    this.#rejectStart = null;
    this.#rejectFinish?.(cancelled);
    this.#socket?.close();
    this.#socket = null;
  }

  private failure(code: FailureCode): DictationStreamingError {
    this.diagnostics.failureCode ??= code;
    const error = new DictationStreamingError(code);
    if (!this.#disposed) this.onFailure?.(error);
    return error;
  }
  private drainAudio(): void {
    const pending = this.#pendingAudio ?? [];
    this.#pendingAudio = null;
    for (const message of pending) this.sendAudio(message);
  }
  private sendAudio(message: { type: "audio.append"; audio: string; byteLength: number }): void {
    if (this.#socket?.readyState !== DICTATION_STREAM_OPEN || this.#disposed) return;
    this.send({ type: message.type, audio: message.audio });
    this.diagnostics.sentAudioBytes += message.byteLength;
    this.diagnostics.sentAudioFrames += 1;
  }
  private send(message: unknown): void {
    if (this.#socket?.readyState === DICTATION_STREAM_OPEN && !this.#disposed)
      this.#socket.send(JSON.stringify(message));
  }
}
