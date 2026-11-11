import { renderHook } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import { useReconnectWhenShown } from "./use-reconnect-when-shown";

type Input = Parameters<typeof useReconnectWhenShown>[0];

function setup(initial: Partial<Input>) {
  const reconnect = vi.fn(async () => {});
  const base: Input = {
    threadId: "thread",
    shown: true,
    canConnect: true,
    connectionFailed: true,
    reconnect,
  };
  const hook = renderHook((props: Partial<Input>) => useReconnectWhenShown({ ...base, ...props }), {
    initialProps: initial,
  });
  return { reconnect, rerender: hook.rerender };
}

describe("useReconnectWhenShown", () => {
  test("retries a failed connection when the chat is shown", () => {
    const { reconnect } = setup({});
    expect(reconnect).toHaveBeenCalledExactlyOnceWith("thread");
  });

  test("does not retry a failure that happens while the chat stays shown", () => {
    const { reconnect, rerender } = setup({ connectionFailed: false });
    rerender({ connectionFailed: true });
    expect(reconnect).not.toHaveBeenCalled();
  });

  test("retries again each time the chat is shown anew", () => {
    const { reconnect, rerender } = setup({});
    rerender({ shown: false });
    rerender({ shown: true });
    expect(reconnect).toHaveBeenCalledTimes(2);
  });

  test("waits until the chat can connect", () => {
    const { reconnect, rerender } = setup({ canConnect: false });
    expect(reconnect).not.toHaveBeenCalled();
    rerender({ canConnect: true });
    expect(reconnect).toHaveBeenCalledExactlyOnceWith("thread");
  });

  test("treats another chat in the same view as a new showing", () => {
    const { reconnect, rerender } = setup({});
    rerender({ threadId: "other" });
    expect(reconnect).toHaveBeenLastCalledWith("other");
    expect(reconnect).toHaveBeenCalledTimes(2);
  });
});
