/* oxlint-disable unicorn/prefer-add-event-listener -- Each audio processor owns exactly one message handler, cleared when capture ends. */
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  abstract process(inputs: readonly (readonly Float32Array[])[]): boolean;
}
declare const registerProcessor: (name: string, processor: new () => AudioWorkletProcessor) => void;

export const DICTATION_AUDIO_FRAME_SAMPLES = 2048;

class NodexDictationPcmProcessor extends AudioWorkletProcessor {
  #buffer = new Float32Array(DICTATION_AUDIO_FRAME_SAMPLES);
  #length = 0;
  #stopped = false;
  constructor() {
    super();
    this.port.onmessage = () => {
      if (this.#stopped) return;
      this.#stopped = true;
      this.flush();
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- This is an AudioWorklet MessagePort.
      this.port.postMessage("stopped");
    };
  }
  process(inputs: readonly (readonly Float32Array[])[]): boolean {
    if (this.#stopped) return false;
    const samples = inputs[0]?.[0];
    if (!samples) return true;
    for (let offset = 0; offset < samples.length;) {
      const count = Math.min(samples.length - offset, this.#buffer.length - this.#length);
      this.#buffer.set(samples.subarray(offset, offset + count), this.#length);
      this.#length += count;
      offset += count;
      if (this.#length === this.#buffer.length) this.flush();
    }
    return true;
  }
  private flush(): void {
    if (this.#length === 0) return;
    const samples = this.#buffer.slice(0, this.#length);
    this.port.postMessage(samples, [samples.buffer]);
    this.#length = 0;
  }
}
registerProcessor("nodex-dictation-pcm", NodexDictationPcmProcessor);
