import { expect, test } from "vite-plus/test";
import type { PersistedAtomTransport } from "@/lib/persisted-atom-store";
import type {
  PersistedAtomEvent,
  PersistedAtomMutation,
  PersistedAtomSnapshot,
} from "../../../shared/ipc-api";
import { createQuestionDraftStore } from "./question-draft-store";

function storage(initial: PersistedAtomSnapshot = { revision: 0, values: {} }) {
  let snapshot = initial;
  const listeners = new Set<(event: PersistedAtomEvent) => void>();
  const transport: PersistedAtomTransport = {
    readSnapshot: async () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    mutate: async (mutation: PersistedAtomMutation) => {
      const event = { ...mutation, revision: snapshot.revision + 1, originRendererId: "test" };
      const values = { ...snapshot.values };
      if (mutation.value === undefined) delete values[mutation.key];
      else values[mutation.key] = mutation.value;
      snapshot = { revision: event.revision, values };
      for (const listener of listeners) listener(event);
      return event;
    },
  };
  return { transport, snapshot: () => snapshot };
}

test("restores independent request drafts in a new viewer and synchronizes edits", async () => {
  const backing = storage();
  const first = createQuestionDraftStore(backing.transport);
  first.write("request-a", "shape-a", { answer: "Alpha" });
  first.write("request-b", "shape-b", { answer: "Beta" });
  const second = createQuestionDraftStore(backing.transport);
  const observed: unknown[] = [];
  const stop = second.watch("request-a", () => observed.push(second.read("request-a", "shape-a")));
  await Promise.resolve();
  expect(second.read("request-a", "shape-a")).toEqual({ answer: "Alpha" });
  expect(second.read("request-b", "shape-b")).toEqual({ answer: "Beta" });
  expect(second.read("request-a", "replacement-shape")).toBeUndefined();
  first.write("request-a", "shape-a", { answer: "Revised" });
  expect(observed.at(-1)).toEqual({ answer: "Revised" });
  first.remove("request-a");
  expect(second.read("request-a", "shape-a")).toBeUndefined();
  expect(second.read("request-b", "shape-b")).toEqual({ answer: "Beta" });
  stop();
});

test("late hydration cannot replace a newer authored draft", async () => {
  const backing = storage();
  let complete: (snapshot: PersistedAtomSnapshot) => void = () => {};
  const draft = createQuestionDraftStore({
    ...backing.transport,
    readSnapshot: () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  });
  draft.read("request", "shape");
  draft.write("request", "shape", { answer: "Newer" });
  complete({
    revision: 0,
    values: {
      "conversation-question-draft-v1:request": {
        version: 1,
        signature: "shape",
        value: { answer: "Older" },
      },
    },
  });
  await Promise.resolve();
  expect(draft.read("request", "shape")).toEqual({ answer: "Newer" });
});

test("flush waits for durable acknowledgement and reports a retained write failure", async () => {
  const backing = storage();
  let finish: (() => void) | undefined;
  let fail = false;
  const errors: unknown[] = [];
  const drafts = createQuestionDraftStore(
    {
      ...backing.transport,
      mutate: async (mutation) => {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        if (fail) throw new Error("Storage unavailable");
        return backing.transport.mutate(mutation);
      },
    },
    { onError: (error) => errors.push(error) },
  );
  drafts.write("a", "shape", { answer: "Retain me" });
  let flushed = false;
  const pending = drafts.flush().then(() => {
    flushed = true;
  });
  await Promise.resolve();
  expect(flushed).toBe(false);
  finish?.();
  await pending;
  expect(flushed).toBe(true);
  fail = true;
  drafts.write("a", "shape", { answer: "New draft" });
  finish?.();
  await expect(drafts.flush()).rejects.toThrow("Could not save question drafts");
  expect(errors).toHaveLength(1);
  expect(drafts.read("a", "shape")).toEqual({ answer: "New draft" });
});

test("older local acknowledgements cannot rewind an in-flight edit while foreign updates still apply", async () => {
  const listeners = new Set<(event: PersistedAtomEvent) => void>();
  const requests: {
    mutation: PersistedAtomMutation;
    finish: (event: PersistedAtomEvent) => void;
  }[] = [];
  let revision = 0;
  const drafts = createQuestionDraftStore({
    readSnapshot: async () => ({ revision: 0, values: {} }),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    mutate: (mutation) => new Promise((finish) => requests.push({ mutation, finish })),
  });
  const publish = (mutation: PersistedAtomMutation) => {
    const event = { ...mutation, revision: ++revision, originRendererId: "window" };
    for (const listener of listeners) listener(event);
    return event;
  };
  const acknowledge = (index: number) => {
    const request = requests[index]!;
    request.finish(publish(request.mutation));
  };
  drafts.write("a", "shape", "A");
  drafts.write("a", "shape", "AB");
  acknowledge(0);
  expect(drafts.read("a", "shape")).toBe("AB");
  drafts.write("a", "shape", "ABC");
  acknowledge(1);
  expect(drafts.read("a", "shape")).toBe("ABC");
  acknowledge(2);
  await drafts.flush();
  expect(drafts.read("a", "shape")).toBe("ABC");
  publish({
    key: "conversation-question-draft-v1:a",
    value: { version: 1, signature: "shape", value: "Other window" },
    mutationId: "foreign-mutation",
  });
  expect(drafts.read("a", "shape")).toBe("Other window");
});
