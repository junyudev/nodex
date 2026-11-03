import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { useCopyFeedback } from "./use-copy-feedback";

afterEach(() => vi.useRealTimers());

test("ignores duplicate writes until the pending write and its confirmation settle", async () => {
  vi.useFakeTimers();
  let finish!: (copied: boolean) => void;
  const write = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  const view = renderHook(() => useCopyFeedback(100));
  let pending!: Promise<boolean>;
  await act(async () => {
    pending = view.result.current.copy(write);
    expect(await view.result.current.copy(write)).toBe(false);
  });
  expect(write).toHaveBeenCalledOnce();
  expect(view.result.current.copied).toBe(false);
  await act(async () => {
    finish(true);
    expect(await pending).toBe(true);
  });
  expect(view.result.current.copied).toBe(true);
  await act(async () => {
    expect(await view.result.current.copy(write)).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
  });
  expect(view.result.current.copied).toBe(false);
  const retry = vi.fn(async () => true);
  await act(async () => {
    expect(await view.result.current.copy(retry)).toBe(true);
  });
  expect(retry).toHaveBeenCalledOnce();
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

test("releases failed writes and never starts confirmation after unmount", async () => {
  vi.useFakeTimers();
  const view = renderHook(() => useCopyFeedback(100));
  await act(async () => {
    expect(
      await view.result.current.copy(async () => {
        throw new Error("denied");
      }),
    ).toBe(false);
  });
  let finish!: (copied: boolean) => void;
  let pending!: Promise<boolean>;
  await act(async () => {
    pending = view.result.current.copy(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
  });
  view.unmount();
  await act(async () => {
    finish(true);
    expect(await pending).toBe(true);
  });
  expect(vi.getTimerCount()).toBe(0);
});
