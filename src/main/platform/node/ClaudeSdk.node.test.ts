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
    allowDangerouslySkipPermissions: false,
    persistSession: true,
    effort: "max",
  });
  expect(options.sessionId).toBeUndefined();
});
