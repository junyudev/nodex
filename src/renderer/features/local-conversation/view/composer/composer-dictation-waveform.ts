import {
  DICTATION_SCROLL_WAVEFORM_ADVANCE_INTERVAL_MS,
  DICTATION_SCROLL_WAVEFORM_SAMPLE_FLOOR,
  normalizeDictationScrollWaveformRms,
} from "@/features/dictation/dictation-waveform";
export const COMPOSER_DICTATION_WAVEFORM_SAMPLE_FLOOR = DICTATION_SCROLL_WAVEFORM_SAMPLE_FLOOR;
export const COMPOSER_DICTATION_WAVEFORM_BAR_WIDTH_PX = 3;
export const COMPOSER_DICTATION_WAVEFORM_BAR_PITCH_PX = 6;
export const COMPOSER_DICTATION_WAVEFORM_ADVANCE_INTERVAL_MS =
  DICTATION_SCROLL_WAVEFORM_ADVANCE_INTERVAL_MS;

export interface ComposerDictationWaveformGeometry {
  readonly barCount: number;
  readonly barPitchPx: number;
  readonly barWidthPx: number;
  readonly historyDurationMs: number;
  readonly scrollSpeedPxPerSecond: number;
}

export function resolveComposerDictationWaveformGeometry(
  clientWidth: number,
): ComposerDictationWaveformGeometry {
  const barCount = Math.max(
    1,
    Math.floor(Math.max(0, clientWidth) / COMPOSER_DICTATION_WAVEFORM_BAR_PITCH_PX) + 1,
  );
  return {
    barCount,
    barPitchPx: COMPOSER_DICTATION_WAVEFORM_BAR_PITCH_PX,
    barWidthPx: COMPOSER_DICTATION_WAVEFORM_BAR_WIDTH_PX,
    historyDurationMs: barCount * COMPOSER_DICTATION_WAVEFORM_ADVANCE_INTERVAL_MS,
    scrollSpeedPxPerSecond:
      (COMPOSER_DICTATION_WAVEFORM_BAR_PITCH_PX * 1_000) /
      COMPOSER_DICTATION_WAVEFORM_ADVANCE_INTERVAL_MS,
  };
}

/** Maps microphone RMS onto the response curve used by the composer waveform. */
export function normalizeComposerDictationRms(rms: number): number {
  return normalizeDictationScrollWaveformRms(rms);
}

export function appendComposerDictationWaveformLevel(
  levels: number[],
  rms: number,
  maxLevelCount: number,
): void {
  if (maxLevelCount <= 0) return;
  levels.push(normalizeComposerDictationRms(rms));
  if (levels.length > maxLevelCount) levels.splice(0, levels.length - maxLevelCount);
}

/** Draws the reference scrolling history, including its fixed 200ms fractional advance. */
export function drawComposerDictationWaveform(
  canvas: HTMLCanvasElement,
  sourceLevels: readonly number[],
  intervalProgress: number,
): void {
  const context = canvas.getContext("2d");
  const { clientHeight, clientWidth } = canvas;
  if (!context || clientWidth <= 0 || clientHeight <= 0) return;

  const pixelRatio = window.devicePixelRatio || 1;
  const width = Math.floor(clientWidth * pixelRatio);
  const height = Math.floor(clientHeight * pixelRatio);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  const { barCount } = resolveComposerDictationWaveformGeometry(clientWidth);
  const visibleLevels = sourceLevels.slice(-barCount);
  const levels = [
    ...Array.from(
      { length: Math.max(0, barCount - visibleLevels.length) },
      () => COMPOSER_DICTATION_WAVEFORM_SAMPLE_FLOOR,
    ),
    ...visibleLevels,
  ];
  const barWidth = COMPOSER_DICTATION_WAVEFORM_BAR_WIDTH_PX * pixelRatio;
  const barPitch = COMPOSER_DICTATION_WAVEFORM_BAR_PITCH_PX * pixelRatio;
  const progress = Math.min(1, Math.max(0, intervalProgress));
  const offsetX = -barPitch * progress;

  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, width, height);
  context.save();
  context.translate(0, height / 2);
  context.fillStyle = getComputedStyle(canvas).color || "#000";

  levels.forEach((level, index) => {
    const normalizedLevel = Math.min(1, Math.max(0, level));
    const barHeight = Math.max(barWidth, (height - barWidth) * normalizedLevel);
    const x = width - (levels.length - index - 1) * barPitch + offsetX;
    context.globalAlpha = normalizedLevel <= COMPOSER_DICTATION_WAVEFORM_SAMPLE_FLOOR ? 0.2 : 0.5;
    context.beginPath();
    context.roundRect(x, -barHeight / 2, barWidth, barHeight, barWidth / 2);
    context.fill();
  });

  const fade = context.createLinearGradient(0, 0, width, 0);
  const edge = Math.min(0.5, barPitch / width);
  fade.addColorStop(0, "rgb(0 0 0 / 0)");
  fade.addColorStop(edge, "rgb(0 0 0 / 1)");
  fade.addColorStop(1 - edge, "rgb(0 0 0 / 1)");
  fade.addColorStop(1, "rgb(0 0 0 / 0)");
  context.globalAlpha = 1;
  context.globalCompositeOperation = "destination-in";
  context.fillStyle = fade;
  context.fillRect(0, -height / 2, width, height);
  context.restore();
}
