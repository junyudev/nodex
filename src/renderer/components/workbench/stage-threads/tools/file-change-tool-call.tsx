import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff, PatchDiff, type FileDiffMetadata } from "@pierre/diffs/react";
import { useMemo } from "react";
import { useTheme } from "../../../../lib/use-theme";
import type { CodexItemView } from "../../../../lib/types";
import {
  NODEX_DIFF_HOST_CLASS,
  getNodexDiffHostStyle,
  getNodexDiffOptions,
} from "./diff-presentation";
import { InlineToolToggle, ToolErrorDetail } from "./tool-primitives";

interface DiffSummary {
  additions: number;
  deletions: number;
}

interface FileChangeToolCallProps {
  item: CodexItemView;
  defaultExpanded?: boolean;
}

interface ParsedChange {
  path?: string;
  diff?: string;
}

function extractDiffText(item: CodexItemView): string | undefined {
  const toolResult = item.toolCall?.result;
  if (typeof toolResult === "object" && toolResult !== null) {
    const candidate = toolResult as { diff?: unknown };
    if (typeof candidate.diff === "string" && candidate.diff.trim().length > 0) {
      return candidate.diff;
    }
  }

  return undefined;
}

function summarizeDiff(diffText: string | undefined): DiffSummary {
  if (!diffText) return { additions: 0, deletions: 0 };

  const lines = diffText.split("\n");
  let additions = 0;
  let deletions = 0;

  for (const line of lines) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions += 1;
    if (line.startsWith("-")) deletions += 1;
  }

  return { additions, deletions };
}

function extractParsedChanges(item: CodexItemView): ParsedChange[] {
  const args = item.toolCall?.args;
  if (typeof args !== "object" || args === null) return [];
  const candidate = args as { changes?: unknown };
  if (!Array.isArray(candidate.changes)) return [];

  return candidate.changes
    .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
    .map((entry) => ({
      path: typeof entry.path === "string" ? entry.path : undefined,
      diff: typeof entry.diff === "string" ? entry.diff : undefined,
    }))
    .filter((entry) => typeof entry.diff === "string" && entry.diff.trim().length > 0);
}

function normalizePathForPatch(path: string | undefined, fallbackIndex: number): string {
  if (!path) return `file-${fallbackIndex + 1}.txt`;

  const normalized = path.replaceAll("\\", "/").trim();
  const trimmed = normalized.replace(/^([ab])\//, "");
  const parts = trimmed.split("/").filter((part) => part.length > 0);
  if (parts.length === 0) return `file-${fallbackIndex + 1}.txt`;
  return parts[parts.length - 1];
}

function isSingleFilePatch(patch: string): boolean {
  try {
    const parsed = parsePatchFiles(patch);
    if (parsed.length !== 1) return false;
    return parsed[0]?.files.length === 1;
  } catch {
    return false;
  }
}

function toSingleFilePatch(change: ParsedChange, index: number): string | undefined {
  if (!change.diff) return undefined;
  const normalizedDiff = `${change.diff.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trimEnd()}\n`;
  if (normalizedDiff.trim().length === 0) return undefined;

  if (isSingleFilePatch(normalizedDiff)) return normalizedDiff;

  const hasHunkHeader = normalizedDiff.split("\n").some((line) => line.startsWith("@@ "));
  if (!hasHunkHeader) return undefined;

  const patchPath = normalizePathForPatch(change.path, index);
  const synthesizedPatch = `--- a/${patchPath}\n+++ b/${patchPath}\n${normalizedDiff}`;
  return isSingleFilePatch(synthesizedPatch) ? synthesizedPatch : undefined;
}

function extractRenderablePatches(item: CodexItemView, diffText: string | undefined): string[] {
  const patchesFromChanges = extractParsedChanges(item)
    .map((change, index) => toSingleFilePatch(change, index))
    .filter((patch): patch is string => typeof patch === "string");
  if (patchesFromChanges.length > 0) return patchesFromChanges;

  if (!diffText) return [];
  if (isSingleFilePatch(diffText)) return [diffText];
  return [];
}

function parseDiffFiles(diffText: string | undefined): FileDiffMetadata[] {
  if (!diffText) return [];

  try {
    const patches = parsePatchFiles(diffText);
    return patches.flatMap((patch) => patch.files);
  } catch {
    return [];
  }
}

/** Extract filenames from patches for display in the card header. */
function extractFilenames(patches: string[], fileDiffs: FileDiffMetadata[]): string[] {
  if (patches.length > 0) {
    return patches.flatMap((patch) => {
      try {
        const parsed = parsePatchFiles(patch);
        return parsed.flatMap((p) => p.files.map((f) => f.name));
      } catch {
        return [];
      }
    });
  }
  return fileDiffs.map((f) => f.name);
}

/** Strip directory prefixes, return just the basename. */
function basename(filePath: string): string {
  const cleaned = filePath.replace(/^[ab]\//, "");
  const parts = cleaned.split("/");
  return parts[parts.length - 1] ?? cleaned;
}

function buildLabel(filenames: string[]): string {
  if (filenames.length === 0) return "Edited file";
  if (filenames.length === 1) return `Edited ${basename(filenames[0])}`;
  return `Edited ${basename(filenames[0])} +${filenames.length - 1} more`;
}

function DiffStats({ additions, deletions }: DiffSummary) {
  if (additions === 0 && deletions === 0) return null;
  return (
    <>
      <span className="text-(--green-text)">+{additions}</span>
      {" "}
      <span className="text-(--red-text)">-{deletions}</span>
    </>
  );
}

export function FileChangeToolCall({ item, defaultExpanded = false }: FileChangeToolCallProps) {
  const diffText = extractDiffText(item);
  const { resolved } = useTheme();
  const renderablePatches = useMemo(() => extractRenderablePatches(item, diffText), [item, diffText]);
  const summary = useMemo(() => summarizeDiff(diffText), [diffText]);
  const fileDiffs = useMemo(() => {
    if (renderablePatches.length > 0) return [];
    return parseDiffFiles(diffText);
  }, [renderablePatches, diffText]);
  const filenames = useMemo(
    () => extractFilenames(renderablePatches, fileDiffs),
    [renderablePatches, fileDiffs],
  );
  const isSingleFile = filenames.length <= 1;
  const label = buildLabel(filenames);
  const diffOptions = useMemo(() => getNodexDiffOptions(resolved, isSingleFile), [resolved, isSingleFile]);
  const diffHostStyle = useMemo(() => getNodexDiffHostStyle(resolved), [resolved]);
  const diffHostClassName = `${NODEX_DIFF_HOST_CLASS} max-h-[250px] overflow-y-auto`;

  return (
    <InlineToolToggle
      label={label}
      leadingLabel="Edited"
      subtitle={<DiffStats additions={summary.additions} deletions={summary.deletions} />}
      status={item.status}
      defaultExpanded={defaultExpanded}
    >
      {renderablePatches.length > 0 ? (
        <div className="-mx-2 -mb-1 overflow-hidden rounded-b-md">
          {renderablePatches.map((patch, index) => (
            <PatchDiff
              key={`patch-${index}`}
              patch={patch}
              className={diffHostClassName}
              style={diffHostStyle}
              options={diffOptions}
            />
          ))}
        </div>
      ) : fileDiffs.length > 0 ? (
        <div className="-mx-2 -mb-1 overflow-hidden rounded-b-md">
          {fileDiffs.map((fileDiff, index) => (
            <FileDiff
              key={`${fileDiff.cacheKey ?? fileDiff.name}-${index}`}
              fileDiff={fileDiff}
              className={diffHostClassName}
              style={diffHostStyle}
              options={diffOptions}
            />
          ))}
        </div>
      ) : diffText ? (
        <pre className="codex-tool-code scrollbar-token max-h-80 overflow-auto px-2.5 py-2 font-mono text-xs/normal wrap-break-word whitespace-pre-wrap">
          {diffText}
        </pre>
      ) : null}

      {item.toolCall?.error && (
        <ToolErrorDetail
          error={item.toolCall.error}
          showLabel={false}
          className="px-1 py-1"
        />
      )}
    </InlineToolToggle>
  );
}
