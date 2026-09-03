import { describe, expect, test } from "vite-plus/test";
import { isChromeControlRuntimeSnapshot } from "./chrome-control-settings";

describe("Chrome control settings snapshot", () => {
  test("accepts the bounded five-gate projection and rejects malformed renderer events", () => {
    expect(
      isChromeControlRuntimeSnapshot({
        bundleSupported: true,
        extensionConnected: false,
        nativeHostInstalled: true,
        providerReady: false,
        reason: "Waiting for extension",
        requested: true,
        revision: 4,
        status: "extension-disconnected",
      }),
    ).toBe(true);
    expect(
      isChromeControlRuntimeSnapshot({
        bundleSupported: true,
        extensionConnected: false,
        nativeHostInstalled: true,
        providerReady: false,
        reason: "x".repeat(513),
        requested: true,
        revision: Number.POSITIVE_INFINITY,
        status: "ready-ish",
      }),
    ).toBe(false);
  });
});
