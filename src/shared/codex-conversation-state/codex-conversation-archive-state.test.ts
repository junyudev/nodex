import { expect, test } from "vite-plus/test";
import { CanonicalConversationArchiveState } from "./codex-conversation-archive-state";

function fixture() {
  const archive = new CanonicalConversationArchiveState();
  let resident = false;
  let ordinary = false;
  let suppressions = 0;
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  const callbacks = {
    hasOrdinaryState: () => ordinary,
    hasConversation: () => resident,
    hasPreviewHistory: () => false,
    onSuppressed: () => { suppressions += 1; },
    hydrate: async (isCurrent: () => boolean) => { await gate; if (isCurrent()) resident = true; },
  };
  return { archive, callbacks, resume, setOrdinary: () => { ordinary = true; }, resident: () => resident, suppressions: () => suppressions };
}

test("ordinary and explicitly unarchived threads never begin archived preview hydration", async () => {
  const f = fixture();
  f.setOrdinary();
  expect(await f.archive.hydratePreview("thread", f.callbacks)).toBe(false);
  f.archive.unsuppress("other");
  expect(await f.archive.hydratePreview("other", { ...f.callbacks, hasOrdinaryState: () => false })).toBe(false);
  expect(f.suppressions()).toBe(0);
});

test("repeated archive suppression retires an outstanding preview even though visibility stays archived", async () => {
  const f = fixture();
  const pending = f.archive.hydratePreview("thread", f.callbacks);
  expect(f.archive.isSuppressed("thread")).toBe(true);
  expect(f.archive.suppress("thread")).toBe(false);
  f.resume();
  expect(await pending).toBe(false);
  expect(f.resident()).toBe(false);
  expect(f.archive.suppressedIds()).toEqual(["thread"]);
});

test("unarchive retires outstanding preview and keeps an explicit unsuppressed marker", async () => {
  const f = fixture();
  const pending = f.archive.hydratePreview("thread", f.callbacks);
  f.archive.unsuppress("thread");
  f.resume();
  expect(await pending).toBe(false);
  expect(f.archive.suppressedIds()).toEqual([]);
  expect(await f.archive.hydratePreview("thread", f.callbacks)).toBe(false);
});

test("current preview succeeds after hydration and reuses already loaded preview history", async () => {
  const f = fixture();
  const pending = f.archive.hydratePreview("thread", f.callbacks);
  f.resume();
  expect(await pending).toBe(true);
  expect(f.suppressions()).toBe(1);
  expect(await f.archive.hydratePreview("thread", { ...f.callbacks, hasPreviewHistory: () => true, hydrate: () => { throw new Error("Must reuse history"); } })).toBe(true);
});

test("current hydration with no resulting conversation reports the archived task failure", async () => {
  const f = fixture();
  await expect(f.archive.hydratePreview("thread", { ...f.callbacks, hydrate: async () => {} })).rejects.toThrow("Could not load archived task");
});
