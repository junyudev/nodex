import { describe, expect, it } from "vitest";
import { insightsUsageSources, nativeImportSources } from "./AgentRuntimeNativeImportSources";

describe("native conversation import sources", () => {
  it.each([
    {
      platform: "darwin",
      environment: { HOME: "/user" },
      fallback: "/fallback",
      codexHome: "/physical/shared-home",
      claudeHome: "~/work",
      expectedClaude: "/user/work",
      expectedAntigravity: "/user/.gemini",
    },
    {
      platform: "win32",
      environment: { HOME: "C:/shell-home", UserProfile: "D:/User" },
      fallback: "C:/Fallback",
      codexHome: "C:/physical/shared-home",
      claudeHome: "~\\work",
      expectedClaude: "D:\\User\\work",
      expectedAntigravity: "D:\\User\\.gemini",
    },
  ])(
    "uses the physical account home, instance-specific Claude directory and shared Antigravity history without credentials on $platform",
    ({
      platform,
      environment,
      fallback,
      codexHome,
      claudeHome,
      expectedClaude,
      expectedAntigravity,
    }) => {
      const sources = nativeImportSources({
        configuration: {
          home: "/profile/agent-runtime",
          cwd: "/repo",
          providers: {
            codex: { driver: "codex", enabled: true, config: { homePath: "/shared/codex" } },
            claude: {
              driver: "claudeAgent",
              enabled: true,
              config: { homePath: claudeHome },
              environment: [
                { name: "ANTHROPIC_API_KEY", value: "private", sensitive: true },
                { name: "CLAUDE_CONFIG_DIR", value: "/ignored", sensitive: false },
              ],
            },
            acp: { driver: "acpRegistry", enabled: true, config: {} },
            agy: {
              driver: "antigravity",
              enabled: true,
              config: {},
              environment: [{ name: "GEMINI_HOME", value: "/profile/agy", sensitive: false }],
            },
            remote: {
              driver: "opencode",
              enabled: true,
              config: { serverUrl: "https://service", serverPassword: "private" },
            },
          },
        },
        environment: { ...environment, CLAUDE_CONFIG_DIR: "/global", ANTHROPIC_API_KEY: "private" },
        platform,
        homeDirectory: fallback,
        codexHome,
      });
      expect(sources).toEqual([
        { providerInstanceId: "codex", driver: "codex", homePath: codexHome },
        { providerInstanceId: "claude", driver: "claudeAgent", homePath: expectedClaude },
        { providerInstanceId: "acp", driver: "acpRegistry", homePath: null },
        { providerInstanceId: "agy", driver: "antigravity", homePath: expectedAntigravity },
        { providerInstanceId: "remote", driver: "opencode", homePath: null },
      ]);
    },
  );

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
                      { name: "Claude_Config_Dir", value: instanceDirectory, sensitive: false },
                    ],
                  }
                : {}),
            },
          },
        },
        environment: {
          HOME: "C:/shell-home",
          Claude_Config_Dir: inheritedDirectory,
        },
        platform: "win32",
        homeDirectory: "D:/Account",
        codexHome: "D:/Account/.codex",
      })[0]?.homePath;
    expect(read("D:/instance", "D:/inherited")).toBe("D:\\instance");
    expect(read(undefined, "D:/inherited")).toBe("D:\\inherited");
    expect(read()).toBe("D:\\Account\\.claude");
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
      platform: "darwin",
      homeDirectory: "/native",
      codexHome: "/native/codex",
    }),
  ).toEqual([
    { providerInstanceId: "nodex_codex", driver: "codex", homePath: null },
    { providerInstanceId: "nodex_claude", driver: "claudeAgent", homePath: null },
  ]);
});

describe("Insights usage sources", () => {
  const read = (
    providers: Parameters<typeof insightsUsageSources>[0]["configuration"]["providers"],
    environment: Readonly<Record<string, string | undefined>> = { HOME: "/user" },
  ) =>
    insightsUsageSources({
      configuration: { home: "/profile/agent-runtime", cwd: "/repo", providers },
      environment,
      platform: "darwin",
      homeDirectory: "/user",
      codexHome: "/user/.codex",
    });

  it("reads a person's own homes even with no provider configured", () => {
    expect(read({})).toEqual([
      { provider: "claude", home: "/user/.claude", origin: "external" },
      { provider: "codex", home: "/user/.codex", origin: "external" },
      { provider: "codex", home: "/profile/agent", origin: "nodex" },
    ]);
  });

  it("follows an inherited Claude home", () => {
    expect(read({}, { HOME: "/user", CLAUDE_CONFIG_DIR: "/elsewhere" })[0]?.home).toBe(
      "/elsewhere",
    );
    // A home-relative value, as typed into a provider's variables, lives in the account home.
    expect(read({}, { HOME: "/user", CLAUDE_CONFIG_DIR: "~/work-claude" })[0]?.home).toBe(
      "/user/work-claude",
    );
  });

  it("marks a managed account's home as Nodex's own, and names each home once", () => {
    const sources = read({
      nodex_claude: {
        driver: "claudeAgent",
        source: "nodex",
        enabled: true,
        config: { isolated: true },
        environment: [
          { name: "CLAUDE_CONFIG_DIR", value: "/profile/models/claude", sensitive: false },
        ],
      },
      nodex_codex: {
        driver: "codex",
        source: "nodex",
        enabled: true,
        config: { homePath: "/profile/models/codex" },
      },
      claude: { driver: "claudeAgent", enabled: true, config: { homePath: "~/.claude" } },
      remote: { driver: "opencode", enabled: true, config: {} },
    });
    expect(sources).toContainEqual({
      provider: "claude",
      home: "/profile/models/claude",
      origin: "nodex",
    });
    expect(sources).toContainEqual({
      provider: "codex",
      home: "/profile/models/codex",
      origin: "nodex",
    });
    expect(sources.filter((source) => source.home === "/user/.claude")).toHaveLength(1);
    expect(sources.some((source) => source.home.includes("remote"))).toBe(false);
  });
});
