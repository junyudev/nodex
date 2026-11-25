import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { preparedProvider } from "./provider-preparation";

const declaration = {
  driver: "claudeAgent",
  displayName: "Work",
  enabled: true,
  environment: [{ name: "ANTHROPIC_AUTH_TOKEN", value: "secret", sensitive: true }],
};

it.effect("passes a prepared Agent through unchanged", () =>
  Effect.gen(function* () {
    assert.strictEqual(
      yield* preparedProvider("work", declaration, Effect.succeed(declaration)),
      declaration,
    );
  }),
);

it.effect(
  "declares an Agent that cannot be prepared unavailable, with the reason and no credentials",
  () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* preparedProvider(
          "key_deepseek_one",
          { driver: "codex", displayName: "DeepSeek", source: "nodex" },
          Effect.fail(
            new Error("EACCES: permission denied, mkdir '/profile/account/keys/one'\n  at …"),
          ),
        ),
        {
          driver: "codex",
          displayName: "DeepSeek",
          source: "nodex",
          enabled: false,
          unavailable: {
            message:
              "Nodex couldn’t prepare this Agent: EACCES: permission denied, mkdir '/profile/account/keys/one'",
          },
        },
      );
      assert.deepStrictEqual(
        yield* preparedProvider(
          "work",
          { driver: "claudeAgent", displayName: " " },
          Effect.fail(""),
        ),
        {
          driver: "claudeAgent",
          enabled: false,
          unavailable: { message: "Nodex couldn’t prepare this Agent." },
        },
      );
    }),
);
