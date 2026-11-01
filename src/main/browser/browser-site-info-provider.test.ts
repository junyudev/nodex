import * as Effect from "effect/Effect";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { makeBrowserSiteInfoRuntime } from "./browser-site-info-provider";

const identity = {
  browserConversationId: "conversation",
  browserViewScopeId: "scope",
  browserTabId: "tab",
};

it.effect("returns Main-owned origin, cookie count, and current permission decisions", () =>
  Effect.gen(function* () {
    const cookies = { get: vi.fn(async () => [{}, {}]) };
    const runtime = makeBrowserSiteInfoRuntime(
      { getTabSnapshot: () => ({ url: "https://example.com/path?private=1" }) },
      cookies,
      {
        sitePermissions: () => [
          { permission: "camera", state: "allow" },
          { permission: "notifications", state: "ask" },
        ],
      },
    );

    const siteInfo = yield* runtime.get(identity);
    assert.deepInclude(siteInfo, {
      ...identity,
      origin: "https://example.com",
      connection: "secure",
      cookieCount: 2,
    });
    assert.deepInclude(siteInfo.permissions, { permission: "camera", state: "allow" });
    assert.deepInclude(siteInfo.permissions, { permission: "notifications", state: "ask" });
    assert.deepEqual(cookies.get.mock.calls[0], [{ url: "https://example.com/path?private=1" }]);
  }),
);

it.effect("classifies localhost separately from insecure remote HTTP", () =>
  Effect.gen(function* () {
    const cookieStore = { get: async () => [] };
    const local = makeBrowserSiteInfoRuntime(
      { getTabSnapshot: () => ({ url: "http://localhost:3000/" }) },
      cookieStore,
      { sitePermissions: () => [] },
    );
    const remote = makeBrowserSiteInfoRuntime(
      { getTabSnapshot: () => ({ url: "http://example.com/" }) },
      cookieStore,
      { sitePermissions: () => [] },
    );

    assert.strictEqual((yield* local.get(identity)).connection, "local");
    assert.strictEqual((yield* remote.get(identity)).connection, "insecure");
  }),
);
