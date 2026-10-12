/* oxlint-disable effecttsgo/strict-effect-provide -- Isolated tests provide the complete Profile repository graph. */
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { CodexVisualizationStateIdentity } from "../../shared/codex-visualization-state";
import {
  codexVisualizationStateAtomKey,
  codexVisualizationInteractionAtomKey,
} from "../../shared/codex-visualization-state";
import type { CodexVisualizationPassiveContext } from "../../shared/codex-visualization-passive-context";
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
const payloads = (context: CodexVisualizationPassiveContext | undefined) => {
  assert.isDefined(context);
  return context!.items
    .filter((_, index) => index % 2 === 1)
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item) || !Array.isArray(item.output))
        throw new Error("Expected paired native output");
      const output = item.output[0];
      if (
        !output ||
        typeof output !== "object" ||
        Array.isArray(output) ||
        typeof output.text !== "string"
      )
        throw new Error("Expected native text output");
      return JSON.parse(output.text) as unknown;
    });
};
const interaction = (
  store: PersistedAtomStore,
  target: CodexVisualizationStateIdentity,
  selected: number,
) =>
  store.update({
    key: codexVisualizationInteractionAtomKey(target),
    value: { [target.path]: { ...target, state: { modelContent: { selected } } } },
  });

it.effect(
  "persists interaction context in the same Profile revision, leaves absent clears untouched and retains explicit clears",
  () =>
    withStore((store, file) =>
      Effect.gen(function* () {
        const owner = yield* CodexVisualizationState;
        const absent = yield* owner.writeInteraction(
          { identity, state: { modelContent: null }, mutationId: "absent-clear" },
          "renderer-one",
        );
        assert.isNull(absent.event);
        assert.strictEqual(store.readSnapshot().revision, 0);
        const context = {
          edits: [{ target: "Chart", changes: [{ label: "Radius", reference: null, value: 40 }] }],
        };
        const confirmed = yield* owner.writeInteraction(
          { identity, state: { modelContent: context }, mutationId: "interaction" },
          "renderer-one",
        );
        assert.isTrue(confirmed.result.ok);
        assert.strictEqual(confirmed.event?.revision, 1);
        const reopened = new PersistedAtomStore(file);
        assert.deepEqual(reopened.readState()[codexVisualizationInteractionAtomKey(identity)], {
          [identity.path]: { ...identity, state: { modelContent: context } },
        });
        const invalid = yield* owner.writeInteraction(
          {
            identity,
            state: { modelContent: { body: "x".repeat(32_768) } },
            mutationId: "oversized",
          },
          "renderer-one",
        );
        assert.isFalse(invalid.result.ok);
        assert.strictEqual(store.readSnapshot().revision, 1);
        const cleared = yield* owner.writeInteraction(
          { identity, state: { modelContent: null }, mutationId: "clear" },
          "renderer-two",
        );
        assert.strictEqual(cleared.event?.revision, 2);
        assert.deepEqual(store.readState()[codexVisualizationInteractionAtomKey(identity)], {
          [identity.path]: { ...identity, state: { modelContent: null } },
        });
      }),
    ),
);
it.effect(
  "failed interaction writes preserve the prior cache/revision and publish no committed event",
  () =>
    withStore((store, file) =>
      Effect.gen(function* () {
        const owner = yield* CodexVisualizationState;
        yield* owner.writeInteraction(
          { identity, state: { modelContent: { selected: 1 } }, mutationId: "first" },
          "renderer-one",
        );
        const before = store.readSnapshot();
        rmSync(file);
        mkdirSync(file);
        const result = yield* owner.writeInteraction(
          { identity, state: { modelContent: { selected: 2 } }, mutationId: "failed" },
          "renderer-one",
        );
        assert.deepEqual(result, {
          result: { ok: false, code: "storage_unavailable", retryable: false },
          event: null,
        });
        assert.deepEqual(store.readSnapshot(), before);
      }),
    ),
);

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

it.effect("collects current persisted model context without requiring a mounted widget", () =>
  withStore((store) =>
    Effect.gen(function* () {
      const owner = yield* CodexVisualizationState;
      yield* owner.write(
        {
          identity,
          state: { modelContent: { count: 1 }, privateContent: { token: "private" } },
          mutationId: "first",
        },
        "renderer-one",
      );
      interaction(store, identity, 2);
      const first = yield* owner.readPassiveContext({ hostId: "local", threadId: "display" });
      assert.deepEqual(payloads(first), [
        { path: "/plot.html", state: { count: 1 } },
        { path: "/plot.html", interaction: { selected: 2 } },
      ]);
      assert.strictEqual(
        yield* owner.readPassiveContext({ hostId: "ssh", threadId: "display" }),
        undefined,
      );
      assert.strictEqual(
        yield* owner.readPassiveContext({ hostId: "local", threadId: "other" }),
        undefined,
      );
      const deduped = yield* owner.readPassiveContext({ hostId: "local", threadId: "display" }, [
        { id: "/plot.html", untrusted: true, structuredContent: { selected: 2 } },
      ]);
      assert.deepEqual(payloads(deduped), [{ path: "/plot.html", state: { count: 1 } }]);
      assert.strictEqual(deduped?.key, first?.key);
      yield* owner.write(
        { identity, state: { modelContent: { count: 3 } }, mutationId: "next" },
        "renderer-one",
      );
      const next = yield* owner.readPassiveContext({ hostId: "local", threadId: "display" });
      assert.notStrictEqual(next?.key, first?.key);
      assert.deepEqual(payloads(next)[0], { path: "/plot.html", state: { count: 3 } });
      assert.deepEqual(payloads(first)[0], { path: "/plot.html", state: { count: 1 } });
    }),
  ),
);

it.effect("uses one Profile snapshot when another state producer commits during collection", () =>
  withStore((store) =>
    Effect.gen(function* () {
      const owner = yield* CodexVisualizationState;
      yield* owner.write(
        { identity, state: { modelContent: { count: 1 } }, mutationId: "first" },
        "renderer-one",
      );
      interaction(store, identity, 1);
      const readState = store.readState.bind(store);
      let advance = true;
      store.readState = () => {
        const snapshot = readState();
        if (advance) {
          advance = false;
          interaction(store, identity, 2);
        }
        return snapshot;
      };

      const captured = yield* owner.readPassiveContext({ hostId: "local", threadId: "display" });
      assert.deepEqual(payloads(captured), [
        { path: "/plot.html", state: { count: 1 } },
        { path: "/plot.html", interaction: { selected: 1 } },
      ]);
      const current = yield* owner.readPassiveContext({ hostId: "local", threadId: "display" });
      assert.deepEqual(payloads(current)[1], { path: "/plot.html", interaction: { selected: 2 } });
      assert.notStrictEqual(captured?.key, current?.key);
    }),
  ),
);

it.effect("treats a failed Profile read as optional context absence", () =>
  withStore((store) =>
    Effect.gen(function* () {
      const owner = yield* CodexVisualizationState;
      interaction(store, identity, 1);
      store.readState = () => {
        throw new Error("Profile unavailable");
      };
      assert.strictEqual(
        yield* owner.readPassiveContext({ hostId: "local", threadId: "display" }),
        undefined,
      );
    }),
  ),
);

it.effect(
  "clears both records for only the deleted host/Thread and leaves no atom inventory entries",
  () =>
    withStore((store, file) =>
      Effect.gen(function* () {
        const owner = yield* CodexVisualizationState;
        const otherHost = { ...identity, hostId: "ssh" };
        const otherThread = { ...identity, threadId: "other" };
        for (const target of [identity, otherHost, otherThread]) {
          yield* write(owner, target, 1);
          interaction(store, target, 2);
        }
        store.update({ key: "draft", value: "latest draft" });
        const before = store.readSnapshot();
        const scope = { hostId: "local", threadId: "display" };
        const events = yield* owner.clearThread(scope);
        assert.deepEqual(
          events.map(({ key, value, revision }) => ({ key, value, revision })),
          [
            {
              key: codexVisualizationStateAtomKey(scope),
              value: undefined,
              revision: before.revision + 1,
            },
            {
              key: codexVisualizationInteractionAtomKey(scope),
              value: undefined,
              revision: before.revision + 2,
            },
          ],
        );
        assert.strictEqual(events[0]?.mutationId, events[1]?.mutationId);
        assert.isTrue(events.every(({ originRendererId }) => originRendererId === null));
        assert.strictEqual(yield* owner.readPassiveContext(scope), undefined);
        assert.strictEqual(yield* owner.read(identity), null);
        assert.isFalse(Object.hasOwn(store.readState(), codexVisualizationStateAtomKey(scope)));
        assert.isFalse(
          Object.hasOwn(store.readState(), codexVisualizationInteractionAtomKey(scope)),
        );
        assert.deepEqual(new PersistedAtomStore(file).readState(), store.readState());
        assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), store.readState());
        assert.strictEqual(store.readState().draft, "latest draft");
        for (const target of [otherHost, otherThread]) {
          assert.deepEqual(
            payloads(
              yield* owner.readPassiveContext({ hostId: target.hostId, threadId: target.threadId }),
            ),
            [
              { path: "/plot.html", state: null },
              { path: "/plot.html", interaction: { selected: 2 } },
            ],
          );
        }
        assert.deepEqual(yield* owner.clearThread(scope), []);
        assert.strictEqual(store.readSnapshot().revision, before.revision + 2);
      }),
    ),
);

it.effect(
  "a failed clear preserves both records and does not publish successful deletion events",
  () =>
    withStore((store, file) =>
      Effect.gen(function* () {
        const owner = yield* CodexVisualizationState;
        yield* write(owner, identity, 1);
        interaction(store, identity, 2);
        const before = store.readSnapshot();
        rmSync(file);
        mkdirSync(file);
        const failure = yield* owner
          .clearThread({ hostId: "local", threadId: "display" })
          .pipe(Effect.result);
        if (failure._tag !== "Failure") throw new Error("Expected failed durable deletion");
        assert.strictEqual(failure.failure.operation, "clear-thread");
        assert.deepEqual(store.readSnapshot(), before);
        assert.deepEqual(
          payloads(yield* owner.readPassiveContext({ hostId: "local", threadId: "display" })),
          [
            { path: "/plot.html", state: null },
            { path: "/plot.html", interaction: { selected: 2 } },
          ],
        );
      }),
    ),
);
