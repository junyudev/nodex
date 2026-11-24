import path from "node:path";
import { gitOutput } from "./check-changed-record.ts";

// Scan a fixed number of mainline commits so the check's cost stays independent of repo age.
const historyLimit = 200;
const rawDiff = ["--raw", "-z", "--no-abbrev", "--no-renames", "--no-color", "--no-relative"];
const log = [
  "-c",
  "log.showRoot=false",
  "log",
  "--first-parent",
  "--no-notes",
  "--no-decorate",
  "--no-show-signature",
  ...rawDiff,
];

interface Commit {
  readonly hash: string;
  readonly subject: string;
}

interface FileRestoration extends Commit {
  readonly paths: string[];
}

function* fileChanges(output: string) {
  const fields = output.split("\0");
  let hash = "";
  let message = "";
  for (let index = 0; index < fields.length; index++) {
    const header = fields[index].replace(/^\n/u, "");
    if (!header) continue;
    if (!header.startsWith(":")) {
      hash = header;
      message = fields[++index];
      continue;
    }
    const [, , before, after] = header.split(" ");
    const file = fields[++index];
    // Raw diffs use the all-zero object ID for absent paths, including additions and deletions.
    if (before !== after) yield { file, before, after, hash, message };
  }
}

function namesRevert(message: string, hash: string): boolean {
  const gitRevert = message.match(/^This reverts commit ([\da-f]{7,64})\b/imu)?.[1];
  if (gitRevert && hash.startsWith(gitRevert.toLowerCase())) return true;
  if (!/^revert(?:\([^)]+\))?!?:/iu.test(message)) return false;
  return (message.match(/\b[\da-f]{7,64}\b/giu) ?? []).some((ref) =>
    hash.startsWith(ref.toLowerCase()),
  );
}

export function findFileRestorations(root: string, base: string, head: string): FileRestoration[] {
  const tip = new Map(
    Array.from(
      fileChanges(
        gitOutput(root, "diff", ...rawDiff, "--end-of-options", base, head, "--").toString(),
      ),
      ({ file, after }) => [file, after],
    ),
  );
  if (!tip.size) return [];

  const candidates = new Map<string, Commit[]>();
  const baseHistory = gitOutput(
    root,
    ...log,
    "--format=%H%x00%s",
    `--max-count=${historyLimit}`,
    "--end-of-options",
    base,
    "--",
  ).toString();
  for (const { file, before, hash, message } of fileChanges(baseHistory)) {
    if (tip.get(file) !== before) continue;
    const commits = candidates.get(file) ?? [];
    commits.push({ hash, subject: message });
    candidates.set(file, commits);
  }
  if (!candidates.size) return [];

  // Only a commit that actually supplied the final state of this path can authorize the revert.
  const pending = new Set(candidates.keys());
  const branchHistory = gitOutput(
    root,
    ...log,
    "--format=%H%x00%B",
    "--end-of-options",
    `${base}..${head}`,
    "--",
  ).toString();
  for (const { file, after, message } of fileChanges(branchHistory)) {
    if (tip.get(file) !== after || !pending.delete(file)) continue;
    if (candidates.get(file)?.some(({ hash }) => namesRevert(message, hash)))
      candidates.delete(file);
    if (!pending.size) break;
  }

  const groups = new Map<string, FileRestoration>();
  for (const [file, [nearest]] of candidates) {
    const group = groups.get(nearest.hash) ?? { ...nearest, paths: [] };
    group.paths.push(file);
    groups.set(nearest.hash, group);
  }
  return [...groups.values()].map((group) => ({ ...group, paths: group.paths.sort() }));
}

function main(root: string, [base, head = "HEAD"]: readonly string[]): number {
  if (!base) {
    process.stdout.write("Skipped file restoration check. No comparison base is available.\n");
    return 0;
  }
  if (gitOutput(root, "rev-parse", "--is-shallow-repository").toString().trim() === "true") {
    process.stdout.write("Skipped file restoration check. Git history is shallow.\n");
    return 0;
  }

  const findings = findFileRestorations(root, base, head);
  if (!findings.length) return 0;
  const lines = [
    "HEAD restores files to their state before these commits in the comparison base.",
    ...findings.flatMap(({ hash, subject, paths }) => [
      `\n${hash} ${subject}`,
      ...paths.map((file) => `  ${/\s/u.test(file) ? JSON.stringify(file) : file}`),
    ]),
    "",
    "Rebase the original branch onto main before squashing, or squash against",
    "`git merge-base HEAD main` and then rebase onto main.",
    "For an intentional undo, use git revert or name the commit hash in a revert: commit.",
  ];
  process.stderr.write(lines.join("\n") + "\n");
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  process.exitCode = main(process.cwd(), process.argv.slice(2));
}
