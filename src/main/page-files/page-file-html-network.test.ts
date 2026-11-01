import { it, assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { configurePageFileHtmlNetwork } from "./page-file-html-network";

it.effect("refuses direct fallback or loopback bypass before guest admission", () =>
  Effect.gen(function* () {
    for (const bypass of ["direct", "fallback", "loopback"] as const) {
      const result = yield* Effect.result(
        configurePageFileHtmlNetwork({
          setProxy: async () => {},
          resolveProxy: async (url) => {
            if (bypass === "direct") return "DIRECT";
            if (bypass === "fallback") return "PROXY 127.0.0.1:0; DIRECT";
            return url.includes("example.invalid") ? "PROXY 127.0.0.1:0" : "DIRECT";
          },
        }),
      );
      assert.equal(result._tag, "Failure");
    }
  }),
);

it.effect("admits only after every network route uses the unreachable proxy", () =>
  Effect.gen(function* () {
    let configured = false;
    yield* configurePageFileHtmlNetwork({
      setProxy: async () => {
        configured = true;
      },
      resolveProxy: async () => {
        assert.isTrue(configured);
        return "PROXY 127.0.0.1:0";
      },
    });
  }),
);
