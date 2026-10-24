import { describe, expect, test } from "vite-plus/test";
import { agentImportInternals } from "./agent-import-operations";

describe("agent import config policy", () => {
  test("keeps only absent, passive config keys", () => {
    const edits = agentImportInternals.buildSafeConfigEdits(
      {
        approval_policy: "never",
        features: { search: true },
        model: "private-model",
        notify: ["private-command"],
        web_search: "live",
      },
      { features: { search: false } },
    );
    expect(edits).toEqual([{ keyPath: "web_search", label: "web_search", value: "live" }]);
  });

  test("removes credentials when translating MCP servers", () => {
    const edits = agentImportInternals.buildMcpConfigEdits(
      {
        mcp_servers: {
          docs: {
            command: "docs-server",
            env: { API_KEY: "must-be-reauthorized" },
          },
        },
      },
      {},
    );
    expect(edits).toEqual([
      {
        keyPath: "mcp_servers",
        label: "docs",
        value: { docs: { command: "docs-server" } },
      },
    ]);
  });
});
