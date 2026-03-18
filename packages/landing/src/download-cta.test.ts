import { expect, test } from "bun:test";

import {
  resolveLatestMacDownloadUrl,
  resolvePreferredMacDownloadArch,
  upgradeLandingDownloadLink,
} from "./download-cta";

test("resolveLatestMacDownloadUrl returns the stable arm64 alias URL", () => {
  expect(resolveLatestMacDownloadUrl("arm64")).toBe(
    "https://github.com/Asphocarp/nodex/releases/latest/download/Nodex-latest-arm64.dmg",
  );
});

test("resolvePreferredMacDownloadArch defaults ambiguous macOS input to arm64", () => {
  expect(resolvePreferredMacDownloadArch({
    platform: "MacIntel",
    userAgent: "Mozilla/5.0 (Macintosh; Mac OS X 14_0) AppleWebKit/605.1.15",
  })).toBe("arm64");
});

test("resolvePreferredMacDownloadArch uses explicit mac Intel user-agent tokens", () => {
  expect(resolvePreferredMacDownloadArch({
    platform: "MacIntel",
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15",
  })).toBe("x64");
});

test("upgradeLandingDownloadLink prefers arm64 when client hints expose ARM architecture", async () => {
  const anchor = document.createElement("a");
  anchor.href = "https://github.com/Asphocarp/nodex/releases/latest";

  await upgradeLandingDownloadLink(anchor, {
    platform: "MacIntel",
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)",
    userAgentData: {
      platform: "macOS",
      async getHighEntropyValues() {
        return { architecture: "arm" };
      },
    },
  });

  expect(anchor.href).toBe(resolveLatestMacDownloadUrl("arm64"));
});

test("upgradeLandingDownloadLink keeps arm64 when userAgentData is missing", async () => {
  const anchor = document.createElement("a");
  anchor.href = "https://github.com/Asphocarp/nodex/releases/latest";

  await upgradeLandingDownloadLink(anchor, {
    platform: "MacIntel",
    userAgent: "Mozilla/5.0 (Macintosh; Mac OS X 14_0)",
  });

  expect(anchor.href).toBe(resolveLatestMacDownloadUrl("arm64"));
});

test("upgradeLandingDownloadLink switches to x64 when client hints expose Intel architecture", async () => {
  const anchor = document.createElement("a");
  anchor.href = "https://github.com/Asphocarp/nodex/releases/latest";

  await upgradeLandingDownloadLink(anchor, {
    platform: "MacIntel",
    userAgent: "Mozilla/5.0 (Macintosh; Mac OS X 14_0)",
    userAgentData: {
      platform: "macOS",
      async getHighEntropyValues() {
        return { architecture: "x86" };
      },
    },
  });

  expect(anchor.href).toBe(resolveLatestMacDownloadUrl("x64"));
});
