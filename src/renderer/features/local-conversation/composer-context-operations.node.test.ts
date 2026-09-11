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

  test("bypasses the native skills cache for an explicit reload", async () => {
    transport.query.mockResolvedValue([]);
    await composerContextOperations.reloadSkills("default", ["/repo"]);
    expect(transport.query).toHaveBeenCalledWith("codex:composer-skills:list", {
      hostId: "default",
      cwds: ["/repo"],
      forceReload: true,
    });
  });

  test("reads context sources through typed query boundaries", async () => {
    transport.query
      .mockResolvedValueOnce({ available: false, target: null })
      .mockResolvedValueOnce({ available: true, conversations: [] });

    await expect(composerContextOperations.readAppshotTarget()).resolves.toEqual({
      available: false,
      target: null,
    });
    await expect(composerContextOperations.searchChatGptConversations("causal")).resolves.toEqual({
      available: true,
      conversations: [],
    });

    expect(transport.query.mock.calls).toEqual([
      ["codex:composer-appshot:target"],
      ["codex:composer-chatgpt-conversations:list", { query: "causal" }],
    ]);
  });

  test("activates plugins as a registered pending operation", async () => {
    transport.command.mockResolvedValue(undefined);
    const cwds = ["/repo", "/repo/packages"] as const;

    await expect(
      composerContextOperations.activatePlugin("plugin-id", "default", cwds),
    ).resolves.toBeUndefined();
    expect(transport.command).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "composer_context.activate_plugin",
        channel: "codex:composer-plugins:activate",
        authority: "external",
        protocol: { kind: "pending_operation" },
      }),
      { id: "plugin-id", hostId: "default", cwds: ["/repo", "/repo/packages"] },
    );
  });
});
