/* oxlint-disable effecttsgo/strict-effect-provide -- Isolated tests provide the complete Profile repository graph. */
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { CodexVisualizationStateIdentity } from "../../shared/codex-visualization-state";
import { codexVisualizationStateAtomKey } from "../../shared/codex-visualization-state";
import { ProfilePersistedAtoms } from "../local-store/ProfilePersistedAtoms";
import { PersistedAtomStore } from "../local-store/persisted-atoms";
import { codexClientThreadIdentityAtomKey } from "../codex/codex-client-thread-identity";
import { make as makeDescriptions } from "./CodexThreadDescriptionPersistence";
import { CodexVisualizationState, live } from "./CodexVisualizationState";

const identity = { hostId: "local", threadId: "display", path: "/plot.html" };
const withStore = <E extends Error>(
  run: (store: PersistedAtomStore, file: string) => Effect.Effect<void, E, CodexVisualizationState>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), "nodex-widget-state-"))),
    (directory) => {
      const file = join(directory, "atoms.json");
      const store = new PersistedAtomStore(file);
      return run(store, file).pipe(
        Effect.provide(live.pipe(Layer.provide(Layer.succeed(ProfilePersistedAtoms, store)))),
      );
    },
    (directory) => Effect.sync(() => rmSync(directory, { recursive: true, force: true })),
  );
const write = (
  owner: CodexVisualizationState["Service"],
  target: CodexVisualizationStateIdentity,
  count: number,
) =>
  owner.write({ identity: target, state: { count }, mutationId: `write-${count}` }, "renderer-one");

it.effect(
  "isolates display host/Thread/file and reloads confirmed state with a fresh Main owner",
  () =>
    withStore((_store, file) =>
      Effect.gen(function* () {
        const owner = yield* CodexVisualizationState;
        assert.strictEqual(yield* owner.read(identity), null);
        const targets = [
          identity,
          { ...identity, hostId: "ssh" },
          { ...identity, threadId: "other" },
          { ...identity, path: "/second.html" },
        ];
        for (const [index, target] of targets.entries()) yield* write(owner, target, index);
        for (const [index, target] of targets.entries())
          assert.deepEqual(yield* owner.read(target), {
            modelContent: null,
            privateContent: null,
            count: index,
          });
        const replacement = live.pipe(
          Layer.provide(Layer.succeed(ProfilePersistedAtoms, new PersistedAtomStore(file))),
        );
        assert.deepEqual(
          yield* Effect.flatMap(CodexVisualizationState, (next) => next.read(identity)).pipe(
            Effect.provide(replacement),
          ),
          { modelContent: null, privateContent: null, count: 0 },
        );
      }),
    ),
);

it.effect(
  "merges interleaved widget, client identity, and renderer atom writes in one cache and revision",
  () =>
    withStore((store) =>
      Effect.gen(function* () {
        const owner = yield* CodexVisualizationState;
        yield* write(owner, identity, 1);
        store.update({
          key: codexClientThreadIdentityAtomKey("local", "native"),
          value: "client-alias",
        });
        yield* makeDescriptions(store).set({ threadId: "native", description: "Readable title" });
        store.commitMutation(
          { key: "draft", value: "Authored draft", mutationId: "renderer-draft" },
          "renderer-two",
        );
        const last = yield* write(owner, { ...identity, path: "/second.html" }, 2);
        assert.isTrue(last.result.ok);
        assert.strictEqual(store.readSnapshot().revision, 5);
        assert.strictEqual(store.readState().draft, "Authored draft");
        assert.strictEqual(
          store.readState()[codexClientThreadIdentityAtomKey("local", "native")],
          "client-alias",
        );
        assert.deepEqual(yield* owner.read(identity), {
          modelContent: null,
          privateContent: null,
          count: 1,
        });
        assert.deepEqual(yield* makeDescriptions(store).get("native"), "Readable title");
      }),
    ),
);

it.effect(
  "keeps the last 100 updated file identities per host/Thread without making reads touch order",
  () =>
    withStore((store) =>
      Effect.gen(function* () {
        const owner = yield* CodexVisualizationState;
        for (let count = 0; count < 100; count++)
          yield* write(owner, { ...identity, path: `/file-${count}.html` }, count);
        const first = { ...identity, path: "/file-0.html" };
        const second = { ...identity, path: "/file-1.html" };
        yield* owner.read(second);
        yield* write(owner, first, 200);
        yield* write(owner, { ...identity, path: "/file-100.html" }, 100);
        assert.strictEqual(yield* owner.read(second), null);
        assert.deepEqual(yield* owner.read(first), {
          modelContent: null,
          privateContent: null,
          count: 200,
        });
        assert.strictEqual(
          Object.keys(store.readState()[codexVisualizationStateAtomKey(identity)] as object).length,
          100,
        );
        const other = { ...identity, threadId: "other" };
        yield* write(owner, other, 300);
        assert.deepEqual(yield* owner.read(other), {
          modelContent: null,
          privateContent: null,
          count: 300,
        });
      }),
    ),
);

it.effect(
  "ignores malformed recovered entries and never acknowledges a failed or invalid write",
  () =>
    withStore((store, file) =>
      Effect.gen(function* () {
        const owner = yield* CodexVisualizationState;
        store.update({
          key: codexVisualizationStateAtomKey(identity),
          value: {
            "/plot.html": { ...identity, threadId: "forged", state: { count: 3 } },
            "/second.html": { ...identity, path: "/third.html", state: {} },
          },
        });
        assert.strictEqual(yield* owner.read(identity), null);
        assert.strictEqual(yield* owner.read({ ...identity, path: "/second.html" }), null);
        const before = store.readSnapshot();
        const invalid = yield* owner.write(
          { identity, state: { imageIds: ["image"] }, mutationId: "invalid" },
          "renderer",
        );
        assert.deepEqual(invalid, {
          event: null,
          result: { ok: false, code: "images_unsupported", retryable: false },
        });
        rmSync(file);
        // A directory at the atomic destination makes rename fail after writing the temp file.
        mkdirSync(file);
        const failed = yield* write(owner, identity, 9);
        assert.deepEqual(failed, {
          event: null,
          result: { ok: false, code: "storage_unavailable", retryable: false },
        });
        assert.deepEqual(store.readSnapshot(), before);
      }),
    ),
);
