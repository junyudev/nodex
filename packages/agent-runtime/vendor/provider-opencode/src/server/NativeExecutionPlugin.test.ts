import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect, test, vi } from "vite-plus/test";
import { environment, source, withSkills } from "./NativeExecutionPlugin.ts";

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
it.effect("merges desktop skill paths into each generation's inline configuration", () =>
  Effect.gen(function* () {
    const paths = ["/plugins/browser/skills", "/plugins/chrome/skills"];
    const v1 = yield* environment(
      {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          skills: { paths: ["/existing", paths[0]], urls: ["https://catalog.invalid"] },
        }),
      },
      "v1",
      paths,
    );
    assert.deepEqual(JSON.parse(v1.OPENCODE_CONFIG_CONTENT!).skills, {
      paths: ["/existing", ...paths],
      urls: ["https://catalog.invalid"],
    });

    const v2 = yield* environment({
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ skills: ["/existing", paths[0]] }),
    });
    const merged = withSkills(v2, paths);
    assert.deepEqual(JSON.parse(merged.OPENCODE_CONFIG_CONTENT!).skills, ["/existing", ...paths]);
    assert.deepEqual(JSON.parse(v2.OPENCODE_CONFIG_CONTENT!).skills, ["/existing", paths[0]]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
