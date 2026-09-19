import { beforeEach, expect, it, vi } from "vitest";
const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("./local-conversation-deps", () => ({ runConversationOperation: bridge.invoke }));
import { readModelCatalogForHost, readPluginCatalogForHost } from "./renderer-native-catalog";

beforeEach(() => {
  bridge.invoke.mockReset();
});

it("loads native model pages with independent caller identities on the selected host", async () => {
  bridge.invoke.mockImplementation(async (_channel, input) => ({
    type: "result",
    result: {
      data: [
        {
          id: input.request.params.cursor ? "second" : "first",
          model: "model",
          defaultReasoningEffort: "high",
        },
      ],
      nextCursor: input.request.params.cursor ? null : "next",
    },
  }));
  const models = await readModelCatalogForHost("remote");
  expect(models.map((model) => model.id)).toEqual(["first", "second"]);
  expect(
    bridge.invoke.mock.calls.map(([channel, input]) => [
      channel,
      input.hostId,
      input.request.method,
      input.request.params.cursor,
    ]),
  ).toEqual([
    ["codex:app-server:request", "remote", "model/list", null],
    ["codex:app-server:request", "remote", "model/list", "next"],
  ]);
  const callers = bridge.invoke.mock.calls.map(([, input]) => input.caller.requestId);
  expect(new Set(callers).size).toBe(2);
  for (const [, input] of bridge.invoke.mock.calls)
    expect(input.request.id).toBe(input.caller.requestId);
});

it("projects installed plugin metadata in the renderer after a native host request", async () => {
  bridge.invoke.mockResolvedValue({
    type: "result",
    result: {
      marketplaces: [
        {
          plugins: [
            {
              id: "browser@bundled",
              name: "browser",
              installed: true,
              enabled: true,
              interface: {
                displayName: "Browser",
                shortDescription: "Browse pages",
                brandColor: "#123456",
              },
            },
          ],
        },
      ],
    },
  });
  const plugins = await readPluginCatalogForHost("remote", ["/repo"]);
  expect(plugins[0]).toMatchObject({
    id: "browser@bundled",
    name: "Browser",
    description: "Browse pages",
    brandColor: "#123456",
  });
  expect(bridge.invoke.mock.calls[0]?.[1]).toMatchObject({
    hostId: "remote",
    request: { method: "plugin/installed", params: { cwds: ["/repo"] } },
  });
});

it("cancels the pending raw catalog caller when its query is aborted", async () => {
  bridge.invoke.mockImplementation((channel) =>
    channel.endsWith(":abandon") ? Promise.resolve() : new Promise(() => {}),
  );
  const controller = new AbortController();
  const pending = readModelCatalogForHost("remote", controller.signal);
  controller.abort();
  await expect(pending).rejects.toThrow("disposed");
  expect(bridge.invoke.mock.calls[1]?.[0]).toBe("codex:app-server:request:abandon");
});

it("carries history queue scheduling independently of the response deadline", async () => {
  const { RendererNativeAppServer } = await import("./renderer-native-app-server");
  bridge.invoke.mockResolvedValue({ type: "result", result: { data: [], nextCursor: null } });
  using client = new RendererNativeAppServer("remote");
  await client.request(
    "thread/turns/list",
    { threadId: "thread", cursor: null, limit: 5, sortDirection: "desc", itemsView: "summary" },
    { priority: "background", source: "thread_hydration", timeoutMs: 0 },
  );
  const [, input] = bridge.invoke.mock.calls[0]!;
  expect(input.scheduling).toEqual({ priority: "background", source: "thread_hydration" });
  expect(input.caller.timeoutMs).toBe(0);
  expect(input.caller.expiresAtMs).toBeNull();
});

it("reconstructs native method errors from the process-safe response outcome", async () => {
  const { RendererNativeAppServer } = await import("./renderer-native-app-server");
  bridge.invoke.mockResolvedValue(
    structuredClone({
      type: "error",
      error: {
        code: -32601,
        message: "unknown variant thread/settings/update",
        data: { method: "thread/settings/update" },
      },
    }),
  );
  using client = new RendererNativeAppServer("remote");
  await expect(
    client.request("thread/settings/update", { threadId: "thread", model: "new" }),
  ).rejects.toMatchObject({
    code: -32601,
    message: "unknown variant thread/settings/update",
    data: { method: "thread/settings/update" },
  });
});
