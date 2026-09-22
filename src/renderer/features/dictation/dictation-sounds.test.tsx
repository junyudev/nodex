import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const contexts: Array<{
  close: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  ended: (() => void) | null;
}> = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  contexts.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(4) })),
  );
  vi.stubGlobal(
    "AudioContext",
    class {
      currentTime = 0;
      outputLatency = 0.02;
      destination = {};
      entry = {
        close: vi.fn(async () => undefined),
        start: vi.fn(),
        ended: null as (() => void) | null,
      };
      constructor() {
        contexts.push(this.entry);
      }
      close = this.entry.close;
      resume = async () => undefined;
      decodeAudioData = async () => ({ duration: 0.18 });
      getOutputTimestamp = () => ({ contextTime: 1 });
      createBufferSource = () => ({
        buffer: null,
        connect: () => undefined,
        addEventListener: (_event: string, callback: () => void) => {
          this.entry.ended = callback;
        },
        start: this.entry.start,
      });
    },
  );
});
afterEach(async () => {
  await vi.runAllTimersAsync();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("dictation feedback sounds", () => {
  it("replaces the previous sound and releases audio after the output latency settles", async () => {
    const { playDictationSound } = await import("./dictation-sounds");
    playDictationSound("start");
    await vi.advanceTimersByTimeAsync(0);
    expect(contexts[0]?.start).toHaveBeenCalledOnce();
    playDictationSound("stop");
    await vi.advanceTimersByTimeAsync(0);
    expect(contexts[0]?.close).toHaveBeenCalledOnce();
    contexts[1]?.ended?.();
    await vi.advanceTimersByTimeAsync(19);
    expect(contexts[1]?.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(contexts[1]?.close).toHaveBeenCalledOnce();
  });

  it("releases the audio device if loading never completes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => undefined)),
    );
    const { playDictationSound } = await import("./dictation-sounds");
    playDictationSound("error");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(contexts[0]?.close).toHaveBeenCalledOnce();
    expect(contexts[0]?.start).not.toHaveBeenCalled();
  });
});
