import { describe, expect, test } from "vite-plus/test";
import { parseRemoteHostedPipNotification } from "./browser-use-pip-metadata";

function browserNotification(overrides: Record<string, unknown> = {}): unknown {
  return {
    method: "item/completed",
    params: {
      item: {
        result: {
          _meta: {
            "codex/toolSurface": {
              backend: "iab",
              browserId: "browser-1",
              browserFamily: "chrome",
              kind: "browserUse",
              openTabIds: ["tab-1"],
              screenshot: {
                tabId: "tab-1",
                url: "data:image/png;base64,YQ==",
              },
              ...overrides,
            },
          },
        },
        server: "node_repl",
        type: "mcpToolCall",
      },
      threadId: "thread-1",
    },
  };
}

describe("parseRemoteHostedPipNotification", () => {
  test("parses a completed node_repl Browser surface without projecting it to transcript state", () => {
    expect(parseRemoteHostedPipNotification(browserNotification())).toEqual({
      kind: "browser-use",
      surface: {
        backend: "iab",
        browserFamily: "chrome",
        browserId: "browser-1",
        openTabIds: ["tab-1"],
        screenshot: {
          tabId: "tab-1",
          url: "data:image/png;base64,YQ==",
        },
      },
      threadId: "thread-1",
    });
  });

  test("rejects non-node_repl calls, unsafe screenshots, and duplicate tab identities", () => {
    const wrongServer = browserNotification() as {
      params: { item: { server: string } };
    };
    wrongServer.params.item.server = "browser";
    expect(parseRemoteHostedPipNotification(wrongServer)).toBeNull();
    expect(
      parseRemoteHostedPipNotification(
        browserNotification({
          screenshot: { tabId: "tab-1", url: "https://example.com/a.png" },
        }),
      ),
    ).toBeNull();
    expect(
      parseRemoteHostedPipNotification(
        browserNotification({
          openTabIds: ["tab-1", "tab-1"],
        }),
      ),
    ).toBeNull();
    expect(
      parseRemoteHostedPipNotification(browserNotification({ browserId: "browser\0forged" })),
    ).toBeNull();
  });

  test("requires an exact extension instance and family only for Chrome surfaces", () => {
    expect(
      parseRemoteHostedPipNotification(
        browserNotification({ backend: "chrome", extensionInstanceId: "profile-a" }),
      ),
    ).not.toBeNull();
    expect(
      parseRemoteHostedPipNotification(
        browserNotification({ backend: "chrome", browserFamily: undefined }),
      ),
    ).toBeNull();
    expect(
      parseRemoteHostedPipNotification(
        browserNotification({ backend: "chrome", extensionInstanceId: undefined }),
      ),
    ).toBeNull();
    expect(
      parseRemoteHostedPipNotification(
        browserNotification({ backend: "cdp", extensionInstanceId: "profile-a" }),
      ),
    ).toBeNull();
  });

  test("parses thread and turn terminal lifecycle", () => {
    expect(
      parseRemoteHostedPipNotification({
        method: "turn/completed",
        params: { threadId: "thread-1", turn: { id: "turn-1", status: "interrupted" } },
      }),
    ).toEqual({
      completed: false,
      kind: "turn-ended",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    expect(
      parseRemoteHostedPipNotification({
        method: "thread/archived",
        params: { threadId: "thread-1" },
      }),
    ).toEqual({ deleted: false, kind: "thread-ended", threadId: "thread-1" });
  });

  test("identifies direct and node_repl Computer Use activity", () => {
    expect(
      parseRemoteHostedPipNotification({
        method: "item/started",
        params: {
          item: { id: "computer-1", server: "computer-use", type: "mcpToolCall" },
          threadId: "thread-1",
        },
      }),
    ).toEqual({ active: true, itemId: "computer-1", kind: "computer-use", threadId: "thread-1" });
    expect(
      parseRemoteHostedPipNotification({
        method: "item/completed",
        params: {
          item: {
            id: "node-1",
            result: { _meta: { "codex/toolSurface": { app: null, kind: "computerUse" } } },
            server: "node_repl",
            type: "mcpToolCall",
          },
          threadId: "thread-1",
        },
      }),
    ).toEqual({ active: true, itemId: "node-1", kind: "computer-use", threadId: "thread-1" });
  });
});
