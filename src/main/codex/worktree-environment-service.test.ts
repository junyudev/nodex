import { describe, expect, test, vi, it as itworktreeenvironmentcodec } from "vite-plus/test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";
import type { WorktreeEnvironmentDefinition } from "../../shared/types";
import {
  WORKTREE_ENVIRONMENT_MAX_BYTES,
  parseWorktreeEnvironmentToml,
  serializeWorktreeEnvironmentDefinition,
  WORKTREE_ENVIRONMENT_ACTION_MAX_COUNT,
  WORKTREE_ENVIRONMENT_ACTION_NAME_MAX_CHARS,
  WORKTREE_ENVIRONMENT_SCRIPT_MAX_BYTES,
} from "./worktree-environment-codec";
import {
  listWorktreeEnvironmentConfigs,
  listWorktreeEnvironmentOptions,
  readWorktreeEnvironmentDefinition,
  readWorktreeEnvironmentSettingsSnapshot,
  saveWorktreeEnvironmentConfigFile as saveWorktreeEnvironmentConfigFileTransaction,
} from "./worktree-environment-service";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { assert, it } from "@effect/vitest";
import type { CodexWorktreeWorkerCreateInput } from "./codex-worktree-worker-protocol";
import { makeCodexRemoteWorktreeWorker } from "./codex-remote-worktree-worker";
import {
  CODEX_WORKTREE_WORKER_PROTOCOL_VERSION,
  type CodexWorktreeWorkerHostMessage,
} from "../worktree-worker/worktree-worker-protocol";
import {
  CODEX_OWNER_METADATA_MIGRATION_CUTOFF_MS,
  CODEX_OWNERLESS_WORKTREE_GRACE_MS,
  planManagedWorktreeRetention,
  type CodexManagedWorktreeRetentionPlanInput,
  type CodexManagedWorktreeRetentionRecord,
} from "./codex-managed-worktree-retention";
import { lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import {
  chatDirectoryName,
  createCodexProjectlessWorkspace,
  formatCodexProjectlessLocalDate,
  parseCodexProjectlessWorkspace,
  type CodexProjectlessWorkspaceFileSystem,
} from "./codex-projectless-workspace";

describe("worktree-environment-service", () => {
  const saveWorktreeEnvironmentConfigFile = (
    input: Parameters<typeof saveWorktreeEnvironmentConfigFileTransaction>[0],
  ) => saveWorktreeEnvironmentConfigFileTransaction(input);

  function createWorkspace(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "nodex-worktree-env-"));
  }

  function removeWorkspace(workspacePath: string): void {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }

  function environmentPath(workspacePath: string, fileName = "environment.toml"): string {
    return path.join(workspacePath, ".codex", "environments", fileName);
  }

  function writeEnvironmentFile(workspacePath: string, fileName: string, contents: string): void {
    const absolutePath = environmentPath(workspacePath, fileName);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, contents, "utf8");
  }

  function makeEnvironment(name: string): WorktreeEnvironmentDefinition {
    return {
      version: 1,
      name,
      setup: { script: "bun install", platformScripts: { linux: "pnpm install" } },
      cleanup: { script: null, platformScripts: {} },
      actions: [
        {
          name: "Test",
          icon: "test",
          command: "bun test",
          platform: null,
        },
      ],
    };
  }

  function referenceRaw(name: string): string {
    return [
      "version = 1",
      `name = ${JSON.stringify(name)}`,
      "[setup]",
      'script = "bun install"',
      "",
    ].join("\n");
  }

  function revisionFor(raw: string): string {
    return `sha256:${createHash("sha256").update(raw, "utf8").digest("hex")}`;
  }

  describe("worktree-environment-service", () => {
    test("lists strict configs and options with local-environment metadata", async () => {
      const workspacePath = createWorkspace();
      writeEnvironmentFile(
        workspacePath,
        "environment.toml",
        [
          "version = 1",
          'name = "Studio"',
          "[setup]",
          'script = "bun install"',
          "[cleanup]",
          'script = "git clean -fd"',
          "[[actions]]",
          'name = "Run tests"',
          'icon = "test"',
          'command = "bun test"',
          "",
        ].join("\n"),
      );
      writeEnvironmentFile(
        workspacePath,
        "environment-2.toml",
        ['name = "Plain"', "[setup]", 'script = ""', ""].join("\n"),
      );
      writeEnvironmentFile(workspacePath, "broken.toml", "name = ");

      try {
        const configs = await listWorktreeEnvironmentConfigs(workspacePath);
        const options = await listWorktreeEnvironmentOptions(workspacePath);

        expect(configs.map((config) => config.state)).toEqual(["parseError", "success", "success"]);
        expect(configs[1]).toMatchObject({
          configPath: ".codex/environments/environment-2.toml",
          name: "Plain",
          hasSetupScript: false,
          hasCleanupScript: false,
          actionCount: 0,
        });
        expect(configs[2]).toMatchObject({
          configPath: ".codex/environments/environment.toml",
          name: "Studio",
          hasSetupScript: true,
          hasCleanupScript: true,
          actionCount: 1,
        });
        expect(options.map((option) => option.name)).toEqual(["Plain", "Studio"]);
      } finally {
        removeWorkspace(workspacePath);
      }
    });

    test("returns the selected raw sha256 revision, including parse errors", async () => {
      const workspacePath = createWorkspace();
      const validRaw = referenceRaw("Preferred");
      writeEnvironmentFile(workspacePath, "environment.toml", validRaw);
      writeEnvironmentFile(workspacePath, "broken.toml", "name = ");

      try {
        const snapshot = await readWorktreeEnvironmentSettingsSnapshot({
          projectId: "project",
          projectName: "Project",
          workspacePath,
        });
        expect(snapshot).toMatchObject({
          configPath: ".codex/environments/environment.toml",
          configExists: true,
          revision: revisionFor(validRaw),
          nextConfigPath: ".codex/environments/environment-2.toml",
        });

        const brokenSnapshot = await readWorktreeEnvironmentSettingsSnapshot({
          projectId: "project",
          projectName: "Project",
          workspacePath,
          configPath: ".codex/environments/broken.toml",
        });
        expect(brokenSnapshot.environment).toBeNull();
        expect(brokenSnapshot.parseErrorMessage).not.toBeNull();
        expect(brokenSnapshot.revision).toBe(revisionFor("name = "));
      } finally {
        removeWorkspace(workspacePath);
      }
    });

    test("uses exclusive create and treats identical retries as idempotent", async () => {
      const workspacePath = createWorkspace();
      const input = {
        projectId: "project",
        workspacePath,
        configPath: ".codex/environments/environment.toml",
        expectedRevision: null,
        environment: makeEnvironment("Created"),
      };

      try {
        await expect(saveWorktreeEnvironmentConfigFile(input)).resolves.toEqual({
          type: "success",
        });
        await expect(saveWorktreeEnvironmentConfigFile(input)).resolves.toEqual({
          type: "success",
        });
        await expect(
          saveWorktreeEnvironmentConfigFile({
            ...input,
            environment: makeEnvironment("Different"),
          }),
        ).resolves.toEqual({ type: "conflict" });
      } finally {
        removeWorkspace(workspacePath);
      }
    });

    test("rejects stale external edits but permits idempotent and matching-revision saves", async () => {
      const workspacePath = createWorkspace();
      writeEnvironmentFile(workspacePath, "environment.toml", referenceRaw("Initial"));

      try {
        const initial = await readWorktreeEnvironmentSettingsSnapshot({
          projectId: "project",
          projectName: "Project",
          workspacePath,
        });
        const updated = makeEnvironment("Updated");
        await expect(
          saveWorktreeEnvironmentConfigFile({
            projectId: "project",
            workspacePath,
            configPath: initial.configPath,
            expectedRevision: initial.revision,
            environment: updated,
          }),
        ).resolves.toEqual({ type: "success" });

        await expect(
          saveWorktreeEnvironmentConfigFile({
            projectId: "project",
            workspacePath,
            configPath: initial.configPath,
            expectedRevision: initial.revision,
            environment: updated,
          }),
        ).resolves.toEqual({ type: "success" });

        fs.writeFileSync(environmentPath(workspacePath), referenceRaw("External"), "utf8");
        await expect(
          saveWorktreeEnvironmentConfigFile({
            projectId: "project",
            workspacePath,
            configPath: initial.configPath,
            expectedRevision: initial.revision,
            environment: makeEnvironment("Stale"),
          }),
        ).resolves.toEqual({ type: "conflict" });
        expect(fs.readFileSync(environmentPath(workspacePath), "utf8")).toBe(
          referenceRaw("External"),
        );
      } finally {
        removeWorkspace(workspacePath);
      }
    });

    test("allows an explicit matching revision to replace a parse error", async () => {
      const workspacePath = createWorkspace();
      writeEnvironmentFile(workspacePath, "broken.toml", "name = ");

      try {
        const snapshot = await readWorktreeEnvironmentSettingsSnapshot({
          projectId: "project",
          projectName: "Project",
          workspacePath,
          configPath: ".codex/environments/broken.toml",
        });
        await expect(
          saveWorktreeEnvironmentConfigFile({
            projectId: "project",
            workspacePath,
            configPath: snapshot.configPath,
            expectedRevision: snapshot.revision,
            environment: makeEnvironment("Repaired"),
          }),
        ).resolves.toEqual({ type: "success" });
      } finally {
        removeWorkspace(workspacePath);
      }
    });

    test("keeps oversized files non-overwritable without a revision", async () => {
      const workspacePath = createWorkspace();
      writeEnvironmentFile(
        workspacePath,
        "huge.toml",
        "x".repeat(WORKTREE_ENVIRONMENT_MAX_BYTES + 1),
      );

      try {
        const snapshot = await readWorktreeEnvironmentSettingsSnapshot({
          projectId: "project",
          projectName: "Project",
          workspacePath,
          configPath: ".codex/environments/huge.toml",
        });
        expect(snapshot.revision).toBeNull();
        await expect(
          saveWorktreeEnvironmentConfigFile({
            projectId: "project",
            workspacePath,
            configPath: snapshot.configPath,
            expectedRevision: snapshot.revision,
            environment: makeEnvironment("Unsafe"),
          }),
        ).resolves.toEqual({ type: "conflict" });
      } finally {
        removeWorkspace(workspacePath);
      }
    });

    test("rejects traversal and symlink escapes on read and write", async () => {
      const workspacePath = createWorkspace();
      const outsidePath = createWorkspace();
      fs.mkdirSync(path.join(workspacePath, ".codex"), { recursive: true });
      fs.symlinkSync(outsidePath, path.join(workspacePath, ".codex", "environments"));

      try {
        await expect(
          readWorktreeEnvironmentDefinition({
            workspacePath,
            environmentPath: "../outside.toml",
          }),
        ).rejects.toThrow("inside .codex/environments");
        await expect(
          saveWorktreeEnvironmentConfigFile({
            projectId: "project",
            workspacePath,
            configPath: ".codex/environments/environment.toml",
            expectedRevision: null,
            environment: makeEnvironment("Escape"),
          }),
        ).rejects.toThrow("inside the workspace");
        expect(fs.existsSync(path.join(outsidePath, "environment.toml"))).toBe(false);
      } finally {
        removeWorkspace(workspacePath);
        removeWorkspace(outsidePath);
      }
    });

    test("rejects a target-file symlink that escapes an otherwise safe environment root", async () => {
      const workspacePath = createWorkspace();
      const outsidePath = path.join(createWorkspace(), "outside.toml");
      fs.writeFileSync(outsidePath, referenceRaw("Outside"), "utf8");
      fs.mkdirSync(path.dirname(environmentPath(workspacePath)), { recursive: true });
      fs.symlinkSync(outsidePath, environmentPath(workspacePath));

      try {
        await expect(
          saveWorktreeEnvironmentConfigFile({
            projectId: "project",
            workspacePath,
            configPath: ".codex/environments/environment.toml",
            expectedRevision: null,
            environment: makeEnvironment("Escape"),
          }),
        ).rejects.toThrow("inside .codex/environments");
        expect(fs.readFileSync(outsidePath, "utf8")).toBe(referenceRaw("Outside"));
      } finally {
        removeWorkspace(workspacePath);
        removeWorkspace(path.dirname(outsidePath));
      }
    });

    test("resolves the current platform setup script with default fallback", async () => {
      const workspacePath = createWorkspace();
      writeEnvironmentFile(
        workspacePath,
        "environment.toml",
        [
          'name = "Platform setup"',
          "[setup]",
          'script = "generic setup"',
          "[setup.darwin]",
          'script = "darwin setup"',
          "[setup.linux]",
          'script = "linux setup"',
          "[setup.win32]",
          'script = "windows setup"',
          "",
        ].join("\n"),
      );

      try {
        const definition = await readWorktreeEnvironmentDefinition({
          workspacePath,
          environmentPath: ".codex/environments/environment.toml",
        });
        const expected =
          process.platform === "darwin"
            ? "darwin setup"
            : process.platform === "linux"
              ? "linux setup"
              : process.platform === "win32"
                ? "windows setup"
                : "generic setup";
        expect(definition.setupScript).toBe(expected);
      } finally {
        removeWorkspace(workspacePath);
      }
    });
  });
});

describe("codex-remote-worktree-worker", () => {
  const createInput = (): CodexWorktreeWorkerCreateInput => ({
    requestId: "request-1",
    hostId: "ssh:devbox",
    repositoryPath: "/repo",
    nodexHome: "/nodex",
    managedRoot: "/nodex/worktrees",
    projectId: "project-1",
    targetId: "pending-1",
    threadTitle: "Implement feature",
    startingState: { type: "branch", branchName: "main" },
    localEnvironmentConfigPath: "/repo/.codex/environments/environment.toml",
    setUpSyncedBranch: true,
    propagateLocalWorkspaceFiles: false,
  });

  const makeSshChild = (protocolVersion: number = CODEX_WORKTREE_WORKER_PROTOCOL_VERSION) => {
    const child = new EventEmitter() as EventEmitter & {
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
      stdin: PassThrough;
      stdout: PassThrough;
      stderr: PassThrough;
      kill: (signal: NodeJS.Signals) => boolean;
    };
    child.exitCode = null;
    child.signalCode = null;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const messages: CodexWorktreeWorkerHostMessage[] = [];
    const forcedSignals: NodeJS.Signals[] = [];
    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.exitCode = code;
      child.signalCode = signal;
      child.emit("exit", code, signal);
    };
    child.kill = (signal) => {
      forcedSignals.push(signal);
      finish(null, signal);
      return true;
    };
    let inputBuffer = "";
    child.stdin.setEncoding("utf8");
    child.stdin.on("data", (chunk: string) => {
      inputBuffer += chunk;
      while (true) {
        const newline = inputBuffer.indexOf("\n");
        if (newline < 0) return;
        const line = inputBuffer.slice(0, newline).trim();
        inputBuffer = inputBuffer.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line) as CodexWorktreeWorkerHostMessage;
        messages.push(message);
        if (message.type === "shutdown") {
          finish(0, null);
          continue;
        }
        if (message.type !== "request") continue;
        child.stdout.write(
          `${JSON.stringify({
            type: "ready",
            epoch: 1,
            hostId: "ssh:devbox",
            protocolVersion,
          })}\n`,
        );
        if (protocolVersion !== CODEX_WORKTREE_WORKER_PROTOCOL_VERSION) continue;
        child.stdout.write(
          `${JSON.stringify({
            type: "event",
            id: message.id,
            operation: "create",
            event: {
              operation: "create",
              type: "path-allocated",
              worktreeGitRoot: "/nodex/worktrees/feature/repo",
              worktreeWorkspaceRoot: "/nodex/worktrees/feature/repo",
            },
          })}\n`,
        );
        child.stdout.write(
          `${JSON.stringify({
            type: "result",
            id: message.id,
            operation: "create",
            result: {
              type: "ok",
              success: {
                operation: "create",
                value: {
                  worktreeGitRoot: "/nodex/worktrees/feature/repo",
                  worktreeWorkspaceRoot: "/nodex/worktrees/feature/repo",
                  setupError: null,
                  shellEnvironment: null,
                },
              },
            },
          })}\n`,
        );
      }
    });
    return {
      child: child as unknown as ChildProcessWithoutNullStreams,
      forcedSignals,
      messages,
    };
  };

  it.effect("rejects protocol drift before opening an SSH worker", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const openWorker = vi.fn(async (): Promise<ChildProcessWithoutNullStreams> => {
          throw new Error("SSH should not open");
        });
        const worker = yield* makeCodexRemoteWorktreeWorker({
          hostId: "ssh:devbox",
          openWorker: () => openWorker(),
        });
        const result = yield* Effect.exit(
          worker.request({ operation: "create", input: createInput() }),
        );
        assert.isTrue(Exit.isFailure(result));
        if (Exit.isFailure(result)) {
          assert.include(
            String(Cause.squash(result.cause)),
            'Nodex built an invalid worktree "create" request: input.localEnvironmentConfigPath:',
          );
        }
        assert.strictEqual(openWorker.mock.calls.length, 0);
      }),
    ),
  );

  it.effect("reports both versions when the SSH worker uses a different protocol", () =>
    Effect.gen(function* () {
      const oldVersion = CODEX_WORKTREE_WORKER_PROTOCOL_VERSION - 1;
      const fixture = makeSshChild(oldVersion);
      const scope = yield* Scope.make();
      try {
        const worker = yield* makeCodexRemoteWorktreeWorker({
          hostId: "ssh:devbox",
          openWorker: () => Promise.resolve(fixture.child),
        }).pipe(Scope.provide(scope));
        const result = yield* Effect.exit(
          worker.request({
            operation: "create",
            input: { ...createInput(), localEnvironmentConfigPath: null },
          }),
        );
        assert.isTrue(Exit.isFailure(result));
        if (Exit.isFailure(result)) {
          assert.include(
            String(Cause.squash(result.cause)),
            `protocol version mismatch (expected ${CODEX_WORKTREE_WORKER_PROTOCOL_VERSION}, received ${oldVersion})`,
          );
        }
      } finally {
        // Retirement cannot confirm a request that never received a terminal result.
        assert.isTrue(Exit.isFailure(yield* Effect.exit(Scope.close(scope, Exit.void))));
      }
    }),
  );

  it.effect("frames remote requests and releases the SSH child through its Scope", () =>
    Effect.gen(function* () {
      const fixture = makeSshChild();
      const events: string[] = [];
      const input = {
        ...createInput(),
        threadTitle: "  Implement feature  ",
        startingState: { type: "branch", branchName: "main", onMissing: "create-branch" },
        localEnvironmentConfigPath: null,
      } satisfies CodexWorktreeWorkerCreateInput;
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const worker = yield* makeCodexRemoteWorktreeWorker({
            hostId: "ssh:devbox",
            openWorker: () => Promise.resolve(fixture.child),
          });
          return yield* worker.request(
            {
              operation: "create",
              input,
            },
            {
              onEvent: (event) => Effect.sync(() => events.push(event.type)),
            },
          );
        }),
      );

      assert.deepEqual(events, ["path-allocated"]);
      assert.strictEqual(result.setupError, null);
      assert.deepEqual(
        fixture.messages.map((message) => message.type),
        ["request", "shutdown"],
      );
      const sent = fixture.messages[0];
      assert.strictEqual(sent?.type, "request");
      if (sent?.type === "request") assert.deepEqual(sent.request, { operation: "create", input });
      assert.deepEqual(fixture.forcedSignals, []);
    }),
  );
});

describe("worktree-environment-codec", () => {
  const it = itworktreeenvironmentcodec;
  function makeEnvironment(
    overrides: Partial<WorktreeEnvironmentDefinition> = {},
  ): WorktreeEnvironmentDefinition {
    return {
      version: 1,
      name: "Example",
      setup: { script: null, platformScripts: {} },
      cleanup: { script: null, platformScripts: {} },
      actions: [],
      ...overrides,
    };
  }

  describe("worktree environment codec", () => {
    it("writes the exact minimal byte contract", () => {
      expect(serializeWorktreeEnvironmentDefinition(makeEnvironment())).toBe(
        [
          "# THIS IS AUTOGENERATED. DO NOT EDIT MANUALLY",
          "version = 1",
          'name = "Example"',
          "",
          "[setup]",
          'script = ""',
          "",
        ].join("\n"),
      );
    });

    it("writes lifecycle platforms, cleanup, and actions in stable order", () => {
      expect(
        serializeWorktreeEnvironmentDefinition(
          makeEnvironment({
            setup: {
              script: "default",
              platformScripts: {
                win32: "windows",
                darwin: "mac",
                linux: "linux",
              },
            },
            cleanup: {
              script: null,
              platformScripts: { linux: "clean" },
            },
            actions: [
              { name: " Run ", icon: null, command: " npm run dev ", platform: null },
              { name: "Test", icon: "test", command: "pnpm test", platform: "linux" },
            ],
          }),
        ),
      ).toBe(
        [
          "# THIS IS AUTOGENERATED. DO NOT EDIT MANUALLY",
          "version = 1",
          'name = "Example"',
          "",
          "[setup]",
          'script = "default"',
          "",
          "[setup.darwin]",
          'script = "mac"',
          "",
          "[setup.linux]",
          'script = "linux"',
          "",
          "[setup.win32]",
          'script = "windows"',
          "",
          "[cleanup]",
          'script = ""',
          "",
          "[cleanup.linux]",
          'script = "clean"',
          "",
          "[[actions]]",
          'name = "Run"',
          'command = "npm run dev"',
          "",
          "[[actions]]",
          'name = "Test"',
          'icon = "test"',
          'command = "pnpm test"',
          'platform = "linux"',
          "",
        ].join("\n"),
      );
    });

    it("filters blank and incomplete actions from serialized bytes", () => {
      const raw = serializeWorktreeEnvironmentDefinition(
        makeEnvironment({
          actions: [
            { name: "", icon: "tool", command: "", platform: null },
            { name: "Named", icon: "run", command: "", platform: null },
            { name: "", icon: "test", command: "command", platform: "darwin" },
          ],
        }),
      );

      expect(raw).toBe(serializeWorktreeEnvironmentDefinition(makeEnvironment()));
    });

    it("normalizes line endings and round-trips multiline delimiters and slashes", () => {
      const script = "first\r\ncontains ''' and \\\\ path\rand \"\"\" too";
      const raw = serializeWorktreeEnvironmentDefinition(
        makeEnvironment({
          setup: { script, platformScripts: {} },
        }),
      );
      const parsed = parseWorktreeEnvironmentToml(
        raw,
        "/workspace/.codex/environments/environment.toml",
      );

      expect(parsed.setup.script).toBe("first\ncontains ''' and \\\\ path\nand \"\"\" too");
      expect(raw.endsWith("\n")).toBe(true);
      expect(raw.endsWith("\n\n")).toBe(false);
    });

    it("requires the reference schema while filtering malformed actions", () => {
      expect(() => parseWorktreeEnvironmentToml('name = "Missing setup"\n', "/tmp/a.toml")).toThrow(
        "setup is required",
      );
      expect(() =>
        parseWorktreeEnvironmentToml(
          'version = 0\nname = "Bad"\n[setup]\nscript = ""\n',
          "/tmp/a.toml",
        ),
      ).toThrow("version must be a positive integer");
      expect(() =>
        parseWorktreeEnvironmentToml(
          'name = "Bad"\n[setup]\nscript = ""\n[[actions]]\nname = "Run"\ncommand = "go"\nplatform = "other"\n',
          "/tmp/a.toml",
        ),
      ).toThrow("Action platform");

      const parsed = parseWorktreeEnvironmentToml(
        [
          'name = " Trimmed "',
          "[setup]",
          'script = " setup "',
          "[[actions]]",
          'name = " "',
          'command = "ignored"',
          "[[actions]]",
          'name = " Run "',
          'command = " npm run dev "',
          "",
        ].join("\n"),
        "/tmp/a.toml",
      );

      expect(parsed.name).toBe("Trimmed");
      expect(parsed.setup.script).toBe("setup");
      expect(parsed.actions).toEqual([
        {
          name: "Run",
          icon: null,
          command: "npm run dev",
          platform: null,
        },
      ]);
    });

    it("enforces field and aggregate limits", () => {
      expect(() =>
        serializeWorktreeEnvironmentDefinition(
          makeEnvironment({
            setup: {
              script: "x".repeat(WORKTREE_ENVIRONMENT_SCRIPT_MAX_BYTES + 1),
              platformScripts: {},
            },
          }),
        ),
      ).toThrow("Setup script");
      expect(() =>
        serializeWorktreeEnvironmentDefinition(
          makeEnvironment({
            actions: [
              {
                name: "x".repeat(WORKTREE_ENVIRONMENT_ACTION_NAME_MAX_CHARS + 1),
                icon: null,
                command: "run",
                platform: null,
              },
            ],
          }),
        ),
      ).toThrow("Action 1 name");
      expect(() =>
        serializeWorktreeEnvironmentDefinition(
          makeEnvironment({
            actions: Array.from(
              { length: WORKTREE_ENVIRONMENT_ACTION_MAX_COUNT + 1 },
              (_, index) => ({
                name: `Action ${index}`,
                icon: null,
                command: "run",
                platform: null,
              }),
            ),
          }),
        ),
      ).toThrow("at most 100 actions");
    });
  });
});

describe("codex-managed-worktree-retention", () => {
  const nowMs = Date.parse("2026-08-14T00:00:00.000Z");

  function record(
    name: string,
    overrides: Partial<CodexManagedWorktreeRetentionRecord> = {},
  ): CodexManagedWorktreeRetentionRecord {
    return {
      hostId: "local",
      worktreeGitRoot: `/managed/${name}/repo`,
      createdAtMs: nowMs - 2 * CODEX_OWNERLESS_WORKTREE_GRACE_MS,
      ownerThreadId: null,
      ownerReadFailed: false,
      ...overrides,
    };
  }

  function input(
    records: readonly CodexManagedWorktreeRetentionRecord[],
    overrides: Partial<CodexManagedWorktreeRetentionPlanInput> = {},
  ): CodexManagedWorktreeRetentionPlanInput {
    return {
      enabled: true,
      keepCount: 1,
      metadataComplete: true,
      records,
      threadMetadata: [],
      pathProtections: [],
      protectPreMigrationOwnerlessWorktrees: true,
      nowMs,
      ...overrides,
    };
  }

  describe("planManagedWorktreeRetention", () => {
    test("fails closed when disabled, invalid, or metadata is incomplete", () => {
      expect(planManagedWorktreeRetention(input([], { enabled: false }))).toMatchObject({
        status: "skipped",
        reason: "disabled",
      });
      expect(planManagedWorktreeRetention(input([], { keepCount: 0 }))).toMatchObject({
        status: "skipped",
        reason: "invalid-keep-count",
      });
      expect(planManagedWorktreeRetention(input([], { metadataComplete: false }))).toMatchObject({
        status: "skipped",
        reason: "metadata-incomplete",
      });
    });

    test("protects permanent, pending, newborn, pinned, active, automation, and young roots", () => {
      const records = [
        record("permanent"),
        record("pending"),
        record("newborn"),
        record("pinned", { ownerThreadId: "thread-pinned" }),
        record("active", { ownerThreadId: "thread-active" }),
        record("automation", { ownerThreadId: "thread-automation" }),
        record("young", { createdAtMs: nowMs - CODEX_OWNERLESS_WORKTREE_GRACE_MS + 1 }),
        record("delete-old", { createdAtMs: nowMs - 4 * CODEX_OWNERLESS_WORKTREE_GRACE_MS }),
        record("keep-new", { createdAtMs: nowMs - 2 * CODEX_OWNERLESS_WORKTREE_GRACE_MS }),
      ];
      const plan = planManagedWorktreeRetention(
        input(records, {
          threadMetadata: [
            {
              threadId: "thread-pinned",
              updatedAtMs: 1,
              pinned: true,
              inProgress: false,
              automationProtected: false,
            },
            {
              threadId: "thread-active",
              updatedAtMs: 2,
              pinned: false,
              inProgress: true,
              automationProtected: false,
            },
            {
              threadId: "thread-automation",
              updatedAtMs: 3,
              pinned: false,
              inProgress: false,
              automationProtected: true,
            },
          ],
          pathProtections: [
            { hostId: "local", worktreeGitRoot: records[0]!.worktreeGitRoot, reason: "permanent" },
            { hostId: "local", worktreeGitRoot: records[1]!.worktreeGitRoot, reason: "pending" },
            { hostId: "local", worktreeGitRoot: records[2]!.worktreeGitRoot, reason: "newborn" },
          ],
        }),
      );
      expect(plan.status).toBe("planned");
      expect(plan.delete.map((item) => item.worktreeGitRoot)).toEqual([
        records[7]!.worktreeGitRoot,
      ]);
      expect(
        Object.fromEntries(
          plan.items.map((item) => [item.worktreeGitRoot, item.protectionReasons]),
        ),
      ).toMatchObject({
        [records[0]!.worktreeGitRoot]: ["permanent"],
        [records[1]!.worktreeGitRoot]: ["pending"],
        [records[2]!.worktreeGitRoot]: ["newborn"],
        [records[3]!.worktreeGitRoot]: ["pinned"],
        [records[4]!.worktreeGitRoot]: ["in-progress"],
        [records[5]!.worktreeGitRoot]: ["automation"],
        [records[6]!.worktreeGitRoot]: ["young-ownerless"],
      });
    });

    test("uses the exact migration and one-hour boundaries", () => {
      const plan = planManagedWorktreeRetention(
        input([
          record("migration-before", { createdAtMs: CODEX_OWNER_METADATA_MIGRATION_CUTOFF_MS - 1 }),
          record("migration-at", { createdAtMs: CODEX_OWNER_METADATA_MIGRATION_CUTOFF_MS }),
          record("hour-before", { createdAtMs: nowMs - CODEX_OWNERLESS_WORKTREE_GRACE_MS + 1 }),
          record("hour-at", { createdAtMs: nowMs - CODEX_OWNERLESS_WORKTREE_GRACE_MS }),
        ]),
      );
      const reasons = Object.fromEntries(
        plan.items.map((item) => [item.worktreeGitRoot, item.protectionReasons]),
      );
      expect(reasons["/managed/migration-before/repo"]).toContain("pre-migration-ownerless");
      expect(reasons["/managed/migration-at/repo"]).not.toContain("pre-migration-ownerless");
      expect(reasons["/managed/hour-before/repo"]).toContain("young-ownerless");
      expect(reasons["/managed/hour-at/repo"]).not.toContain("young-ownerless");
    });

    test("sorts ownerless first by birthtime, then owned by owner update time with path ties", () => {
      const plan = planManagedWorktreeRetention(
        input(
          [
            record("ownerless-new", { createdAtMs: 20 }),
            record("owner-b", { ownerThreadId: "thread-b" }),
            record("ownerless-old-b", { createdAtMs: 10 }),
            record("owner-a", { ownerThreadId: "thread-a" }),
            record("ownerless-old-a", { createdAtMs: 10 }),
          ],
          {
            keepCount: 2,
            protectPreMigrationOwnerlessWorktrees: false,
            threadMetadata: [
              {
                threadId: "thread-a",
                updatedAtMs: 30,
                pinned: false,
                inProgress: false,
                automationProtected: false,
              },
              {
                threadId: "thread-b",
                updatedAtMs: 40,
                pinned: false,
                inProgress: false,
                automationProtected: false,
              },
            ],
          },
        ),
      );
      expect(plan.orderedCandidates.map((item) => item.worktreeGitRoot)).toEqual([
        "/managed/ownerless-old-a/repo",
        "/managed/ownerless-old-b/repo",
        "/managed/ownerless-new/repo",
        "/managed/owner-a/repo",
        "/managed/owner-b/repo",
      ]);
      expect(plan.delete).toHaveLength(3);
      expect(plan.keep).toHaveLength(2);
    });

    test("counts only eligible roots against keepCount and keeps shared-owner protection", () => {
      const protectedOwner = record("shared", { ownerThreadId: "owner" });
      const plan = planManagedWorktreeRetention(
        input([protectedOwner, record("one"), record("two")], {
          keepCount: 2,
          threadMetadata: [
            {
              threadId: "owner",
              updatedAtMs: 1,
              pinned: true,
              inProgress: false,
              automationProtected: false,
            },
          ],
        }),
      );
      expect(plan.delete).toEqual([]);
      expect(plan.keep).toHaveLength(3);
    });
  });
});

describe("codex-projectless-workspace", () => {
  async function captureErrorMessage(action: () => Promise<unknown>): Promise<string> {
    try {
      await action();
      return "";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  describe("Codex projectless workspace", () => {
    test("names a folder after the first words of its message, in ASCII", () => {
      expect(formatCodexProjectlessLocalDate(new Date(2026, 0, 2, 23, 59, 59))).toBe("2026-01-02");
      expect(chatDirectoryName("One two three four five six seven eight")).toBe(
        "one-two-three-four-five-six",
      );
      expect(chatDirectoryName("帮我修复 login 页面的 bug")).toBe("login-bug");
      expect(chatDirectoryName("你好，世界")).toBe("new-chat");
      expect(chatDirectoryName("🗂️")).toBe("new-chat");
      expect(chatDirectoryName(null)).toBe("new-chat");
      expect(chatDirectoryName(`${"a".repeat(79)} b`)).toBe("a".repeat(79));
    });

    test("creates a split workspace under the projects directory with cwd at the thread root", async () => {
      const homeDirectory = await mkdtemp(path.join(tmpdir(), "nodex-projectless-home-"));
      try {
        const workspaceRoot = path.join(homeDirectory, "Documents", "Nodex");
        const workspace = await createCodexProjectlessWorkspace({
          createSplitDirectories: true,
          date: new Date(2026, 6, 11, 12),
          workspaceRoot,
          nameHint: "Draft a concise launch report with sources",
        });
        const threadDirectory = path.join(
          workspaceRoot,
          "2026-07-11",
          "draft-a-concise-launch-report-with",
        );

        expect(workspace.workspaceRoot).toBe(workspaceRoot);
        expect(workspace.cwd).toBe(threadDirectory);
        expect(workspace.outputDirectory).toBe(path.join(threadDirectory, "outputs"));
        expect((await lstat(threadDirectory)).isDirectory()).toBe(true);
        expect((await lstat(path.join(threadDirectory, "outputs"))).isDirectory()).toBe(true);
        expect((await lstat(path.join(threadDirectory, "work"))).isDirectory()).toBe(true);
      } finally {
        await rm(homeDirectory, { recursive: true, force: true });
      }
    });

    test("validates a renderer-returned workspace descriptor", () => {
      expect(
        parseCodexProjectlessWorkspace({
          cwd: "/tmp/Nodex/thread",
          outputDirectory: "/tmp/Nodex/thread/outputs",
          workspaceRoot: "/tmp/Nodex",
        }),
      ).toStrictEqual({
        cwd: "/tmp/Nodex/thread",
        outputDirectory: "/tmp/Nodex/thread/outputs",
        workspaceRoot: "/tmp/Nodex",
      });
      expect(() =>
        parseCodexProjectlessWorkspace({
          cwd: "",
          outputDirectory: "/tmp/Nodex/thread/outputs",
          workspaceRoot: "/tmp/Nodex",
        }),
      ).toThrow("Projectless workspace cwd must be a non-empty string");
    });

    test("tries 100 numeric names followed by at most five unique names", async () => {
      const homeDirectory = await mkdtemp(path.join(tmpdir(), "nodex-projectless-collision-"));
      try {
        const workspaceRoot = path.join(homeDirectory, "Documents", "Nodex");
        const dateDirectory = path.join(workspaceRoot, "2026-07-11");
        await mkdir(dateDirectory, { recursive: true });
        for (let index = 0; index < 100; index += 1) {
          const name = index === 0 ? "collision" : `collision-${index + 1}`;
          await mkdir(path.join(dateDirectory, name));
        }
        for (let index = 1; index < 5; index += 1) {
          await mkdir(path.join(dateDirectory, `collision-uuid-${index}`));
        }

        let suffixAttempt = 0;
        const workspace = await createCodexProjectlessWorkspace({
          createSplitDirectories: false,
          date: new Date(2026, 6, 11, 12),
          nameHint: "collision",
          workspaceRoot,
          uniqueDirectoryNameSuffix: () => `uuid-${(suffixAttempt += 1)}`,
        });

        const expectedDirectory = path.join(dateDirectory, "collision-uuid-5");
        expect(suffixAttempt).toBe(5);
        expect(workspace.cwd).toBe(expectedDirectory);
        expect(workspace.outputDirectory).toBe(expectedDirectory);
        expect((await lstat(expectedDirectory)).isDirectory()).toBe(true);
      } finally {
        await rm(homeDirectory, { recursive: true, force: true });
      }
    });

    test("rejects symlinked workspace and date directories", async () => {
      const fixtureRoot = await mkdtemp(path.join(tmpdir(), "nodex-projectless-symlink-"));
      try {
        const homeDirectory = path.join(fixtureRoot, "home");
        const targetDirectory = path.join(fixtureRoot, "target");
        const workspaceRoot = path.join(homeDirectory, "Documents", "Nodex");
        await mkdir(path.dirname(workspaceRoot), { recursive: true });
        await mkdir(targetDirectory);
        await symlink(targetDirectory, workspaceRoot, "dir");

        expect(
          await captureErrorMessage(() =>
            createCodexProjectlessWorkspace({
              createSplitDirectories: false,
              date: new Date(2026, 6, 11, 12),
              workspaceRoot,
              nameHint: "workspace symlink",
            }),
          ),
        ).toBe("Projectless thread directory must be a real directory");

        await rm(workspaceRoot, { force: true });
        await mkdir(workspaceRoot);
        await symlink(targetDirectory, path.join(workspaceRoot, "2026-07-11"), "dir");

        expect(
          await captureErrorMessage(() =>
            createCodexProjectlessWorkspace({
              createSplitDirectories: false,
              date: new Date(2026, 6, 11, 12),
              workspaceRoot,
              nameHint: "date symlink",
            }),
          ),
        ).toBe("Projectless thread directory must be a real directory");
      } finally {
        await rm(fixtureRoot, { recursive: true, force: true });
      }
    });

    test("falls back to one unsplit directory when split subdirectory creation fails", async () => {
      const homeDirectory = await mkdtemp(path.join(tmpdir(), "nodex-projectless-fallback-"));
      const fileSystem: CodexProjectlessWorkspaceFileSystem = {
        async createDirectory(input) {
          if (path.basename(input.path) === "work") throw new Error("simulated split failure");
          await mkdir(input.path, { recursive: input.recursive });
        },
        async getMetadata(directoryPath) {
          const metadata = await lstat(directoryPath);
          return {
            isDirectory: metadata.isDirectory(),
            isSymlink: metadata.isSymbolicLink(),
          };
        },
      };

      try {
        const workspace = await createCodexProjectlessWorkspace({
          createSplitDirectories: true,
          date: new Date(2026, 6, 11, 12),
          fileSystem,
          workspaceRoot: homeDirectory,
          nameHint: "fallback",
        });

        expect(workspace.outputDirectory).toBe(workspace.cwd);
        expect((await lstat(workspace.cwd)).isDirectory()).toBe(true);
      } finally {
        await rm(homeDirectory, { recursive: true, force: true });
      }
    });
  });
});
