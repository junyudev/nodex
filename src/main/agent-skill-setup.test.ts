import path from "node:path";
import * as Effect from "effect/Effect";
import { it } from "@effect/vitest";
import { describe, expect, vi } from "vite-plus/test";
import type { MessageBoxOptions, MessageBoxReturnValue } from "electron";

import {
  AgentSkillCliProcessError,
  parseAgentSkillCommandResult,
  runAgentSkillSetup,
  type AgentSkillCliInvocation,
  type AgentSkillCliRunner,
} from "./agent-skill-setup";

const CLI_PATH = path.resolve("/Applications/Nodex.app/Contents/Resources/bin/nodex");

const target = (agent: string, state: string, outcome = "inspected") => ({
  agent,
  changed: false,
  detected: true,
  outcome,
  path: `/Users/test/.${agent}/skills/nodex`,
  state,
});

const commandResult = (operation: string, targets: unknown[], changed = false) => ({
  version: 1,
  ok: true,
  result: {
    schemaVersion: 1,
    operation,
    dryRun: false,
    changed,
    bundle: {
      releaseVersion: "1.2.3",
      source: "/Applications/Nodex.app/Contents/Resources/agent-skills/skills/nodex",
      treeSha256: "a".repeat(64),
    },
    targets,
  },
});

const successfulRunner =
  (
    invocations: AgentSkillCliInvocation[],
    statusTargets = [target("codex", "missing"), target("claude-code", "missing")],
  ): AgentSkillCliRunner =>
  (invocation) =>
    Effect.sync(() => {
      invocations.push(invocation);
      const installing = invocation.argv.includes("install");
      return {
        stderr: "",
        stdout: JSON.stringify(
          installing
            ? commandResult(
                "install",
                statusTargets.map((entry) => ({
                  ...entry,
                  changed: entry.state === "missing",
                  outcome: entry.state === "missing" ? "installed" : "already-installed",
                  state: "managed-current",
                })),
                statusTargets.some((entry) => entry.state === "missing"),
              )
            : commandResult("status", statusTargets),
        ),
      };
    });

const messageBox = (responses: number[], calls: MessageBoxOptions[]) =>
  vi.fn((options: MessageBoxOptions): Effect.Effect<MessageBoxReturnValue> =>
    Effect.sync(() => {
      calls.push(options);
      return {
        response: responses.shift() ?? 0,
        checkboxChecked: false,
      };
    }),
  );

describe("Agent Skill setup", () => {
  it.effect("cancellation performs only the read-only status call", () =>
    Effect.gen(function* () {
      const invocations: AgentSkillCliInvocation[] = [];
      const dialogs: MessageBoxOptions[] = [];
      const result = yield* runAgentSkillSetup({
        cliPath: CLI_PATH,
        runCli: successfulRunner(invocations),
        showMessageBox: messageBox([3], dialogs),
      });

      expect(result.status).toBe("cancelled");
      expect(invocations).toEqual([
        {
          executable: CLI_PATH,
          argv: ["--json", "skills", "status"],
          shell: false,
        },
      ]);
      expect(dialogs).toHaveLength(1);
    }),
  );

  it.effect("uses fixed shell-free argv for the selected Agents", () =>
    Effect.gen(function* () {
      const invocations: AgentSkillCliInvocation[] = [];
      const dialogs: MessageBoxOptions[] = [];
      const result = yield* runAgentSkillSetup({
        cliPath: CLI_PATH,
        pathConfigured: false,
        runCli: successfulRunner(invocations),
        showMessageBox: messageBox([0, 0], dialogs),
      });

      expect(result.status).toBe("installed");
      expect(invocations).toEqual([
        {
          executable: CLI_PATH,
          argv: ["--json", "skills", "status"],
          shell: false,
        },
        {
          executable: CLI_PATH,
          argv: [
            "--json",
            "skills",
            "install",
            "--agent",
            "codex",
            "--agent",
            "claude-code",
            "--yes",
          ],
          shell: false,
        },
      ]);
      expect(dialogs[0]?.detail).toContain("~/.local/bin on PATH");
      expect(dialogs[1]?.type).toBe("info");
    }),
  );

  it.effect("onboarding skips the prompt when both official targets are available", () =>
    Effect.gen(function* () {
      const invocations: AgentSkillCliInvocation[] = [];
      const showMessageBox = vi.fn();
      const result = yield* runAgentSkillSetup({
        cliPath: CLI_PATH,
        onlyWhenMissing: true,
        runCli: successfulRunner(invocations, [
          target("codex", "managed-current"),
          target("claude-code", "compatible-external"),
        ]),
        showMessageBox,
      });

      expect(result.status).toBe("already-configured");
      expect(invocations).toHaveLength(1);
      expect(showMessageBox).not.toHaveBeenCalled();
    }),
  );

  it("preserves unknown target identities in structured status", () => {
    const parsed = parseAgentSkillCommandResult({
      schemaVersion: 1,
      operation: "status",
      dryRun: false,
      changed: false,
      targets: [target("codex", "managed-current"), target("future-agent", "future-state")],
    });

    expect(parsed.targets[1]).toMatchObject({
      agent: "future-agent",
      state: "future-state",
    });
  });

  it.effect("shows structured CLI errors with the exact target path", () =>
    Effect.gen(function* () {
      const dialogs: MessageBoxOptions[] = [];
      const targetPath = "/Users/test/.agents/skills/nodex";
      const result = yield* runAgentSkillSetup({
        cliPath: CLI_PATH,
        runCli: () =>
          Effect.fail(
            new AgentSkillCliProcessError({
              message: "CLI failed",
              stdout: "",
              stderr: JSON.stringify({
                version: 1,
                ok: false,
                error: {
                  code: "SKILL_TARGET_CONFLICT",
                  message: "The target belongs to the user.",
                  path: targetPath,
                },
              }),
            }),
          ),
        showMessageBox: messageBox([0], dialogs),
      });

      expect(result.status).toBe("failed");
      expect(dialogs).toHaveLength(1);
      expect(dialogs[0]?.type).toBe("error");
      expect(dialogs[0]?.detail).toContain(targetPath);
      expect(dialogs[0]?.detail).toContain("SKILL_TARGET_CONFLICT");
    }),
  );
});
