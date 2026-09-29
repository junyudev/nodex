import { mkdtemp, mkdir, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { expect, test } from "vite-plus/test";
import * as Effect from "effect/Effect";
import {
  claudeDiscoveryFingerprint,
  discoverClaudeSkills,
  parseClaudeSkillFrontmatter,
  probeClaudeVersion,
} from "./ClaudeDiscovery";
import { defaultClaudeInstance } from "../../../shared/claude-agent-settings";

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
      const executable = join(root, "claude");
      yield* Effect.promise(() =>
        writeFile(
          executable,
          '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.276 (Claude Code)"; else exit 9; fi\n',
        ),
      );
      yield* Effect.promise(() => chmod(executable, 0o700));
      expect(yield* probeClaudeVersion(executable, { HOME: root }, root)).toBe(
        "2.1.276 (Claude Code)",
      );
      expect(yield* probeClaudeVersion(join(root, "missing"), { HOME: root }, root)).toBeNull();
    }).pipe(Effect.scoped),
);
