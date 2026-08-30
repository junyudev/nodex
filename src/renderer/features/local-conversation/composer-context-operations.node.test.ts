import { beforeEach, describe, expect, test, vi } from "vite-plus/test";

const transport = vi.hoisted(() => ({
  command: vi.fn(),
  query: vi.fn(),
}));

vi.mock("@/lib/renderer-command", () => ({
  defineRendererCommand: <Definition>(definition: Definition) => definition,
  invokePlainCommand: transport.command,
  invokeRendererQuery: transport.query,
}));

import { composerContextOperations } from "./composer-context-operations";

describe("composer context operations", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  test("reads context sources through typed query boundaries", async () => {
    transport.query
      .mockResolvedValueOnce({ available: false, target: null })
      .mockResolvedValueOnce({ matches: [], ancestorDirectories: [], truncated: false })
      .mockResolvedValueOnce({ available: true, conversations: [] });

    await expect(composerContextOperations.readAppshotTarget()).resolves.toEqual({
      available: false,
      target: null,
    });
    await expect(
      composerContextOperations.searchWorkspaceFiles({
        workspaceRoot: "/repo",
        query: "renderer",
        maxResults: 24,
      }),
    ).resolves.toEqual({ matches: [], ancestorDirectories: [], truncated: false });
    await expect(composerContextOperations.searchChatGptConversations("causal")).resolves.toEqual({
      available: true,
      conversations: [],
    });

    expect(transport.query.mock.calls).toEqual([
      ["codex:composer-appshot:target"],
      ["workspace-file-search", { workspaceRoot: "/repo", query: "renderer", maxResults: 24 }],
      ["codex:composer-chatgpt-conversations:list", { query: "causal" }],
    ]);
  });

  test("activates plugins as a registered pending operation", async () => {
    transport.command.mockResolvedValue(undefined);
    const cwds = ["/repo", "/repo/packages"] as const;

    await expect(
      composerContextOperations.activatePlugin("plugin-id", cwds),
    ).resolves.toBeUndefined();
    expect(transport.command).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "composer_context.activate_plugin",
        channel: "codex:composer-plugins:activate",
        authority: "external",
        protocol: { kind: "pending_operation" },
      }),
      { id: "plugin-id", cwds: ["/repo", "/repo/packages"] },
    );
  });
});
