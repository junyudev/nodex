import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { makePersistedAtomStore } from "../local-store/persisted-atoms";
import { CODEX_THREAD_DESCRIPTIONS_ATOM_KEY, make } from "./CodexThreadDescriptionPersistence";

it.effect("persists and reloads bounded thread descriptions from the shared atom store", () => {
  const root = mkdtempSync(join(tmpdir(), "nodex-thread-descriptions-"));
  return Effect.acquireUseRelease(
    Effect.sync(() => make(makePersistedAtomStore(root))),
    (descriptions) =>
      Effect.gen(function* () {
        yield* descriptions.set({ threadId: "thread-a", description: "  Search summary  " });
        yield* descriptions.set({ threadId: "thread-b", description: "Second summary" });
        yield* descriptions.set({ threadId: "thread-long", description: "x".repeat(140) });

        assert.strictEqual(yield* descriptions.get("thread-a"), "Search summary");
        assert.strictEqual(yield* descriptions.get("thread-b"), "Second summary");
        assert.strictEqual(yield* descriptions.get("thread-long"), "x".repeat(100));

        const reloaded = make(makePersistedAtomStore(root));
        assert.strictEqual(yield* reloaded.get("thread-a"), "Search summary");

        makePersistedAtomStore(root).update({
          key: CODEX_THREAD_DESCRIPTIONS_ATOM_KEY,
          value: { "thread-a": "Search summary", invalid: 42, " ": "ignored" },
        });
        assert.strictEqual(yield* reloaded.get("invalid"), null);
      }),
    () => Effect.sync(() => rmSync(root, { recursive: true, force: true })),
  );
});
