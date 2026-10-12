/* oxlint-disable effecttsgo/strict-effect-provide -- Test owns the complete temporary Profile layer. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { assert, it } from "@effect/vitest";
import { testLayer } from "../app/MainConfig";
import { ProfilePersistedAtoms, live } from "./ProfilePersistedAtoms";

it.effect(
  "one Profile acquisition shares ordered durable atom state and a replacement starts a fresh revision",
  () =>
    Effect.acquireUseRelease(
      Effect.sync(() => mkdtempSync(join(tmpdir(), "nodex-atom-owner-"))),
      (nodexHome) => {
        const profile = live.pipe(Layer.provide(testLayer({ nodexHome })));
        return Effect.gen(function* () {
          const first = yield* ProfilePersistedAtoms;
          first.commitMutation({ key: "draft", value: "first", mutationId: "draft" }, "one");
          const secondConsumer = yield* ProfilePersistedAtoms;
          secondConsumer.commitMutation(
            { key: "identity", value: "client", mutationId: "identity" },
            "two",
          );
          assert.deepEqual(first.readSnapshot(), {
            revision: 2,
            values: { draft: "first", identity: "client" },
          });
        }).pipe(
          Effect.provide(profile),
          Effect.andThen(
            Effect.gen(function* () {
              const replacement = yield* ProfilePersistedAtoms;
              assert.deepEqual(replacement.readSnapshot(), {
                revision: 0,
                values: { draft: "first", identity: "client" },
              });
            }).pipe(Effect.provide(profile)),
          ),
        );
      },
      (nodexHome) => Effect.sync(() => rmSync(nodexHome, { recursive: true, force: true })),
    ),
);
