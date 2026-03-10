import type { CodexCommandAction, CodexItemView } from "../../../../lib/types";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;
  return value as Record<string, unknown>;
}

function normalizeActionType(actionType: string): string {
  return actionType.replace(/[_\-\s]/g, "").toLowerCase();
}

export function parseCommandActions(value: unknown): CodexCommandAction[] {
  if (!Array.isArray(value)) return [];

  return value.reduce<CodexCommandAction[]>((acc, entry) => {
    const candidate = asRecord(entry);
    if (!candidate) return acc;

    const actionTypeRaw = typeof candidate.type === "string" ? candidate.type : null;
    if (!actionTypeRaw) return acc;
    const actionType = normalizeActionType(actionTypeRaw);

    const command = typeof candidate.command === "string"
      ? candidate.command
      : typeof candidate.cmd === "string"
        ? candidate.cmd
        : "";

    if (actionType === "read") {
      const name = typeof candidate.name === "string" ? candidate.name : "";
      const path = typeof candidate.path === "string" ? candidate.path : "";
      if (!name || !path) return acc;
      acc.push({ type: "read", command, name, path });
      return acc;
    }

    if (actionType === "listfiles") {
      acc.push({
        type: "listFiles",
        command,
        path: typeof candidate.path === "string" ? candidate.path : null,
      });
      return acc;
    }

    if (actionType === "search") {
      acc.push({
        type: "search",
        command,
        query: typeof candidate.query === "string" ? candidate.query : null,
        path: typeof candidate.path === "string" ? candidate.path : null,
      });
      return acc;
    }

    if (actionType === "unknown") {
      acc.push({ type: "unknown", command });
    }

    return acc;
  }, []);
}

export function extractCommandActions(item: Pick<CodexItemView, "toolCall">): CodexCommandAction[] {
  const args = item.toolCall?.args;
  if (typeof args !== "object" || args === null) return [];
  return parseCommandActions((args as { commandActions?: unknown }).commandActions);
}

export function isExplorationAction(action: CodexCommandAction): boolean {
  return action.type === "read" || action.type === "listFiles" || action.type === "search";
}
