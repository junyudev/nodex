import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vite-plus/test";
import {
  assertSameReleaseIdentity,
  createReleaseIdentity,
  resolveReleaseIdentity,
} from "./candidate";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2026-10-29T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-10-29T00:00:00Z",
    },
  }).trim();

describe("release candidate identity", () => {
  test("derives one deterministic nightly identity from source facts", () => {
    const facts = {
      channel: "nightly" as const,
      sourceSha: "a".repeat(40),
      sourceTree: "b".repeat(40),
      sourceVersion: "0.2.1",
      sourceDate: "2026-08-13",
      mainlineOrdinal: 842,
    };
    expect(createReleaseIdentity(facts)).toEqual(createReleaseIdentity(facts));
    expect(createReleaseIdentity(facts)).toMatchObject({
      version: "0.2.2-nightly.20260813.842",
      buildVersion: "1.8.42",
      tag: "v0.2.2-nightly.20260813.842",
    });
  });

  test("rejects an identity that is not the exact expected source identity", () => {
    const expected = createReleaseIdentity({
      channel: "nightly",
      sourceSha: "a".repeat(40),
      sourceTree: "b".repeat(40),
      sourceVersion: "0.2.1",
      sourceDate: "2026-08-13",
      mainlineOrdinal: 842,
    });
    const other = createReleaseIdentity({
      ...expected,
      sourceSha: "c".repeat(40),
    });
    expect(() => assertSameReleaseIdentity(expected, other)).toThrow("exact source ref");
  });

  test.each(["stable", "nightly"] as const)(
    "requires complete history before deriving a %s build identity",
    (channel) => {
      const root = mkdtempSync(join(tmpdir(), "nodex-release-history-"));
      const repository = join(root, "source");
      const shallow = join(root, "shallow");
      try {
        mkdirSync(join(repository, "crates/nodex-core"), { recursive: true });
        writeFileSync(join(repository, "package.json"), '{"version":"0.4.0"}\n');
        writeFileSync(
          join(repository, "Cargo.toml"),
          '[workspace]\nmembers = ["crates/nodex-core"]\n\n[workspace.package]\nversion = "0.4.0"\n',
        );
        writeFileSync(
          join(repository, "crates/nodex-core/Cargo.toml"),
          '[package]\nname = "nodex-core"\nversion.workspace = true\n',
        );
        writeFileSync(
          join(repository, "Cargo.lock"),
          'version = 4\n\n[[package]]\nname = "nodex-core"\nversion = "0.4.0"\n',
        );
        writeFileSync(
          join(repository, "CHANGELOG.md"),
          "# Changelog\n\n## [Unreleased]\n\n## [0.4.0] - 2026-10-29\n\n- Release fixture.\n",
        );
        git(repository, "init", "--initial-branch=main");
        git(repository, "config", "user.name", "Nodex Test");
        git(repository, "config", "user.email", "nodex@example.com");
        git(repository, "config", "commit.gpgsign", "false");
        git(repository, "add", ".");
        git(repository, "commit", "-m", "chore: seed release source");
        git(repository, "commit", "--allow-empty", "-m", "chore: advance source history");
        git(repository, "commit", "--allow-empty", "-m", "chore: advance release history");
        const sourceSha = git(repository, "rev-parse", "HEAD");
        const expected = resolveReleaseIdentity({ channel, cwd: repository, ref: sourceSha });
        expect(expected).toMatchObject({
          sourceSha,
          sourceTree: git(repository, "rev-parse", "HEAD^{tree}"),
          sourceVersion: "0.4.0",
          mainlineOrdinal: 3,
          buildVersion: "1.0.3",
          sourceDate: "2026-10-29",
        });

        git(root, "clone", "--depth=1", pathToFileURL(repository).href, shallow);
        expect(git(shallow, "rev-parse", "--is-shallow-repository")).toBe("true");
        expect(git(shallow, "rev-list", "--first-parent", "--count", sourceSha)).toBe("1");
        expect(() => resolveReleaseIdentity({ channel, cwd: shallow, ref: sourceSha })).toThrow(
          "complete Git history",
        );

        git(shallow, "fetch", "--unshallow");
        expect(git(shallow, "rev-parse", "--is-shallow-repository")).toBe("false");
        expect(resolveReleaseIdentity({ channel, cwd: shallow, ref: sourceSha })).toEqual(expected);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
