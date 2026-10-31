import type { GitRepositoryIdentity } from "../../../shared/git-repository-identity";
import {
  abbreviateHomeDirectory,
  type LocalPathPresentationContext,
} from "../../../shared/local-path-presentation";
import type { ProjectActivitySummary, ProjectSource } from "@/lib/types";

export interface ProjectHoverCardMetadataRow {
  kind: "repository" | "source";
  label: string;
  path: string | null;
}

function pluralize(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

export function formatProjectActivitySummary(
  summary: ProjectActivitySummary | null | undefined,
): string {
  if (summary === undefined) return "Loading task activity…";
  if (summary === null) return "Task activity unavailable";

  const parts = [pluralize(summary.taskCount, "task")];
  if (summary.waitingCount > 0) {
    parts.push(`${summary.waitingCount} waiting`);
  }
  if (summary.unreadCount > 0) {
    parts.push(`${summary.unreadCount} unread`);
  }
  if (summary.activeCount > 0) {
    parts.push(`${summary.activeCount} active`);
  }
  return parts.join(" · ");
}

function repositoryLabel(identity: GitRepositoryIdentity): string {
  if (identity.ownerRepo) {
    return `${identity.ownerRepo.owner}/${identity.ownerRepo.repo}`;
  }

  return identity.repositoryRoot.split(/[\\/]/).filter(Boolean).at(-1) ?? identity.repositoryRoot;
}

export function buildProjectHoverCardMetadataRows(input: {
  projectName: string;
  sources: readonly ProjectSource[];
  repositoryIdentity: GitRepositoryIdentity | null | undefined;
  pathContext: LocalPathPresentationContext | null | undefined;
}): ProjectHoverCardMetadataRow[] {
  const rows: ProjectHoverCardMetadataRow[] = [];
  const seen = new Set<string>([input.projectName.trim().toLocaleLowerCase()]);
  const addRow = (row: ProjectHoverCardMetadataRow) => {
    const identity = row.label.trim().toLocaleLowerCase();
    if (!identity) return;
    if (seen.has(identity)) return;
    seen.add(identity);
    rows.push(row);
  };

  if (input.repositoryIdentity) {
    addRow({
      kind: "repository",
      label: repositoryLabel(input.repositoryIdentity),
      path: null,
    });
  }

  for (const source of [...input.sources].sort((left, right) => left.order - right.order)) {
    const root = source.root.trim();
    if (!root) continue;
    addRow({
      kind: "source",
      label: abbreviateHomeDirectory(root, input.pathContext),
      path: root,
    });
  }

  return rows;
}
