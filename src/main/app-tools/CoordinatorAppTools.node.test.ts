import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { countWords } from "../../shared/word-count";

it.effect.each(["word", "工作", "仕事"])(
  "enforces the 100-word Turn-note limit for %s at the tool boundary",
  (word) =>
    Effect.gen(function* () {
      const f = yield* routingFixture();
      const separator = word === "word" ? " " : "、";
      const body = Array.from({ length: 101 }, () => word).join(separator);
      assert.equal(countWords(body), 101);
      const rejected = yield* f.tool(
        invocation(
          { pageId: "page:work", notify: false, eventIds: ["report"], body },
          "write_turn_note",
        ),
      );
      assert.isTrue(rejected.isError);
      assert.deepEqual(rejected.structuredContent?.error, { code: "body_too_long" });
      assert.deepEqual(rejected.content, [
        { type: "text", text: "Body has 101 words; shorten it to at most 100." },
      ]);
      assert.isEmpty(f.commands);
      const accepted = yield* f.tool(
        invocation(
          {
            pageId: "page:work",
            notify: false,
            eventIds: ["report"],
            body: Array.from({ length: 100 }, () => word).join(separator),
          },
          "write_turn_note",
          "valid",
        ),
      );
      assert.isUndefined(accepted.isError);
      assert.lengthOf(f.commands, 1);
    }),
);

it.effect.each(["word", "工作", "仕事"])("validates origin reply word limits for %s", (word) =>
  Effect.gen(function* () {
    const f = yield* routingFixture();
    const separator = word === "word" ? " " : "、";
    const rejected = yield* f.tool(
      invocation(
        { pageId: "page:work", body: Array(101).fill(word).join(separator) },
        "reply_to_origin",
      ),
    );
    assert.isTrue(rejected.isError);
    assert.deepEqual(rejected.structuredContent?.error, { code: "body_too_long" });
    assert.isEmpty(f.commands);
    const accepted = yield* f.tool(
      invocation(
        { pageId: "page:work", body: Array(100).fill(word).join(separator) },
        "reply_to_origin",
        "reply-valid",
      ),
    );
    assert.isUndefined(accepted.isError);
    assert.equal(f.commands[0]?.intent.kind, "agent_command");
  }),
);
it.effect("origin replies cannot choose an address or inject a reserved marker", () =>
  Effect.gen(function* () {
    const f = yield* routingFixture();
    for (const args of [
      { pageId: "page", body: "Hi", url: "https://github.com/other/repo/issues/1" },
      { pageId: "page", body: "Hi <!-- nodex:fake -->" },
    ]) {
      const result = yield* f.tool(invocation(args, "reply_to_origin"));
      assert.isTrue(result.isError);
    }
    assert.isEmpty(f.commands);
  }),
);

it.effect("only the Coordinator can acknowledge an origin", () =>
  Effect.gen(function* () {
    const f = yield* routingFixture();
    f.setCaller("work-chat");
    const refused = yield* f.tool(
      invocation({ pageId: "page", body: "Started" }, "reply_to_origin"),
    );
    assert.isTrue(refused.isError);
    assert.isEmpty(f.commands);
  }),
);

it.effect("assessment tools reject authority and mode fields at the tool boundary", () =>
  Effect.gen(function* () {
    const f = yield* routingFixture();
    const rejected = yield* f.tool(
      invocation(
        { request_id: "request", generation: 1, resource: "thread", url: "https://example.com" },
        "automation_assessment_read",
      ),
    );
    assert.isTrue(rejected.isError);
    assert.isEmpty(f.commands);
    const submitted = yield* f.tool(
      invocation(
        {
          request_id: "request",
          generation: 1,
          policy_hash: "a".repeat(64),
          automation_assessments: [],
          proposed_actions: [],
          mode: "auto",
        },
        "automation_assessment_submit",
      ),
    );
    assert.isTrue(submitted.isError);
    assert.isEmpty(f.commands);
  }),
);
