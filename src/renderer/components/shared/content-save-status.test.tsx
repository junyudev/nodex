import { act, render } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { ContentSaveStatus } from "./content-save-status";

afterEach(() => vi.useRealTimers());

test("delays each new save and clears the elapsed delay when idle", async () => {
  vi.useFakeTimers();
  let pending = 1;
  const listeners = new Set<() => void>();
  const source = {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getActivity: () => ({ pending, acknowledged: 0, unknown: 0 }),
  };
  const view = render(<ContentSaveStatus source={source} />);
  expect(view.getByRole("status").textContent).toBe("");
  await act(async () => vi.advanceTimersByTime(1000));
  expect(view.getByRole("status").textContent).toBe("Saving…");
  await act(async () => {
    pending = 0;
    listeners.forEach((listener) => listener());
  });
  await act(async () => {
    pending = 1;
    listeners.forEach((listener) => listener());
  });
  expect(view.getByRole("status").textContent).toBe("");
  await act(async () => vi.advanceTimersByTime(999));
  expect(view.getByRole("status").textContent).toBe("");
  view.unmount();
  expect(listeners.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});
