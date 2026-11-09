import { createHash } from "node:crypto";
import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { TestClock } from "effect/testing";
import { inboxRoutingIdentity } from "./inbox-suggestions";
import { INBOX_ROUTING_DEADLINE_MS, INBOX_ROUTING_HANDOVER_CAP_MS } from "./inbox-suggestions";
import {
  routingFixture,
  routingRequest,
  keepOutput,
  invocation,
} from "./coordinator-inbox.test-support";

it.effect("routes through inbox_suggest and records one complete settlement", () =>
  Effect.gen(function* () {
    const f = yield* routingFixture();
    const worker = yield* f.worker;
    yield* worker.drain;
    yield* worker.drain;
    assert.lengthOf(f.send.mock.calls, 1);
    assert.lengthOf(f.settlements, 1);
    assert.deepInclude(f.send.mock.calls[0]![0], {
      origin: "host",
      mode: "queue",
      sessionId: "nodex",
    });
    assert.equal(f.settlements[0]!.produced_by, "Codex · Model");
    assert.equal(f.settlements[0]!.suggestions[0]!.explicit_request, false);
  }),
);

it.effect("reconciles a lost admission reply across restart without redelivering", () =>
  Effect.gen(function* () {
    const f = yield* routingFixture();
    const started = yield* Deferred.make<void>();
    f.setOnSend(() =>
      Deferred.succeed(started, undefined).pipe(
        Effect.andThen(
          Effect.fail(
            new AgentRuntimeApplicationError({ operation: "send", message: "reply lost" }),
          ),
        ),
      ),
    );
    const first = yield* f.worker;
    const running = yield* first.drain.pipe(Effect.forkScoped);
    yield* Deferred.await(started);
    yield* Fiber.interrupt(running);
    const restarted = yield* f.worker;
    const again = yield* restarted.drain.pipe(Effect.forkScoped);
    yield* TestClock.adjust(1000);
    assert.lengthOf(f.send.mock.calls, 1);
    const request = f.pending.get("request:one")!;
    const result = yield* f.tool(invocation(keepOutput(request)));
    assert.deepEqual(result.structuredContent, { recorded: true });
    yield* TestClock.adjust(1000);
    yield* Fiber.join(again);
    assert.lengthOf(f.send.mock.calls, 1);
  }),
);

it.effect("records the provider's reason when a delivered routing run fails", () =>
  Effect.gen(function* () {
    const f = yield* routingFixture();
    f.setOnSend(() => Effect.sync(() => f.failRun("The requested model is unavailable")));
    yield* (yield* f.worker).drain;
    assert.lengthOf(f.send.mock.calls, 1);
    assert.lengthOf(f.settlements, 1);
    assert.equal(f.settlements[0]!.error, "The requested model is unavailable");
  }),
);

it.effect("persists the timeout failure and refuses a late tool response", () =>
  Effect.gen(function* () {
    const f = yield* routingFixture();
    f.setOnSend(() => Effect.void);
    const request = f.pending.get("request:one")!;
    const worker = yield* f.worker;
    const running = yield* worker.drain.pipe(Effect.forkScoped);
    yield* TestClock.adjust(INBOX_ROUTING_DEADLINE_MS);
    yield* Fiber.join(running);
    assert.equal(f.settlements[0]!.error, "The suggestion agent timed out");
    const late = yield* f.tool(invocation(keepOutput(request)));
    assert.equal(
      late.structuredContent?.message,
      "This request is no longer pending; nothing was recorded.",
    );
    assert.lengthOf(f.settlements, 1);
  }),
);

it.effect(
  "records a retained admission rejection without sending or waiting for the deadline",
  () =>
    Effect.gen(function* () {
      const f = yield* routingFixture();
      f.rejectAdmission("The Coordinator rejected this message");
      yield* (yield* f.worker).drain;
      assert.isEmpty(f.send.mock.calls);
      assert.lengthOf(f.settlements, 1);
      assert.equal(f.settlements[0]!.error, "The Coordinator rejected this message");
    }),
);

it.effect(
  "keeps validation errors actionable and accepts a correction within the same request",
  () =>
    Effect.gen(function* () {
      const f = yield* routingFixture();
      const responses: unknown[] = [];
      f.setOnSend(() =>
        Effect.gen(function* () {
          const request = f.pending.get("request:one")!;
          const valid = keepOutput(request);
          const malformed = yield* f.tool(invocation({ ...valid, suggestions: [] }));
          assert.isTrue(malformed.isError);
          assert.include(f.pending.get(request.request_id)!.delivery!.last_refusal!, "suggestions");
          responses.push(
            yield* f.tool(
              invocation({
                ...valid,
                suggestions: [{ ...valid.suggestions[0], page_ids: ["page:unknown"] }],
              }),
            ),
          );
          assert.isTrue(f.pending.has(request.request_id));
          assert.isEmpty(f.settlements);
          responses.push(yield* f.tool(invocation(valid, "inbox_suggest", "corrected-call")));
        }),
      );
      yield* (yield* f.worker).drain;
      assert.deepInclude(responses[0], { isError: true });
      assert.deepInclude(responses[1], { structuredContent: { recorded: true } });
    }),
);

it.effect("refuses non-Coordinator suggestion and post calls before any mutation", () =>
  Effect.gen(function* () {
    const f = yield* routingFixture();
    f.setCaller("other");
    for (const name of ["inbox_suggest", "write_turn_note"]) {
      const result = yield* f.tool(
        invocation(
          name === "inbox_suggest"
            ? keepOutput(routingRequest())
            : { pageId: "page:work", notify: false, body: "Done", eventIds: ["event"] },
          name,
        ),
      );
      assert.isTrue(result.isError);
      assert.equal((result.structuredContent?.error as { code: string }).code, "coordinator_only");
    }
    assert.isEmpty(f.commands);
    assert.isEmpty(f.settlements);
  }),
);

it.effect("uses stable note identities and stays quiet on replay", () =>
  Effect.gen(function* () {
    const f = yield* routingFixture();
    const input = invocation(
      {
        pageId: "page:work",
        notify: false,
        body: "README is ready",
        eventIds: ["report:ready"],
      },
      "write_turn_note",
    );
    const first = yield* f.tool(input);
    const replay = yield* f.tool({ ...input, caller: { ...input.caller, callId: "retry" } });
    assert.isUndefined(first.isError);
    assert.equal(first.structuredContent?.pageId, replay.structuredContent?.pageId);
    assert.isEmpty(f.posted);
    assert.equal(replay.structuredContent?.replay, true);
    assert.equal(f.commands[0]!.intent.kind, "agent_command");
  }),
);

it.effect("never redirects an uncertain request after resetting Nodex", () =>
  Effect.gen(function* () {
    const request = {
      ...routingRequest(),
      delivery: {
        coordinator_session_id: "nodex",
        run_started_at_ms: null,
        last_refusal: null,
        handed_over_at_ms: yield* Clock.currentTimeMillis,
      },
    };
    const f = yield* routingFixture([request]);
    f.reset();
    const worker = yield* f.worker;
    const running = yield* worker.drain.pipe(Effect.forkScoped);
    yield* TestClock.adjust(INBOX_ROUTING_HANDOVER_CAP_MS);
    yield* Fiber.join(running);
    assert.isEmpty(f.send.mock.calls);
    assert.equal(f.settlements[0]!.error, "The suggestion agent timed out");
  }),
);

it.effect("delivers at most three unsettled requests and then admits the next", () =>
  Effect.gen(function* () {
    const requests = ["one", "two", "three", "four"].map(routingRequest);
    const f = yield* routingFixture(requests);
    f.setOnSend(() => Effect.void);
    const worker = yield* f.worker;
    const running = yield* worker.drain.pipe(Effect.forkScoped);
    yield* TestClock.adjust(1000);
    assert.lengthOf(f.send.mock.calls, 3);
    for (const request of requests.slice(0, 3))
      yield* f.tool(invocation(keepOutput(request), "inbox_suggest", request.request_id));
    yield* TestClock.adjust(1000);
    assert.lengthOf(f.send.mock.calls, 4);
    yield* f.tool(invocation(keepOutput(requests[3]!), "inbox_suggest", "four"));
    yield* TestClock.adjust(1000);
    yield* Fiber.join(running);
    assert.notEqual(
      inboxRoutingIdentity(requests[0]!).messageId,
      inboxRoutingIdentity({ ...requests[0]!, generation: 2 }).messageId,
    );
  }),
);

it.effect(
  "delivers frozen message images in marker order and marks missing bytes unavailable",
  () =>
    Effect.gen(function* () {
      const before = new Uint8Array([137, 80, 78, 71]);
      const after = new Uint8Array([255, 216, 255]);
      const image = (id: string, bytes: Uint8Array) => ({
        source: `nodex://files/${id}`,
        file_id: id,
        content_hash: createHash("sha256").update(bytes).digest("hex"),
      });
      const initial = routingRequest();
      const request = {
        ...initial,
        context: {
          ...initial.context,
          entries: [
            {
              ...initial.context.entries[0]!,
              body: "**Before** [Image #1] [Image #2] [Image #3]",
              images: [image("before", before), image("missing", before), image("after", after)],
            },
          ],
        },
      };
      const f = yield* routingFixture([request], {
        before: { mimeType: "image/png", bytes: before },
        after: { mimeType: "image/jpeg", bytes: after },
      });
      yield* (yield* f.worker).drain;
      const message = f.send.mock.calls[0]![0].message;
      assert.deepEqual(message.images, [
        {
          source: `data:image/png;base64,${Buffer.from(before).toString("base64")}`,
          caption: "[Image #1]",
        },
        {
          source: `data:image/jpeg;base64,${Buffer.from(after).toString("base64")}`,
          caption: "[Image #3]",
        },
      ]);
      const data = JSON.parse(message.text.split("JSON data:\n")[1]!);
      assert.deepEqual(data.messages[0].attached_images, ["[Image #1]", "[Image #3]"]);
      assert.deepEqual(data.messages[0].unavailable_images, ["[Image #2]"]);
    }),
);

it.effect("settles a sixteen-message selected group as one fenced proposal", () =>
  Effect.gen(function* () {
    const initial = routingRequest();
    const entries = Array.from({ length: 16 }, (_, index) => ({
      ...initial.context.entries[0]!,
      page_id: `page:${index}`,
      basis: { page_id: `page:${index}`, content_hash: "a".repeat(64) },
    }));
    const request = {
      ...initial,
      mode: "grouped" as const,
      page_ids: entries.map((entry) => entry.page_id),
      basis: entries.map((entry) => entry.basis),
      context: { ...initial.context, entries },
    };
    const f = yield* routingFixture([request]);
    f.setOnSend(() =>
      Effect.gen(function* () {
        const output = keepOutput(request);
        yield* f.tool(
          invocation({
            ...output,
            suggestions: [{ ...output.suggestions[0], page_ids: request.page_ids }],
          }),
        );
      }),
    );
    yield* (yield* f.worker).drain;
    assert.lengthOf(f.settlements, 1);
    assert.lengthOf(f.settlements[0]!.suggestions, 1);
    assert.deepEqual(f.settlements[0]!.suggestions[0]!.page_ids, request.page_ids);
  }),
);

it.effect("Off still settles a previously delivered request after restart", () =>
  Effect.gen(function* () {
    const delivered = {
      ...routingRequest(),
      delivery: {
        coordinator_session_id: "nodex",
        run_started_at_ms: null,
        last_refusal: null,
        handed_over_at_ms: yield* Clock.currentTimeMillis,
      },
    };
    const queued = routingRequest("queued");
    const f = yield* routingFixture([delivered, queued]);
    f.setSuggestions("off");
    f.admissions.add(inboxRoutingIdentity(delivered).messageId);
    const worker = yield* f.worker;
    const running = yield* worker.drain.pipe(Effect.forkScoped);
    yield* TestClock.adjust(INBOX_ROUTING_DEADLINE_MS);
    yield* Fiber.join(running);
    assert.isEmpty(f.send.mock.calls);
    assert.equal(f.settlements[0]!.error, "The suggestion agent timed out");
    assert.isTrue(f.pending.has(queued.request_id));
  }),
);

it.effect("starts the routing budget with the carrying Run and retains it across restart", () =>
  Effect.gen(function* () {
    const f = yield* routingFixture();
    f.setRunStartedAt(null);
    f.setOnSend(() => Effect.void);
    const first = yield* f.worker;
    const running = yield* first.drain.pipe(Effect.forkScoped);
    yield* TestClock.adjust(INBOX_ROUTING_DEADLINE_MS + 60_000);
    assert.isEmpty(f.settlements);
    const startedAt = yield* Clock.currentTimeMillis;
    f.setRunStartedAt(startedAt);
    yield* TestClock.adjust(1000);
    assert.equal(f.pending.get("request:one")!.delivery!.run_started_at_ms, startedAt);
    yield* Fiber.interrupt(running);
    // The persisted start wins even if the Runtime cannot be read again after restart.
    f.setRunStartedAt(null);
    const restarted = yield* f.worker;
    const resumed = yield* restarted.drain.pipe(Effect.forkScoped);
    yield* TestClock.adjust(INBOX_ROUTING_DEADLINE_MS - 1001);
    assert.isEmpty(f.settlements);
    yield* TestClock.adjust(1001);
    yield* Fiber.join(resumed);
    assert.equal(f.settlements[0]!.error, "The suggestion agent timed out");
    assert.lengthOf(f.send.mock.calls, 1);
  }),
);

it.effect("fails a request whose Run never starts after the handover cap", () =>
  Effect.gen(function* () {
    const f = yield* routingFixture();
    f.setRunStartedAt(null);
    f.setOnSend(() => Effect.void);
    const worker = yield* f.worker;
    const running = yield* worker.drain.pipe(Effect.forkScoped);
    yield* TestClock.adjust(INBOX_ROUTING_HANDOVER_CAP_MS - 1);
    assert.isEmpty(f.settlements);
    yield* TestClock.adjust(1);
    yield* Fiber.join(running);
    assert.equal(f.settlements[0]!.error, "The suggestion agent timed out");
  }),
);

it.effect("returns an overlong automatic routing note for correction without settling", () =>
  Effect.gen(function* () {
    const f = yield* routingFixture();
    f.setOnSend(() => Effect.void);
    const worker = yield* f.worker;
    yield* worker.trigger;
    yield* TestClock.adjust(1);
    const request = f.pending.get("request:one")!;
    const output = keepOutput(request);
    const suggestion = {
      ...output.suggestions[0]!,
      action: "new_chat",
      explicit_request: true,
      prompt: Array(31).fill("route").join(" "),
    };
    const invalid = yield* f.tool(
      invocation({ ...output, suggestions: [suggestion] }, "inbox_suggest", "too-long"),
    );
    assert.isTrue(invalid.isError);
    assert.include(invalid.content[0]?.type === "text" ? invalid.content[0].text : "", "31-word");
    assert.isTrue(f.pending.has(request.request_id));
    const corrected = yield* f.tool(
      invocation(
        { ...output, suggestions: [{ ...suggestion, prompt: "Handle the person's request" }] },
        "inbox_suggest",
        "corrected",
      ),
    );
    assert.deepEqual(corrected.structuredContent, { recorded: true });
    assert.lengthOf(f.settlements, 1);
    assert.isNull(f.settlements[0]!.error);
    yield* TestClock.adjust(1000);
  }),
);

it.effect(
  "fences a tool submission using the carrying Run even before the dispatcher observes it",
  () =>
    Effect.gen(function* () {
      const request = {
        ...routingRequest(),
        delivery: {
          coordinator_session_id: "nodex",
          handed_over_at_ms: yield* Clock.currentTimeMillis,
          run_started_at_ms: null,
          last_refusal: null,
        },
      };
      const f = yield* routingFixture([request]);
      f.admissions.add(inboxRoutingIdentity(request).messageId);
      yield* TestClock.adjust(INBOX_ROUTING_DEADLINE_MS);
      const late = yield* f.tool(invocation(keepOutput(request)));
      assert.equal(
        late.structuredContent?.message,
        "This request is no longer pending; nothing was recorded.",
      );
      assert.lengthOf(f.settlements, 1);
      assert.equal(f.settlements[0]!.error, "The suggestion agent timed out");
    }),
);

it.effect("follows up once with the last refusal when Nodex ends without answering", () =>
  Effect.gen(function* () {
    const f = yield* routingFixture();
    const request = f.pending.get("request:one")!;
    let refusal: string | undefined;
    f.setChooseModels(false);
    f.setOnSend((input) =>
      Effect.gen(function* () {
        if (input.message.messageId === inboxRoutingIdentity(request).messageId) {
          const invalid = {
            ...keepOutput(request),
            suggestions: [
              {
                ...keepOutput(request).suggestions[0],
                action: "new_chat",
                prompt: "Fix README",
                chat_instance_id: "codex",
                chat_model: "model",
              },
            ],
          };
          const rejected = yield* f.tool(invocation(invalid));
          refusal = rejected.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n");
          assert.include(refusal, "not offered");
          f.completeRun(input.message.messageId);
          return;
        }
        assert.include(input.message.text, request.request_id);
        assert.include(input.message.text, "still unanswered");
        assert.include(input.message.text, refusal!);
        yield* f.tool(invocation(keepOutput(request), "inbox_suggest", "followup-answer"));
      }),
    );
    yield* (yield* f.worker).drain;
    assert.deepEqual(
      f.send.mock.calls.map(([input]) => input.message.messageId),
      [inboxRoutingIdentity(request).messageId, inboxRoutingIdentity(request, true).messageId],
    );
    assert.lengthOf(f.settlements, 1);
    assert.isNull(f.settlements[0]!.error);
  }),
);

it.effect("recovers an admitted follow-up across restart without sending it twice", () =>
  Effect.gen(function* () {
    const f = yield* routingFixture();
    const request = f.pending.get("request:one")!;
    const followupAdmitted = yield* Deferred.make<void>();
    f.setOnSend((input) => {
      if (input.message.messageId === inboxRoutingIdentity(request).messageId)
        return Effect.sync(() => f.completeRun(input.message.messageId));
      return Deferred.succeed(followupAdmitted, undefined).pipe(
        Effect.andThen(
          Effect.fail(
            new AgentRuntimeApplicationError({ operation: "send", message: "reply lost" }),
          ),
        ),
      );
    });
    const first = yield* (yield* f.worker).drain.pipe(Effect.forkScoped);
    yield* Deferred.await(followupAdmitted);
    const deadline = f.pending.get(request.request_id)!.delivery!.run_started_at_ms;
    yield* Fiber.interrupt(first);
    const resumed = yield* (yield* f.worker).drain.pipe(Effect.forkScoped);
    yield* TestClock.adjust(1000);
    assert.lengthOf(f.send.mock.calls, 2);
    assert.equal(f.pending.get(request.request_id)!.delivery!.run_started_at_ms, deadline);
    yield* f.tool(invocation(keepOutput(request)));
    yield* TestClock.adjust(1000);
    yield* Fiber.join(resumed);
    assert.lengthOf(f.send.mock.calls, 2);
    assert.isNull(f.settlements[0]!.error);
  }),
);

it.effect("fails immediately after the follow-up ends unanswered and refuses a late answer", () =>
  Effect.gen(function* () {
    const f = yield* routingFixture();
    const request = f.pending.get("request:one")!;
    f.setOnSend((input) => Effect.sync(() => f.completeRun(input.message.messageId)));
    yield* (yield* f.worker).drain;
    assert.lengthOf(f.send.mock.calls, 2);
    assert.include(f.settlements[0]!.error!, "ended its follow-up without answering");
    const late = yield* f.tool(invocation(keepOutput(request)));
    assert.equal(late.structuredContent?.recorded, false);
    assert.lengthOf(f.settlements, 1);
  }),
);

it.effect("fences a tool answer after the unanswered follow-up ends, before the worker polls", () =>
  Effect.gen(function* () {
    const request = {
      ...routingRequest(),
      delivery: {
        coordinator_session_id: "nodex",
        handed_over_at_ms: yield* Clock.currentTimeMillis,
        run_started_at_ms: null,
        last_refusal: null,
      },
    };
    const f = yield* routingFixture([request]);
    for (const followup of [false, true]) {
      const id = inboxRoutingIdentity(request, followup).messageId;
      f.admissions.add(id);
      f.completeRun(id);
    }
    const late = yield* f.tool(invocation(keepOutput(request)));
    assert.equal(late.structuredContent?.recorded, false);
    assert.include(f.settlements[0]!.error!, "ended its follow-up without answering");
    assert.lengthOf(f.send.mock.calls, 0);
  }),
);

it.effect("holds an unanswered routing follow-up across restart and resumes it once", () =>
  Effect.gen(function* () {
    const f = yield* routingFixture();
    const first = yield* Deferred.make<void>();
    f.setOnSend((input) =>
      Effect.gen(function* () {
        if (f.send.mock.calls.length === 1) {
          f.completeRun(input.message.messageId);
          yield* f.setExecutionHeld(true);
          yield* Deferred.succeed(first, undefined);
          return;
        }
        const request = f.pending.get("request:one")!;
        yield* f.tool(invocation(keepOutput(request), "inbox_suggest", "resumed-followup"));
      }),
    );
    const running = yield* (yield* f.worker).drain.pipe(Effect.forkScoped);
    yield* Deferred.await(first);
    yield* TestClock.adjust(INBOX_ROUTING_DEADLINE_MS * 2);
    assert.lengthOf(f.send.mock.calls, 1);
    assert.isEmpty(f.settlements);
    yield* Fiber.interrupt(running);
    yield* (yield* f.worker).drain;
    assert.lengthOf(f.send.mock.calls, 1);
    yield* f.setExecutionHeld(false);
    const resumed = yield* (yield* f.worker).drain.pipe(Effect.forkScoped);
    yield* TestClock.adjust(1000);
    yield* Fiber.join(resumed);
    assert.lengthOf(f.send.mock.calls, 2);
    assert.include(f.send.mock.calls[1]![0].message.text, "still unanswered");
    assert.lengthOf(f.settlements, 1);
    assert.isNull(f.settlements[0]!.error);
  }),
);
