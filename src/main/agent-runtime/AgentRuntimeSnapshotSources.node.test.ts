import { describe, expect, it } from "vitest";
import { nativeHistorySources } from "./AgentRuntimeSnapshotSources";

describe("native snapshot history sources", () => {
  it("uses the physical account home and instance-specific Claude directory without credentials", () => {
    const sources = nativeHistorySources({
      configuration: {
        home: "/profile/agent-runtime",
        cwd: "/repo",
        providers: {
          codex: { driver: "codex", enabled: true, config: { homePath: "/shared/codex" } },
          claude: {
            driver: "claudeAgent",
            enabled: true,
            config: { homePath: "~/work" },
            environment: [
              { name: "ANTHROPIC_API_KEY", value: "private", sensitive: true },
              { name: "CLAUDE_CONFIG_DIR", value: "/ignored", sensitive: false },
            ],
          },
          acp: { driver: "acpRegistry", enabled: true, config: {} },
          remote: {
            driver: "opencode",
            enabled: true,
            config: { serverUrl: "https://service", serverPassword: "private" },
          },
        },
      },
      environment: { HOME: "/user", CLAUDE_CONFIG_DIR: "/global", ANTHROPIC_API_KEY: "private" },
      homeDirectory: "/fallback",
      codexHome: "/physical/shared-home",
    });
    expect(sources).toEqual([
      { providerInstanceId: "codex", driver: "codex", homePath: "/physical/shared-home" },
      { providerInstanceId: "claude", driver: "claudeAgent", homePath: "/user/work" },
      { providerInstanceId: "acp", driver: "acpRegistry", homePath: null },
      { providerInstanceId: "remote", driver: "opencode", homePath: null },
    ]);
  });

  it("captures newly appended restored history without borrowing credential directories", () => {
    expect(
      nativeHistorySources({
        configuration: {
          home: "/profile/agent-runtime",
          cwd: "/repo",
          providers: {
            codex: {
              driver: "codex",
              enabled: true,
              config: {
                homePath: "/profile/agent-runtime/native-history/codex",
                hostAuthentication: true,
              },
            },
            claude: {
              driver: "claudeAgent",
              enabled: true,
              config: {
                homePath: "/private/claude-account",
                restoredHistoryPath: "/profile/agent-runtime/native-history/claude",
              },
            },
          },
        },
        environment: {},
        homeDirectory: "/user",
        codexHome: "/private/codex-account",
      }),
    ).toEqual([
      {
        providerInstanceId: "codex",
        driver: "codex",
        homePath: "/profile/agent-runtime/native-history/codex",
      },
      {
        providerInstanceId: "claude",
        driver: "claudeAgent",
        homePath: "/profile/agent-runtime/native-history/claude",
      },
    ]);
  });

  it("honors Claude's instance environment before inherited and default homes", () => {
    const read = (instanceDirectory?: string, inheritedDirectory?: string) =>
      nativeHistorySources({
        configuration: {
          home: "/profile/agent-runtime",
          cwd: "/repo",
          providers: {
            claude: {
              driver: "claudeAgent",
              enabled: false,
              config: { homePath: "" },
              ...(instanceDirectory
                ? {
                    environment: [
                      { name: "CLAUDE_CONFIG_DIR", value: instanceDirectory, sensitive: false },
                    ],
                  }
                : {}),
            },
          },
        },
        environment: { CLAUDE_CONFIG_DIR: inheritedDirectory },
        homeDirectory: "/fallback",
        codexHome: "/codex",
      })[0]?.homePath;
    expect(read("/instance", "/inherited")).toBe("/instance");
    expect(read(undefined, "/inherited")).toBe("/inherited");
    expect(read()).toBe("/fallback/.claude");
  });
});
