import { beforeEach, expect, test, vi } from "vite-plus/test";
import { writeReviewDiffDraftStorage } from "@/lib/review-diff-annotations";
import { createReviewDiffDraftSource } from "./review-diff-draft-source";

const patch = "@@ -1 +1 @@\n-before\n+after\n";

beforeEach(() => window.localStorage.clear());

test("hydrates each scope independently and keeps its snapshot stable between updates", () => {
  writeReviewDiffDraftStorage("first", {
    "additions:1": "Keep this draft",
    "invalid:2": "Ignore",
    "deletions:0": "Ignore",
  });
  writeReviewDiffDraftStorage("second", { "deletions:1": "Other draft" });
  const first = createReviewDiffDraftSource("first", "example.ts", patch);
  const original = first.getSnapshot();
  expect(original["additions:1"]?.text).toBe("Keep this draft");
  expect(Object.keys(original)).toEqual(["additions:1"]);
  expect(first.getSnapshot()).toBe(original);
  const second = createReviewDiffDraftSource("second", "example.ts", patch);
  expect(second.getSnapshot()["deletions:1"]?.text).toBe("Other draft");
  expect(second.getSnapshot()["additions:1"]).toBeUndefined();
});

test("publishes functional edits and releases subscriptions", () => {
  writeReviewDiffDraftStorage("scope", { "additions:1": "Draft" });
  const source = createReviewDiffDraftSource("scope", "example.ts", patch);
  const before = source.getSnapshot();
  const changed = vi.fn();
  const unsubscribe = source.subscribe(changed);
  source.update((current) => {
    const draft = current["additions:1"];
    if (!draft) throw new Error("Expected a hydrated draft");
    return { ...current, "additions:1": { ...draft, text: "Edited" } };
  });
  expect(source.getSnapshot()).not.toBe(before);
  expect(source.getSnapshot()["additions:1"]?.text).toBe("Edited");
  expect(before["additions:1"]?.text).toBe("Draft");
  expect(changed).toHaveBeenCalledTimes(1);
  source.update((current) => current);
  expect(changed).toHaveBeenCalledTimes(1);
  unsubscribe();
  source.update({});
  expect(changed).toHaveBeenCalledTimes(1);
});
