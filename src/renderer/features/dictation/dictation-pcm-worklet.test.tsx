import { afterEach, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllGlobals());
it("batches 2048 samples and flushes the partial tail before acknowledging stop", async () => {
  const messages: unknown[] = [];
  const port = {
    onmessage: null as null | (() => void),
    postMessage: (message: unknown) => messages.push(message),
  };
  let Processor!: new () => { process(inputs: Float32Array[][]): boolean };
  vi.stubGlobal(
    "AudioWorkletProcessor",
    class {
      port = port;
    },
  );
  vi.stubGlobal("registerProcessor", (_name: string, constructor: typeof Processor) => {
    Processor = constructor;
  });
  await import("./dictation-pcm-worklet");
  const processor = new Processor();
  const input = Float32Array.from({ length: 2051 }, (_, index) => index / 4096);
  processor.process([[input.subarray(0, 1024)]]);
  expect(messages).toHaveLength(0);
  processor.process([[input.subarray(1024)]]);
  expect(messages).toEqual([input.slice(0, 2048)]);
  port.onmessage?.();
  expect(messages).toEqual([input.slice(0, 2048), input.slice(2048), "stopped"]);
  expect(processor.process([[input]])).toBe(false);
  port.onmessage?.();
  expect(messages).toHaveLength(3);
});
