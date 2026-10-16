import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vite-plus/test";
import type { ClaudeAgentSettings } from "../../../shared/claude-agent-settings";
import {
  defaultOpenCodeInstance,
  type OpenCodeAgentSettings,
} from "../../../shared/opencode-agent-settings";
import type { AcpAgentSettings } from "../../../shared/types";
import { useAgentInstances } from "./use-agent-instances";

const mocks = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    readClaude: vi.fn<() => Promise<ClaudeAgentSettings>>(),
    readOpenCode: vi.fn<() => Promise<OpenCodeAgentSettings>>(),
    readAcp: vi.fn<() => Promise<AcpAgentSettings>>(),
    subscribe: vi.fn((listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
    publish: () => {
      for (const listener of listeners) listener();
    },
    listeners,
  };
});
vi.mock("../../lib/workbench-settings-runtime", () => ({
  readClaudeAgentSettings: mocks.readClaude,
  readAcpAgentSettings: mocks.readAcp,
}));
vi.mock("../../lib/opencode-agent-settings-runtime", () => ({
  readOpenCodeAgentSettings: mocks.readOpenCode,
}));
vi.mock("../../lib/renderer-transport", () => ({
  resolveRendererTransport: () => ({ subscribeAgentSettingsChanges: mocks.subscribe }),
}));
beforeEach(() => {
  mocks.readClaude.mockReset().mockResolvedValue({ instances: [] });
  mocks.readAcp.mockReset().mockResolvedValue({ instances: [] });
  mocks.readOpenCode.mockReset().mockResolvedValue({ instances: [] });
});

test("a settings read failure remains explicit instead of classifying the selected profile as removed", async () => {
  mocks.readOpenCode.mockRejectedValueOnce(new Error("Could not read Agent profiles"));
  const { result } = renderHook(() => useAgentInstances());
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.error).toBe("Could not read Agent profiles");
  expect(result.current.instances).toEqual([]);
});

test("a late settings read cannot re-enable a profile disabled by a newer settings event", async () => {
  let complete!: (settings: OpenCodeAgentSettings) => void;
  const instance = { ...defaultOpenCodeInstance(), enabled: true };
  mocks.readOpenCode
    .mockReturnValueOnce(
      new Promise((resolve) => {
        complete = resolve;
      }),
    )
    .mockResolvedValueOnce({ instances: [{ ...instance, enabled: false }] });
  const { result, unmount } = renderHook(() => useAgentInstances());
  await act(async () => {
    mocks.publish();
  });
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.instances[0]?.enabled).toBe(false);
  await act(async () => {
    complete({ instances: [instance] });
  });
  expect(result.current.instances[0]?.enabled).toBe(false);
  unmount();
  expect(mocks.listeners.size).toBe(0);
});

test("refresh retries failed profile settings and recovers inventory without blocking Codex", async () => {
  const instance = defaultOpenCodeInstance();
  mocks.readOpenCode
    .mockRejectedValueOnce(new Error("Could not read Agent profiles"))
    .mockResolvedValueOnce({ instances: [instance] });
  const { result } = renderHook(() => useAgentInstances());
  await waitFor(() => expect(result.current.error).toBe("Could not read Agent profiles"));
  await act(async () => {
    result.current.refresh();
  });
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.error).toBeNull();
  expect(result.current.instances).toEqual([
    {
      binding: { kind: "opencode", instanceConfigId: instance.id },
      label: instance.displayName,
      enabled: instance.enabled,
      usesHostExecutable: true,
    },
  ]);
  expect(mocks.readClaude).toHaveBeenCalledTimes(2);
  expect(mocks.readOpenCode).toHaveBeenCalledTimes(2);
  expect(mocks.readAcp).toHaveBeenCalledTimes(2);
});

test("only local profiles running the default executable depend on host OpenCode setup", async () => {
  const base = defaultOpenCodeInstance();
  mocks.readOpenCode.mockResolvedValueOnce({
    instances: [
      { ...base, enabled: false },
      { ...base, id: "custom", binaryPath: "/opt/opencode/bin/opencode" },
      { ...base, id: "server", serverUrl: "http://127.0.0.1:4096" },
    ],
  });
  const { result } = renderHook(() => useAgentInstances());
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(
    result.current.instances.map(({ enabled, usesHostExecutable }) => ({
      enabled,
      usesHostExecutable,
    })),
  ).toEqual([
    { enabled: false, usesHostExecutable: true },
    { enabled: true, usesHostExecutable: false },
    { enabled: true, usesHostExecutable: false },
  ]);
});
