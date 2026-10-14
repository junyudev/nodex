import { afterEach, expect, it, vi } from "vitest";

interface TestProcessor {
  readonly port: {
    onmessage: ((event: MessageEvent<unknown>) => void) | null;
    postMessage(message: unknown): void;
  };
  process(
    inputs: readonly (readonly Float32Array[])[],
    outputs: readonly (readonly Float32Array[])[],
  ): boolean;
}
afterEach(() => vi.unstubAllGlobals());

it("runs the registered processor through buffering, acknowledged mute and input release", async () => {
  const messages: unknown[] = [];
  let Processor: (new (options: AudioWorkletNodeOptions) => TestProcessor) | null = null;
  class PlatformProcessor {
    readonly port = { onmessage: null, postMessage: (message: unknown) => messages.push(message) };
  }
  vi.stubGlobal("sampleRate", 10);
  vi.stubGlobal("AudioWorkletProcessor", PlatformProcessor);
  vi.stubGlobal("registerProcessor", (name: string, value: NonNullable<typeof Processor>) => {
    expect(name).toBe("nodex-realtime-buffered-audio");
    Processor = value;
  });
  await import("./realtime-voice-audio-worklet");
  if (!Processor) throw new Error("The audio processor did not register");
  const createProcessor = Processor as new (options: AudioWorkletNodeOptions) => TestProcessor;
  const processor = new createProcessor({ processorOptions: { bufferInputWhileConnecting: true } });
  const output = new Float32Array(4);
  expect(processor.process([[Float32Array.of(0, 0.2, 0.3, 0)]], [[output]])).toBe(true);
  expect(Array.from(output)).toEqual([0, 0, 0, 0]);
  processor.process([[Float32Array.of(0.4, 0, 0, 0)]], [[output]]);
  expect(
    messages.filter((message) => (message as { type: string }).type === "capture-started"),
  ).toHaveLength(1);
  processor.port.onmessage?.(
    new MessageEvent("message", { data: { type: "mute", muted: true, requestId: 9 } }),
  );
  processor.process([[Float32Array.of(0.5, 0.5, 0.5, 0.5)]], [[output]]);
  expect(Array.from(output)).toEqual([0, 0, 0, 0]);
  expect(messages).toContainEqual({ type: "mute-applied", muted: true, requestId: 9 });
  processor.port.onmessage?.(new MessageEvent("message", { data: { type: "release" } }));
  processor.port.onmessage?.(
    new MessageEvent("message", { data: { type: "mute", muted: false, requestId: 10 } }),
  );
  processor.process([[Float32Array.of(0.1, 0.2, 0.3, 0.4)]], [[output]]);
  expect(Array.from(output)).toEqual(Array.from(Float32Array.of(0.1, 0.2, 0.3, 0.4)));
  expect(messages).toContainEqual({ type: "mute-applied", muted: false, requestId: 10 });
  expect(messages).toContainEqual({ type: "phase-changed", phase: "live", reason: "release" });
});
