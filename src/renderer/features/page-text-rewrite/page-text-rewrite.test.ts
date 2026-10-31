import { expect, it } from "vite-plus/test";
import type {
  PageTextRewriteEvent,
  PageTextRewriteStart,
  PageTextRewriteStartResult,
} from "../../../shared/page-text-rewrite";
import { createPageTextRewrite } from "./page-text-rewrite";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
};
const setup = () => {
  const listeners = new Set<(event: PageTextRewriteEvent) => void>();
  const requests: PageTextRewriteStart[] = [];
  const cancellations: string[] = [];
  const admission = deferred<PageTextRewriteStartResult>();
  const owner = createPageTextRewrite({
    start: (input) => {
      requests.push(input);
      return admission.promise;
    },
    cancel: async (id) => {
      cancellations.push(id);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  });
  const emit = (event: PageTextRewriteEvent) => {
    for (const listener of listeners) listener(event);
  };
  return { owner, admission, requests, cancellations, listeners, emit };
};
const input = { markdown: "Selected text", instruction: "Make concise" };

it("subscribes before admission so immediate output cannot be lost", async () => {
  const fixture = setup();
  const handle = fixture.owner.start(input);
  fixture.emit({ requestId: "unrelated", kind: "done", markdown: "Wrong" });
  fixture.emit({ requestId: handle.requestId, kind: "done", markdown: "Short" });
  fixture.admission.resolve({ ok: true });
  expect(await handle.result).toMatchObject({ kind: "done", markdown: "Short" });
  expect(fixture.listeners.size).toBe(0);
  await handle.cancel();
  expect(fixture.cancellations).toEqual([]);
});

it("settles discard immediately, waits for admission to cancel, and ignores late completion", async () => {
  const fixture = setup();
  const handle = fixture.owner.start(input);
  const cancellation = handle.cancel();
  expect(await handle.result).toEqual({ kind: "cancelled" });
  expect(fixture.listeners.size).toBe(0);
  expect(fixture.cancellations).toEqual([]);
  fixture.emit({ requestId: handle.requestId, kind: "done", markdown: "Late" });
  fixture.admission.resolve({ ok: true });
  await cancellation;
  await handle.cancel();
  expect(fixture.cancellations).toEqual([handle.requestId]);
  expect(await handle.result).toEqual({ kind: "cancelled" });
});

it("keeps retries independent and cleans rejected admission subscriptions", async () => {
  const fixture = setup();
  const first = fixture.owner.start(input);
  const cancelled = first.cancel();
  const second = fixture.owner.start(input);
  expect(second.requestId).not.toBe(first.requestId);
  fixture.admission.resolve({ ok: true });
  await cancelled;
  fixture.emit({ requestId: first.requestId, kind: "done", markdown: "Old" });
  fixture.emit({
    requestId: second.requestId,
    kind: "error",
    error: { code: "unavailable", message: "Connect an Agent" },
  });
  expect(await second.result).toMatchObject({ kind: "error", error: { code: "unavailable" } });
  expect(fixture.listeners.size).toBe(0);
  const rejected = setup();
  const handle = rejected.owner.start(input);
  rejected.admission.resolve({
    ok: false,
    error: { code: "invalid_input", message: "Select text" },
  });
  expect(await handle.result).toEqual({
    kind: "error",
    error: { code: "invalid_input", message: "Select text" },
  });
  expect(rejected.listeners.size).toBe(0);
});
