import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { cutRelease } from "./release-cut";

let tempDir = "";

function run(command: string, args: string[]): string {
  return execFileSync(command, args, {
    cwd: tempDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "nodex-release-cut-test-"));
  writeFileSync(
    join(tempDir, "package.json"),
    `${JSON.stringify(
      {
        name: "temp-release-cut",
        version: "0.1.1",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  writeFileSync(
    join(tempDir, "CHANGELOG.md"),
    `# Changelog

## [Unreleased]

### Added
- Added release automation.
`,
    "utf8",
  );

  run("git", ["init"]);
  run("git", ["config", "user.name", "Nodex Test"]);
  run("git", ["config", "user.email", "nodex@example.com"]);
  run("git", ["add", "package.json", "CHANGELOG.md"]);
  run("git", ["commit", "-m", "chore: seed test repo"]);
});

afterEach(() => {
  rmSync(tempDir, {
    recursive: true,
    force: true,
  });
});

test("cutRelease bumps package version, rolls the changelog, commits, and tags", () => {
  const result = cutRelease({
    cwd: tempDir,
    target: "patch",
  });
  const packageJson = JSON.parse(readFileSync(join(tempDir, "package.json"), "utf8")) as { version: string };
  const changelog = readFileSync(join(tempDir, "CHANGELOG.md"), "utf8");
  const latestCommitMessage = run("git", ["log", "-1", "--pretty=%B"]);
  const tagName = run("git", ["tag", "--list"]);

  expect(result.version).toBe("0.1.2");
  expect(result.tagName).toBe("v0.1.2");
  expect(packageJson.version).toBe("0.1.2");
  expect(changelog.includes("## [0.1.2] - ")).toBeTrue();
  expect(changelog.includes("## [Unreleased]\n\n### Added\n\n### Changed\n\n### Fixed")).toBeTrue();
  expect(latestCommitMessage.startsWith("release: v0.1.2")).toBeTrue();
  expect(tagName).toBe("v0.1.2");
});

test("cutRelease refuses to run on a dirty tracked worktree", () => {
  let errorMessage = "";

  writeFileSync(join(tempDir, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n\n### Added\n- Dirty state.\n", "utf8");

  try {
    cutRelease({
      cwd: tempDir,
      target: "patch",
    });
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
  }

  expect(errorMessage).toBe("Release cut requires a clean git worktree with no tracked changes.");
  expect(JSON.parse(readFileSync(join(tempDir, "package.json"), "utf8")).version).toBe("0.1.1");
});
