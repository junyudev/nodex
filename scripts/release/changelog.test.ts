import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { readUnreleasedChanges } from "../../src/shared/changelog";
import { readChangeFiles, readChangeFilesAtRef, renderReleaseNotesAtRef } from "./changelog";

let cwd: string;
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "nodex-release-notes-"));
  git("init");
  git("config", "user.name", "Nodex Test");
  git("config", "user.email", "nodex@example.com");
  git("config", "commit.gpgsign", "false");
  git("commit", "--allow-empty", "-m", "Before change files");
});

afterEach(() => rmSync(cwd, { recursive: true, force: true }));

test("renders notes from the selected revision, preserving canonical section and entry order", () => {
  mkdirSync(join(cwd, "changes/added"), { recursive: true });
  mkdirSync(join(cwd, "changes/fixed"), { recursive: true });
  writeFileSync(join(cwd, "changes/README.md"), "Write each change in a file.\n");
  writeFileSync(join(cwd, "changes/added/2026-11-12-shortcuts.md"), "Added shortcuts.\n");
  writeFileSync(
    join(cwd, "changes/added/2026-11-11-setup.md"),
    "Added setup.\r\nStart quickly.\r\n",
  );
  writeFileSync(join(cwd, "changes/fixed/2026-11-10-sync.md"), "Fixed sync.\n");
  git("add", "changes");
  git("commit", "-m", "Add release entries");

  writeFileSync(join(cwd, "changes/added/2026-11-11-setup.md"), "Edited since the Nightly.\n");
  expect(renderReleaseNotesAtRef(cwd, "HEAD", "Verified releases")).toBe(
    "Verified releases\n\n### Added\n\n- Added setup. Start quickly.\n- Added shortcuts.\n\n### Fixed\n\n- Fixed sync.\n",
  );
  expect(readChangeFiles(cwd)).toContainEqual({
    path: "changes/added/2026-11-11-setup.md",
    content: "Edited since the Nightly.\n",
  });
  expect(readChangeFilesAtRef(cwd, "HEAD^")).toEqual([]);
  expect(() => renderReleaseNotesAtRef(cwd, "HEAD^", "Verified releases")).toThrow("no entries");
});

test("passes nested and hidden files to validation rather than silently omitting them", () => {
  const path = "changes/added/nested/.unknown";
  mkdirSync(join(cwd, "changes/added/nested"), { recursive: true });
  writeFileSync(join(cwd, path), "An unsupported file.\n");
  git("add", "changes");
  git("commit", "-m", "Add nested file");

  expect(() => readUnreleasedChanges(readChangeFiles(cwd))).toThrow(path);
  expect(() => renderReleaseNotesAtRef(cwd, "HEAD", "Verified releases")).toThrow(path);
});
