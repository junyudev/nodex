/* oxlint-disable unicorn/require-post-message-target-origin -- This processor uses an AudioWorklet MessagePort. */
import { createRealtimeVoiceAudioBuffer } from "./realtime-voice-audio-buffer";

declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: AudioWorkletNodeOptions);
  abstract process(
    inputs: readonly (readonly Float32Array[])[],
    outputs: readonly (readonly Float32Array[])[],
  ): boolean;
}
declare const sampleRate: number;
declare const registerProcessor: (
  name: string,
  processor: new (options: AudioWorkletNodeOptions) => AudioWorkletProcessor,
) => void;

class RealtimeVoiceAudioProcessor extends AudioWorkletProcessor {
  readonly #buffer: ReturnType<typeof createRealtimeVoiceAudioBuffer>;
  #captureReported = false;
  constructor(options: AudioWorkletNodeOptions) {
    super(options);
    this.#buffer = createRealtimeVoiceAudioBuffer({
      bufferInputWhileConnecting: options.processorOptions?.bufferInputWhileConnecting,
      capacitySamples: sampleRate * 30,
      leadingSilenceThreshold: 0.003,
      preRollSamples: sampleRate * 0.1,
      onPhaseChange: (phase, reason) =>
        this.port.postMessage({ type: "phase-changed", phase, reason }),
    });
    // Each processor owns one handler; the graph owner closes this port on retirement.
    // oxlint-disable-next-line unicorn/prefer-add-event-listener
    this.port.onmessage = (event: MessageEvent<unknown>) => {
      const value = event.data;
      if (!value || typeof value !== "object" || !("type" in value)) return;
      if (value.type === "release") {
        this.#buffer.release();
        return;
      }
      if (
        value.type !== "mute" ||
        !("muted" in value) ||
        typeof value.muted !== "boolean" ||
        !("requestId" in value) ||
        typeof value.requestId !== "number"
      )
        return;
      this.#buffer.setMuted(value.muted);
      this.port.postMessage({
        type: "mute-applied",
        muted: value.muted,
        requestId: value.requestId,
      });
    };
  }
  process(
    inputs: readonly (readonly Float32Array[])[],
    outputs: readonly (readonly Float32Array[])[],
  ): boolean {
    const output = outputs[0]?.[0];
    if (!output) return true;
    const input = inputs[0]?.[0];
    this.#buffer.process(input, output);
    if (!this.#captureReported && input && input.length > 0) {
      this.#captureReported = true;
      this.port.postMessage({ type: "capture-started" });
    }
    return true;
  }
}
registerProcessor("nodex-realtime-buffered-audio", RealtimeVoiceAudioProcessor);
