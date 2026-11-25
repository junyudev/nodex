import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import {
  invocation,
  routingFixture,
} from "../../host/inbox-application/routing-decisions.test-support";

it.effect("forwards the bound request and generation when answering an Inbox question", () =>
  Effect.gen(function* () {
    const f = yield* routingFixture();
    const admitted = yield* Deferred.make<void>();
    f.setOnSend(() => Deferred.succeed(admitted, undefined));
    yield* (yield* f.worker).trigger;
    yield* Deferred.await(admitted);
    const unavailable = yield* f.tool(
      invocation(
        { questionPageId: "page:one", body: "One", requestId: "another" },
        "answer_inbox_question",
      ),
    );
    assert.isTrue(unavailable.isError);
    const answer = yield* f.tool(
      invocation({ questionPageId: "page:one", body: "One" }, "answer_inbox_question"),
    );
    assert.isTrue(answer.structuredContent?.recorded);
    assert.deepNestedInclude(f.commands[0]?.intent, {
      "intent.request_id": "request:one",
      "intent.generation": 1,
      "intent.question_page_id": "page:one",
    });
  }),
);
