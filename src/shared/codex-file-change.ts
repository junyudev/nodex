import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import type {
  CodexFileChange,
  CodexFileChangeKind,
  CodexFileChangeLineCounts,
  CodexFileChangeMap,
  CodexFileChangePatch,
  CodexItemStatus,
  CodexProtocolRequestId,
  CodexTurnDiffPatchBatch,
  ReviewFileSafety,
  ReviewSkipReason,
} from "./types";
import { classifyReviewTextPayload, REVIEW_RENDERABLE_TEXT_MAX_BYTES } from "./review-file-safety";
import { classifyContentBudget } from "./content-budget";

export type CodexFileChangeDisplayStatus =
  | "applied"
  | "pending"
  | "rejected"
  | "streaming"
  | "stopped";
export type CodexFileChangePatchAction = "create" | "delete" | "edit";

export interface CodexUnifiedDiffSummary {
  additions: number;
  deletions: number;
  openLine: number;
}

export interface CodexFileChangePatchRow {
  key: string;
  path: string;
  action: CodexFileChangePatchAction;
  change: CodexFileChange;
  patch: CodexFileChangePatch;
  unifiedDiff: string | null;
  summary: CodexUnifiedDiffSummary | null;
  safety: ReviewFileSafety | null;
  openLine?: number;
}

export interface CodexFileChangePatchSummary {
  rows: CodexFileChangePatchRow[];
  fileCount: number;
  additions: number;
  deletions: number;
  firstPath: string | null;
  hasChanges: boolean;
}

export const CODEX_FILE_CHANGE_MAX_INLINE_BYTES = 256 * 1024;
export const CODEX_FILE_CHANGE_MAX_INLINE_LINES = 5_000;

export function canParseCodexFileChangeInline(diffText: string): boolean {
  return (
    classifyContentBudget({
      value: diffText,
      maxBytes: CODEX_FILE_CHANGE_MAX_INLINE_BYTES,
      maxLines: CODEX_FILE_CHANGE_MAX_INLINE_LINES,
    }).kind === "withinBudget"
  );
}

const CODEX_VISUALIZATION_PATH_PATTERN =
  /(?:^|[\\/])\.codex[\\/]visualizations[\\/]\d{4}[\\/]\d{2}[\\/]\d{2}[\\/][a-zA-Z0-9_-]+[\\/][a-z0-9]+(?:-[a-z0-9]+)*\.html$/;

export function isCodexVisualizationPath(path: string): boolean {
  return CODEX_VISUALIZATION_PATH_PATTERN.test(path);
}

function extractGitDiffDestinationPath(header: string): string | null {
  const payload = header.slice("diff --git ".length);
  if (payload.startsWith('"')) {
    const match = /^"[^"]*"\s+"b\/([^"]+)"$/.exec(payload);
    return match?.[1] ?? null;
  }
  const destinationIndex = payload.lastIndexOf(" b/");
  return destinationIndex < 0 ? null : payload.slice(destinationIndex + 3);
}

/** Exact VGe behavior: omit visualization-only git diff blocks from turn diff. */
export function stripCodexVisualizationDiffBlocks(diff: string): string {
  const retained: string[] = [];
  let block = "";
  let keepBlock = true;

  for (const line of diff.split(/(?<=\n)/)) {
    if (line.startsWith("diff --git ")) {
      if (keepBlock) retained.push(block);
      block = line;
      const path = extractGitDiffDestinationPath(line.replace(/\r?\n$/, ""));
      keepBlock = !isCodexVisualizationPath(path ?? "");
      continue;
    }
    block += line;
  }
  if (keepBlock) retained.push(block);
  return retained.join("");
}

function normalizeText(value: string): string {
  return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function normalizeContentLines(value: string): string[] {
  const normalized = normalizeText(value);
  const lines = normalized.split("\n");
  return lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
}

function isReviewFileSafety(value: unknown): value is ReviewFileSafety {
  if (typeof value !== "object" || value === null) return false;
  const safety = value as Partial<ReviewFileSafety>;
  const skipReason = safety.skipReason as ReviewSkipReason | null | undefined;
  return (
    typeof safety.binary === "boolean" &&
    typeof safety.tooLarge === "boolean" &&
    typeof safety.invalidText === "boolean" &&
    typeof safety.renderable === "boolean" &&
    (safety.sizeBytes === null || typeof safety.sizeBytes === "number") &&
    (safety.mimeType === null || typeof safety.mimeType === "string") &&
    (skipReason === null ||
      skipReason === "binary" ||
      skipReason === "tooLarge" ||
      skipReason === "invalidText" ||
      skipReason === "unsupported")
  );
}

function buildNonRenderableCodexFileChange(input: {
  path: string;
  kind: CodexFileChangeKind;
  movePath?: string | null;
  safety: ReviewFileSafety;
}): CodexFileChange {
  return {
    path: input.path,
    type: "nonRenderable",
    originalType: input.kind,
    movePath: input.movePath ?? null,
    safety: input.safety,
  };
}

/** A withheld diff with measured counts was set aside for its size. */
function withheldDiffSafety(measured: boolean): ReviewFileSafety {
  return {
    binary: false,
    tooLarge: measured,
    invalidText: false,
    renderable: false,
    sizeBytes: null,
    mimeType: null,
    skipReason: measured ? "tooLarge" : "unsupported",
  };
}

function measuredLines(change: { lineCounts?: CodexFileChangeLineCounts }) {
  return change.lineCounts ? { lineCounts: change.lineCounts } : {};
}

export function buildCodexFileChangeFromProtocol(input: {
  path: string;
  kind: CodexFileChangeKind;
  diff: string;
  movePath?: string | null;
  /** Changed lines the execution owner measured from the complete diff. */
  lineCounts?: CodexFileChangeLineCounts;
  /** The execution owner withheld the diff text. */
  diffWithheld?: boolean;
}): CodexFileChange | null {
  const path = input.path.trim();
  if (path.length === 0) return null;
  const change = buildCodexFileChangeBody({ ...input, path });
  return { ...change, ...measuredLines(input) };
}

function buildCodexFileChangeBody(input: {
  path: string;
  kind: CodexFileChangeKind;
  diff: string;
  movePath?: string | null;
  lineCounts?: CodexFileChangeLineCounts;
  diffWithheld?: boolean;
}): CodexFileChange {
  const { path } = input;
  if (input.diffWithheld) {
    return buildNonRenderableCodexFileChange({
      path,
      kind: input.kind,
      movePath: input.movePath ?? null,
      safety: withheldDiffSafety(input.lineCounts !== undefined),
    });
  }
  const safety = classifyReviewTextPayload({
    path,
    text: input.diff,
    maxBytes: REVIEW_RENDERABLE_TEXT_MAX_BYTES,
  });

  if (!safety.renderable) {
    return buildNonRenderableCodexFileChange({
      path,
      kind: input.kind,
      movePath: input.movePath ?? null,
      safety,
    });
  }

  if (input.kind === "add") {
    return {
      path,
      type: "add",
      content: input.diff,
    };
  }

  if (input.kind === "delete") {
    return {
      path,
      type: "delete",
      content: input.diff,
    };
  }

  return {
    path,
    type: "update",
    unifiedDiff: normalizeText(input.diff),
    movePath: input.movePath ?? null,
  };
}

export function toCodexFileChangePatch(change: CodexFileChange): CodexFileChangePatch {
  if (change.type === "add") {
    return {
      type: "add",
      content: change.content,
      ...measuredLines(change),
    };
  }

  if (change.type === "delete") {
    return {
      type: "delete",
      content: change.content,
      ...measuredLines(change),
    };
  }

  if (change.type === "nonRenderable") {
    return {
      type: "nonRenderable",
      originalType: change.originalType,
      movePath: change.movePath,
      safety: change.safety,
      ...measuredLines(change),
    };
  }

  return {
    type: "update",
    unifiedDiff: change.unifiedDiff,
    movePath: change.movePath,
    ...measuredLines(change),
  };
}

export function materializeCodexFileChange(
  path: string,
  change: CodexFileChangePatch,
): CodexFileChange {
  if (change.type === "add") {
    return {
      path,
      type: "add",
      content: change.content,
      ...measuredLines(change),
    };
  }

  if (change.type === "delete") {
    return {
      path,
      type: "delete",
      content: change.content,
      ...measuredLines(change),
    };
  }

  if (change.type === "nonRenderable") {
    return {
      path,
      type: "nonRenderable",
      originalType: change.originalType,
      movePath: change.movePath,
      safety: change.safety,
      ...measuredLines(change),
    };
  }

  return {
    path,
    type: "update",
    unifiedDiff: change.unifiedDiff,
    movePath: change.movePath,
    ...measuredLines(change),
  };
}

export function buildCodexFileChangeMap(changes: readonly CodexFileChange[]): CodexFileChangeMap {
  const map: CodexFileChangeMap = {};
  for (const change of changes) {
    map[change.path] = toCodexFileChangePatch(change);
  }
  return map;
}

export function isCodexFileChangePatch(value: unknown): value is CodexFileChangePatch {
  if (typeof value !== "object" || value === null) return false;
  const patch = value as Partial<CodexFileChangePatch>;
  if (patch.type === "add" || patch.type === "delete") return typeof patch.content === "string";
  if (patch.type === "update") return typeof patch.unifiedDiff === "string";
  if (patch.type === "nonRenderable") {
    return (
      (patch.originalType === "add" ||
        patch.originalType === "delete" ||
        patch.originalType === "update") &&
      isReviewFileSafety(patch.safety)
    );
  }
  return false;
}

export function getCodexFileChangeEntries(
  changes: CodexFileChangeMap | null | undefined,
): Array<[string, CodexFileChangePatch]> {
  if (!changes) return [];
  if (Array.isArray(changes)) return [];
  return Object.entries(changes).filter(
    (entry): entry is [string, CodexFileChangePatch] =>
      entry[0].trim().length > 0 && isCodexFileChangePatch(entry[1]),
  );
}

export function hasCodexFileChangeEntries(changes: CodexFileChangeMap | null | undefined): boolean {
  return getCodexFileChangeEntries(changes).length > 0;
}

export function getCodexFileChangeList(
  changes: CodexFileChangeMap | null | undefined,
): CodexFileChange[] {
  return getCodexFileChangeEntries(changes).map(([path, change]) =>
    materializeCodexFileChange(path, change),
  );
}

export function getCodexFileChangePaths(changes: CodexFileChangeMap | null | undefined): string[] {
  return getCodexFileChangeEntries(changes).map(([path]) => path);
}

export function resolveCodexPatchSuccess(status: CodexItemStatus | undefined): boolean | null {
  if (status === "completed") return true;
  if (status === "failed" || status === "declined") return false;
  return null;
}

export function resolveCodexFileChangeDisplayStatus(input: {
  success: boolean | null | undefined;
  approvalRequestId: CodexProtocolRequestId | null | undefined;
  isTurnCancelled: boolean;
}): CodexFileChangeDisplayStatus {
  if (input.success === true) return "applied";
  if (input.success === false) return "rejected";
  if (input.approvalRequestId != null) return "pending";
  if (input.isTurnCancelled) return "stopped";
  return "streaming";
}

export function buildCodexFileChangeUnifiedDiff(change: CodexFileChange): string | null;
export function buildCodexFileChangeUnifiedDiff(
  path: string,
  change: CodexFileChangePatch,
): string | null;
export function buildCodexFileChangeUnifiedDiff(
  pathOrChange: string | CodexFileChange,
  maybeChange?: CodexFileChangePatch,
): string | null {
  const path = typeof pathOrChange === "string" ? pathOrChange : pathOrChange.path;
  const change =
    typeof pathOrChange === "string" ? maybeChange : toCodexFileChangePatch(pathOrChange);
  if (!change) return null;
  if (change.type === "nonRenderable") return null;

  if (change.type === "update") {
    const previousPath = path;
    const currentPath = change.movePath ?? path;
    const unifiedDiff = change.unifiedDiff.trimStart();
    const hasFileHeaders = /\n?---\s/.test(unifiedDiff);
    const hasDiffGitHeader = /^diff --git /m.test(unifiedDiff);
    const patch = hasFileHeaders
      ? unifiedDiff
      : `--- a/${previousPath}\n+++ b/${currentPath}\n${unifiedDiff}`;
    return `${hasDiffGitHeader ? "" : `diff --git a/${previousPath} b/${currentPath}\n`}${patch}`;
  }

  const lines = normalizeContentLines(change.content);
  const lineCount = lines.length;

  if (change.type === "add") {
    const additions = lines.map((line) => `+${line}`).join("\n");
    const hunk = lineCount > 0 ? `@@ -0,0 +1,${lineCount} @@\n${additions}\n` : "";
    return [
      `diff --git a/${path} b/${path}`,
      "new file mode 100644",
      "--- /dev/null",
      `+++ b/${path}`,
      hunk,
    ]
      .filter(Boolean)
      .join("\n");
  }

  const deletions = lines.map((line) => `-${line}`).join("\n");
  const hunk = lineCount > 0 ? `@@ -1,${lineCount} +0,0 @@\n${deletions}\n` : "";
  return [
    `diff --git a/${path} b/${path}`,
    "deleted file mode 100644",
    `--- a/${path}`,
    "+++ /dev/null",
    hunk,
  ]
    .filter(Boolean)
    .join("\n");
}

function summarizeDiffByLineScan(diffText: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  let start = 0;

  while (start <= diffText.length) {
    const lineEnd = diffText.indexOf("\n", start);
    const end = lineEnd < 0 ? diffText.length : lineEnd;
    const line = diffText.slice(start, end).replace(/\r$/u, "");
    if (!line.startsWith("+++") && !line.startsWith("---")) {
      if (line.startsWith("+")) additions += 1;
      if (line.startsWith("-")) deletions += 1;
    }

    if (lineEnd < 0) break;
    start = lineEnd + 1;
  }
  return { additions, deletions };
}

function countFileDiffMetadataLines(fileDiff: FileDiffMetadata): {
  additions: number;
  deletions: number;
} {
  return fileDiff.hunks.reduce(
    (summary, hunk) => ({
      additions: summary.additions + hunk.additionLines,
      deletions: summary.deletions + hunk.deletionLines,
    }),
    { additions: 0, deletions: 0 },
  );
}

function getPositiveNumber(value: unknown): number | null {
  return typeof value === "number" && value > 0 ? value : null;
}

function resolveFirstChangedLine(fileDiff: FileDiffMetadata): number {
  const additionHunk = fileDiff.hunks.find(
    (hunk) =>
      getPositiveNumber((hunk as { additionCount?: unknown }).additionCount) != null ||
      getPositiveNumber(hunk.additionLines) != null,
  );
  const deletionHunk = fileDiff.hunks.find((hunk) => getPositiveNumber(hunk.deletionLines) != null);
  return (
    getPositiveNumber(additionHunk?.additionStart) ??
    getPositiveNumber(deletionHunk?.deletionStart) ??
    1
  );
}

function parseFirstFileDiff(diffText: string): FileDiffMetadata | null {
  try {
    return parsePatchFiles(diffText)[0]?.files[0] ?? null;
  } catch {
    return null;
  }
}

export function summarizeCodexUnifiedDiff(
  diffText: string | null | undefined,
): CodexUnifiedDiffSummary | null {
  if (!diffText) return null;

  const fallback = summarizeDiffByLineScan(diffText);
  if (!canParseCodexFileChangeInline(diffText)) {
    return fallback.additions === 0 && fallback.deletions === 0
      ? null
      : { ...fallback, openLine: 1 };
  }
  const fileDiff = parseFirstFileDiff(diffText);
  if (fileDiff) {
    const parsed = countFileDiffMetadataLines(fileDiff);
    if (
      parsed.additions > 0 ||
      parsed.deletions > 0 ||
      (fallback.additions === 0 && fallback.deletions === 0)
    ) {
      return {
        additions: parsed.additions,
        deletions: parsed.deletions,
        openLine: resolveFirstChangedLine(fileDiff),
      };
    }
  }

  if (fallback.additions === 0 && fallback.deletions === 0) return null;

  return {
    ...fallback,
    openLine: 1,
  };
}

/** Counts its execution owner measured win over a recount of possibly withheld or bounded text. */
function withMeasuredLines(
  summary: CodexUnifiedDiffSummary | null,
  change: CodexFileChangePatch,
): CodexUnifiedDiffSummary | null {
  return change.lineCounts ? { ...change.lineCounts, openLine: summary?.openLine ?? 1 } : summary;
}

/** One file's changed lines, measured by its execution owner or read from its diff. */
export function summarizeCodexFileChangeLines(
  path: string,
  change: CodexFileChangePatch,
): CodexUnifiedDiffSummary | null {
  return withMeasuredLines(
    summarizeCodexUnifiedDiff(buildCodexFileChangeUnifiedDiff(path, change)),
    change,
  );
}

export function resolveCodexFileChangePatchAction(
  change: CodexFileChange | CodexFileChangePatch,
): CodexFileChangePatchAction {
  const type = change.type === "nonRenderable" ? change.originalType : change.type;
  if (type === "add") return "create";
  if (type === "delete") return "delete";
  return "edit";
}

export function buildCodexFileChangePatchRows(
  changes: CodexFileChangeMap | null | undefined,
): CodexFileChangePatchRow[] {
  return getCodexFileChangeEntries(changes).map(([path, patch]) => {
    const change = materializeCodexFileChange(path, patch);
    const unifiedDiff = buildCodexFileChangeUnifiedDiff(path, patch);
    const summary = withMeasuredLines(summarizeCodexUnifiedDiff(unifiedDiff), patch);

    return {
      key: path,
      path,
      action: resolveCodexFileChangePatchAction(patch),
      change,
      patch,
      unifiedDiff,
      summary,
      safety: patch.type === "nonRenderable" ? patch.safety : null,
      openLine: summary?.openLine,
    };
  });
}

export function summarizeCodexFileChangePatch(
  changes: CodexFileChangeMap | null | undefined,
): CodexFileChangePatchSummary | null {
  const rows = buildCodexFileChangePatchRows(changes);
  if (rows.length === 0) return null;

  const totals = rows.reduce(
    (summary, row) => ({
      additions: summary.additions + (row.summary?.additions ?? 0),
      deletions: summary.deletions + (row.summary?.deletions ?? 0),
    }),
    { additions: 0, deletions: 0 },
  );

  return {
    rows,
    fileCount: rows.length,
    additions: totals.additions,
    deletions: totals.deletions,
    firstPath: rows[0]?.path ?? null,
    hasChanges: true,
  };
}

export function isCodexFileChange(value: unknown): value is CodexFileChange {
  if (typeof value !== "object" || value === null) return false;
  const change = value as Partial<CodexFileChange>;
  if (typeof change.path !== "string" || change.path.trim().length === 0) return false;
  if (change.type === "add" || change.type === "delete") return typeof change.content === "string";
  if (change.type === "update")
    return typeof change.unifiedDiff === "string" && change.unifiedDiff.trim().length > 0;
  if (change.type === "nonRenderable") {
    return (
      (change.originalType === "add" ||
        change.originalType === "delete" ||
        change.originalType === "update") &&
      isReviewFileSafety(change.safety)
    );
  }
  return false;
}

function buildPatchMergeKey(cwd: string | null | undefined, path: string): string {
  return `${cwd ?? ""}\0${path}`;
}

function extractHunksForAppend(diff: string): string | null {
  const trimmed = diff.trimStart();
  if (trimmed.startsWith("@@")) return trimmed;

  const hunkStart = trimmed.indexOf("\n@@");
  if (hunkStart === -1) return null;
  return trimmed.slice(hunkStart + 1);
}

function normalizePatchSection(diff: string): string | null {
  const normalized = normalizeText(diff).trim();
  return normalized.length > 0 ? normalized : null;
}

export function buildCodexTurnDiffFromPatchBatches(
  patchBatches: readonly CodexTurnDiffPatchBatch[],
): string {
  const sections: string[] = [];
  const updateSectionIndexByPath = new Map<string, number>();

  for (const batch of patchBatches) {
    const cwd = typeof batch.cwd === "string" && batch.cwd.trim().length > 0 ? batch.cwd : null;
    for (const change of batch.changes) {
      if (!isCodexFileChange(change)) continue;

      const section = normalizePatchSection(buildCodexFileChangeUnifiedDiff(change) ?? "");
      if (!section) continue;

      const mergeKey = buildPatchMergeKey(cwd, change.path);
      const canMergeUpdate = change.type === "update" && change.movePath == null;
      if (!canMergeUpdate) {
        updateSectionIndexByPath.delete(mergeKey);
        if (change.type === "update" && change.movePath) {
          updateSectionIndexByPath.delete(buildPatchMergeKey(cwd, change.movePath));
        }
        sections.push(section);
        continue;
      }

      const existingIndex = updateSectionIndexByPath.get(mergeKey);
      if (existingIndex === undefined) {
        updateSectionIndexByPath.set(mergeKey, sections.length);
        sections.push(section);
        continue;
      }

      const hunks = extractHunksForAppend(section);
      if (!hunks) {
        sections[existingIndex] = section;
        continue;
      }
      sections[existingIndex] = `${sections[existingIndex]?.trimEnd() ?? ""}\n${hunks}`;
    }
  }

  const diff = sections.filter((section) => section.trim().length > 0).join("\n\n");
  return diff.length > 0 ? `${diff}\n` : "";
}
