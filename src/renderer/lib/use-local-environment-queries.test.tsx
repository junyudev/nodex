import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, test } from "vite-plus/test";
import type { WorktreeEnvironmentConfigRecord } from "./types";
import { installWindowApi } from "../test/browser-globals";
import { createTestQueryClient, TestQueryProvider } from "../test/query";
import { useLocalEnvironmentConfigs } from "./use-local-environment-queries";

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Value>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const environment: WorktreeEnvironmentConfigRecord = {
  configPath: ".codex/environments/development.toml",
  fileName: "development.toml",
  state: "success",
  exists: true,
  name: "Development",
  hasSetupScript: true,
  hasCleanupScript: false,
  actionCount: 0,
  parseErrorMessage: null,
  readErrorMessage: null,
  environment: null,
};

test.each(["success", "failure"] as const)(
  "a previous Project's late environment %s cannot overwrite the current Project",
  async (outcome) => {
    const previous = deferred<WorktreeEnvironmentConfigRecord[]>();
    const current = deferred<WorktreeEnvironmentConfigRecord[]>();
    installWindowApi({
      invoke: (channel: string, projectId: string) => {
        if (channel !== "worktrees:environments:configs:list")
          throw new Error(`Unexpected query ${channel}`);
        return projectId === "previous" ? previous.promise : current.promise;
      },
      on: () => () => {},
    });
    const client = createTestQueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <TestQueryProvider client={client}>{children}</TestQueryProvider>
    );
    const { result, rerender } = renderHook(
      ({ projectId }) => useLocalEnvironmentConfigs(projectId),
      {
        initialProps: { projectId: "previous" },
        wrapper,
      },
    );
    await waitFor(() => expect(result.current.isFetching).toBe(true));
    rerender({ projectId: "current" });
    await act(async () => {
      if (outcome === "success") previous.resolve([{ ...environment, name: "Previous" }]);
      else previous.reject(new Error("Previous Project unavailable"));
      await Promise.resolve();
    });
    expect(result.current.isFetching).toBe(true);
    expect(result.current.data).toBeUndefined();
    expect(result.current.isError).toBe(false);
    await act(async () => {
      current.resolve([environment]);
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.data).toEqual([environment]));
    expect(result.current.isFetching).toBe(false);
    expect(result.current.isError).toBe(false);
  },
);
