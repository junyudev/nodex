import { expect, it, vi } from "vitest";
import type { GlobalDictationRendererCommand } from "../../../shared/global-dictation";
import { deliverGlobalDictation } from "./global-dictation-delivery";

function fixture() {
  const listeners = new Set<(command: GlobalDictationRendererCommand) => void>();
  const abort = new AbortController();
  const sendEvent = vi.fn(async () => true);
  const promise = deliverGlobalDictation({
    sessionId: "session",
    transcript: "text",
    signal: abort.signal,
    sendEvent,
    onCommand: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  });
  return {
    promise,
    abort,
    sendEvent,
    listeners,
    emit: (command: GlobalDictationRendererCommand) => {
      for (const listener of listeners) listener(command);
    },
  };
}

it("waits for the correlated native paste result rather than the event acknowledgement", async () => {
  const state = fixture();
  const settled = vi.fn();
  void state.promise.then(settled);
  await Promise.resolve();
  expect(state.sendEvent).toHaveBeenCalledOnce();
  expect(settled).not.toHaveBeenCalled();
  state.emit({ type: "paste-completed", sessionId: "other", clipboardRestoreMs: 700 });
  await Promise.resolve();
  expect(settled).not.toHaveBeenCalled();
  state.emit({ type: "paste-completed", sessionId: "session", clipboardRestoreMs: 713 });
  await expect(state.promise).resolves.toEqual({ clipboardRestoreMs: 713 });
  expect(state.listeners.size).toBe(0);
});

it("releases the listener on cancellation and does not accept late paste results", async () => {
  const state = fixture();
  state.abort.abort(new DOMException("Cancelled", "AbortError"));
  await expect(state.promise).rejects.toMatchObject({ name: "AbortError" });
  expect(state.listeners.size).toBe(0);
  state.emit({ type: "paste-completed", sessionId: "session", clipboardRestoreMs: 700 });
});

it("cancels a pending paste when the global bar returns to idle without a paste receipt", async () => {
  const state = fixture();
  state.emit({ type: "idle", configuredHotkey: "Fn", configuredToggleHotkey: null });
  await expect(state.promise).rejects.toMatchObject({ name: "AbortError" });
  expect(state.listeners.size).toBe(0);
});
