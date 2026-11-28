import { isUtf8 } from "node:buffer";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readChangeSections } from "../../src/shared/change-media";
import {
  CHANGES_DIRECTORY,
  formatReleaseNotes,
  type RepositoryFile,
} from "../../src/shared/changelog";

const changeFile = (path: string, content: Buffer): RepositoryFile => {
  if (!isUtf8(content)) throw new Error(`${path} must be a UTF-8 file.`);
  return { path, content: content.toString("utf8") };
};

const git = (cwd: string, ...args: string[]): Buffer =>
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });

export function resolveReleaseRef(cwd: string, ref: string): string {
  return git(cwd, "rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`).toString().trim();
}

export function readChangeFiles(cwd: string): readonly RepositoryFile[] {
  const directory = lstatSync(join(cwd, CHANGES_DIRECTORY), { throwIfNoEntry: false });
  if (!directory) return [];
  if (!directory.isDirectory()) throw new Error(`${CHANGES_DIRECTORY} must be a directory.`);

  const readDirectory = (path: string): RepositoryFile[] =>
    readdirSync(join(cwd, path), { withFileTypes: true }).flatMap((entry) => {
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory()) return readDirectory(child);
      if (!entry.isFile()) throw new Error(`${child} must be a regular file.`);
      return [changeFile(child, readFileSync(join(cwd, child)))];
    });
  return readDirectory(CHANGES_DIRECTORY);
}

export function readChangeFilesAtRef(cwd: string, ref: string): readonly RepositoryFile[] {
  const sha = resolveReleaseRef(cwd, ref);
  const tree = git(cwd, "ls-tree", "-r", "-z", sha, "--", CHANGES_DIRECTORY).toString("utf8");
  return tree
    .split("\0")
    .filter(Boolean)
    .map((item) => {
      const tab = item.indexOf("\t");
      const mode = item.slice(0, tab).split(" ")[0];
      const path = item.slice(tab + 1);
      if (path === CHANGES_DIRECTORY) throw new Error(`${CHANGES_DIRECTORY} must be a directory.`);
      if (mode !== "100644" && mode !== "100755") {
        throw new Error(`${path} must be a regular file.`);
      }
      return changeFile(path, git(cwd, "show", `${sha}:${path}`));
    });
}

export function renderReleaseNotesAtRef(cwd: string, ref: string, headline: string): string {
  return formatReleaseNotes(
    { headline, sections: readChangeSections(readChangeFilesAtRef(cwd, ref)) },
    `Release source ${ref}`,
  );
}
