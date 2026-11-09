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
