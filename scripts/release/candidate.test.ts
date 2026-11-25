import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vite-plus/test";
import { formatChangelog, readUnreleasedChanges } from "../../src/shared/changelog";
import {
  assertSameBuildIdentity,
  createBuildIdentity,
  resolveBuildIdentity,
  resolveNightlyCandidate,
} from "./candidate";
import { readChangeFilesAtRef } from "./changelog";
import { advanceReleaseSource } from "./source";

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

function seedRepository(repository: string): void {
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
  writeFileSync(join(repository, "CHANGELOG.md"), formatChangelog([]));
  git(repository, "init", "--initial-branch=main");
  git(repository, "config", "user.name", "Nodex Test");
  git(repository, "config", "user.email", "nodex@example.com");
  git(repository, "config", "commit.gpgsign", "false");
  git(repository, "add", ".");
  git(repository, "commit", "-m", "chore: seed release source");
}

describe("release candidate identity", () => {
  test("derives one deterministic nightly identity from source facts", () => {
    const facts = {
      sourceSha: "a".repeat(40),
      sourceTree: "b".repeat(40),
      version: "0.2.1",
      sourceDate: "2026-08-13",
      mainlineOrdinal: 842,
    };
    expect(createBuildIdentity(facts)).toEqual(createBuildIdentity(facts));
    expect(createBuildIdentity(facts)).toMatchObject({
      version: "0.2.1",
      buildVersion: "1.8.42",
    });
  });

  test("rejects an identity that is not the exact expected source identity", () => {
    const expected = createBuildIdentity({
      sourceSha: "a".repeat(40),
      sourceTree: "b".repeat(40),
      version: "0.2.1",
      sourceDate: "2026-08-13",
      mainlineOrdinal: 842,
    });
    const other = createBuildIdentity({
      ...expected,
      sourceSha: "c".repeat(40),
    });
    expect(() => assertSameBuildIdentity(expected, other)).toThrow("exact source ref");
  });

  test("requires complete history before deriving a build identity", () => {
    const root = mkdtempSync(join(tmpdir(), "nodex-release-history-"));
    const repository = join(root, "source");
    const shallow = join(root, "shallow");
    try {
      seedRepository(repository);
      git(repository, "commit", "--allow-empty", "-m", "chore: advance source history");
      git(repository, "commit", "--allow-empty", "-m", "chore: advance release history");
      const sourceSha = git(repository, "rev-parse", "HEAD");
      const expected = resolveBuildIdentity({ cwd: repository, ref: sourceSha });
      expect(expected).toMatchObject({
        sourceSha,
        sourceTree: git(repository, "rev-parse", "HEAD^{tree}"),
        mainlineOrdinal: 3,
        buildVersion: "1.0.3",
        sourceDate: "2026-10-29",
      });

      git(root, "clone", "--depth=1", pathToFileURL(repository).href, shallow);
      expect(git(shallow, "rev-parse", "--is-shallow-repository")).toBe("true");
      expect(git(shallow, "rev-list", "--first-parent", "--count", sourceSha)).toBe("1");
      expect(() => resolveBuildIdentity({ cwd: shallow, ref: sourceSha })).toThrow(
        "complete Git history",
      );

      git(shallow, "fetch", "--unshallow");
      expect(git(shallow, "rev-parse", "--is-shallow-repository")).toBe("false");
      expect(resolveBuildIdentity({ cwd: shallow, ref: sourceSha })).toEqual(expected);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("skips Nightly for an exact release advance and admits ordinary change files", () => {
    const repository = mkdtempSync(join(tmpdir(), "nodex-nightly-advance-"));
    try {
      seedRepository(repository);
      mkdirSync(join(repository, "changes/fixed"), { recursive: true });
      const entry = join(repository, "changes/fixed/2026-10-29-sync.md");
      writeFileSync(entry, "Fixed sync.\n");
      git(repository, "add", "changes");
      git(repository, "commit", "-m", "Fix sync");
      const source = git(repository, "rev-parse", "HEAD");
      expect(resolveNightlyCandidate({ cwd: repository, sourceSha: source })).toMatchObject({
        shouldRelease: true,
        identity: { version: "0.4.0" },
      });

      const sourceChanges = readChangeFilesAtRef(repository, source);
      advanceReleaseSource(
        repository,
        {
          version: "0.4.0",
          date: "2026-10-29",
          headline: "More reliable sync",
          sections: readUnreleasedChanges(sourceChanges),
        },
        sourceChanges,
      );
      git(repository, "add", "-A");
      git(
        repository,
        "commit",
        "-m",
        "Advance the release",
        "-m",
        `Nodex-Release-Source: ${source}`,
      );
      const head = git(repository, "rev-parse", "HEAD");
      expect(resolveNightlyCandidate({ cwd: repository, sourceSha: head })).toEqual({
        shouldRelease: false,
        reason: "version-advance-only",
        sourceSha: head,
      });
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });
});
