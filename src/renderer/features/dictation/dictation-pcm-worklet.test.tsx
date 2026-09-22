import { afterEach, beforeEach, expect, it, vi } from "vitest";

const createProcessor = async () => {
  const messages: unknown[] = [];
  const port = {
    onmessage: null as null | ((event: { data: unknown }) => void),
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
  return {
    processor: new Processor(),
    messages,
    send: (data: unknown) => port.onmessage?.({ data }),
  };
};
beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

it("batches 2048 samples and flushes the partial tail before acknowledging stop", async () => {
  const { processor, messages, send } = await createProcessor();
  const input = Float32Array.from({ length: 2051 }, (_, index) => index / 4096);
  processor.process([[input.subarray(0, 1024)]]);
  expect(messages).toHaveLength(0);
  processor.process([[input.subarray(1024)]]);
  expect(messages).toEqual([input.slice(0, 2048)]);
  send("stop");
  expect(messages).toEqual([input.slice(0, 2048), input.slice(2048), "stopped"]);
  expect(processor.process([[input]])).toBe(false);
  send("stop");
  expect(messages).toHaveLength(3);
});

it("flushes each exact PCM boundary, acknowledges empty boundaries, and continues capture", async () => {
  const { processor, messages, send } = await createProcessor();
  const first = Float32Array.of(0.1, -0.1);
  const second = Float32Array.of(0.2, -0.2, 0.3);
  processor.process([[first]]);
  send({ boundary: 1 });
  send({ boundary: 2 });
  expect(processor.process([[second]])).toBe(true);
  send("stop");
  expect(messages).toEqual([first, { boundary: 1 }, { boundary: 2 }, second, "stopped"]);
  send({ boundary: 3 });
  expect(messages).toHaveLength(5);
});
