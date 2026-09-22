import type { DictationControllerPorts } from "@/features/dictation/dictation-session-controller";
import { normalizeDictationScrollWaveformRms } from "@/features/dictation/dictation-waveform";

const WEIGHTS = [0.64, 0.88, 1, 1, 0.82, 0.58];
export interface InlineDictationWaveformState {
  readonly elapsedSeconds: number;
  readonly audioLevels: readonly number[];
  readonly levels: readonly number[];
}
export const createInlineDictationWaveformState = (): InlineDictationWaveformState => ({
  elapsedSeconds: 0,
  audioLevels: WEIGHTS.map(() => 0),
  levels: WEIGHTS.map(() => 0),
});
const startupPulse = (time: number): number => {
  if (time < 0 || time >= 0.53) return 0;
  if (time < 0.18) return 0.5 - 0.5 * Math.cos((Math.PI * time) / 0.18);
  if (time < 0.23) return 1;
  return 0.5 + 0.5 * Math.cos((Math.PI * (time - 0.23)) / 0.3);
};
export function advanceInlineDictationWaveform(
  previous: InlineDictationWaveformState,
  input: {
    readonly deltaSeconds: number;
    readonly nowSeconds: number;
    readonly inputTimeSeconds: number;
    readonly inputLevel: number;
    readonly reducedMotion: boolean;
  },
): InlineDictationWaveformState {
  const delta = Math.min(Math.max(input.deltaSeconds, 0), 1 / 15);
  const elapsedSeconds = previous.elapsedSeconds + delta;
  const level = input.nowSeconds - input.inputTimeSeconds <= 0.3 ? input.inputLevel : 0;
  const audioLevels = WEIGHTS.map((weight, index) => {
    const modulation = input.reducedMotion
      ? 0.8
      : 0.72 + 0.28 * Math.sin(elapsedSeconds * (4.6 + index * 0.71) + index * 1.67);
    const target = Math.min(Math.max(level * weight * modulation, 0), 1);
    const previousLevel = previous.audioLevels[index] ?? 0;
    const response = target > previousLevel ? 0.04 : 0.16;
    return previousLevel + (target - previousLevel) * (1 - Math.exp(-delta / response));
  });
  return {
    elapsedSeconds,
    audioLevels,
    levels: audioLevels.map((level, index) =>
      Math.max(level, input.reducedMotion ? 0 : startupPulse(elapsedSeconds * 2 - index * 0.055)),
    ),
  };
}

export function drawInlineDictationWaveform(
  canvas: HTMLCanvasElement,
  levels: readonly number[],
): void {
  const context = canvas.getContext("2d");
  const { clientWidth, clientHeight } = canvas;
  if (!context || clientWidth <= 0 || clientHeight <= 0) return;
  const ratio = window.devicePixelRatio || 1;
  const width = Math.floor(clientWidth * ratio);
  const height = Math.floor(clientHeight * ratio);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const barWidth = 2 * ratio;
  const gap = 3 * ratio;
  const startX = (width - (barWidth * WEIGHTS.length + gap * (WEIGHTS.length - 1))) / 2;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, width, height);
  context.save();
  context.fillStyle = getComputedStyle(canvas).color || "#000";
  context.globalAlpha = 1;
  WEIGHTS.forEach((_, index) => {
    const barHeight = (3 + (levels[index] ?? 0) * (Math.min(clientHeight, 20) - 3)) * ratio;
    context.beginPath();
    context.roundRect(
      startX + index * (barWidth + gap),
      (height - barHeight) / 2,
      barWidth,
      barHeight,
      Math.min(barWidth / 2, barHeight / 2),
    );
    context.fill();
  });
  context.restore();
}

const createSilentContext = (): AudioContext => {
  try {
    const options: AudioContextOptions & { sinkId: { type: "none" } } = {
      sinkId: { type: "none" },
    };
    return new AudioContext(options);
  } catch {
    return new AudioContext();
  }
};

export const browserInlineDictationWaveformPort: DictationControllerPorts["waveform"] = {
  start(stream, onSamples) {
    let state = createInlineDictationWaveformState();
    let inputLevel = 0;
    let inputTimeSeconds = -Infinity;
    let previousAt = performance.now();
    let active = true;
    let frame: number | null = null;
    let context: AudioContext | null = null;
    let source: MediaStreamAudioSourceNode | null = null;
    let processor: ScriptProcessorNode | null = null;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const advance = (now: number) => {
      if (!active) return;
      if (now - previousAt >= 1000 / 30) {
        state = advanceInlineDictationWaveform(state, {
          deltaSeconds: (now - previousAt) / 1000,
          nowSeconds: now / 1000,
          inputTimeSeconds,
          inputLevel,
          reducedMotion: reducedMotion.matches,
        });
        onSamples(state.levels);
        previousAt = now;
      }
      frame = requestAnimationFrame(advance);
    };
    frame = requestAnimationFrame(advance);
    try {
      if (typeof AudioContext !== "undefined") {
        context = createSilentContext();
        source = context.createMediaStreamSource(stream);
        processor = context.createScriptProcessor(2048, 1, 1);
        processor.onaudioprocess = (event) => {
          const samples = event.inputBuffer.getChannelData(0);
          let squared = 0;
          for (const sample of samples) squared += sample * sample;
          const level = normalizeDictationScrollWaveformRms(
            Math.sqrt(squared / Math.max(1, samples.length)),
          );
          if (!Number.isFinite(level)) return;
          inputLevel = Math.min(1, Math.max(0, level));
          inputTimeSeconds = performance.now() / 1000;
        };
        source.connect(processor);
        processor.connect(context.destination);
      }
    } catch {
      processor?.disconnect();
      source?.disconnect();
      void context?.close();
      context = null;
    }
    return {
      dispose: () => {
        active = false;
        if (frame !== null) cancelAnimationFrame(frame);
        if (processor) {
          processor.onaudioprocess = null;
          processor.disconnect();
        }
        source?.disconnect();
        void context?.close();
      },
    };
  },
};
