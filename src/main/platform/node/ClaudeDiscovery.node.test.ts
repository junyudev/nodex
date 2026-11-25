import { describe, expect, test, it as itClaudeSdk } from "vite-plus/test";
import { ASYNC_WAIT_TIMEOUT_MS } from "../../../../config/test-timeouts";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  chmod,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schedule from "effect/Schedule";
import {
  claudeDiscoveryFingerprint,
  discoverClaudeSkills,
  parseClaudeSkillFrontmatter,
  probeClaudeVersion,
} from "./ClaudeDiscovery";
import { claudeProfile } from "../../../shared/agents/profile.test-fixtures";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { resolveClaudeIntelligence } from "./ClaudeIntelligence";
import { claudeEnvironment, claudeDiscoveryOptions, ClaudeSdk, live } from "./ClaudeSdk";
import { fileURLToPath } from "node:url";
import * as Layer from "effect/Layer";
import { testLayer as mainConfigLayer } from "../../app/MainConfig";
import { HostShellEnvironment } from "../../host-runtime/HostShellEnvironment";
import { claudeSdkModuleUrl } from "./ClaudeSdkModule";

describe("ClaudeDiscovery", () => {
  it.live.skipIf(process.platform === "win32")(
    "native version cancellation awaits a child that ignores TERM",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), "nodex-claude-probe-"))),
          (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
        );
        const executable = join(root, "probe.cjs");
        const pidPath = join(root, "pid");
        yield* Effect.promise(() =>
          writeFile(
            executable,
            `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); setInterval(() => {}, 1000);`,
          ),
        );
        const probe = yield* probeClaudeVersion(executable, { HOME: root }, root).pipe(
          Effect.forkChild,
        );
        const pid = Number(
          yield* Effect.tryPromise(() => readFile(pidPath, "utf8")).pipe(
            Effect.retry(Schedule.spaced("20 millis")),
            Effect.timeout(ASYNC_WAIT_TIMEOUT_MS),
          ),
        );
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            try {
              const args = execFileSync("/bin/ps", ["-p", String(pid), "-o", "args="], {
                encoding: "utf8",
              });
              if (args.trim().split(/\s+/u).includes(executable)) process.kill(pid, "SIGKILL");
            } catch {
              /* Already released by the probe. */
            }
          }),
        );
        yield* Fiber.interrupt(probe);
        expect(() => process.kill(pid, 0)).toThrow();
      }).pipe(Effect.scoped),
  );

  test("native skill frontmatter accepts YAML booleans and skips invalid metadata", () => {
    expect(
      parseClaudeSkillFrontmatter(
        "---\nname: ignored\ndescription: >\n  Multi line\n  description\nuser-invocable: no\n---\nbody",
      ),
    ).toEqual({ description: "Multi line description", userInvocable: false });
    expect(parseClaudeSkillFrontmatter("---\nuser-invocable: YES\n---\nbody")?.userInvocable).toBe(
      true,
    );
    expect(parseClaudeSkillFrontmatter("---\ndescription: [broken\n---\nbody")).toBeNull();
  });

  it.effect("skill paths follow native user precedence and init commands decide invocation", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(join(tmpdir(), "nodex-claude-skills-"))),
        (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
      );
      const account = join(root, "account");
      const cwd = join(root, "workspace");
      for (const [directory, body] of [
        [join(account, "skills", "same"), "---\ndescription: User skill\n---\nbody"],
        [join(cwd, ".claude", "skills", "same"), "---\ndescription: Project skill\n---\nbody"],
        [join(cwd, ".claude", "skills", "hidden"), "---\nuser-invocable: false\n---\nbody"],
        [join(cwd, ".claude", "skills", "disabled"), "body"],
      ] as const) {
        yield* Effect.promise(() => mkdir(directory, { recursive: true }));
        yield* Effect.promise(() => writeFile(join(directory, "SKILL.md"), body));
      }
      const skills = yield* discoverClaudeSkills(
        { HOME: root, CLAUDE_CONFIG_DIR: account },
        cwd,
        [{ name: "same" }, { name: "hidden" }, { name: "disabled" }],
        { disabled: "off" },
      );
      expect(skills.find(({ name }) => name === "same")).toMatchObject({
        description: "User skill",
        path: join(account, "skills", "same", "SKILL.md"),
        userInvocable: true,
      });
      expect(skills.find(({ name }) => name === "hidden")?.userInvocable).toBe(false);
      expect(skills.find(({ name }) => name === "disabled")).toMatchObject({
        enabled: false,
        userInvocable: false,
      });
    }).pipe(Effect.scoped),
  );

  it.effect("Claude filesystem skills never fall back to other providers' skill roots", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(join(tmpdir(), "nodex-claude-skill-scope-"))),
        (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
      );
      const home = join(root, "home");
      const cwd = join(root, "workspace");
      yield* Effect.promise(() => mkdir(join(cwd, ".git"), { recursive: true }));
      for (const directory of [
        join(home, ".codex", "skills", "other-provider"),
        join(home, ".agents", "skills", "shared-agent"),
        join(cwd, ".agents", "skills", "repository-agent"),
      ]) {
        yield* Effect.promise(() => mkdir(directory, { recursive: true }));
        yield* Effect.promise(() => writeFile(join(directory, "SKILL.md"), "Skill instructions"));
      }
      const commands = ["other-provider", "shared-agent", "repository-agent", "native-project"].map(
        (name) => ({ name }),
      );
      expect(yield* discoverClaudeSkills({ HOME: home }, cwd, commands)).toEqual([]);

      const nativeDirectory = join(cwd, ".claude", "skills", "native-project");
      yield* Effect.promise(() => mkdir(nativeDirectory, { recursive: true }));
      yield* Effect.promise(() =>
        writeFile(join(nativeDirectory, "SKILL.md"), "Project skill instructions"),
      );
      const skills = yield* discoverClaudeSkills({ HOME: home }, cwd, commands);
      expect(skills.map(({ name }) => name)).toEqual(["native-project"]);
      expect(skills[0]?.userInvocable).toBe(true);
    }).pipe(Effect.scoped),
  );

  for (const gitMarker of ["directory", "file"] as const)
    it.effect(
      `nested skills inherit through the repository root with a .git ${gitMarker} boundary`,
      () =>
        Effect.gen(function* () {
          const createdRoot = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(join(tmpdir(), "nodex-claude-nested-skills-"))),
            (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
          );
          const root = yield* Effect.promise(() => realpath(createdRoot));
          const repository = join(root, "repository");
          const parent = join(repository, "packages");
          const cwd = join(parent, "app");
          const alias = join(root, "linked-workspace");
          yield* Effect.promise(() => mkdir(cwd, { recursive: true }));
          yield* Effect.promise(() => symlink(cwd, alias, "dir"));
          if (gitMarker === "directory")
            yield* Effect.promise(() => mkdir(join(repository, ".git")));
          else
            yield* Effect.promise(() =>
              writeFile(join(repository, ".git"), `gitdir: ${join(root, "external-git")}\n`),
            );
          for (const [directory, name, description] of [
            [root, "outside", "Outside repository"],
            [repository, "ancestor", "Repository skill"],
            [repository, "same", "Root duplicate"],
            [repository, "unadvertised", "Unavailable command"],
            [parent, "middle", "Parent skill"],
            [cwd, "same", "Nested duplicate"],
          ] as const) {
            const skillDirectory = join(directory, ".claude", "skills", name);
            yield* Effect.promise(() => mkdir(skillDirectory, { recursive: true }));
            yield* Effect.promise(() =>
              writeFile(
                join(skillDirectory, "SKILL.md"),
                `---\ndescription: ${description}\n---\nbody`,
              ),
            );
          }
          const skills = yield* discoverClaudeSkills(
            { HOME: join(root, "account") },
            gitMarker === "file" ? alias : cwd,
            [{ name: "ancestor" }, { name: "middle" }, { name: "same" }, { name: "outside" }],
          );
          expect(skills.find(({ name }) => name === "ancestor")).toMatchObject({
            path: join(repository, ".claude", "skills", "ancestor", "SKILL.md"),
            userInvocable: true,
          });
          expect(skills.find(({ name }) => name === "middle")).toMatchObject({
            path: join(parent, ".claude", "skills", "middle", "SKILL.md"),
            userInvocable: true,
          });
          expect(skills.find(({ name }) => name === "same")).toMatchObject({
            description: "Nested duplicate",
            path: join(cwd, ".claude", "skills", "same", "SKILL.md"),
          });
          expect(skills.find(({ name }) => name === "unadvertised")?.userInvocable).toBe(false);
          expect(skills.find(({ name }) => name === "outside")).toBeUndefined();
        }).pipe(Effect.scoped),
    );

  test("catalog identity reacts to secret and workspace changes without publishing a secret", () => {
    const instance = claudeProfile();
    const fingerprint = claudeDiscoveryFingerprint(
      instance,
      { ANTHROPIC_AUTH_TOKEN: "private" },
      "/workspace",
    );
    expect(fingerprint).not.toContain("private");
    expect(
      claudeDiscoveryFingerprint(instance, { ANTHROPIC_AUTH_TOKEN: "changed" }, "/workspace"),
    ).not.toBe(fingerprint);
    expect(
      claudeDiscoveryFingerprint(instance, { ANTHROPIC_AUTH_TOKEN: "private" }, "/other"),
    ).not.toBe(fingerprint);
  });

  it.effect(
    "native version diagnostics use a local bounded command and preserve unknown failures",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), "nodex-claude-version-"))),
          (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
        );
        const executable = join(root, "claude.cjs");
        yield* Effect.promise(() =>
          writeFile(
            executable,
            'if (process.argv[2] === "--version") console.log("2.1.276 (Claude Code)"); else process.exit(9);',
          ),
        );
        yield* Effect.promise(() => chmod(executable, 0o700));
        expect(yield* probeClaudeVersion(executable, { HOME: root }, root)).toBe(
          "2.1.276 (Claude Code)",
        );
        expect(yield* probeClaudeVersion(join(root, "missing"), { HOME: root }, root)).toBeNull();
      }).pipe(Effect.scoped),
  );
});

describe("ClaudeIntelligence", () => {
  const model = (id: string): ModelInfo => ({
    value: id,
    displayName: id,
    description: "",
    supportsAdaptiveThinking: true,
  });
  const resolve = (
    settings: unknown,
    extra: Partial<Parameters<typeof resolveClaudeIntelligence>[0]> = {},
  ) =>
    resolveClaudeIntelligence({
      settings,
      models: [model("claude-opus-5"), model("claude-sonnet-5-5")],
      customModels: [],
      environment: {},
      acknowledged: {},
      ...extra,
    });

  describe("native resolved intelligence", () => {
    test("applied model and effort win over settings while accepted toggles follow the merged cascade", () => {
      expect(
        resolve({
          applied: { model: "claude-opus-5", effort: "medium" },
          effective: {
            model: "ignored",
            effortLevel: "max",
            alwaysThinkingEnabled: false,
            fastMode: true,
          },
        }),
      ).toEqual({ model: "claude-opus-5", effort: "medium", thinking: false, fast: true });
      expect(
        resolve({
          applied: { model: "claude-opus-5", effort: "max" },
          effective: { alwaysThinkingEnabled: false },
        }),
      ).toMatchObject({ effort: "high", thinking: false });
      expect(
        resolve(
          {
            applied: { model: "claude-opus-5", effort: null },
            effective: { alwaysThinkingEnabled: true, fastMode: false },
          },
          { acknowledged: { thinking: false, fast: true } },
        ),
      ).toMatchObject({ effort: null, thinking: true, fast: false });
    });
    test("mandatory thinking ignores an inherited disabled preference and unknown models stay unknown", () => {
      expect(
        resolve({
          applied: { model: "claude-sonnet-5-5", effort: "medium" },
          effective: { alwaysThinkingEnabled: false },
        }),
      ).toMatchObject({ thinking: true });
      expect(
        resolve({
          applied: { model: "claude-opus-5[1m]", effort: "high" },
          effective: { alwaysThinkingEnabled: false },
        }),
      ).toMatchObject({ model: "claude-opus-5[1m]", thinking: false });
      expect(
        resolve({
          applied: { model: "claude-sonnet-5-5[1m]", effort: "medium" },
          effective: { alwaysThinkingEnabled: false },
        }),
      ).toMatchObject({ model: "claude-sonnet-5-5[1m]", thinking: true });
      expect(
        resolve({
          applied: { model: "gateway/opaque", effort: "high" },
          effective: { alwaysThinkingEnabled: false },
        }),
      ).toMatchObject({ model: "gateway/opaque", thinking: null });
      expect(
        resolve(
          {
            applied: { model: "gateway/opaque", effort: "high" },
            effective: { alwaysThinkingEnabled: false },
          },
          {
            customModels: [
              { id: "gateway/opaque", displayName: "Opaque", traits: { disableThinking: true } },
            ],
          },
        ),
      ).toMatchObject({ thinking: false });
    });
    test("native environment priority and live fast state override accepted flag settings", () => {
      const settings = {
        applied: { model: "claude-opus-5", effort: "high" },
        effective: { alwaysThinkingEnabled: false, fastMode: true },
      };
      expect(
        resolve(settings, { environment: { MAX_THINKING_TOKENS: "1000" }, fastState: "off" }),
      ).toMatchObject({ thinking: true, fast: false });
      expect(
        resolve(settings, { environment: { MAX_THINKING_TOKENS: "0" }, fastState: "on" }),
      ).toMatchObject({ thinking: false, fast: true });
      expect(
        resolve(settings, {
          environment: { CLAUDE_CODE_DISABLE_THINKING: "true" },
          fastState: "cooldown",
        }),
      ).toMatchObject({ thinking: null, fast: false });
    });
    test("absent or malformed native fields never fabricate a default model or effort", () => {
      expect(resolve(undefined)).toEqual({ model: null, effort: null, thinking: null, fast: null });
      expect(resolve({ applied: { model: "claude-opus-5", effort: "invented" } })).toEqual({
        model: "claude-opus-5",
        effort: null,
        thinking: true,
        fast: null,
      });
    });
  });
});

describe("ClaudeSdk", () => {
  const it = itClaudeSdk;
  const instance = claudeProfile({
    id: "work",
    displayName: "Work",
    settings: { configDirectory: "/config/work", customModels: [] },
  });

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
      claudeEnvironment(
        { HOME: "/users/me" },
        { ...instance, settings: { ...instance.settings, configDirectory: "~/work-claude" } },
      ).CLAUDE_CONFIG_DIR,
    ).toBe(join("/users/me", "work-claude"));
    expect(() =>
      claudeEnvironment(
        { HOME: "/users/me" },
        { ...instance, settings: { ...instance.settings, configDirectory: "relative" } },
      ),
    ).toThrow("must be absolute");
  });

  it("metadata discovery disables executable integrations and never persists a conversation", () => {
    expect(
      claudeDiscoveryOptions(
        {
          instance,
          environment: { HOME: "/users/me", FORCE_CODE_TERMINAL: "1" },
          cwd: "/workspace",
        },
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
});

describe("ClaudeSdkModule", () => {
  it.effect(
    "packaged Main and history workers share the standalone SDK through Unicode paths",
    () =>
      Effect.gen(function* () {
        const resourcesPath = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), "nodex SDK 用户 "))),
          (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
        );
        const url = claudeSdkModuleUrl({
          isPackaged: true,
          resourcesPath,
          projectRootPath: "/unused",
        });
        const modulePath = join(
          resourcesPath,
          "agent-runtime/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs",
        );
        expect(fileURLToPath(url)).toBe(modulePath);
        yield* Effect.promise(() => mkdir(dirname(modulePath), { recursive: true }));
        yield* Effect.promise(() =>
          writeFile(
            modulePath,
            "export const owner = 'agent-runtime'; export async function listSessions() { return [{sessionId:'packaged',summary:'Shared SDK',lastModified:1}]; }",
          ),
        );
        const module = yield* Effect.promise(() => import(url));
        expect(module.owner).toBe("agent-runtime");
        const sdkLayer = live.pipe(
          Layer.provide(mainConfigLayer({ isPackaged: true, resourcesPath })),
          Layer.provide(
            Layer.succeed(HostShellEnvironment, {
              latest: Effect.die("History must not read host shell discovery"),
              recover: Effect.die("History must not start host shell discovery"),
              load: Effect.die("Native history must not discover PATH"),
            }),
          ),
        );
        const sessions = yield* Effect.gen(function* () {
          const sdk = yield* ClaudeSdk;
          return yield* sdk.listSessions(
            { instance: claudeProfile(), environment: { HOME: resourcesPath } },
            { offset: 0, limit: 51 },
          );
        }).pipe(Effect.provide(sdkLayer));
        expect(sessions).toEqual([
          { sessionId: "packaged", summary: "Shared SDK", lastModified: 1 },
        ]);
        // Missing packaged assets must never fall back to the development dependency.
        yield* Effect.promise(() =>
          expect(
            import(
              claudeSdkModuleUrl({
                isPackaged: true,
                resourcesPath: join(resourcesPath, "missing"),
                projectRootPath: process.cwd(),
              })
            ),
          ).rejects.toThrow(),
        );
      }).pipe(Effect.scoped),
  );

  test("source tests and development use the installed SDK without requiring a staged runtime", async () => {
    const url = claudeSdkModuleUrl({
      isPackaged: false,
      resourcesPath: "/unused",
      projectRootPath: process.cwd(),
    });
    expect(typeof (await import(url)).query).toBe("function");
  });
});
