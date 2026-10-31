import { it } from "@effect/vitest";
import { afterEach, expect, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { modelAccessFixture, modelStatusFixture } from "../../nodex-account/model-access-fixture";
import { make } from "./NodexModelAccessPlatform";

afterEach(() => vi.unstubAllGlobals());
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const payload = { ...modelAccessFixture, apiKey: "synthetic-gateway-key" };
it.live("keeps production credentials on the fixed exchange and usage origins", () =>
  Effect.gen(function* () {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response(payload))
      .mockResolvedValueOnce(response({ balance: 9.5, unit: "USD" }));
    vi.stubGlobal("fetch", fetch);
    const platform = make({
      isPackaged: true,
      environment: {
        NODEX_TEST_MODEL_ACCESS_ORIGIN: "http://127.0.0.1:1234",
        NODEX_TEST_CLERK_LOOPBACK: "1",
      },
      openExternal: () => Promise.resolve(),
    });
    const access = yield* platform.exchange(Redacted.make("oauth-token"));
    expect(yield* platform.balance(access)).toBe(9.5);
    expect(fetch.mock.calls[0]).toMatchObject([
      "https://api.nodex.jyu.app/v1/model-access",
      { method: "POST", headers: { authorization: "Bearer oauth-token" }, redirect: "error" },
    ]);
    expect(fetch.mock.calls[1]).toMatchObject([
      "https://api.jyu.app/v1/usage",
      { headers: { authorization: "Bearer synthetic-gateway-key" }, redirect: "error" },
    ]);
  }),
);
it.live("rejects a credential-routing response outside the trusted gateway origins", () =>
  Effect.gen(function* () {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(response({ ...payload, anthropicBaseUrl: "https://other.invalid" })),
    );
    const platform = make({
      isPackaged: true,
      environment: {},
      openExternal: () => Promise.resolve(),
    });
    const error = yield* platform.exchange(Redacted.make("oauth-token")).pipe(Effect.flip);
    expect(error.code).toBe("unavailable");
  }),
);
it.live("returns categorical exchange failures without backend response text", () =>
  Effect.gen(function* () {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          response({ error: { code: "email_unverified", message: "private server detail" } }, 403),
        ),
    );
    const platform = make({
      isPackaged: true,
      environment: {},
      openExternal: () => Promise.resolve(),
    });
    const error = yield* platform.exchange(Redacted.make("oauth-token")).pipe(Effect.flip);
    expect(error.code).toBe("email_unverified");
    expect(JSON.stringify(error)).not.toContain("private server detail");
  }),
);

it.live(
  "reads public supply without credentials and creates authenticated Stripe checkout in Main",
  () =>
    Effect.gen(function* () {
      const { modelStatusFixture } = yield* Effect.promise(
        () => import("../../nodex-account/model-access-fixture"),
      );
      const url = "https://checkout.stripe.com/c/pay/synthetic";
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(response(modelStatusFixture))
        .mockResolvedValueOnce(response({ url }));
      vi.stubGlobal("fetch", fetch);
      const openExternal = vi.fn(() => Promise.resolve());
      const platform = make({ isPackaged: true, environment: {}, openExternal });
      expect(yield* platform.status).toEqual(modelStatusFixture);
      const checkout = yield* platform.checkout(Redacted.make("clerk-token"), 2);
      expect(fetch.mock.calls[0]).toMatchObject([
        "https://api.nodex.jyu.app/v1/status",
        { redirect: "error" },
      ]);
      expect(fetch.mock.calls[0]?.[1]?.headers).toBeUndefined();
      expect(fetch.mock.calls[1]).toMatchObject([
        "https://api.nodex.jyu.app/v1/checkout",
        {
          method: "POST",
          body: '{"amount":2}',
          headers: { authorization: "Bearer clerk-token", "content-type": "application/json" },
        },
      ]);
      yield* platform.openCheckout(checkout);
      expect(openExternal).toHaveBeenCalledExactlyOnceWith(url);
    }),
);

for (const [code, status] of [
  ["unauthenticated", 401],
  ["forbidden_client", 403],
  ["tier_unavailable", 409],
  ["unavailable", 503],
] as const) {
  it.live(`preserves checkout ${code} without leaking backend text`, () =>
    Effect.gen(function* () {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(
            response({ error: { code, message: "private server detail" } }, status),
          ),
      );
      const platform = make({
        isPackaged: true,
        environment: {},
        openExternal: () => Promise.resolve(),
      });
      const failure = yield* platform.checkout(Redacted.make("token"), 2).pipe(Effect.flip);
      expect(failure.code).toBe(code);
      expect(JSON.stringify(failure)).not.toContain("private server detail");
    }),
  );
}
for (const url of [
  "https://checkout.stripe.com.evil.invalid/pay",
  "https://evil.invalid/",
  "file:///tmp/checkout",
  "https://user@checkout.stripe.com/pay",
]) {
  it.live(`rejects an untrusted checkout destination ${url}`, () =>
    Effect.gen(function* () {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ url })));
      const openExternal = vi.fn(() => Promise.resolve());
      const platform = make({ isPackaged: true, environment: {}, openExternal });
      expect((yield* platform.checkout(Redacted.make("token"), 2).pipe(Effect.flip)).code).toBe(
        "unavailable",
      );
      expect((yield* platform.openCheckout(url).pipe(Effect.flip)).code).toBe("unavailable");
      expect(openExternal).not.toHaveBeenCalled();
    }),
  );
}
