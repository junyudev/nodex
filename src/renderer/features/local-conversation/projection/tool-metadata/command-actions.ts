import type { CodexCommandAction, CodexTranscriptEntry } from "../../../../lib/types";

export interface ExplorationSkillPathInfo {
  skillId: string;
  skillName: string;
  isSkillDefinitionFile: boolean;
}

export function extractCommandActions(
  item: Pick<CodexTranscriptEntry, "commandActions">,
): CodexCommandAction[] {
  return item.commandActions ?? [];
}

export function isExplorationAction(action: CodexCommandAction): boolean {
  return action.type === "read" || action.type === "listFiles" || action.type === "search";
}

export function normalizeExplorationPath(path: string | null | undefined): string | null {
  const trimmed = path?.trim();
  if (!trimmed) return null;

  const isAbsolute = trimmed.startsWith("/") || /^[A-Za-z]:[\\/]/.test(trimmed);
  const normalizedSegments: string[] = [];

  for (const segment of trimmed.replaceAll("\\", "/").split("/")) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") {
      if (
        normalizedSegments.length > 0 &&
        normalizedSegments[normalizedSegments.length - 1] !== ".."
      ) {
        normalizedSegments.pop();
        continue;
      }
      if (!isAbsolute) normalizedSegments.push(segment);
      continue;
    }
    normalizedSegments.push(segment);
  }

  const normalizedPath = normalizedSegments.join("/");
  if (isAbsolute) return normalizedPath.length > 0 ? `/${normalizedPath}` : "/";
  return normalizedPath.length > 0 ? normalizedPath : null;
}

export function resolveExplorationPath(
  path: string | null | undefined,
  cwd: string | null | undefined,
): string | null {
  const normalizedPath = normalizeExplorationPath(path);
  if (!normalizedPath) return null;
  if (normalizedPath.startsWith("/")) return normalizedPath;
  const normalizedCwd = normalizeExplorationPath(cwd);
  if (!normalizedCwd) return normalizedPath;
  return normalizeExplorationPath(`${normalizedCwd}/${normalizedPath}`);
}

function formatSkillName(value: string): string {
  return value
    .replaceAll("_", "-")
    .split("-")
    .filter((segment) => segment.length > 0)
    .map((segment) => `${segment[0]?.toUpperCase() ?? ""}${segment.slice(1)}`)
    .join(" ");
}

export function resolveExplorationSkillPathInfo(
  path: string | null | undefined,
): ExplorationSkillPathInfo | null {
  const normalizedPath = normalizeExplorationPath(path);
  if (!normalizedPath) return null;

  const segments = normalizedPath
    .replace(/^\/+/, "")
    .split("/")
    .filter((segment) => segment.length > 0);

  for (let index = 0; index < segments.length; index += 1) {
    const current = segments[index]?.toLowerCase();
    const next = segments[index + 1]?.toLowerCase();
    if ((current !== ".codex" && current !== ".agents") || next !== "skills") continue;

    const candidate = segments[index + 2] ?? null;
    const candidateLower = candidate?.toLowerCase();
    const skillNameIndex =
      candidateLower === "_import" || candidateLower === ".system" ? index + 3 : index + 2;
    const skillSegment = segments[skillNameIndex] ?? null;
    if (!skillSegment) continue;

    const remainingSegments = segments.slice(skillNameIndex + 1);
    return {
      skillId: skillSegment,
      skillName: formatSkillName(skillSegment),
      isSkillDefinitionFile:
        remainingSegments.length === 1 && remainingSegments[0]?.toLowerCase() === "skill.md",
    };
  }

  return null;
}
