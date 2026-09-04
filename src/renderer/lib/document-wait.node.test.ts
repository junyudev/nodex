import { expect, test, vi } from "vite-plus/test";
import { DocumentWaitError, waitForDocumentOperation } from "./document-wait";

test("cancels a waiter without running its continuation after late completion", async () => {
  const controller = new AbortController();
  let complete: () => void = () => undefined;
  const durable = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const submit = vi.fn();
  const result = waitForDocumentOperation(() => durable, { signal: controller.signal })
    .then(submit)
    .catch((error) => error);
  controller.abort();
  expect(await result).toMatchObject({ reason: "cancelled" });
  complete();
  await durable;
  expect(submit).not.toHaveBeenCalled();
});

test("uses an absolute deadline and rejects before starting expired work", async () => {
  vi.useFakeTimers();
  try {
    const result = waitForDocumentOperation(() => new Promise<void>(() => undefined), {
      deadlineAt: Date.now() + 100,
    }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toMatchObject({ reason: "timeout" });
    const start = vi.fn(async () => undefined);
    await expect(
      waitForDocumentOperation(start, { deadlineAt: Date.now() - 1 }),
    ).rejects.toBeInstanceOf(DocumentWaitError);
    expect(start).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
