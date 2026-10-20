import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "@effect/vitest";

it("isolates Git fixtures from user hooks and tracing while preserving local fixture hooks", () => {
  const root = mkdtempSync(join(tmpdir(), "nodex-agent-runtime-git-"));
  const userHome = join(root, "user");
  const repository = join(root, "repository");
  const userHooks = join(userHome, "hooks");
  const fixtureHooks = join(root, "fixture-hooks");
  const traceFile = join(root, "user-trace.json");
  for (const directory of [userHome, repository, userHooks, fixtureHooks]) {
    mkdirSync(directory, { recursive: true });
  }
  const env = { ...process.env, HOME: userHome, USERPROFILE: userHome, XDG_CONFIG_HOME: userHome };
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repository, env, encoding: "utf8" }).trim();
  try {
    git("config", "--file", join(userHome, ".gitconfig"), "core.hooksPath", userHooks);
    git("config", "--file", join(userHome, ".gitconfig"), "trace2.eventTarget", traceFile);
    writeFileSync(join(userHooks, "post-commit"), "#!/bin/sh\nprintf hook > .user-hook-ran\n", {
      mode: 0o755,
    });
    writeFileSync(
      join(fixtureHooks, "post-commit"),
      "#!/bin/sh\nprintf hook > .fixture-hook-ran\n",
      { mode: 0o755 },
    );

    git("init", "--quiet");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@nodex.invalid");
    git("commit", "--quiet", "--allow-empty", "-m", "isolated fixture");
    expect(existsSync(join(repository, ".user-hook-ran"))).toBe(false);
    expect(existsSync(traceFile)).toBe(false);

    git("config", "core.hooksPath", fixtureHooks);
    git("commit", "--quiet", "--allow-empty", "-m", "fixture-owned hook");
    expect(existsSync(join(repository, ".fixture-hook-ran"))).toBe(true);
    expect(existsSync(traceFile)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
