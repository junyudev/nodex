import { describe, expect, test } from "vite-plus/test";

import { classifyComputerUseProbeResponse, cleanupBrowserRuntime } from "./probe-browser-runtime";

describe("Browser runtime probe cleanup", () => {
  test("attempts every teardown operation and preserves the first failure", async () => {
    const events: string[] = [];

    await expect(
      cleanupBrowserRuntime({
        closeForeignAccessHost: async () => {
          events.push("close-foreign-host");
        },
        closeNativePipeServer: async () => {
          events.push("close-pipe");
          throw new Error("pipe close failed");
        },
        removeStateHome: () => {
          events.push("remove-profile");
        },
        stopComputerUseRuntime: async () => {
          events.push("stop-computer-use");
        },
        stopClient: async () => {
          events.push("stop-client");
          throw new Error("client stop failed");
        },
      }),
    ).rejects.toThrow("client stop failed");

    expect(events).toEqual([
      "stop-client",
      "stop-computer-use",
      "close-pipe",
      "close-foreign-host",
      "remove-profile",
    ]);
  });
});

describe("classifyComputerUseProbeResponse", () => {
  test("accepts a real list_apps response", () => {
    expect(
      classifyComputerUseProbeResponse('tool output\n__NODEX_CUA_PROBE__{"appCount":12}', false),
    ).toEqual({ appCount: 12, status: "available" });
  });

  test("treats the native locked-session guard as successful policy conformance", () => {
    expect(
      classifyComputerUseProbeResponse(
        "The Mac is locked and automatic unlock could not unlock it.",
        true,
      ),
    ).toEqual({ reason: "mac-locked", status: "unavailable" });
  });
});
