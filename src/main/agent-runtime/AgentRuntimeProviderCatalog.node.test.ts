import { join } from "node:path";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { make } from "./AgentRuntimeProviderCatalog";

const providers = [
  { instanceId: "codex", driver: "codex", models: [{ slug: "model-a", name: "Model A" }] },
] as unknown as AgentRuntimeOperations["providers.read"]["output"];

it.effect("a stopped engine serves the catalog it last served under the same declaration", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = join(yield* fs.makeTempDirectoryScoped({ prefix: "nodex-catalog-" }), "engine");
    const declared = { identity: "declared", running: false };
    const open = make({
      home,
      identity: Effect.sync(() => declared.identity),
      running: Effect.sync(() => declared.running),
    });
    const first = yield* open;
    // A Profile that never ran execution has nothing to serve.
    assert.isNull(yield* first.lastKnown);
    yield* first.record(providers);
    assert.deepEqual(yield* first.lastKnown, providers);
    // The next launch serves the same rows from disk.
    const relaunched = yield* open;
    assert.deepEqual(yield* relaunched.lastKnown, providers);
    // A running engine answers live, though observers that must not reach it keep the copy.
    declared.running = true;
    assert.isNull(yield* relaunched.lastKnown);
    assert.deepEqual(yield* relaunched.saved, providers);
    declared.running = false;
    // A changed engine build or provider declaration needs a live read.
    declared.identity = "changed";
    assert.isNull(yield* relaunched.lastKnown);
    assert.isNull(yield* relaunched.saved);
    assert.isNull(yield* (yield* open).lastKnown);
    // A damaged snapshot never reaches a picker.
    yield* fs.writeFileString(join(home, "provider-catalog.json"), "{not a catalog");
    assert.isNull(yield* (yield* open).lastKnown);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
