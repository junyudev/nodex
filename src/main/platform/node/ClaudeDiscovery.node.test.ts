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
import { join } from "node:path";
import { it } from "@effect/vitest";
import { expect, test } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schedule from "effect/Schedule";
import {
  claudeDiscoveryFingerprint,
  discoverClaudeSkills,
  parseClaudeSkillFrontmatter,
  probeClaudeVersion,
} from "./ClaudeDiscovery";
import { defaultClaudeInstance } from "../../../shared/claude-agent-settings";

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
          Effect.timeout("5 seconds"),
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
        if (gitMarker === "directory") yield* Effect.promise(() => mkdir(join(repository, ".git")));
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
  const instance = defaultClaudeInstance();
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
