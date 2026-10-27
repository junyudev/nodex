import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { PluginMutationResult } from "../../shared/codex-plugin-management";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("./local-commit-ingress", () => ({ admitLocalCommitApply: vi.fn() }));
vi.mock("./renderer-causal-trace", () => ({
  beginRendererCommandTrace: () => null,
  recordRendererCommandTrace: vi.fn(),
}));

import { commandPluginManagement } from "./plugin-management-adapter";

const context = { hostId: "remote-host", projectId: "project-one" };

describe("plugin management command transport", () => {
  beforeEach(() => {
    invoke.mockReset();
    vi.stubGlobal("window", { api: { invoke } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("preserves project scope and each command's input through the registered transport", async () => {
    const result: PluginMutationResult = {
      status: "success-with-refresh-warning",
      value: undefined,
      refreshFailures: ["apps"],
    };
    invoke.mockResolvedValue(result);
    const tool = { ...context, appId: "weather", toolName: "forecast", enabled: false };
    const plugin = { ...context, pluginId: "plugin-one", enabled: true };
    await expect(commandPluginManagement("app-tool-enabled", tool)).resolves.toBe(result);
    await expect(commandPluginManagement("set-enabled", plugin)).resolves.toBe(result);
    await expect(commandPluginManagement("refresh", context)).resolves.toBe(result);
    expect(invoke.mock.calls).toEqual([
      ["codex:plugins:app-tool-enabled", tool],
      ["codex:plugins:set-enabled", plugin],
      ["codex:plugins:refresh", context],
    ]);
  });

  it("preserves service failures and rejects interrupted transport without reporting success", async () => {
    const denied: PluginMutationResult = {
      status: "policy_denied",
      error: { code: "policy_denied", message: "Managed by your organization", retryable: false },
    };
    invoke.mockResolvedValueOnce(denied);
    await expect(commandPluginManagement("refresh", context)).resolves.toBe(denied);
    const disconnected = new Error("Host disconnected");
    invoke.mockRejectedValueOnce(disconnected);
    await expect(commandPluginManagement("refresh", context)).rejects.toBe(disconnected);
  });
});
