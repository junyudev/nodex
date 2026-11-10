import { it, assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { configurePageFileHtmlNetwork } from "./page-file-html-network";

it.live("refuses direct fallback or loopback bypass before guest admission", () =>
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

it.live("waits for proxy propagation before admitting a guest", () =>
  Effect.gen(function* () {
    const verified = new Set<string>();
    let loopbackReady = false;
    yield* configurePageFileHtmlNetwork({
      setProxy: async () => {},
      resolveProxy: async (url) => {
        if (url === "http://127.0.0.1" && !loopbackReady) {
          loopbackReady = true;
          verified.clear();
          return "DIRECT";
        }
        verified.add(url);
        return "PROXY 127.0.0.1:0";
      },
    });
    assert.sameMembers(
      [...verified],
      ["https://example.invalid", "http://127.0.0.1", "http://[::1]"],
    );
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
