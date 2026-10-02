import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vite-plus/test";
import type { AgentModelCatalog } from "../../../shared/agent-model-catalog";
import { useAgentModelCatalogs } from "./use-agent-model-catalog";
import { modelCatalog } from "../../lib/agent-model-catalog.test-fixtures";

const instance = {
  binding: { kind: "opencode", instanceConfigId: "local" },
  label: "Local",
  enabled: true,
} as const;
const subscribe = () => () => {};

test("fences replies by Project and execution directory; explicit refresh asks the runtime to reload", async () => {
  const pending: { resolve: (catalog: AgentModelCatalog) => void; signal?: AbortSignal }[] = [];
  const read = vi.fn(
    (_input, signal?: AbortSignal) =>
      new Promise<AgentModelCatalog>((resolve) => {
        pending.push({ resolve, signal });
      }),
  );
  const { result, rerender } = renderHook(
    (scope) =>
      useAgentModelCatalogs(
        {
          instances: [instance],
          ...scope,
        },
        { read, subscribe },
      ),
    { initialProps: { projectId: "first", observedExecutionLocation: "/one" } },
  );
  rerender({ projectId: "second", observedExecutionLocation: "/two" });
  expect(pending[0]?.signal?.aborted).toBe(true);
  await act(async () => {
    pending[0]?.resolve(modelCatalog());
  });
  expect(result.current.entries[0]?.catalog).toBeNull();
  await act(async () => {
    pending[1]?.resolve(modelCatalog({ defaultModel: "local/small" }));
  });
  await waitFor(() => expect(result.current.entries[0]?.catalog?.defaultModel).toBe("local/small"));
  await act(async () => {
    result.current.refresh();
  });
  expect(read).toHaveBeenLastCalledWith(
    {
      scope: { kind: "project", projectId: "second", binding: instance.binding },
      forceReload: true,
    },
    expect.any(AbortSignal),
  );
  await act(async () => {
    pending[2]?.resolve(modelCatalog());
  });
});

test("rejects a catalog from a different instance and pins attached discovery to the Thread", async () => {
  const read = vi.fn(async () =>
    modelCatalog({ binding: { kind: "opencode", instanceConfigId: "other" } }),
  );
  const { result } = renderHook(() =>
    useAgentModelCatalogs(
      {
        instances: [instance],
        projectId: "project",
        threadId: "thread",
        observedExecutionLocation: "/worktree",
      },
      { read, subscribe },
    ),
  );
  await waitFor(() => expect(result.current.entries[0]?.loading).toBe(false));
  expect(result.current.entries[0]?.catalog).toBeNull();
  expect(result.current.entries[0]?.error).toMatch(/another Agent instance/);
  expect(read).toHaveBeenCalledWith(
    { scope: { kind: "thread", threadId: "thread" } },
    expect.any(AbortSignal),
  );
});

test("bounds concurrent native discovery and does not dequeue more work after a scope is released", async () => {
  const pending: { resolve: (catalog: AgentModelCatalog) => void; instanceConfigId: string }[] = [];
  const read = vi.fn(
    (input) =>
      new Promise<AgentModelCatalog>((resolve) => {
        if (input.scope.kind !== "project") throw new Error("Expected Project discovery");
        pending.push({ resolve, instanceConfigId: input.scope.binding.instanceConfigId ?? "" });
      }),
  );
  const instances = ["one", "two", "three", "four"].map((id) => ({
    ...instance,
    binding: { kind: "opencode" as const, instanceConfigId: id },
  }));
  const { unmount } = renderHook(() =>
    useAgentModelCatalogs({ instances, projectId: "project" }, { read, subscribe }),
  );
  expect(read).toHaveBeenCalledTimes(2);
  await act(async () => {
    pending[0]?.resolve(modelCatalog({ binding: { kind: "opencode", instanceConfigId: "one" } }));
  });
  expect(read).toHaveBeenCalledTimes(3);
  unmount();
  await act(async () => {
    for (const entry of pending.slice(1))
      entry.resolve(
        modelCatalog({ binding: { kind: "opencode", instanceConfigId: entry.instanceConfigId } }),
      );
  });
  expect(read).toHaveBeenCalledTimes(3);
});
