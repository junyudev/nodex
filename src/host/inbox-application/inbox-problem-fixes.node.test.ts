import { createBoundedOperationId } from "../../shared/operation-identity";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { make } from "./InboxApplication";
import { StoreAdministration } from "../../main/core-runtime/StoreAdministration";
import { routingFixture } from "./coordinator-inbox.test-support";
it.effect("re-arms only the problem named by a validated person retry", () =>
  Effect.gen(function* () {
    const f = yield* routingFixture();
    const inbox = yield* make.pipe(
      Effect.provide(f.services),
      Effect.provideService(StoreAdministration, { requestErasure: Effect.void } as never),
    );
    const invalid = yield* inbox
      .retryProblem({ problemId: "", operationId: createBoundedOperationId("test.retry-invalid") })
      .pipe(Effect.result);
    assert.equal(invalid._tag, "Failure");
    assert.isEmpty(f.commands);
    yield* inbox.retryProblem({
      problemId: "problem:delivery",
      operationId: createBoundedOperationId("test.retry-valid"),
    });
    assert.deepEqual(f.commands[0]?.intent, {
      kind: "source",
      command: { kind: "retry_problem", problem_id: "problem:delivery" },
    });
  }),
);
