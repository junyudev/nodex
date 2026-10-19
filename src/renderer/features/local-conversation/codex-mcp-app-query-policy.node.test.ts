import { describe, expect, test } from "vite-plus/test";
import { mcpAppsQueryOptions, mcpServerStatusesQueryOptions } from "../../lib/query-options";
import { queryKeys } from "../../lib/query-keys";
import { shouldEnableCodexMcpAppsQuery } from "./codex-mcp-app-query-policy";

describe("Codex MCP app query policy", () => {
  test("waits for a signed-in ChatGPT identity and honors the caller gate", () => {
    expect(
      shouldEnableCodexMcpAppsQuery({
        account: null,
        appsFeatureEnabled: true,
        callerEnabled: true,
        productSupportsApps: true,
      }),
    ).toBe(false);
    expect(
      shouldEnableCodexMcpAppsQuery({
        account: { status: "ready", account: { type: "apiKey" }, requiresOpenAiAuth: false },
        appsFeatureEnabled: true,
        callerEnabled: true,
        productSupportsApps: true,
      }),
    ).toBe(false);
    expect(
      shouldEnableCodexMcpAppsQuery({
        account: {
          status: "ready",
          account: { type: "chatgpt", email: "fixture@example.test", planType: "team" },
          requiresOpenAiAuth: true,
        },
        appsFeatureEnabled: true,
        callerEnabled: true,
        productSupportsApps: true,
      }),
    ).toBe(true);
    expect(
      shouldEnableCodexMcpAppsQuery({
        account: {
          status: "ready",
          account: { type: "chatgpt", email: "fixture@example.test", planType: "team" },
          requiresOpenAiAuth: true,
        },
        appsFeatureEnabled: true,
        callerEnabled: false,
        productSupportsApps: true,
      }),
    ).toBe(false);
    expect(
      shouldEnableCodexMcpAppsQuery({
        account: {
          status: "ready",
          account: { type: "chatgpt", email: "fixture@example.test", planType: "team" },
          requiresOpenAiAuth: true,
        },
        appsFeatureEnabled: false,
        callerEnabled: true,
        productSupportsApps: true,
      }),
    ).toBe(false);
    expect(
      shouldEnableCodexMcpAppsQuery({
        account: {
          status: "ready",
          account: { type: "chatgpt", email: "fixture@example.test", planType: "team" },
          requiresOpenAiAuth: true,
        },
        appsFeatureEnabled: true,
        callerEnabled: true,
        productSupportsApps: false,
      }),
    ).toBe(false);
  });

  test("uses the exact five-minute stale window without query-library retries", () => {
    const options = mcpAppsQueryOptions();
    expect(options.staleTime).toBe(5 * 60_000);
    expect(options.retry).toBe(false);
    expect(options.queryKey).toEqual(queryKeys.mcp.apps());
    expect(options.queryKey).toEqual(["mcp", "apps"]);

    const statusesOptions = mcpServerStatusesQueryOptions();
    expect(statusesOptions.staleTime).toBe(5 * 60_000);
    expect(statusesOptions.queryKey).toEqual(queryKeys.mcp.statuses());
    expect(statusesOptions.queryKey).toEqual(["mcp", "statuses"]);
  });
});
