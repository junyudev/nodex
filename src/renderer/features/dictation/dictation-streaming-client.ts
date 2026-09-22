/* oxlint-disable unicorn/prefer-add-event-listener -- Each audio processor owns exactly one message handler, cleared when capture ends. */
import {
  emptyDictationStreamDiagnostics,
  type DictationStreamDiagnostics,
} from "../../../shared/dictation-diagnostics";
import {
  applyDictationStreamingServerEvent,
  createDictationStreamingTranscriptState,
  readDictationStreamingFinalText,
  type DictationStreamingConnectInfo,
  type DictationStreamingTranscriptState,
} from "../../../shared/dictation-streaming";
import type {
  DictationControllerPorts,
  DictationStreamingAttempt,
} from "./dictation-session-controller";
import { encodeDictationPcm16 } from "./dictation-pcm";
import { DictationStreamingError, DictationWebSocketClient } from "./dictation-websocket-client";
import dictationPcmWorkletUrl from "./dictation-pcm-worklet.ts?worker&url";

const FIRST_AUDIO_TIMEOUT_MS = 2000;
const AUDIO_FLUSH_TIMEOUT_MS = 1000;
const createDeferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
};

interface PreparedAudio {
  readonly context: AudioContext;
  readonly processor: AudioWorkletNode;
}
let preparedAudio: PreparedAudio | null = null;
let preparingAudio: Promise<void> | null = null;

function createSilentAudioContext(): AudioContext {
  try {
    const options: AudioContextOptions & { sinkId: { type: "none" } } = {
      sinkId: { type: "none" },
    };
    return new AudioContext(options);
  } catch {
    return new AudioContext();
  }
}

/** Warm one disconnected, silent processor for the next recording. */
export function prepareDictationAudio(): Promise<void> {
  if (preparedAudio) return Promise.resolve();
  preparingAudio ??= (async () => {
    const context = createSilentAudioContext();
    try {
      await context.audioWorklet.addModule(dictationPcmWorkletUrl);
      const processor = new AudioWorkletNode(context, "nodex-dictation-pcm", {
        channelCount: 1,
        channelCountMode: "explicit",
        outputChannelCount: [1],
      });
      processor.connect(context.destination);
      preparedAudio = { context, processor };
    } catch (error) {
      void context.close().catch(() => undefined);
      throw error;
    }
  })().finally(() => {
    preparingAudio = null;
  });
  return preparingAudio;
}

interface StreamingOptions {
  readonly onTranscript?: (text: string, segment?: { id: number; text: string }) => void;
}

interface StreamingSegment {
  readonly client: DictationWebSocketClient;
  readonly transcript: DictationStreamingTranscriptState;
  readonly diagnostics: DictationStreamDiagnostics;
  connection: Promise<void> | null;
  finished: Promise<void> | null;
  audio: ArrayBuffer[];
  recovered: string | null;
  completed: boolean;
}

/** Each segment keeps its PCM until it has a complete server receipt or a recovered transcript. */
class BrowserDictationStreamingAttempt implements DictationStreamingAttempt {
  #closed = false;
  #captureStopped = false;
  #aborted = false;
  #segments: StreamingSegment[] = [];
  #captureSegment = 0;
  #sampleRate = 0;
  #admission = createDeferred<boolean>();
  #audioContext: AudioContext | null = null;
  #processor: AudioWorkletNode | null = null;
  #source: MediaStreamAudioSourceNode | null = null;
  #preparation: Promise<void> | null = null;
  #connection: Promise<void> | null = null;
  #audioStart: ReturnType<typeof createDeferred<void>> | null = null;
  #audioStop: Promise<void> | null = null;
  #completeAudioStop: ((error?: Error) => void) | null = null;
  #finish: Promise<string | null> | null = null;
  #gain = 1;
  #hasSignal: boolean | null = null;
  #diagnostics = emptyDictationStreamDiagnostics();
  constructor(
    private readonly readConnectInfo: () => Promise<DictationStreamingConnectInfo>,
    private readonly options: StreamingOptions = {},
  ) {
    void this.#admission.promise.catch(() => undefined);
    this.createSegment();
  }

  private createSegment(): StreamingSegment {
    const id = this.#segments.length;
    const transcript = createDictationStreamingTranscriptState();
    const diagnostics = emptyDictationStreamDiagnostics();
    const client = new DictationWebSocketClient(
      this.readConnectInfo,
      (event) => {
        if (this.#closed) return;
        applyDictationStreamingServerEvent(transcript, event);
        if (event.type === "transcript.final") this.#diagnostics.finalReceived = true;
        if (
          event.type === "transcript.final" ||
          event.type === "transcript.segment" ||
          event.type === "transcript.delta"
        )
          this.#diagnostics.transcriptEvents += 1;
        if (event.type === "transcript.final" || event.type === "transcript.segment") {
          this.options.onTranscript?.(this.transcriptText(true), {
            id,
            text: readDictationStreamingFinalText(transcript, true),
          });
        }
      },
      diagnostics,
      (error) => this.recordFailure(error),
    );
    const segment: StreamingSegment = {
      client,
      transcript,
      diagnostics,
      connection: null,
      finished: null,
      audio: [],
      recovered: null,
      completed: false,
    };
    this.#segments.push(segment);
    return segment;
  }

  private transcriptText(includeSegments: boolean): string {
    return this.#segments
      .map(
        (segment) =>
          segment.recovered ?? readDictationStreamingFinalText(segment.transcript, includeSegments),
      )
      .filter((text) => text.length > 0)
      .join(" ");
  }

  split(): number | null {
    if (this.#closed || this.#captureStopped || !this.#processor || !this.#audioContext)
      return null;
    const id = this.#segments.length;
    const segment = this.createSegment();
    segment.connection = segment.client.connect(
      this.#sampleRate,
      this.options.onTranscript != null,
    );
    void segment.connection.catch((error: unknown) => this.recordFailure(error));
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- This is an AudioWorklet MessagePort.
    this.#processor.port.postMessage({ boundary: id });
    return id;
  }

  hasBoundaries(): boolean {
    return this.#segments.length > 1;
  }

  isSilent(): boolean {
    return this.#hasSignal === false && this.transcriptText(true).length === 0;
  }

  async recover(transcribe: (blob: Blob) => Promise<string>, signal: AbortSignal): Promise<string> {
    await Promise.allSettled(this.#segments.map((_segment, id) => this.finishSegment(id)));
    for (const [id, segment] of this.#segments.entries()) {
      signal.throwIfAborted();
      if (this.#aborted) throw new DictationStreamingError("aborted");
      if (segment.completed) continue;
      segment.client.close();
      const audioBytes = segment.audio.reduce((total, frame) => total + frame.byteLength, 0);
      const text =
        audioBytes === 0
          ? ""
          : await transcribe(createPcmWav(segment.audio, this.#sampleRate, audioBytes));
      signal.throwIfAborted();
      if (this.#aborted) throw new DictationStreamingError("aborted");
      segment.recovered = text;
      segment.completed = true;
      segment.audio = [];
      this.options.onTranscript?.(this.transcriptText(true), { id, text });
    }
    return this.transcriptText(false);
  }

  private finishSegment(id: number): Promise<void> {
    const segment = this.#segments[id]!;
    segment.finished ??= (async () => {
      await segment.connection;
      await segment.client.finish();
      if ([...segment.transcript.values()].some((utterance) => utterance.final === null)) {
        throw new DictationStreamingError("incomplete-transcript");
      }
      segment.completed = true;
      segment.audio = [];
      if (this.#closed) return;
      this.options.onTranscript?.(this.transcriptText(true), {
        id,
        text: readDictationStreamingFinalText(segment.transcript),
      });
    })();
    void segment.finished.catch((error: unknown) => this.recordFailure(error));
    return segment.finished;
  }
  diagnostics(): DictationStreamDiagnostics {
    const segments = this.#segments.map((segment) => segment.diagnostics);
    // Connection metadata belongs to the initial attempt; later segments contribute totals.
    return {
      ...segments[0],
      attempted: segments.some((segment) => segment.attempted),
      opened: segments.some((segment) => segment.opened),
      started: segments.some((segment) => segment.started),
      finalReceived: this.#diagnostics.finalReceived,
      sentAudioBytes: segments.reduce((total, segment) => total + segment.sentAudioBytes, 0),
      sentAudioFrames: segments.reduce((total, segment) => total + segment.sentAudioFrames, 0),
      transcriptEvents: this.#diagnostics.transcriptEvents,
      finishMs: this.#diagnostics.finishMs,
      failureCode:
        this.#diagnostics.failureCode ??
        segments.find((segment) => segment.failureCode)?.failureCode,
    };
  }

  prepare(): void {
    this.#preparation ??= this.prepareSession();
    void this.#preparation.catch((error: unknown) => this.recordFailure(error));
  }

  private async prepareSession(): Promise<void> {
    await prepareDictationAudio();
    if (this.#closed || this.#captureStopped) return;
    const audio = preparedAudio;
    if (!audio) throw new DictationStreamingError("audio-worklet-failed");
    preparedAudio = null;
    this.#sampleRate = audio.context.sampleRate;
    this.#audioContext = audio.context;
    this.#processor = audio.processor;
    const segment = this.#segments[0]!;
    this.#connection = segment.client.connect(
      audio.context.sampleRate,
      this.options.onTranscript != null,
      this.#admission.promise,
    );
    segment.connection = this.#connection;
    void this.#connection.catch((error: unknown) => this.recordFailure(error));
  }

  async start(
    stream: MediaStream | Promise<MediaStream>,
    confirmed: Promise<boolean> = Promise.resolve(true),
    onReady?: () => void,
  ): Promise<void> {
    void confirmed.then(this.#admission.resolve, this.#admission.reject);
    this.prepare();
    await this.#preparation;
    if (this.#closed || this.#captureStopped) throw new DictationStreamingError("aborted");
    const context = this.#audioContext;
    const processor = this.#processor;
    if (!context || !processor) throw new DictationStreamingError("audio-worklet-failed");
    const firstAudio = createDeferred<void>();
    const audioStart = createDeferred<void>();
    this.#audioStart = audioStart;
    void audioStart.promise.catch(() => undefined);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const readyStream = await stream;
      if (this.#closed || this.#captureStopped) throw new DictationStreamingError("aborted");
      timeout = setTimeout(
        () => audioStart.reject(new DictationStreamingError("audio-start-timeout")),
        FIRST_AUDIO_TIMEOUT_MS,
      );
      this.#source = context.createMediaStreamSource(readyStream);
      processor.port.onmessage = (
        event: MessageEvent<Float32Array | "stopped" | { boundary: number }>,
      ) => {
        if (this.#closed || this.#processor !== processor) return;
        if (event.data === "stopped") {
          this.#completeAudioStop?.();
          return;
        }
        if (!(event.data instanceof Float32Array)) {
          void this.finishSegment(this.#captureSegment);
          this.#captureSegment = event.data.boundary;
          return;
        }
        if (event.data.length === 0) return;
        const frame = encodeDictationPcm16(event.data, this.#gain);
        this.#gain = frame.gain;
        this.#hasSignal = this.#hasSignal === true || frame.rms >= 0.003;
        const segment = this.#segments[this.#captureSegment]!;
        segment.audio.push(frame.pcm16);
        segment.client.appendPCM16(frame.pcm16);
        firstAudio.resolve();
      };
      this.#source.connect(processor);
      const running = (async () => {
        if (context.state !== "running") await context.resume();
        if (this.#captureStopped && !this.#closed && this.#hasSignal !== null) return;
        if (this.#audioContext !== context || context.state !== "running")
          throw new DictationStreamingError("audio-worklet-failed");
      })();
      void Promise.all([running, firstAudio.promise]).then(() => {
        if (!this.#closed && !this.#captureStopped) onReady?.();
        audioStart.resolve();
      }, audioStart.reject);
      await Promise.all([this.#connection, audioStart.promise]);
    } catch (error) {
      this.recordFailure(error);
      this.close();
      throw error;
    } finally {
      clearTimeout(timeout);
      if (this.#audioStart === audioStart) this.#audioStart = null;
    }
  }

  finish(): Promise<string | null> {
    if (this.#finish) return this.#finish;
    const finishingAt = performance.now();
    this.#finish = this.finishTranscript()
      .catch((error: unknown) => {
        this.recordFailure(error);
        // Keep all segment receipts and PCM alive until recovery or explicit cancellation.
        // Other segments may still complete while the failed segment is being recovered.
        return this.isSilent() && !this.hasBoundaries() ? "" : null;
      })
      .finally(() => {
        this.#diagnostics.finishMs = performance.now() - finishingAt;
      });
    return this.#finish;
  }

  private async finishTranscript(): Promise<string | null> {
    await this.stopAndFlush();
    await this.#connection?.catch((error: unknown) => {
      if (!this.#closed) throw error;
    });
    if (this.#closed) return this.isSilent() && !this.hasBoundaries() ? "" : null;
    await Promise.all(this.#segments.map((_segment, id) => this.finishSegment(id)));
    if (this.#closed) return null;
    this.#closed = true;
    return this.transcriptText(false);
  }

  stopAndFlush(): Promise<void> {
    if (this.#audioStop) return this.#audioStop;
    this.#captureStopped = true;
    const processor = this.#processor;
    if (!processor || !this.#source) {
      this.disposeAudioCapture();
      this.#audioStop = Promise.resolve();
      return this.#audioStop;
    }
    this.#audioStop = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => this.#completeAudioStop?.(new DictationStreamingError("audio-flush-timeout")),
        AUDIO_FLUSH_TIMEOUT_MS,
      );
      this.#completeAudioStop = (error) => {
        clearTimeout(timeout);
        this.#completeAudioStop = null;
        this.disposeAudioCapture();
        if (!error) {
          resolve();
          return;
        }
        this.#hasSignal = null;
        this.recordFailure(error);
        this.close();
        reject(error);
      };
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- This is an AudioWorklet MessagePort.
      processor.port.postMessage("stop");
    });
    return this.#audioStop;
  }

  abort(): void {
    this.#aborted = true;
    this.#diagnostics.failureCode ??= "aborted";
    this.close();
  }
  private close(): void {
    this.#closed = true;
    this.#captureStopped = true;
    this.#completeAudioStop?.();
    this.disposeAudioCapture();
    for (const segment of this.#segments) segment.client.close();
  }
  private disposeAudioCapture(): void {
    if (!this.#closed && this.#hasSignal !== null) this.#audioStart?.resolve();
    else this.#audioStart?.reject(new DictationStreamingError("aborted"));
    if (this.#processor) {
      this.#processor.port.onmessage = null;
      this.#processor.port.close();
    }
    this.#processor?.disconnect();
    this.#source?.disconnect();
    this.#processor = null;
    this.#source = null;
    void this.#audioContext?.close().catch(() => undefined);
    this.#audioContext = null;
    void prepareDictationAudio().catch(() => undefined);
  }
  private recordFailure(error: unknown): void {
    this.#diagnostics.failureCode ??=
      error instanceof DictationStreamingError ? error.code : "audio-worklet-failed";
  }
}

export const createBrowserDictationStreamingPort = (
  readConnectInfo: () => Promise<DictationStreamingConnectInfo>,
): DictationControllerPorts["streaming"] => ({
  prepare: async (_sessionId, options?: StreamingOptions) => {
    const attempt = new BrowserDictationStreamingAttempt(readConnectInfo, options);
    attempt.prepare();
    return attempt;
  },
});

function createPcmWav(audio: readonly ArrayBuffer[], sampleRate: number, audioBytes: number): Blob {
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const bytes = new Uint8Array(header);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  bytes.set(new TextEncoder().encode("WAVEfmt "), 8);
  view.setUint32(4, 36 + audioBytes, true);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  bytes.set(new TextEncoder().encode("data"), 36);
  view.setUint32(40, audioBytes, true);
  return new Blob([header, ...audio], { type: "audio/wav" });
}
