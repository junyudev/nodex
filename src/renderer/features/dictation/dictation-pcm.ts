export interface DictationPcmFrame {
  readonly pcm16: ArrayBuffer;
  readonly gain: number;
  readonly rms: number;
}

/** Use fast gain reduction, smoothed gain increases, and truncating signed PCM16 conversion. */
export const encodeDictationPcm16 = (
  samples: Float32Array,
  previousGain = 1,
): DictationPcmFrame => {
  let squaredTotal = 0;
  let peak = 0;
  for (const sample of samples) {
    squaredTotal += sample * sample;
    peak = Math.max(peak, Math.abs(sample));
  }
  const rms = samples.length ? Math.sqrt(squaredTotal / samples.length) : 0;
  const desiredGain = rms < 0.003 ? 1 : Math.min(4, Math.max(1, 0.063 / rms), 0.708 / peak);
  const gain =
    rms < 0.003 || desiredGain <= previousGain
      ? desiredGain
      : previousGain + (desiredGain - previousGain) * 0.35;
  const pcm = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index++) {
    const sample = Math.max(-1, Math.min(1, (samples[index] ?? 0) * gain));
    pcm[index] = sample < 0 ? sample * 32768 : sample * 32767;
  }
  return { pcm16: pcm.buffer, gain, rms };
};
