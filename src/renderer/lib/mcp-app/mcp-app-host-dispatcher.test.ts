import { describe, expect, test, vi } from "vite-plus/test";
import type { McpAppScopeSnapshot } from "../../../shared/mcp-app/mcp-app-scope";
import { McpAppHostDispatcher } from "./mcp-app-host-dispatcher";

const navigation = vi.hoisted(() => ({
  authorize: vi.fn<() => Promise<void>>(async () => undefined),
}));
vi.mock("../renderer-command", () => ({
  defineRendererCommand: (value: unknown) => value,
  invokePlainCommand: navigation.authorize,
  invokeRendererQuery: vi.fn(),
}));

function scope(toolName: string): McpAppScopeSnapshot {
  return {
    allowedTools: new Map([[toolName, { name: toolName, inputSchema: { type: "object" } }]]),
    codexAppsToolScope: null,
    originResourceUri: "ui://calendar/widget",
    resourceTemplates: [],
    resources: [],
    server: "calendar",
    threadId: "thread-1",
  };
}

describe("MCP App host dispatcher", () => {
  test("does not accept model context without a real Composer recipient", async () => {
    const dispatcher = new McpAppHostDispatcher({ scope: scope("calendar") });
    await expect(
      dispatcher.handlers().callMcp({
        method: "ui/update-model-context",
        params: { structuredContent: { selected: 1 } },
      }),
    ).rejects.toMatchObject({ code: -32_601 });
  });
  test("resolves the latest trusted tool scope for every list request", async () => {
    let current = scope("list-events");
    const dispatcher = new McpAppHostDispatcher({
      getScope: () => current,
      scope: current,
    });
    const callMcp = dispatcher.handlers().callMcp;

    await expect(callMcp({ method: "tools/list" })).resolves.toMatchObject({
      tools: [{ name: "list-events" }],
    });
    current = scope("create-event");
    await expect(callMcp({ method: "tools/list" })).resolves.toMatchObject({
      tools: [{ name: "create-event" }],
    });
  });
});

test.each([
  ["inline", false, undefined, undefined],
  ["modal", false, undefined, "external-browser"],
  ["inline", true, "popup", "external-browser"],
  ["inline", false, "popup", undefined],
  ["inline", true, "tab", undefined],
] as const)(
  "routes %s app navigation with firstParty=%s and mode=%s",
  async (displayMode, isFirstParty, openMode, openTarget) => {
    const openLink = vi.fn(async () => true);
    const dispatcher = new McpAppHostDispatcher({
      scope: scope("calendar"),
      hostId: "ssh:work",
      openLink,
      getDisplayMode: () => displayMode,
      isFirstParty,
    });
    await dispatcher
      .handlers()
      .openExternal({ href: "https://example.com/", ...(openMode ? { openMode } : {}) });
    expect(openLink).toHaveBeenCalledExactlyOnceWith({
      url: "https://example.com/",
      hostId: "ssh:work",
      initiator: "mcp_app_resource",
      source: "manual",
      ...(openTarget ? { openTarget } : {}),
    });
  },
);
test.each(["http://localhost:3000", "file:///tmp/a.html", "javascript:alert(1)"])(
  "rejects unsupported guest link %s before routing",
  async (href) => {
    const openLink = vi.fn(async () => true);
    const dispatcher = new McpAppHostDispatcher({ scope: scope("calendar"), openLink });
    await expect(dispatcher.handlers().openExternal({ href })).rejects.toMatchObject({
      code: -32_602,
    });
    expect(openLink).not.toHaveBeenCalled();
  },
);
test("Nodex resource links keep app navigation after Main validation", async () => {
  const openLink = vi.fn(async () => true);
  const dispatcher = new McpAppHostDispatcher({ scope: scope("calendar"), openLink });
  await dispatcher.handlers().openExternal({ href: "nodex://sessions/session-1" });
  expect(navigation.authorize).toHaveBeenCalledWith(
    expect.objectContaining({ channel: "mcp-app:open-external" }),
    "nodex://sessions/session-1",
  );
  expect(openLink).not.toHaveBeenCalled();
});

test("a retired app cannot dispatch navigation after Main validation completes", async () => {
  let current = true;
  let release!: () => void;
  navigation.authorize.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const openLink = vi.fn(async () => true);
  const dispatcher = new McpAppHostDispatcher({
    scope: scope("calendar"),
    openLink,
    isCurrent: () => current,
  });
  const pending = dispatcher.handlers().openExternal({ href: "https://example.com/" });
  current = false;
  release();
  await pending;
  expect(openLink).not.toHaveBeenCalled();
});
