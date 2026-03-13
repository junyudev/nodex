import type { CodexCollaborationModeKind } from "./types";

const STORAGE_KEY = "nodex-codex-collaboration-mode-settings-v1";
export const DEFAULT_CODEX_COLLABORATION_MODE: CodexCollaborationModeKind = "default";

function isCollaborationMode(value: unknown): value is CodexCollaborationModeKind {
  return value === "default" || value === "plan";
}

function readRawStorageValue(): string | null {
  if (typeof localStorage === "undefined") return null;
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeRawStorageValue(value: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // ignore localStorage failures
  }
}

function sanitizeStoredMap(value: unknown): Record<string, CodexCollaborationModeKind> {
  if (typeof value !== "object" || value === null) return {};

  const candidate = value as Record<string, unknown>;
  const rawEntries =
    typeof candidate.modes === "object" && candidate.modes !== null
      ? candidate.modes as Record<string, unknown>
      : candidate;

  return Object.entries(rawEntries).reduce<Record<string, CodexCollaborationModeKind>>((acc, [key, mode]) => {
    if (!isCollaborationMode(mode)) return acc;
    acc[key] = mode;
    return acc;
  }, {});
}

function readStoredMap(): Record<string, CodexCollaborationModeKind> {
  const raw = readRawStorageValue();
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw) as unknown;
    return sanitizeStoredMap(parsed);
  } catch {
    return {};
  }
}

function writeStoredMap(value: Record<string, CodexCollaborationModeKind>): void {
  writeRawStorageValue(JSON.stringify(value));
}

export function getThreadCollaborationModeStorageKey(threadId: string): string {
  return `thread:${threadId}`;
}

export function getDraftCollaborationModeStorageKey(projectId: string, cardId: string): string {
  return `draft:${projectId}:${cardId}`;
}

export function readCollaborationModeForContextKey(contextKey: string): CodexCollaborationModeKind {
  const value = readStoredMap()[contextKey];
  return isCollaborationMode(value) ? value : DEFAULT_CODEX_COLLABORATION_MODE;
}

export function writeCollaborationModeForContextKey(
  contextKey: string,
  mode: CodexCollaborationModeKind,
): CodexCollaborationModeKind {
  const nextMode = isCollaborationMode(mode) ? mode : DEFAULT_CODEX_COLLABORATION_MODE;
  const current = readStoredMap();
  current[contextKey] = nextMode;
  writeStoredMap(current);
  return nextMode;
}
