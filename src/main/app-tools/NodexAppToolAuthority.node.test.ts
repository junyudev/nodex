import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { NodexAgentTurnContext } from "../../shared/nodex-agent-authority";
import { make } from "./NodexAppToolAuthority";
const authority: NodexAgentTurnContext = {
  threadId: "thread",
  turnId: "turn",
  rootThreadId: "thread",
  actorProjectId: "project",
  libraryId: "library",
  storeEpoch: "epoch",
  admittedAtMs: 1,
};
it.effect("binds current execution identity and rejects withdrawn execution", () =>
  Effect.gen(function* () {
    const owner = yield* make;
    const current = yield* owner.bind({ authority, isCurrent: Effect.succeed(true) });
    assert.deepEqual(current.authority, authority);
    const withdrawn = yield* owner.bind({ authority, isCurrent: Effect.succeed(false) });
    assert.isNull(withdrawn.authority);
  }),
);
