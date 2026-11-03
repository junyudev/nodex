import { act } from "@testing-library/react";
import { expect, test, vi } from "vite-plus/test";
import { render } from "../../test/dom";
import { useInboxClock } from "./use-inbox-clock";

function Day() {
  return <time>{new Date(useInboxClock()).toLocaleDateString()}</time>;
}

test("day labels advance when the Inbox stays open across midnight and release their timer", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 10, 3, 23, 59, 30));
  const view = render(<Day />);
  try {
    expect(view.getByText(new Date(2026, 10, 3).toLocaleDateString())).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(view.getByText(new Date(2026, 10, 4).toLocaleDateString())).toBeTruthy();
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    view.unmount();
    vi.useRealTimers();
  }
});
