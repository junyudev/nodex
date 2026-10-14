import { describe, expect, test } from "vite-plus/test";
import {
  createRealtimeVoiceAudioBuffer,
  type RealtimeVoiceAudioPhase,
} from "./realtime-voice-audio-buffer";

const frame = (values: readonly number[]) => new Float32Array(values);
const queue = (capacitySamples = 12, preRollSamples = 1) => {
  const phases: RealtimeVoiceAudioPhase[] = [];
  const buffer = createRealtimeVoiceAudioBuffer({
    capacitySamples,
    preRollSamples,
    leadingSilenceThreshold: 0.003,
    onPhaseChange: (phase) => phases.push(phase),
  });
  const process = (input: readonly number[] | undefined, size = input?.length ?? 4) => {
    const output = new Float32Array(size);
    buffer.process(input === undefined ? undefined : frame(input), output);
    return output;
  };
  return { buffer, phases, process };
};

describe("realtime startup audio", () => {
  test("trims silence while retaining both pre-roll boundaries and replays before live input", () => {
    const f = queue();
    expect(f.process([0, 0, 0, 0.5, 0.25, 0, 0, 0])).toEqual(frame([0, 0, 0, 0, 0, 0, 0, 0]));
    f.buffer.release();
    expect(f.process(undefined, 6)).toEqual(frame([0, 0.5, 0.25, 0, 0, 0]));
    expect(f.phases).toEqual(["replaying", "live"]);
    expect(f.process([0.8, 0.2])).toEqual(frame([0.8, 0.2]));
  });
  test("retains only the newest bounded startup samples", () => {
    const f = queue(4, 0);
    f.process([1, 2, 3]);
    f.process([4, 5, 6]);
    f.buffer.release();
    expect(f.process(undefined, 4)).toEqual(frame([3, 4, 5, 6]));
    expect(f.phases).toEqual(["replaying", "live"]);
  });
  test("releases a silent buffer directly to live without replaying old silence", () => {
    const f = queue();
    f.process([0.001, 0.002, 0]);
    f.buffer.release();
    expect(f.phases).toEqual(["live"]);
    expect(f.process([0.25, 0])).toEqual(frame([0.25, 0]));
    f.buffer.release();
    expect(f.phases).toEqual(["live"]);
  });
  test("appends live speech behind buffered speech, without prolonging replay with silence", () => {
    const f = queue(12, 0);
    f.process([0.4, 0.5]);
    f.buffer.release();
    expect(f.process([0.6, 0.7])).toEqual(frame([0.4, 0.5]));
    expect(f.process([0, 0])).toEqual(frame([0.6, 0.7]));
    expect(f.phases).toEqual(["replaying", "live"]);
  });
  test("mute discards buffered and replaying speech so unmute cannot leak it", () => {
    const f = queue();
    f.process([0.5, 0.6]);
    f.buffer.release();
    f.buffer.setMuted(true);
    expect(f.process([0.9, 0.9])).toEqual(frame([0, 0]));
    f.buffer.setMuted(false);
    expect(f.process([0.2, 0.3])).toEqual(frame([0.2, 0.3]));
    expect(f.phases).toEqual(["replaying", "live"]);
  });
  test("mute before release discards the connecting buffer and does not capture muted input", () => {
    const f = queue();
    f.process([0.5, 0.6]);
    f.buffer.setMuted(true);
    f.process([0.9, 0.9]);
    f.buffer.setMuted(false);
    f.buffer.release();
    expect(f.process([0.2, 0.3])).toEqual(frame([0.2, 0.3]));
    expect(f.phases).toEqual(["live"]);
  });
  test("disabled buffering still waits for release, then directly forwards current audio", () => {
    const buffer = createRealtimeVoiceAudioBuffer({
      capacitySamples: 12,
      preRollSamples: 1,
      leadingSilenceThreshold: 0.003,
      bufferInputWhileConnecting: false,
    });
    const output = frame([1, 1]);
    buffer.process(frame([0.5, 0.6]), output);
    expect(output).toEqual(frame([0, 0]));
    buffer.release();
    buffer.process(frame([0.2, 0.3]), output);
    expect(output).toEqual(frame([0.2, 0.3]));
  });
  test("an explicit double-rate replay consumes pairs while maintaining output-frame size", () => {
    const buffer = createRealtimeVoiceAudioBuffer({
      capacitySamples: 8,
      preRollSamples: 0,
      leadingSilenceThreshold: 0.003,
      replayRate: 2,
    });
    buffer.process(frame([1, 3, 5, 7]), new Float32Array(4));
    buffer.release();
    const output = new Float32Array(2);
    buffer.process(undefined, output);
    expect(output).toEqual(frame([2, 6]));
    buffer.process(frame([0.2, 0.3]), output);
    expect(output).toEqual(frame([0.2, 0.3]));
  });
});
