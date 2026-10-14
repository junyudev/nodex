export type RealtimeVoiceAudioPhase = "buffering" | "replaying" | "live";

export interface RealtimeVoiceAudioBufferOptions {
  readonly capacitySamples: number;
  readonly leadingSilenceThreshold: number;
  readonly preRollSamples: number;
  readonly bufferInputWhileConnecting?: boolean;
  readonly replayRate?: 1 | 2;
  readonly onPhaseChange?: (
    phase: RealtimeVoiceAudioPhase,
    reason: "release" | "drained" | "mute",
  ) => void;
}

/** One bounded mono ring owns startup audio until the transport releases it. */
export function createRealtimeVoiceAudioBuffer(options: RealtimeVoiceAudioBufferOptions) {
  const samples = new Float32Array(
    options.bufferInputWhileConnecting === false ? 0 : options.capacitySamples,
  );
  let length = 0;
  let readOffset = 0;
  let muted = false;
  let phase: RealtimeVoiceAudioPhase = "buffering";
  const setPhase = (next: RealtimeVoiceAudioPhase, reason: "release" | "drained" | "mute") => {
    if (phase === next) return;
    phase = next;
    options.onPhaseChange?.(next, reason);
  };
  const append = (input: Float32Array | undefined) => {
    if (!input || samples.length === 0) return;
    for (const value of input) {
      if (length === samples.length) {
        readOffset = (readOffset + 1) % samples.length;
        length -= 1;
      }
      samples[(readOffset + length) % samples.length] = value;
      length += 1;
    }
  };
  const shift = () => {
    const value = samples[readOffset] ?? 0;
    readOffset = (readOffset + 1) % samples.length;
    length -= 1;
    return value;
  };
  const copy = (input: Float32Array | undefined, output: Float32Array, start = 0) => {
    if (!input) return;
    for (let index = start; index < output.length && index < input.length; index += 1)
      output[index] = input[index] ?? 0;
  };
  return {
    process(input: Float32Array | undefined, output: Float32Array): void {
      output.fill(0);
      if (muted) return;
      if (phase === "buffering") {
        append(input);
        return;
      }
      if (phase === "live") {
        copy(input, output);
        return;
      }
      if (options.replayRate === 2) {
        append(input);
        for (let index = 0; index < output.length; index += 1) {
          if (length === 0) break;
          const remaining = output.length - index;
          const value = shift();
          output[index] = length >= remaining ? (value + shift()) / 2 : value;
        }
        if (length === 0) setPhase("live", "drained");
        return;
      }
      if (input?.some((value) => Math.abs(value) >= options.leadingSilenceThreshold)) append(input);
      for (let index = 0; index < output.length; index += 1) {
        if (length === 0) {
          setPhase("live", "drained");
          copy(input, output, index);
          break;
        }
        output[index] = shift();
      }
      if (length === 0) setPhase("live", "drained");
    },
    release(): void {
      if (phase !== "buffering") return;
      let firstSignal: number | null = null;
      for (let index = 0; index < length; index += 1) {
        if (
          Math.abs(samples[(readOffset + index) % samples.length] ?? 0) <
          options.leadingSilenceThreshold
        )
          continue;
        firstSignal = index;
        break;
      }
      if (firstSignal === null) {
        length = 0;
        setPhase("live", "release");
        return;
      }
      const leading = Math.max(0, firstSignal - options.preRollSamples);
      readOffset = (readOffset + leading) % samples.length;
      length -= leading;
      let trailing = 0;
      while (trailing < length) {
        const index = (readOffset + length - trailing - 1) % samples.length;
        if (Math.abs(samples[index] ?? 0) >= options.leadingSilenceThreshold) break;
        trailing += 1;
      }
      length -= Math.max(0, trailing - options.preRollSamples);
      setPhase("replaying", "release");
    },
    setMuted(value: boolean): void {
      muted = value;
      if (!value) return;
      samples.fill(0);
      length = 0;
      readOffset = 0;
      if (phase === "replaying") setPhase("live", "mute");
    },
  };
}
