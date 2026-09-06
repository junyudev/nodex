import {
  DictationStreamDiagnosticsSchema,
  emptyDictationStreamDiagnostics,
  type DictationStreamDiagnostics,
} from "../../../shared/dictation-diagnostics";
import {
  DICTATION_STREAM_MAX_OUTSTANDING_AUDIO_BYTES,
  DICTATION_STREAMING_WINDOW_MESSAGE,
  type DictationStreamingHostMessage,
} from "../../../shared/dictation-streaming";
import type {
  DictationControllerPorts,
  DictationStreamingAttempt,
} from "./dictation-session-controller";
import dictationPcmWorkletUrl from "./dictation-pcm-worklet.ts?worker&url";

const RENDERER_STREAM_FINISH_TIMEOUT_MS = 9_000;

const isHostMessage = (input: unknown): input is DictationStreamingHostMessage =>
  Boolean(input && typeof input === "object" && "type" in input);

class MainDictationStreamingAttempt implements DictationStreamingAttempt {
  readonly #sessionId: string;
  #audioContext: AudioContext | null = null;
  #source: MediaStreamAudioSourceNode | null = null;
  #worklet: AudioWorkletNode | null = null;
  #port: MessagePort | null = null;
  #sequence = 0;
  #outstandingBytes = 0;
  #finishRequested = false;
  #finishTimer: ReturnType<typeof setTimeout> | null = null;
  #failed = false;
  #diagnostics = emptyDictationStreamDiagnostics();
  diagnostics(): DictationStreamDiagnostics {
    return { ...this.#diagnostics };
  }
  #finalText = "";
  #finishPromise: Promise<string | null>;
  #resolveFinish: (text: string | null) => void = () => undefined;
  readonly #handleHostPortMessage = (event: MessageEvent): void => {
    this.#onHostMessage(event.data);
  };
  readonly #handleHostPortMessageError = (): void => this.#markFailed("port-failed");
  readonly #handleWorkletMessage = (event: MessageEvent<{ readonly pcm16?: unknown }>): void => {
    if (this.#finishRequested || this.#failed) return;
    const pcm16 = event.data.pcm16;
    if (!(pcm16 instanceof ArrayBuffer) || pcm16.byteLength === 0) return;
    const byteLength = pcm16.byteLength;
    if (this.#outstandingBytes + byteLength > DICTATION_STREAM_MAX_OUTSTANDING_AUDIO_BYTES) {
      this.#markFailed("backpressure-overflow");
      return;
    }
    this.#outstandingBytes += byteLength;
    this.#port?.postMessage({ type: "audio-frame", sequence: this.#sequence++, pcm16 }, [pcm16]);
  };

  constructor(sessionId: string) {
    this.#sessionId = sessionId;
    this.#finishPromise = new Promise((resolve) => {
      this.#resolveFinish = resolve;
    });
  }

  async start(stream: MediaStream): Promise<void> {
    if (this.#failed) throw new Error("Dictation streaming is unavailable");
    const audioContext = new AudioContext();
    this.#audioContext = audioContext;
    try {
      await audioContext.audioWorklet.addModule(dictationPcmWorkletUrl);
      if (this.#failed) return;
      const channel = new MessageChannel();
      this.#port = channel.port1;
      channel.port1.addEventListener("message", this.#handleHostPortMessage);
      channel.port1.addEventListener("messageerror", this.#handleHostPortMessageError);
      channel.port1.start();
      window.postMessage(
        {
          type: DICTATION_STREAMING_WINDOW_MESSAGE,
          sessionId: this.#sessionId,
          sampleRateHz: audioContext.sampleRate,
        },
        window.location.origin,
        [channel.port2],
      );
      const source = audioContext.createMediaStreamSource(stream);
      const worklet = new AudioWorkletNode(audioContext, "nodex-dictation-pcm", {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: 1,
      });
      this.#source = source;
      this.#worklet = worklet;
      worklet.port.addEventListener("message", this.#handleWorkletMessage);
      worklet.port.start();
      source.connect(worklet);
      if (this.#finishRequested) {
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- MessagePort has no target origin.
        this.#port.postMessage({ type: "finish" });
      }
    } catch (error) {
      this.#markFailed("audio-worklet-failed");
      throw error;
    }
  }

  finish(): Promise<string | null> {
    this.#finishRequested = true;
    this.#stopAudioGraph();
    if (this.#failed) return Promise.resolve(null);
    this.#port?.postMessage({ type: "finish" });
    this.#finishTimer ??= setTimeout(
      () => this.#markFailed("renderer-finish-timeout"),
      RENDERER_STREAM_FINISH_TIMEOUT_MS,
    );
    return this.#finishPromise;
  }

  abort(): void {
    if (!this.#failed) this.#port?.postMessage({ type: "abort" });
    this.#markFailed("aborted");
  }

  #onHostMessage(input: unknown): void {
    if (!isHostMessage(input) || this.#failed) return;
    switch (input.type) {
      case "diagnostics": {
        const parsed = DictationStreamDiagnosticsSchema.safeParse(input.diagnostics);
        if (parsed.success) this.#diagnostics = parsed.data;
        return;
      }
      case "audio-ack":
        this.#outstandingBytes = Math.max(0, input.outstandingBytes);
        return;
      case "final":
        this.#finalText = input.text.trim();
        return;
      case "failed":
        this.#markFailed(input.error.code);
        return;
      case "closed":
        if (input.outcome.kind === "completed") {
          this.#resolveFinish(this.#finalText || null);
          this.#cleanupPort();
          return;
        }
        this.#markFailed();
        return;
      default:
        return;
    }
  }

  #markFailed(code: DictationStreamDiagnostics["failureCode"] = "port-failed"): void {
    if (this.#failed) return;
    this.#diagnostics.failureCode ??= code;
    this.#failed = true;
    if (this.#finishTimer) clearTimeout(this.#finishTimer);
    this.#finishTimer = null;
    this.#resolveFinish(null);
    this.#stopAudioGraph();
    this.#cleanupPort();
  }

  #stopAudioGraph(): void {
    this.#source?.disconnect();
    this.#worklet?.disconnect();
    this.#worklet?.port.removeEventListener("message", this.#handleWorkletMessage);
    this.#source = null;
    this.#worklet = null;
    const context = this.#audioContext;
    this.#audioContext = null;
    void context?.close();
  }

  #cleanupPort(): void {
    if (this.#finishTimer) clearTimeout(this.#finishTimer);
    this.#finishTimer = null;
    this.#port?.removeEventListener("message", this.#handleHostPortMessage);
    this.#port?.removeEventListener("messageerror", this.#handleHostPortMessageError);
    this.#port?.close();
    this.#port = null;
  }
}

export const mainDictationStreamingPort: DictationControllerPorts["streaming"] = {
  prepare: async (sessionId) => new MainDictationStreamingAttempt(sessionId),
};
