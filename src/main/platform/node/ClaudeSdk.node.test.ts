import { expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { claudeEnvironment, claudeQueryOptions } from "./ClaudeSdk";
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
  const options = claudeQueryOptions(
    {
      instance,
      environment,
      cwd: "/workspace",
      sessionId: "session",
      resume: true,
      effort: "max",
      permissionMode: "default",
      canUseTool: () => Effect.succeed({ behavior: "deny", message: "test" }),
    },
    "/bin/claude",
  );
  expect(options).toMatchObject({
    pathToClaudeCodeExecutable: "/bin/claude",
    cwd: "/workspace",
    resume: "session",
    settingSources: ["user", "project", "local"],
    permissionMode: "default",
    allowDangerouslySkipPermissions: true,
    persistSession: true,
    effort: "max",
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

it("discovery and helpers keep native model configuration while disabling executable integrations", () => {
  const input = {
    instance,
    environment: { HOME: "/users/me" },
    cwd: "/workspace",
    sessionId: "session",
    resume: false,
    permissionMode: "dontAsk" as const,
    canUseTool: () => Effect.succeed({ behavior: "deny" as const, message: "test" }),
  };
  for (const purpose of ["discovery", "helper"] as const) {
    const options = claudeQueryOptions(
      { ...input, purpose, ...(purpose === "helper" ? { outputSchema: { type: "object" } } : {}) },
      "/bin/claude",
    );
    expect(options).toMatchObject({
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
    if (purpose === "helper")
      expect(options).toMatchObject({
        maxTurns: 1,
        outputFormat: { type: "json_schema", schema: { type: "object" } },
      });
  }
  expect(
    claudeQueryOptions(
      {
        ...input,
        launchContext: {
          systemPromptAppend: "Trusted owner instructions",
          mcpServers: { trusted: { type: "stdio", command: "/app/tool" } },
        },
      },
      "/bin/claude",
    ),
  ).toMatchObject({
    systemPrompt: { append: "Trusted owner instructions" },
    mcpServers: { trusted: { command: "/app/tool" } },
  });
});
