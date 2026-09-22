import type { CodexConversationTurn, CodexConversationItem } from "../../../lib/types";
import type { CodexCanonicalAutomaticApprovalReviewItem } from "../../../../shared/codex-conversation-state/codex-conversation-state";
import type { MemoryCitationEntry } from "../../../../../packages/codex-app-server-protocol/src/v2/MemoryCitationEntry";
import { resolveExplorationPath } from "./tool-metadata/command-actions";

export interface UsedTurnSkill {
  path: string;
  name: string;
  source: "System" | "Custom" | "Project" | "User" | "Plugin";
  pluginId?: string;
  pluginMarketplaceName?: string;
}
export interface TurnApprovalReview {
  id: string;
  command: string;
  decision: "accepted" | "rejected";
  durationMs: number;
  rationale: string | null;
}
export interface TurnFooterMetadata {
  skills: UsedTurnSkill[];
  reviews: TurnApprovalReview[];
  memories: MemoryCitationEntry[];
  goalTimeUsedSeconds?: number;
  cwd?: string | null;
  hostId?: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function skillFromPath(path: string, cwd?: string | null): UsedTurnSkill | null {
  const normalized = resolveExplorationPath(path, cwd);
  if (!normalized) return null;
  const segments = normalized.split("/");
  const regular = segments.findIndex(
    (segment, index) =>
      (segment === ".codex" || segment === ".agents") && segments[index + 1] === "skills",
  );
  const plugin = segments.indexOf("plugins");
  let rootIndex: number;
  let source: UsedTurnSkill["source"] = "Custom";
  let pluginId: string | undefined;
  let pluginMarketplaceName: string | undefined;
  if (regular >= 0) {
    const system = segments[regular + 2] === ".system";
    rootIndex = regular + (system || segments[regular + 2] === "_import" ? 3 : 2);
    source = system
      ? "System"
      : cwd && normalized.startsWith(`${cwd.replace(/\/$/, "")}/`)
        ? "Project"
        : "Custom";
  } else if (plugin >= 0) {
    const cached = segments[plugin + 1] === "cache";
    const pluginIndex = plugin + (cached ? 3 : 1);
    pluginId = segments[pluginIndex];
    pluginMarketplaceName = cached ? segments[plugin + 2] : undefined;
    const skillsIndex = segments.indexOf("skills", pluginIndex + 1);
    rootIndex = skillsIndex >= 0 ? skillsIndex + 1 : pluginIndex + (cached ? 1 : 0);
    if (skillsIndex < 0 && segments[rootIndex + 1]?.toLowerCase() !== "skill.md") return null;
    source = "Plugin";
  } else return null;
  const name = segments[rootIndex];
  if (!name) return null;
  return {
    path: `${segments.slice(0, rootIndex + 1).join("/")}/SKILL.md`,
    name: name
      .replaceAll("_", "-")
      .split("-")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" "),
    source,
    ...(pluginId ? { pluginId } : {}),
    ...(pluginMarketplaceName ? { pluginMarketplaceName } : {}),
  };
}

function inputPaths(item: CodexConversationItem): string[] {
  const raw = record(item.rawItem);
  const input = raw?.content;
  if (!Array.isArray(input)) return [];
  return input.flatMap((part: unknown) => {
    const value = record(part);
    if (value?.type === "skill" && typeof value.path === "string") return [value.path];
    if (value?.type !== "text" || typeof value.text !== "string") return [];
    return Array.from(value.text.matchAll(/\[\$[^\]]+\]\(([^)]+)\)/g), (match) => match[1] ?? "");
  });
}

function reviewFromItem(
  item: CodexConversationItem,
  items: CodexConversationItem[],
): TurnApprovalReview | null {
  const raw = record(item.rawItem);
  if (raw?.type !== "automaticApprovalReview") return null;
  const review = raw as unknown as CodexCanonicalAutomaticApprovalReviewItem;
  if (review.status !== "approved" && review.status !== "denied") return null;
  if (review.startedAtMs == null || review.completedAtMs == null) return null;
  const action = review.action;
  if (!action) return null;
  let command: string | undefined;
  if (action.type === "command") command = action.command;
  if (action.type === "execve")
    command = [action.program, ...action.argv]
      .map((arg) => (/^[\w./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`))
      .join(" ");
  if (action.type === "networkAccess") {
    const target = items.find((candidate) => candidate.itemId === review.targetItemId);
    const index = items.indexOf(item);
    const nearest = Array.from({ length: items.length - 1 }, (_, offset) => offset + 1)
      .flatMap((distance) => [items[index + distance], items[index - distance]])
      .find((candidate) => candidate?.kind === "commandExecution" && candidate.command?.trim());
    command = target?.command?.trim() || nearest?.command?.trim() || action.target;
  }
  if (!command) return null;
  return {
    id: item.itemId,
    command,
    decision: review.status === "approved" ? "accepted" : "rejected",
    durationMs: Math.max(0, review.completedAtMs - review.startedAtMs),
    rationale: review.rationale,
  };
}

export function buildTurnFooterMetadata(
  turn: CodexConversationTurn | null,
  cwd?: string | null,
  hostId?: string,
): TurnFooterMetadata | undefined {
  if (!turn || turn.status === "inProgress") return undefined;
  const skills = new Map<string, UsedTurnSkill>();
  const reviews: TurnApprovalReview[] = [];
  let memories: MemoryCitationEntry[] = [];
  for (const item of turn.items) {
    const paths = [
      ...inputPaths(item),
      ...(item.commandActions ?? []).flatMap((action) =>
        action.type === "read"
          ? [action.path, action.name]
          : "path" in action && action.path
            ? [action.path]
            : [],
      ),
    ];
    for (const path of paths) {
      const skill = skillFromPath(path, cwd);
      if (skill) skills.set(skill.path, skill);
    }
    const review = reviewFromItem(item, turn.items);
    if (review) reviews.push(review);
    const raw = record(item.rawItem);
    if (raw?.type !== "agentMessage") continue;
    const citation = record(raw.memoryCitation);
    memories = Array.isArray(citation?.entries)
      ? (citation.entries as MemoryCitationEntry[]).filter((entry) => entry.path.trim().length > 0)
      : [];
  }
  if (skills.size === 0 && reviews.length === 0 && memories.length === 0) return undefined;
  return {
    skills: [...skills.values()].sort((a, b) => a.path.localeCompare(b.path)),
    reviews,
    memories,
    cwd,
    hostId,
  };
}
