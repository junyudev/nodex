import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";

test("git fixtures read only the repository's test configuration", () => {
  const repository = mkdtempSync(join(tmpdir(), "nodex-test-git-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
  try {
    git("init", "--quiet");
    // A developer's commit signing never reaches a fixture commit.
    expect(git("config", "--show-origin", "--get", "commit.gpgsign")).toMatch(
      /config\/test\.gitconfig\tfalse$/,
    );
    expect(git("symbolic-ref", "--short", "HEAD")).toBe("main");
    git("commit", "--quiet", "--allow-empty", "-m", "fixture");
    expect(git("log", "-1", "--format=%an <%ae> %G?")).toBe("Nodex Test <test@nodex.invalid> N");
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});
