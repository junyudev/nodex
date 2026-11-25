import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { makeAcpSessionTraversals } from "./AcpSessionTraversals.ts";

it.effect("limits a traversal to 100 issued cursors", () =>
  Effect.gen(function* () {
    const traversals = makeAcpSessionTraversals();
    const source = {};
    const query = { instanceId: "first", cwd: "/workspace" };
    let page = yield* traversals.begin(query, source);
    for (let index = 1; index <= 100; index++) {
      const cursor = String(index);
      (yield* page.prepareCommit(cursor))();
      page = yield* traversals.begin({ ...query, cursor }, source);
    }

    expect(yield* page.prepareCommit("101").pipe(Effect.flip)).toMatchObject({
      reason: "invalid_request",
      message: "The Agent session listing exceeded its page budget.",
    });
    (yield* page.prepareCommit(null))();
  }),
);

it.effect("evicts the oldest retained query once 64 directory scopes are occupied", () =>
  Effect.gen(function* () {
    const traversals = makeAcpSessionTraversals();
    const source = {};
    const query = { instanceId: "first", cwd: "/workspace" };
    const first = yield* traversals.begin(query, source);
    (yield* first.prepareCommit("A"))();
    for (let index = 1; index <= 64; index++) {
      const page = yield* traversals.begin({ ...query, cwd: `/workspace-${index}` }, source);
      (yield* page.prepareCommit("A"))();
    }

    expect(
      yield* traversals.begin({ ...query, cursor: "A" }, source).pipe(Effect.flip),
    ).toMatchObject({ reason: "invalid_request" });
    const retained = yield* traversals.begin(
      { ...query, cwd: "/workspace-64", cursor: "A" },
      source,
    );
    (yield* retained.prepareCommit(null))();
  }),
);
