import { expect, it } from "vite-plus/test";
import { claudeEnvironment, claudeDiscoveryOptions } from "./ClaudeSdk";
const instance = {
  id: "work",
  displayName: "Work",
  binaryPath: "claude",
  configDirectory: "/config/work",
  enabled: true,
  environment: [],
  customModels: [],
};
it("uses native configuration sources and isolates account selection without changing HOME", () => {
  const environment = {
    HOME: "/users/me",
    PATH: "/bin",
    CLAUDECODE: "1",
    ANTHROPIC_BASE_URL: "https://router.example",
  };
  expect(claudeEnvironment(environment, instance)).toEqual({
    HOME: "/users/me",
    PATH: "/bin",
    ANTHROPIC_BASE_URL: "https://router.example",
    CLAUDE_CONFIG_DIR: "/config/work",
  });
  expect(environment.CLAUDECODE).toBe("1");
  const options = claudeDiscoveryOptions(
    {
      instance,
      environment,
      cwd: "/workspace",
    },
    "/bin/claude",
  );
  expect(options).toMatchObject({
    pathToClaudeCodeExecutable: "/bin/claude",
    cwd: "/workspace",
    settingSources: ["user", "project", "local"],
    permissionMode: "dontAsk",
    allowDangerouslySkipPermissions: false,
    persistSession: false,
  });
  expect(options.sessionId).toBeUndefined();
});

it("expands explicit native account paths and rejects relative account drift", () => {
  expect(
    claudeEnvironment({ HOME: "/users/me" }, { ...instance, configDirectory: "~/work-claude" })
      .CLAUDE_CONFIG_DIR,
  ).toBe("/users/me/work-claude");
  expect(() =>
    claudeEnvironment({ HOME: "/users/me" }, { ...instance, configDirectory: "relative" }),
  ).toThrow("must be absolute");
});

it("metadata discovery disables executable integrations and never persists a conversation", () => {
  expect(
    claudeDiscoveryOptions(
      { instance, environment: { HOME: "/users/me", FORCE_CODE_TERMINAL: "1" }, cwd: "/workspace" },
      "/bin/claude",
    ),
  ).toMatchObject({
    tools: [],
    allowedTools: [],
    strictMcpConfig: true,
    mcpServers: {},
    settings: { disableAllHooks: true },
    allowDangerouslySkipPermissions: false,
    persistSession: false,
    env: {
      ENABLE_CLAUDEAI_MCP_SERVERS: "false",
      CLAUDE_CODE_AUTO_CONNECT_IDE: "0",
      CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: "1",
    },
  });
});
