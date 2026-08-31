import { act, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "vite-plus/test";
import { render, settleAsyncRender } from "@/test/dom";
import { installWindowApi } from "@/test/browser-globals";
import { createTestQueryClient, TestQueryProvider } from "@/test/query";
import { applyCodexHostCatalogEvent, NodexQueryProvider } from "./query-client";
import { queryKeys } from "./query-keys";
import type {
  WorktreeEnvironmentConfigRecord,
  WorktreeEnvironmentDefinition,
  WorktreeEnvironmentSettingsSnapshot,
  CodexEvent,
  ProtocolAppInfo,
} from "./types";
import {
  useLocalEnvironmentConfigs,
  useLocalEnvironmentOptions,
  useLocalEnvironmentSnapshot,
  useSaveLocalEnvironmentConfigMutation,
} from "./use-local-environment-queries";
import { useMcpApps, useMcpServerStatuses } from "./use-mcp-queries";

const ENVIRONMENT: WorktreeEnvironmentDefinition = {
  version: 1,
  name: "local",
  setup: { script: null, platformScripts: {} },
  cleanup: { script: null, platformScripts: {} },
  actions: [],
};

function makeConfig(configPath: string): WorktreeEnvironmentConfigRecord {
  return {
    configPath,
    fileName: configPath.split("/").at(-1) ?? "environment.json",
    state: "success",
    exists: true,
    name: "local",
    hasSetupScript: false,
    hasCleanupScript: false,
    actionCount: 0,
    parseErrorMessage: null,
    readErrorMessage: null,
    environment: ENVIRONMENT,
  };
}

function makeSnapshot(
  configs: WorktreeEnvironmentConfigRecord[],
): WorktreeEnvironmentSettingsSnapshot {
  return {
    projectId: "project-1",
    projectName: "Project 1",
    workspacePath: "/tmp/project-1",
    configPath: configs[0]?.configPath ?? "/tmp/project-1/.codex/environment.json",
    nextConfigPath: "/tmp/project-1/.codex/environment-2.json",
    configExists: configs.length > 0,
    revision: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    configs,
    environment: ENVIRONMENT,
    parseErrorMessage: null,
    readErrorMessage: null,
  };
}

function ServerStateHarness() {
  const { data: configs } = useLocalEnvironmentConfigs("project-1");
  const { data: options } = useLocalEnvironmentOptions("project-1");
  const { data: snapshot } = useLocalEnvironmentSnapshot("project-1", null);
  const saveConfig = useSaveLocalEnvironmentConfigMutation();
  useMcpServerStatuses({ enabled: false });

  return (
    <button
      type="button"
      data-testid="configs"
      onClick={() => {
        void saveConfig.mutateAsync({
          projectId: "project-1",
          configPath: "/tmp/project-1/.codex/environment.json",
          expectedRevision: snapshot?.revision ?? null,
          environment: ENVIRONMENT,
        });
      }}
    >
      {configs?.length ?? 0}|{options?.length ?? 0}|{snapshot?.configs.length ?? 0}
    </button>
  );
}

function McpCatalogConsumer({ label }: { label: string }) {
  const { data } = useMcpServerStatuses();
  return <div data-testid={label}>{data?.data.length ?? 0}</div>;
}

function makeApp(name: string): ProtocolAppInfo {
  return {
    id: `connector_${name.toLowerCase()}`,
    name,
    description: null,
    logoUrl: null,
    logoUrlDark: null,
    iconAssets: null,
    iconDarkAssets: null,
    distributionChannel: null,
    branding: null,
    appMetadata: null,
    labels: null,
    installUrl: null,
    isAccessible: true,
    isEnabled: true,
    pluginDisplayNames: [],
  };
}

function AppsCatalogConsumer() {
  const { data = [] } = useMcpApps();
  return <div data-testid="apps">{data.map((app) => app.name).join(",")}</div>;
}

describe("server state query hooks", () => {
  let configs: WorktreeEnvironmentConfigRecord[];
  let configListCalls = 0;
  let optionListCalls = 0;
  let snapshotCalls = 0;
  let saveResult: "success" | "conflict" = "success";
  let mcpStatusCalls = 0;
  let mcpStatusArgs: unknown[] = [];
  let appListCalls = 0;
  let codexEventListeners = new Set<(...args: unknown[]) => void>();

  beforeEach(() => {
    configs = [makeConfig("/tmp/project-1/.codex/environment.json")];
    configListCalls = 0;
    optionListCalls = 0;
    snapshotCalls = 0;
    saveResult = "success";
    mcpStatusCalls = 0;
    mcpStatusArgs = [];
    appListCalls = 0;
    codexEventListeners = new Set();

    installWindowApi({
      invoke: async (channel: string, ...args: unknown[]) => {
        if (channel === "worktrees:environments:configs:list") {
          configListCalls += 1;
          return configs;
        }

        if (channel === "worktrees:environments:list") {
          optionListCalls += 1;
          return configs.map((config) => ({
            path: config.configPath,
            name: config.name,
            hasSetupScript: config.hasSetupScript,
            hasCleanupScript: config.hasCleanupScript,
            actionCount: config.actionCount,
          }));
        }

        if (channel === "worktrees:environments:config:read") {
          snapshotCalls += 1;
          return makeSnapshot(configs);
        }

        if (channel === "worktrees:environments:config:save") {
          if (saveResult === "conflict") return { type: "conflict" };
          configs = [
            configs[0] ?? makeConfig("/tmp/project-1/.codex/environment.json"),
            makeConfig("/tmp/project-1/.codex/environment-2.json"),
          ];
          return { type: "success" };
        }

        if (channel === "codex:mcp-server-statuses:list") {
          mcpStatusCalls += 1;
          mcpStatusArgs = args;
          return {
            data: [
              {
                name: "docs",
                serverInfo: null,
                tools: {},
                resources: [],
                resourceTemplates: [],
                runtimeStatus: "connected",
                authStatus: "unsupported",
              },
            ],
            nextCursor: null,
          };
        }

        if (channel === "codex:mcp-apps:list") {
          appListCalls += 1;
          return [makeApp("Docs")];
        }

        throw new Error(`Unexpected channel: ${channel}`);
      },
      on: (channel: string, listener: (...args: unknown[]) => void) => {
        if (channel !== "codex:event") return () => {};
        codexEventListeners.add(listener);
        return () => codexEventListeners.delete(listener);
      },
    });
  });

  test("skips disabled MCP queries and refetches all canonical environment data after success", async () => {
    const view = render(
      <TestQueryProvider>
        <ServerStateHarness />
      </TestQueryProvider>,
    );

    await waitFor(() => {
      expect(view.getByTestId("configs").textContent).toBe("1|1|1");
    });
    expect(configListCalls).toBe(1);
    expect(optionListCalls).toBe(1);
    expect(snapshotCalls).toBe(1);
    expect(mcpStatusCalls).toBe(0);

    fireEvent.click(view.getByRole("button"));
    await settleAsyncRender();

    await waitFor(() => {
      expect(view.getByTestId("configs").textContent).toBe("2|2|2");
    });
    expect(configListCalls).toBe(2);
    expect(optionListCalls).toBe(2);
    expect(snapshotCalls).toBe(2);
    expect(mcpStatusCalls).toBe(0);
  });

  test("keeps canonical environment caches untouched after a conflict", async () => {
    saveResult = "conflict";
    const view = render(
      <TestQueryProvider>
        <ServerStateHarness />
      </TestQueryProvider>,
    );
    await waitFor(() => {
      expect(view.getByTestId("configs").textContent).toBe("1|1|1");
    });

    fireEvent.click(view.getByRole("button"));
    await settleAsyncRender();

    expect(configListCalls).toBe(1);
    expect(optionListCalls).toBe(1);
    expect(snapshotCalls).toBe(1);
  });

  test("shares one host catalog request across independent MCP consumers", async () => {
    const view = render(
      <TestQueryProvider>
        <McpCatalogConsumer label="first" />
        <McpCatalogConsumer label="second" />
      </TestQueryProvider>,
    );

    await waitFor(() => {
      expect(view.getByTestId("first").textContent).toBe("1");
      expect(view.getByTestId("second").textContent).toBe("1");
    });
    expect(mcpStatusCalls).toBe(1);
    expect(mcpStatusArgs).toEqual([]);
  });

  test("replaces an observed Apps catalog from the host update event", async () => {
    const view = render(
      <NodexQueryProvider>
        <AppsCatalogConsumer />
      </NodexQueryProvider>,
    );

    await waitFor(() => {
      expect(view.getByTestId("apps").textContent).toBe("Docs");
    });
    expect(appListCalls).toBe(1);

    await act(async () => {
      const event: CodexEvent = { type: "appsUpdated", apps: [makeApp("Calendar")] };
      for (const listener of codexEventListeners) listener(event);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(view.getByTestId("apps").textContent).toBe("Calendar");
    });
    expect(appListCalls).toBe(1);
  });

  test("does not warm an unobserved Apps cache from a host update", () => {
    const client = createTestQueryClient();
    const event: CodexEvent = { type: "appsUpdated", apps: [makeApp("Calendar")] };

    applyCodexHostCatalogEvent(client, event);
    expect(client.getQueryData(queryKeys.mcp.apps())).toBeUndefined();

    client.setQueryData(queryKeys.mcp.apps(), [makeApp("Docs")]);
    applyCodexHostCatalogEvent(client, event);
    expect(client.getQueryData<ProtocolAppInfo[]>(queryKeys.mcp.apps())?.[0]?.name).toBe(
      "Calendar",
    );
  });
});
