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

class BrowserDictationStreamingAttempt implements DictationStreamingAttempt {
  #closed = false;
  #captureStopped = false;
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
  #transcripts = createDictationStreamingTranscriptState();
  #client: DictationWebSocketClient;

  constructor(readConnectInfo: () => Promise<DictationStreamingConnectInfo>) {
    this.#client = new DictationWebSocketClient(
      readConnectInfo,
      (event) => {
        if (this.#closed) return;
        applyDictationStreamingServerEvent(this.#transcripts, event);
        if (event.type === "transcript.final") this.#diagnostics.finalReceived = true;
        if (
          event.type === "transcript.final" ||
          event.type === "transcript.segment" ||
          event.type === "transcript.delta"
        )
          this.#diagnostics.transcriptEvents += 1;
      },
      this.#diagnostics,
    );
  }
  diagnostics(): DictationStreamDiagnostics {
    return { ...this.#diagnostics };
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
    this.#audioContext = audio.context;
    this.#processor = audio.processor;
    this.#connection = this.#client.connect(audio.context.sampleRate);
    void this.#connection.catch((error: unknown) => this.recordFailure(error));
  }

  async start(stream: MediaStream): Promise<void> {
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
    const timeout = setTimeout(
      () => audioStart.reject(new DictationStreamingError("audio-start-timeout")),
      FIRST_AUDIO_TIMEOUT_MS,
    );
    try {
      this.#source = context.createMediaStreamSource(stream);
      processor.port.onmessage = (event: MessageEvent<Float32Array | "stopped">) => {
        if (this.#closed || this.#processor !== processor) return;
        if (event.data === "stopped") {
          this.#completeAudioStop?.();
          return;
        }
        if (event.data.length === 0) return;
        const frame = encodeDictationPcm16(event.data, this.#gain);
        this.#gain = frame.gain;
        this.#hasSignal = this.#hasSignal === true || frame.rms >= 0.003;
        this.#client.appendPCM16(frame.pcm16);
        firstAudio.resolve();
      };
      this.#source.connect(processor);
      const running = (async () => {
        if (context.state !== "running") await context.resume();
        if (this.#captureStopped && !this.#closed && this.#hasSignal !== null) return;
        if (this.#audioContext !== context || context.state !== "running")
          throw new DictationStreamingError("audio-worklet-failed");
      })();
      void Promise.all([running, firstAudio.promise]).then(
        () => audioStart.resolve(),
        audioStart.reject,
      );
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
    this.#finish ??= this.finishTranscript().catch((error: unknown) => {
      this.recordFailure(error);
      this.close();
      return this.#hasSignal === false ? "" : null;
    });
    return this.#finish;
  }

  private async finishTranscript(): Promise<string | null> {
    await this.stopAndFlush();
    await this.#connection?.catch((error: unknown) => {
      if (!this.#closed) throw error;
    });
    if (this.#closed) return this.#hasSignal === false ? "" : null;
    await this.#client.finish();
    if (this.#closed) return null;
    this.#closed = true;
    return readDictationStreamingFinalText(this.#transcripts);
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
    this.#diagnostics.failureCode ??= "aborted";
    this.close();
  }
  private close(): void {
    this.#closed = true;
    this.#captureStopped = true;
    this.#completeAudioStop?.();
    this.disposeAudioCapture();
    this.#client.close();
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
  prepare: async () => {
    const attempt = new BrowserDictationStreamingAttempt(readConnectInfo);
    attempt.prepare();
    return attempt;
  },
});
