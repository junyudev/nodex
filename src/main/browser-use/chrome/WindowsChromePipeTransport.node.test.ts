import { Duplex } from "node:stream";
import * as Effect from "effect/Effect";
import { expect, test } from "vite-plus/test";
import { unsupportedWindowsDesktopTools } from "../../platform/node/WindowsDesktopTools";
import {
  BrowserUseNativePipeFrameDecoder,
  encodeBrowserUseNativePipeFrame,
} from "../native-pipe-framing";
import { ChromeExtensionPipeRegistry } from "./ChromeExtensionPipeRegistry";
import { createWindowsChromePipeTransport } from "./WindowsChromePipeTransport";
import { TEST_CHROME_EXTENSION_IDS, TEST_CHROME_AUTHORITY } from "./chrome-test-fixture";

test("discovers only the verified host and focuses the exact instance on the same authenticated pipe", async () => {
  const good = "\\\\.\\pipe\\codex-browser-use-good";
  const wrongPeer = "\\\\.\\pipe\\codex-browser-use-wrong";
  const wrongExtension = "\\\\.\\pipe\\codex-browser-use-unlisted";
  const verifiedPath = "C:\\Profile\\extension-host.exe";
  const writes: Array<{ endpoint: string; connection: number; method: string }> = [];
  let connections = 0;
  let currentInstance = "exact";
  let ownsRegistration = true;
  const windows = createWindowsChromePipeTransport({
    callbacks: { runPromise: Effect.runPromise, fork: () => null },
    nativeHostPath: verifiedPath,
    ownsRegistration: async () => ownsRegistration,
    verifyHost: async () => {},
    native: {
      ...unsupportedWindowsDesktopTools,
      enumeratePipes: (prefix, limit) =>
        Effect.sync(() => {
          expect(prefix).toBe("codex-browser-use");
          expect(limit).toBe(64);
          return {
            names: [good, wrongPeer, wrongExtension, "\\\\.\\pipe\\other"],
            truncated: false,
          };
        }),
      connectPipe: (endpoint) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const connection = ++connections;
            const decoder = new BrowserUseNativePipeFrameDecoder();
            const stream = new Duplex({
              read() {},
              write(chunk: Buffer, _encoding, done) {
                for (const frame of decoder.push(chunk)) {
                  const { id, method } = JSON.parse(frame) as { id: number; method: string };
                  writes.push({ endpoint, connection, method });
                  this.push(
                    encodeBrowserUseNativePipeFrame(
                      JSON.stringify({
                        jsonrpc: "2.0",
                        id,
                        result: {
                          type: "extension",
                          family: "chrome",
                          metadata: {
                            extensionId:
                              endpoint === wrongExtension
                                ? "a".repeat(32)
                                : TEST_CHROME_EXTENSION_IDS[0],
                            extensionInstanceId: currentInstance,
                          },
                        },
                      }),
                    ),
                  );
                }
                done();
              },
            });
            return {
              stream,
              peer: {
                pid: connection,
                creationTime: String(connection),
                imagePath:
                  endpoint === wrongPeer
                    ? "C:\\Other\\extension-host.exe"
                    : verifiedPath.toUpperCase(),
              },
            };
          }),
          ({ stream }) =>
            Effect.sync(() => {
              stream.destroy();
            }),
        ),
    },
  });
  const registry = new ChromeExtensionPipeRegistry({
    authority: {
      ...TEST_CHROME_AUTHORITY,
      families: TEST_CHROME_AUTHORITY.families.map((family) => ({
        ...family,
        windows: {
          processNames: ["chrome.exe"],
          registrationBrowser: "chrome",
          userDataDirectorySegments: ["Chrome"],
        },
      })),
    },
    windows,
  });
  try {
    expect(
      (await registry.start()).instances.map(({ extensionInstanceId }) => extensionInstanceId),
    ).toEqual(["exact"]);
    expect(writes.some(({ endpoint }) => endpoint === wrongPeer)).toBe(false);
    const focus = { extensionInstanceId: "exact", sessionId: "session", tabId: "42" };
    await registry.focusPresentation(focus);
    expect(writes.slice(-2)).toEqual([
      { endpoint: good, connection: connections, method: "getInfo" },
      { endpoint: good, connection: connections, method: "focusTab" },
    ]);
    currentInstance = "changed";
    await expect(registry.focusPresentation(focus)).rejects.toThrow("instance changed");
    expect(writes.at(-1)?.method).toBe("getInfo");

    ownsRegistration = false;
    expect((await registry.refresh()).providerReady).toBe(false);
  } finally {
    registry.stop();
  }
});
