import { getIntl, type IntlShape } from "@/lib/i18n";
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

export function formatProjectActivitySummary(
  summary: ProjectActivitySummary | null | undefined,
  intl: IntlShape = getIntl(),
): string {
  if (summary === undefined)
    return intl.formatMessage({
      id: "workbench.projectHoverCardModel.loadingActivity",
      defaultMessage: "Loading task activity…",
    });
  if (summary === null)
    return intl.formatMessage({
      id: "workbench.projectHoverCardModel.activityUnavailable",
      defaultMessage: "Task activity unavailable",
    });

  const parts = [
    intl.formatMessage(
      {
        id: "workbench.projectHoverCardModel.tasks",
        defaultMessage: "{count, plural, one {# task} other {# tasks}}",
      },
      { count: summary.taskCount },
    ),
  ];
  if (summary.waitingCount > 0) {
    parts.push(
      intl.formatMessage(
        { id: "workbench.projectHoverCardModel.waiting", defaultMessage: "{count} waiting" },
        { count: summary.waitingCount },
      ),
    );
  }
  if (summary.unreadCount > 0) {
    parts.push(
      intl.formatMessage(
        { id: "workbench.projectHoverCardModel.unread", defaultMessage: "{count} unread" },
        { count: summary.unreadCount },
      ),
    );
  }
  if (summary.activeCount > 0) {
    parts.push(
      intl.formatMessage(
        { id: "workbench.projectHoverCardModel.active", defaultMessage: "{count} active" },
        { count: summary.activeCount },
      ),
    );
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
    if (source.kind === "repository") {
      addRow({
        kind: "repository",
        label: source.remote.replace(/^https:\/\/[^/]+\//u, ""),
        path: null,
      });
      continue;
    }
    const root = source.path.trim();
    if (!root) continue;
    addRow({
      kind: "source",
      label: abbreviateHomeDirectory(root, input.pathContext),
      path: root,
    });
  }

  return rows;
}
