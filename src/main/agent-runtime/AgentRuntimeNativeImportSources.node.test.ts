import path from "node:path";
import { describe, expect, it } from "vitest";
import { nativeImportSources } from "./AgentRuntimeNativeImportSources";

describe("native conversation import sources", () => {
  it("uses the physical account home and instance-specific Claude directory without credentials", () => {
    const sources = nativeImportSources({
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
      { providerInstanceId: "claude", driver: "claudeAgent", homePath: path.resolve("/user/work") },
      { providerInstanceId: "acp", driver: "acpRegistry", homePath: null },
      { providerInstanceId: "remote", driver: "opencode", homePath: null },
    ]);
  });

  it("honors Claude's instance environment before inherited and default homes", () => {
    const read = (instanceDirectory?: string, inheritedDirectory?: string) =>
      nativeImportSources({
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
    expect(read(path.resolve("/instance"), path.resolve("/inherited"))).toBe(
      path.resolve("/instance"),
    );
    expect(read(undefined, path.resolve("/inherited"))).toBe(path.resolve("/inherited"));
    expect(read()).toBe(path.resolve("/fallback/.claude"));
  });
});

it("never substitutes the user Codex or Claude home for a managed account during native import", () => {
  expect(
    nativeImportSources({
      configuration: {
        home: "/profile/runtime",
        cwd: "/repo",
        providers: {
          nodex_codex: {
            driver: "codex",
            source: "nodex",
            config: { homePath: "/profile/account/models/codex" },
          },
          nodex_claude: {
            driver: "claudeAgent",
            source: "nodex",
            config: { homePath: "/profile/account/models/claude" },
          },
        },
      },
      environment: { CLAUDE_CONFIG_DIR: "/native/claude" },
      homeDirectory: "/native",
      codexHome: "/native/codex",
    }),
  ).toEqual([
    { providerInstanceId: "nodex_codex", driver: "codex", homePath: null },
    { providerInstanceId: "nodex_claude", driver: "claudeAgent", homePath: null },
  ]);
});
