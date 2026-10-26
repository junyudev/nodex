/**
 * File changes in one provider-neutral shape. Adapters record every file a tool changed with its
 * operation, diff text and line counts, measured once from the complete diff, so presentation
 * never has to infer a change from a provider's text or from a diff a projection withheld.
 */
import type { OrchestrationV2FileChangeDetail } from "@t3tools/contracts";
import { unquoteGitPatchPath } from "./gitPatchPath.ts";

export interface FileChangeInput {
  /** `add`, `delete`, `modify` or `move`; a provider may report another ACP diff operation. */
  readonly operation: string;
  readonly path: string;
  readonly oldPath?: string | undefined;
  /** Content for `add` and `delete`, unified diff hunks otherwise. */
  readonly diff?: string | undefined;
  readonly fileType?: string | undefined;
  readonly mimeType?: string | undefined;
}

export interface FileChangeLineCounts {
  readonly additions: number;
  readonly deletions: number;
}

/** Structured hunks as `diff`'s `structuredPatch` and Claude's edit results report them. */
export interface StructuredHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: ReadonlyArray<string>;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u;

function normalizedLines(text: string): string[] {
  return text.replaceAll("\r\n", "\n").split("\n");
}

function contentLineCount(content: string): number {
  if (content.length === 0) return 0;
  const lines = normalizedLines(content);
  return lines.at(-1) === "" ? lines.length - 1 : lines.length;
}

/**
 * Counts inside hunks only, bounded by each hunk header, so a removed line that reads `--- x` is
 * still a deletion. Text without hunk headers falls back to a scan that skips file headers.
 */
function countHunkLines(diff: string): FileChangeLineCounts {
  let additions = 0;
  let deletions = 0;
  let oldLeft = 0;
  let newLeft = 0;
  let sawHunk = false;
  for (const line of normalizedLines(diff)) {
    const header = HUNK_HEADER.exec(line);
    if (header) {
      sawHunk = true;
      oldLeft = header[2] === undefined ? 1 : Number(header[2]);
      newLeft = header[4] === undefined ? 1 : Number(header[4]);
      continue;
    }
    if (oldLeft <= 0 && newLeft <= 0) continue;
    if (line.startsWith("+")) {
      additions += 1;
      newLeft -= 1;
    } else if (line.startsWith("-")) {
      deletions += 1;
      oldLeft -= 1;
    } else if (!line.startsWith("\\")) {
      oldLeft -= 1;
      newLeft -= 1;
    }
  }
  if (sawHunk) return { additions, deletions };
  for (const line of normalizedLines(diff)) {
    if (line.startsWith("+") && !line.startsWith("+++ ")) additions += 1;
    if (line.startsWith("-") && !line.startsWith("--- ")) deletions += 1;
  }
  return { additions, deletions };
}

export function countFileChangeLines(operation: string, diff: string): FileChangeLineCounts {
  if (operation === "add") return { additions: contentLineCount(diff), deletions: 0 };
  if (operation === "delete") return { additions: 0, deletions: contentLineCount(diff) };
  return countHunkLines(diff);
}

/** One recorded file change with its measured counts; a blank path records nothing. */
export function fileChangeDetail(input: FileChangeInput): OrchestrationV2FileChangeDetail | null {
  const path = input.path.trim();
  const operation = input.operation.trim();
  if (path.length === 0 || operation.length === 0) return null;
  const oldPath = input.oldPath?.trim();
  const fileType = input.fileType?.trim();
  const mimeType = input.mimeType?.trim();
  return {
    operation,
    path,
    ...(oldPath ? { oldPath } : {}),
    ...(fileType ? { fileType } : {}),
    ...(mimeType ? { mimeType } : {}),
    ...(input.diff === undefined
      ? {}
      : { diff: input.diff, ...countFileChangeLines(operation, input.diff) }),
  };
}

/** The item-level identity and totals of a file_change item, or nothing when no file changed. */
export function fileChangeItemFields(changes: ReadonlyArray<OrchestrationV2FileChangeDetail>):
  | {
      readonly fileName: string;
      readonly changes: Array<OrchestrationV2FileChangeDetail>;
      readonly additions?: number;
      readonly deletions?: number;
    }
  | undefined {
  const first = changes[0];
  if (first === undefined) return undefined;
  const measured = changes.filter((change) => change.additions !== undefined);
  return {
    fileName: first.path,
    changes: [...changes],
    ...(measured.length === 0
      ? {}
      : {
          additions: measured.reduce((total, change) => total + (change.additions ?? 0), 0),
          deletions: measured.reduce((total, change) => total + (change.deletions ?? 0), 0),
        }),
  };
}

/** Unified hunk text for structured hunks. */
export function unifiedHunksText(hunks: ReadonlyArray<StructuredHunk>): string {
  return hunks
    .map(
      (hunk) =>
        `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${hunk.lines
          .map((line) => `${line}\n`)
          .join("")}`,
    )
    .join("");
}

interface PatchSection {
  gitOld?: string;
  gitNew?: string;
  /** `null` is `/dev/null`; `undefined` means the header was absent. */
  oldName?: string | null;
  newName?: string | null;
  renameFrom?: string;
  renameTo?: string;
  created: boolean;
  deleted: boolean;
  binary: boolean;
  hunkLines: string[];
}

function headerToken(token: string): string {
  return token.startsWith('"') ? unquoteGitPatchPath(token) : token;
}

function headerName(rest: string): string | null {
  const name = headerToken(rest.startsWith('"') ? rest : (rest.split("\t")[0] ?? rest).trimEnd());
  return name === "/dev/null" ? null : name;
}

function gitHeaderNames(rest: string): { readonly old: string; readonly new: string } | undefined {
  const quoted = /^("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|\S+)$/u.exec(rest);
  if (quoted?.[1]?.startsWith('"') || quoted?.[2]?.startsWith('"'))
    return { old: headerToken(quoted[1]!), new: headerToken(quoted[2]!) };
  // Equal names split in the middle, as git reads them, so a name holding " b/" stays whole.
  const middle = (rest.length - 1) / 2;
  if (
    rest.startsWith("a/") &&
    rest[middle] === " " &&
    rest.startsWith("b/", middle + 1) &&
    rest.slice(2, middle) === rest.slice(middle + 3)
  )
    return { old: rest.slice(0, middle), new: rest.slice(middle + 1) };
  const split = rest.lastIndexOf(" b/");
  return split < 0 ? undefined : { old: rest.slice(0, split), new: rest.slice(split + 1) };
}

function stripPrefix(name: string | undefined, prefix: "a/" | "b/", git: boolean) {
  return name !== undefined && git && name.startsWith(prefix) ? name.slice(2) : name;
}

function sectionContent(lines: ReadonlyArray<string>, marker: "+" | "-"): string {
  const content: string[] = [];
  let newlineAtEnd = true;
  for (const line of lines) {
    if (line.startsWith(marker)) {
      content.push(line.slice(1));
      newlineAtEnd = true;
    } else if (line.startsWith("\\") && content.length > 0) {
      newlineAtEnd = false;
    }
  }
  return content.length === 0 ? "" : `${content.join("\n")}${newlineAtEnd ? "\n" : ""}`;
}

function sectionChange(
  section: PatchSection,
  fallbackPath: string | undefined,
): OrchestrationV2FileChangeDetail | null {
  const named = section.oldName !== undefined || section.newName !== undefined;
  // Outside git's own headers, text is a patch only with hunks under both file headers or none.
  if (
    section.gitOld === undefined &&
    (section.hunkLines.length === 0 ||
      (named && (section.oldName === undefined || section.newName === undefined)))
  )
    return null;
  const prefixed = (name: string | null | undefined, prefix: "a/" | "b/") =>
    name == null || name.startsWith(prefix);
  const git =
    section.gitOld !== undefined ||
    (named &&
      (section.oldName ?? section.newName) != null &&
      prefixed(section.oldName, "a/") &&
      prefixed(section.newName, "b/"));
  // Only headerless hunks belong to the reported path.
  const fallback = named || section.gitOld !== undefined ? undefined : fallbackPath;
  const oldPath =
    section.renameFrom ?? stripPrefix(section.oldName ?? section.gitOld, "a/", git) ?? fallback;
  const newPath =
    section.renameTo ?? stripPrefix(section.newName ?? section.gitNew, "b/", git) ?? fallback;
  const hunks = section.hunkLines.filter((line, index, lines) =>
    index === lines.length - 1 ? line.length > 0 : true,
  );
  const diff = section.binary ? undefined : hunks.length === 0 ? "" : `${hunks.join("\n")}\n`;
  if (section.created || section.oldName === null)
    return fileChangeDetail({
      operation: "add",
      path: newPath ?? "",
      diff: diff === undefined ? undefined : sectionContent(hunks, "+"),
    });
  if (section.deleted || section.newName === null)
    return fileChangeDetail({
      operation: "delete",
      path: oldPath ?? "",
      diff: diff === undefined ? undefined : sectionContent(hunks, "-"),
    });
  if (oldPath !== undefined && newPath !== undefined && oldPath !== newPath)
    return fileChangeDetail({ operation: "move", path: newPath, oldPath, diff });
  return fileChangeDetail({ operation: "modify", path: newPath ?? oldPath ?? "", diff });
}

/**
 * The file changes a unified patch describes, one per file. Git and plain unified headers are
 * both read; headerless hunks belong to `fallbackPath`.
 */
export function fileChangesFromPatch(
  patch: string,
  fallbackPath?: string,
): Array<OrchestrationV2FileChangeDetail> {
  const sections: PatchSection[] = [];
  let current: PatchSection | undefined;
  let oldLeft = 0;
  let newLeft = 0;
  const start = (): PatchSection => {
    current = { created: false, deleted: false, binary: false, hunkLines: [] };
    sections.push(current);
    return current;
  };
  for (const line of normalizedLines(patch)) {
    if (current !== undefined && (oldLeft > 0 || newLeft > 0)) {
      current.hunkLines.push(line);
      if (line.startsWith("+")) newLeft -= 1;
      else if (line.startsWith("-")) oldLeft -= 1;
      else if (!line.startsWith("\\")) {
        oldLeft -= 1;
        newLeft -= 1;
      }
      continue;
    }
    const hunk = HUNK_HEADER.exec(line);
    if (hunk) {
      (current ?? start()).hunkLines.push(line);
      oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      newLeft = hunk[4] === undefined ? 1 : Number(hunk[4]);
      continue;
    }
    if (line.startsWith("\\") && current !== undefined && current.hunkLines.length > 0) {
      current.hunkLines.push(line);
      continue;
    }
    if (line.startsWith("diff --git ")) {
      const names = gitHeaderNames(line.slice("diff --git ".length));
      const section = start();
      if (names) {
        section.gitOld = names.old;
        section.gitNew = names.new;
      }
      continue;
    }
    if (line.startsWith("--- ")) {
      const section =
        current === undefined || current.hunkLines.length > 0 || current.oldName !== undefined
          ? start()
          : current;
      section.oldName = headerName(line.slice(4));
      continue;
    }
    if (current === undefined) continue;
    if (line.startsWith("+++ ")) current.newName = headerName(line.slice(4));
    else if (line.startsWith("new file mode")) current.created = true;
    else if (line.startsWith("deleted file mode")) current.deleted = true;
    else if (line.startsWith("rename from ")) current.renameFrom = headerToken(line.slice(12));
    else if (line.startsWith("rename to ")) current.renameTo = headerToken(line.slice(10));
    else if (line.startsWith("Binary files ") || line === "GIT binary patch") current.binary = true;
  }
  return sections.flatMap((section) => sectionChange(section, fallbackPath) ?? []);
}
