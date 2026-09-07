import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { createFakeCoreHandshake, FakeCoreClient } from "../core-client/testing/fake-core-client";
import type { CoreGenerationClient } from "../core-client/core-generation-client";
import type { LibraryReadSnapshot } from "../core-client/types";
import { CoreAuthority, CoreSessionAccess } from "../core-runtime/CoreAuthority";
import { LibraryModule, live } from "./LibraryModule";

const identity = {
  profileId: "profile:test",
  libraryId: "library:test",
  storeEpoch: "epoch:test",
} as const;

const metadata = (commitHead: number): LibraryReadSnapshot => ({
  contract_version: 6,
  commit_head: commitHead,
  store_epoch: identity.storeEpoch,
  value: {
    commit_seq: commitHead,
    kind: "metadata",
    library_id: identity.libraryId,
    profile_id: identity.profileId,
  },
});

it.effect("routes Library reads through the exact durable access boundary", () =>
  Effect.gen(function* () {
    const client = new FakeCoreClient();
    client.enqueueRead(metadata(1));
    client.enqueueRead(metadata(2));
    const projectScopes: Array<string | null | undefined> = [];
    const handshake = createFakeCoreHandshake(identity);
    const generationClient = Object.assign(client, {
      handshake,
      forProject: () => generationClient,
      health: () =>
        Promise.resolve({
          pid: 1,
          start_nonce: handshake.generation.start_nonce,
          status: "ready" as const,
        }),
      shutdown: () => Promise.resolve({ status: "draining" as const }),
    }) as unknown as CoreGenerationClient;
    const sessionAccess = CoreSessionAccess.of({
      use: (_operation, run, options) =>
        Effect.promise((signal) => {
          projectScopes.push(options?.projectId);
          return run(generationClient, signal);
        }),
      handshake: Effect.succeed(createFakeCoreHandshake(identity)),
    });
    const authority = CoreAuthority.of({
      identity,
    } as CoreAuthority["Service"]);
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(
      live.pipe(
        Layer.provide(
          Layer.merge(
            Layer.succeed(CoreAuthority, authority),
            Layer.succeed(CoreSessionAccess, sessionAccess),
          ),
        ),
      ),
      scope,
    );
    const library = Context.get(context, LibraryModule);

    const project = yield* library.read(
      { kind: "project", projectId: "project:test" },
      { read: { mode: "metadata" } },
    );
    const libraryWide = yield* library.read({ kind: "library" }, { read: { mode: "metadata" } });

    assert.deepEqual(projectScopes, ["project:test", undefined]);
    assert.deepEqual(project, {
      ok: true,
      value: {
        profileId: identity.profileId,
        libraryId: identity.libraryId,
        storeEpoch: identity.storeEpoch,
        commitSeq: 1,
        authorization: null,
        value: { kind: "metadata" },
      },
    });
    assert.isTrue(libraryWide.ok);
    if (libraryWide.ok) assert.strictEqual(libraryWide.value.commitSeq, 2);

    yield* Scope.close(scope, Exit.void);
  }),
);
