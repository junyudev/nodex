import { describe, expect, vi, test, afterEach } from "vite-plus/test";
import path from "node:path";
import { delimiter, dirname, join } from "node:path";
import * as Effect from "effect/Effect";
import { it } from "@effect/vitest";
import type { MessageBoxOptions, MessageBoxReturnValue } from "electron";
import {
  AgentSkillCliProcessError,
  parseAgentSkillCommandResult,
  runAgentSkillSetup,
  type AgentSkillCliInvocation,
  type AgentSkillCliRunner,
} from "./agent-skill-setup";
import {
  runMacApplicationsInstallerGate,
  type MacApplicationsInstallerEnvironment,
  type MacApplicationsInstallerPromptChoice,
} from "./macos-applications-installer";
import { resolveBootstrapConfig } from "./bootstrap-config";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { installCliCommand } from "./cli-command-installer";
import { resolveNodexHomePath } from "./nodex-home";

describe("agent-skill-setup", () => {
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
});

describe("macos-applications-installer", () => {
  function makeEnvironment(
    overrides: Partial<MacApplicationsInstallerEnvironment> = {},
  ): MacApplicationsInstallerEnvironment {
    return {
      platform: "darwin",
      isPackaged: true,
      launchKind: "ordinary",
      isInApplicationsFolder: () => false,
      showInstallPrompt: async () => "continue",
      showMoveFailedPrompt: async () => "quit",
      moveToApplicationsFolder: () => false,
      ...overrides,
    };
  }

  describe("runMacApplicationsInstallerGate", () => {
    test("skips non-mac, unpackaged, and already-installed launches", async () => {
      expect(await runMacApplicationsInstallerGate(makeEnvironment({ platform: "linux" }))).toBe(
        "continue",
      );
      expect(await runMacApplicationsInstallerGate(makeEnvironment({ isPackaged: false }))).toBe(
        "continue",
      );
      expect(
        await runMacApplicationsInstallerGate(
          makeEnvironment({ isInApplicationsFolder: () => true }),
        ),
      ).toBe("continue");
    });

    test("keeps supervised packaged launches non-interactive and non-mutating", async () => {
      let applicationsFolderChecks = 0;
      let promptCalls = 0;
      let moveCalls = 0;

      const result = await runMacApplicationsInstallerGate(
        makeEnvironment({
          launchKind: "supervised",
          isInApplicationsFolder: () => {
            applicationsFolderChecks += 1;
            return false;
          },
          showInstallPrompt: async () => {
            promptCalls += 1;
            return "move";
          },
          moveToApplicationsFolder: () => {
            moveCalls += 1;
            return true;
          },
        }),
      );

      expect(result).toBe("continue");
      expect({ applicationsFolderChecks, moveCalls, promptCalls }).toEqual({
        applicationsFolderChecks: 0,
        moveCalls: 0,
        promptCalls: 0,
      });
    });

    test("honors continue and quit prompt choices", async () => {
      expect(
        await runMacApplicationsInstallerGate(
          makeEnvironment({
            showInstallPrompt: async () => "continue",
          }),
        ),
      ).toBe("continue");
      expect(
        await runMacApplicationsInstallerGate(
          makeEnvironment({
            showInstallPrompt: async () => "quit",
          }),
        ),
      ).toBe("quit");
    });

    test("moves to Applications and forwards conflict handling", async () => {
      let conflictHandlerResult = false;
      const result = await runMacApplicationsInstallerGate(
        makeEnvironment({
          showInstallPrompt: async () => "move",
          confirmMoveConflict: () => true,
          moveToApplicationsFolder: (options) => {
            conflictHandlerResult = options.conflictHandler?.("exists") ?? false;
            return true;
          },
        }),
      );

      expect(result).toBe("moved");
      expect(conflictHandlerResult).toBe(true);
    });

    test("never replaces an installed copy that is still running", async () => {
      let conflictWasReported = false;
      const result = await runMacApplicationsInstallerGate(
        makeEnvironment({
          showInstallPrompt: async () => "move",
          confirmMoveConflict: (conflictType) => {
            conflictWasReported = conflictType === "existsAndRunning";
            return true;
          },
          moveToApplicationsFolder: (options) => {
            expect(options.conflictHandler?.("existsAndRunning")).toBe(false);
            return false;
          },
        }),
      );

      expect(result).toBe("quit");
      expect(conflictWasReported).toBe(true);
    });

    test("uses the failed-move prompt when move returns false or throws", async () => {
      const failedChoices: MacApplicationsInstallerPromptChoice[] = [];
      const returnedFalse = await runMacApplicationsInstallerGate(
        makeEnvironment({
          showInstallPrompt: async () => "move",
          showMoveFailedPrompt: async () => {
            failedChoices.push("continue");
            return "continue";
          },
          moveToApplicationsFolder: () => false,
        }),
      );
      const threw = await runMacApplicationsInstallerGate(
        makeEnvironment({
          showInstallPrompt: async () => "move",
          showMoveFailedPrompt: async () => {
            failedChoices.push("quit");
            return "quit";
          },
          moveToApplicationsFolder: () => {
            throw new Error("copy failed");
          },
        }),
      );

      expect(returnedFalse).toBe("continue");
      expect(threw).toBe("quit");
      expect(failedChoices.join("|")).toBe("continue|quit");
    });
  });
});

describe("bootstrap-config", () => {
  function makeVirtualFs(files: Record<string, string>) {
    const entries = Object.fromEntries(
      Object.entries(files).map(([file, body]) => [path.resolve(file), body]),
    );
    return {
      exists: (filePath: string) => Object.prototype.hasOwnProperty.call(entries, filePath),
      readFile: (filePath: string) => entries[filePath] ?? "",
    };
  }

  describe("resolveBootstrapConfig", () => {
    test("prefers NODEX_HOME and resolves relative env paths from cwd", () => {
      const cwd = path.resolve("/workspace/project");

      expect(
        resolveBootstrapConfig({
          isPackaged: false,
          cwd,
          env: { NODEX_HOME: "relative-data" },
          homeDir: path.resolve("/home/user"),
        }),
      ).toMatchObject({
        nodexHome: path.join(cwd, "relative-data"),
        profileSettingsPath: path.join(cwd, "relative-data", "config.toml"),
      });
    });

    test("requires an explicit Profile for unpackaged Desktop startup", () => {
      const files = makeVirtualFs({
        "/workspace/project/.nodex/config.toml": '[server]\nhome = "legacy-development-home"\n',
      });

      expect(() =>
        resolveBootstrapConfig({
          isPackaged: false,
          cwd: path.resolve("/workspace/project"),
          env: {},
          homeDir: path.resolve("/home/user"),
          exists: files.exists,
          readFile: files.readFile,
        }),
      ).toThrow(
        "Unpackaged Nodex requires NODEX_HOME. Start development with `vp run dev` or provide an isolated Profile explicitly.",
      );
    });

    test("merges user and project config with project home taking precedence", () => {
      const cwd = path.resolve("/workspace/project/subdir");
      const files = makeVirtualFs({
        "/home/user/.nodex/config.toml": '[server]\nhome = "~/user-data"\n',
        "/workspace/project/.nodex/config.toml": '[server]\nhome = "project-data"\n',
      });

      expect(
        resolveBootstrapConfig({
          isPackaged: true,
          cwd,
          env: {},
          homeDir: path.resolve("/home/user"),
          exists: files.exists,
          readFile: files.readFile,
        }),
      ).toMatchObject({
        nodexHome: path.join(cwd, "project-data"),
        personalNodexHome: path.resolve("/home/user/user-data"),
        projectBootstrapConfigPath: path.resolve("/workspace/project/.nodex/config.toml"),
        userBootstrapConfigPath: path.resolve("/home/user/.nodex/config.toml"),
      });
    });

    test("expands tilde config paths and falls back to the default Nodex home", () => {
      const files = makeVirtualFs({
        "/home/user/.nodex/config.toml": '[server]\nhome = "~/custom-nodex"\n',
      });

      expect(
        resolveBootstrapConfig({
          isPackaged: true,
          cwd: path.resolve("/workspace/project"),
          env: {},
          homeDir: path.resolve("/home/user"),
          exists: files.exists,
          readFile: files.readFile,
        }),
      ).toMatchObject({
        nodexHome: path.resolve("/home/user/custom-nodex"),
        profileSettingsPath: path.resolve("/home/user/custom-nodex/config.toml"),
      });

      expect(
        resolveBootstrapConfig({
          isPackaged: true,
          cwd: path.resolve("/workspace/project"),
          env: {},
          homeDir: path.resolve("/home/user"),
          exists: () => false,
        }),
      ).toMatchObject({
        nodexHome: path.resolve("/home/user/.nodex"),
        profileSettingsPath: path.resolve("/home/user/.nodex/config.toml"),
      });
    });

    test("fails closed when an existing bootstrap config is malformed", () => {
      const files = makeVirtualFs({
        "/home/user/.nodex/config.toml": "[server\n",
      });

      expect(() =>
        resolveBootstrapConfig({
          isPackaged: true,
          cwd: path.resolve("/workspace/project"),
          env: {},
          homeDir: path.resolve("/home/user"),
          exists: files.exists,
          readFile: files.readFile,
        }),
      ).toThrow();
    });
  });
});

describe("cli-command-installer", () => {
  const temporaryDirectories: string[] = [];

  const makeTemporaryDirectory = (): string => {
    const directory = mkdtempSync(join(tmpdir(), "nodex-cli-installer-"));
    temporaryDirectories.push(directory);
    return directory;
  };

  const makePackagedCli = (root: string, appName = "Nodex.app"): string => {
    const cli = join(root, appName, "Contents/Resources/bin/nodex");
    mkdirSync(dirname(cli), { recursive: true });
    writeFileSync(cli, "#!/bin/sh\n", { mode: 0o755 });
    chmodSync(cli, 0o755);
    return cli;
  };

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  describe("installCliCommand", () => {
    test("installs one symlink to the packaged CLI and detects PATH", () => {
      const root = makeTemporaryDirectory();
      const sourcePath = makePackagedCli(root);
      const targetPath = join(root, ".local/bin/nodex");

      const result = installCliCommand({
        environmentPath: [join(root, ".local/bin"), "/usr/bin"].join(delimiter),
        sourcePath,
        targetPath,
      });

      expect(result).toMatchObject({
        pathConfigured: true,
        sourcePath,
        status: "installed",
        targetPath,
      });
      expect(lstatSync(targetPath).isSymbolicLink()).toBe(true);
      expect(readlinkSync(targetPath)).toBe(sourcePath);
    });

    test("is idempotent and updates only an earlier Nodex app symlink", () => {
      const root = makeTemporaryDirectory();
      const previousSource = makePackagedCli(join(root, "previous"));
      const sourcePath = makePackagedCli(join(root, "current"));
      const targetPath = join(root, ".local/bin/nodex");
      mkdirSync(dirname(targetPath), { recursive: true });
      symlinkSync(previousSource, targetPath);

      expect(
        installCliCommand({
          sourcePath,
          targetPath,
        }).status,
      ).toBe("updated");
      expect(readlinkSync(targetPath)).toBe(sourcePath);
      expect(
        installCliCommand({
          sourcePath,
          targetPath,
        }).status,
      ).toBe("already-installed");
    });

    test("refuses to overwrite files and unrelated symlinks", () => {
      const root = makeTemporaryDirectory();
      const sourcePath = makePackagedCli(root);
      const targetPath = join(root, ".local/bin/nodex");
      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, "unrelated");

      expect(() =>
        installCliCommand({
          sourcePath,
          targetPath,
        }),
      ).toThrow("existing non-symlink");

      rmSync(targetPath);
      symlinkSync("/usr/bin/true", targetPath);
      expect(() =>
        installCliCommand({
          sourcePath,
          targetPath,
        }),
      ).toThrow("not managed by Nodex");
    });
  });
});

describe("nodex-home", () => {
  const baseOptions = {
    cwd: "/workspace/project",
    platform: "linux",
    env: {},
    userHome: "/home/user",
  } satisfies Parameters<typeof resolveNodexHomePath>[0];

  describe("resolveNodexHomePath", () => {
    test("prefers an absolute environment override", () => {
      expect(
        resolveNodexHomePath({
          ...baseOptions,
          env: { NODEX_HOME: "/profiles/work" },
          configuredHome: "/profiles/configured",
        }),
      ).toBe("/profiles/work");
    });

    test("resolves relative environment overrides from the launch directory", () => {
      expect(
        resolveNodexHomePath({
          ...baseOptions,
          env: { NODEX_HOME: "relative-profile" },
        }),
      ).toBe(path.posix.join(baseOptions.cwd, "relative-profile"));
    });

    test("ignores a blank environment override", () => {
      expect(
        resolveNodexHomePath({
          ...baseOptions,
          env: { NODEX_HOME: "   " },
          configuredHome: "/profiles/configured",
        }),
      ).toBe("/profiles/configured");
    });

    test("resolves absolute, relative, and tilde-configured homes", () => {
      expect(
        resolveNodexHomePath({
          ...baseOptions,
          configuredHome: "/profiles/configured",
        }),
      ).toBe("/profiles/configured");
      expect(
        resolveNodexHomePath({
          ...baseOptions,
          configuredHome: "project-profile",
        }),
      ).toBe(path.posix.join(baseOptions.cwd, "project-profile"));
      expect(
        resolveNodexHomePath({
          ...baseOptions,
          configuredHome: "~/custom-nodex",
        }),
      ).toBe("/home/user/custom-nodex");
    });

    test("defaults to the hidden Nodex home under the user home", () => {
      expect(resolveNodexHomePath(baseOptions)).toBe("/home/user/.nodex");
    });
  });

  test("resolves Windows drive, UNC and tilde homes with Windows path semantics", () => {
    const windows = {
      platform: "win32",
      cwd: "C:\\工作\\repo",
      userHome: "C:\\Users\\Ada",
      env: {},
    };
    expect(resolveNodexHomePath(windows)).toBe("C:\\Users\\Ada\\.nodex");
    expect(resolveNodexHomePath({ ...windows, configuredHome: "~\\My Profile" })).toBe(
      "C:\\Users\\Ada\\My Profile",
    );
    expect(resolveNodexHomePath({ ...windows, env: { NODEX_HOME: "D:\\Profiles\\work" } })).toBe(
      "D:\\Profiles\\work",
    );
    expect(
      resolveNodexHomePath({ ...windows, env: { NODEX_HOME: "\\\\server\\profiles\\work" } }),
    ).toBe("\\\\server\\profiles\\work");
  });
});
