import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { expect, test, vi } from "vite-plus/test";
import { source } from "./NativeExecutionPlugin.ts";

test("each OpenCode shell tool execution pins the Run and restores the original command", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nodex-opencode-shell-"));
  vi.stubEnv("NODEX_OPENCODE_CLI_ROUTING", directory);
  vi.stubEnv("NODEX_AGENT_PROFILE_HOME", "/profile");
  try {
    const { default: plugin } = await import(
      /* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
    );
    type ToolEvent = { tool: string; sessionID: string; input: { command: string } };
    type ShellEvent = { command: string; env: Record<string, string> };
    let execute!: (event: ToolEvent) => Promise<void>;
    let create!: (event: ShellEvent) => Promise<void>;
    await plugin.setup({
      tool: { hook: (name: string, hook: typeof execute) => {
        expect(name).toBe("execute.before");
        execute = hook;
      } },
      shell: { hook: (name: string, hook: typeof create) => {
        expect(name).toBe("create.before");
        create = hook;
      } },
    });
    const command = "nodex context";
    for (const [tool, turnId] of [["shell", "run-one"], ["shell", "run-two"], ["bash", "run-three"]]) {
      await writeFile(join(directory, "session"), JSON.stringify({ taskId: "task", bin: "/bin/nodex", turnId }));
      const toolEvent = { tool: tool!, sessionID: "session", input: { command } };
      await execute(toolEvent);
      const shellEvent = { command: toolEvent.input.command, env: { PATH: "/bin" } };
      await create(shellEvent);
      expect(shellEvent.command).toBe(command);
      expect(shellEvent.env).toEqual({
        PATH: ["/bin/nodex", "/bin"].join(delimiter),
        NODEX_AGENT_SHELL: "1",
        NODEX_AGENT_PROFILE_HOME: "/profile",
        NODEX_CLI_TASK_ID: "task",
        NODEX_CLI_TURN_ID: turnId,
      });
    }
    const unboundTool = { tool: "shell", sessionID: "unbound", input: { command } };
    await execute(unboundTool);
    const unboundShell = { command: unboundTool.input.command, env: {} };
    await create(unboundShell);
    expect(unboundShell).toEqual({
      command, env: { NODEX_AGENT_SHELL: "1", NODEX_AGENT_PROFILE_HOME: "/profile" },
    });
  } finally {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
});
