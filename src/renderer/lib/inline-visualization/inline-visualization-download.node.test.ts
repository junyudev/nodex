import { expect, test, vi } from "vite-plus/test";
import { createVisualizationDownloadHandler } from "./inline-visualization-download";

test("checks the attempt capability before consuming a single native gesture", async () => {
  let available = true;
  const consumeGesture = vi.fn(async () => {
    const grant = available;
    available = false;
    return grant;
  });
  const save = vi.fn();
  const signal = new AbortController().signal;
  const handler = createVisualizationDownloadHandler({
    capability: "attempt-a",
    signal,
    consumeGesture,
    save,
  });
  const blob = new Blob(["download bytes"], { type: "text/plain" });
  for (const invalid of [
    null,
    { blob, name: "file.txt", capability: "retired" },
    { blob: {}, name: "file.txt", capability: "attempt-a" },
    { blob, name: " ", capability: "attempt-a" },
    { blob, name: "x".repeat(256), capability: "attempt-a" },
  ])
    await expect(handler(invalid)).rejects.toThrow();
  expect(consumeGesture).not.toHaveBeenCalled();
  await handler({ blob, name: "  file.txt  ", capability: "attempt-a" });
  expect(save).toHaveBeenCalledExactlyOnceWith(blob, "file.txt");
  await expect(handler({ blob, name: "file.txt", capability: "attempt-a" })).rejects.toThrow();
  expect(save).toHaveBeenCalledTimes(1);
});

test("fences retirement before and during native gesture authorization", async () => {
  const controller = new AbortController();
  let finish: (value: boolean) => void = () => {};
  const consumeGesture = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  const save = vi.fn();
  const handler = createVisualizationDownloadHandler({
    capability: "attempt-a",
    signal: controller.signal,
    consumeGesture,
    save,
  });
  const input = { blob: new Blob(["bytes"]), name: "file.txt", capability: "attempt-a" };
  const pending = handler(input);
  controller.abort();
  finish(true);
  await expect(pending).rejects.toThrow();
  await expect(handler(input)).rejects.toThrow();
  expect(consumeGesture).toHaveBeenCalledTimes(1);
  expect(save).not.toHaveBeenCalled();
});
