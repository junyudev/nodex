import { describe, expect, test } from "vite-plus/test";
import {
  TESTED_BROWSER_APP_SERVER_PAIRS,
  isTestedBrowserAppServerPair,
  projectBundledAppServerRuntimeIdentity,
} from "./browser-app-server-compatibility";

describe("Browser and app-server compatibility", () => {
  test("accepts only an exact conformance-tested artifact pair", () => {
    const pair = TESTED_BROWSER_APP_SERVER_PAIRS[0];
    if (!pair) throw new Error("Expected a committed Browser compatibility pair");

    expect(isTestedBrowserAppServerPair(pair.appServer, pair.browser)).toBe(true);
    expect(
      isTestedBrowserAppServerPair({ ...pair.appServer, runtimeVersion: "0.152.1" }, pair.browser),
    ).toBe(false);
    expect(
      isTestedBrowserAppServerPair(pair.appServer, {
        ...pair.browser,
        manifestSha256: "0".repeat(64),
      }),
    ).toBe(false);
  });

  test("does not infer compatibility from version ordering", () => {
    const pair = TESTED_BROWSER_APP_SERVER_PAIRS[0];
    if (!pair) throw new Error("Expected a committed Browser compatibility pair");

    expect(
      isTestedBrowserAppServerPair(
        {
          ...pair.appServer,
          entrypointSha256: "f".repeat(64),
          runtimeVersion: "0.151.0",
        },
        pair.browser,
      ),
    ).toBe(false);
  });

  test("keeps the tested package identity stable after platform signing", () => {
    const pair = TESTED_BROWSER_APP_SERVER_PAIRS[0];
    if (!pair) throw new Error("Expected a committed Browser compatibility pair");
    const metadata = {
      appServerRuntimeVersion: pair.appServer.runtimeVersion,
      releaseAsset: { entrypointSha256: pair.appServer.entrypointSha256 },
      protocolSchemaFingerprint: pair.appServer.protocolSchemaFingerprint,
      sourceRevision: { commit: pair.appServer.sourceCommit },
      targetArch: pair.appServer.targetArch,
      targetPlatform: pair.appServer.targetPlatform,
    } as Parameters<typeof projectBundledAppServerRuntimeIdentity>[0];

    expect(projectBundledAppServerRuntimeIdentity(metadata)).toEqual(pair.appServer);
  });

  test("admits multiple exact partners without inferring untested combinations", () => {
    const pair = TESTED_BROWSER_APP_SERVER_PAIRS[0];
    if (!pair) throw new Error("Expected a committed Browser compatibility pair");
    const otherAppServer = { ...pair.appServer, entrypointSha256: "a".repeat(64) };
    const otherBrowser = { ...pair.browser, manifestSha256: "b".repeat(64) };
    const pairs = [
      pair,
      { appServer: otherAppServer, browser: pair.browser },
      { appServer: pair.appServer, browser: otherBrowser },
    ];

    for (const orderedPairs of [pairs, pairs.toReversed()]) {
      expect(isTestedBrowserAppServerPair(pair.appServer, pair.browser, orderedPairs)).toBe(true);
      expect(isTestedBrowserAppServerPair(otherAppServer, pair.browser, orderedPairs)).toBe(true);
      expect(isTestedBrowserAppServerPair(pair.appServer, otherBrowser, orderedPairs)).toBe(true);
      expect(isTestedBrowserAppServerPair(otherAppServer, otherBrowser, orderedPairs)).toBe(false);
    }
  });
});
