import { useQuery, type QueryClient } from "@tanstack/react-query";
import { defineMessage, useIntl, type MessageDescriptor } from "@/lib/i18n";
import type { Project } from "../../../shared/types";
import { LocalStatusIcon, WorktreeStatusIcon } from "@/components/shared/icons";
import { gitRepositoryIdentityQueryOptions } from "@/lib/query-options";
import { cn } from "@/lib/utils";
import { normalizeProjectPrimaryWorkspaceRoot } from "@/lib/workbench-workspace-context";
import type { InboxAgents } from "./inbox-agent-picker";

/**
 * Where a chat the Inbox starts works: its Page's worktree, apart from the user's checkout, or
 * the Project's checkout. It reads the same wherever the Inbox shows it, and as a chat's own
 * location reads in the chat.
 */
const LOCATION_NAMES: Readonly<Record<"worktree" | "local", MessageDescriptor>> = {
  worktree: defineMessage({ id: "inbox.inboxChatLocation.worktree", defaultMessage: "Worktree" }),
  local: defineMessage({ id: "inbox.inboxChatLocation.local", defaultMessage: "Local" }),
};

const LOCATION_DESCRIPTIONS: Readonly<Record<"worktree" | "local", MessageDescriptor>> = {
  worktree: defineMessage({
    id: "inbox.inboxChatLocation.itsPageSWorktree",
    defaultMessage: "Its Page’s worktree, apart from your checkout",
  }),
  local: defineMessage({
    id: "inbox.inboxChatLocation.theProjectSCheckout",
    defaultMessage: "The Project’s checkout",
  }),
};

export const USE_A_WORKTREE = defineMessage({
  id: "inbox.inboxChatLocation.useAWorktree",
  defaultMessage: "Use a worktree",
});

const locationOf = (worktree: boolean) => (worktree ? "worktree" : "local");

function InboxChatLocationIcon({
  worktree,
  className,
}: {
  readonly worktree: boolean;
  readonly className?: string;
}) {
  const Icon = worktree ? WorktreeStatusIcon : LocalStatusIcon;
  return <Icon className={cn("icon-2xs shrink-0", className)} />;
}

/** The location's glyph and short name, as a trigger or a line shows it. */
export function InboxChatLocationLabel({
  worktree,
  className,
}: {
  readonly worktree: boolean;
  readonly className?: string;
}) {
  const intl = useIntl();
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1", className)}>
      <InboxChatLocationIcon worktree={worktree} />
      {intl.formatMessage(LOCATION_NAMES[locationOf(worktree)])}
    </span>
  );
}

/** The short name and what it means, for an accessible name or a tooltip. */
export function useInboxChatLocationText() {
  const intl = useIntl();
  return {
    name: (worktree: boolean) => intl.formatMessage(LOCATION_NAMES[locationOf(worktree)]),
    description: (worktree: boolean) =>
      intl.formatMessage(LOCATION_DESCRIPTIONS[locationOf(worktree)]),
  };
}

const repositoryOf = (project: Project | null | undefined) =>
  gitRepositoryIdentityQueryOptions(normalizeProjectPrimaryWorkspaceRoot(project) ?? "");

/**
 * A Project whose folder has been read and is not a Git repository, so every chat in it works in
 * the folder itself, whatever its decision chose.
 */
export const projectKnownOutsideGit = (queryClient: QueryClient, project: Project | undefined) =>
  project !== undefined && queryClient.getQueryData(repositoryOf(project).queryKey) === null;

/**
 * Whether a new chat works in its Page's worktree, the Inbox's setting unless its decision chose,
 * or null when there is nothing to show: the chat has no Project, its Project's folder is known
 * not to be a Git repository, where every chat works in the folder itself, or the Inbox's setting
 * has not arrived, so its default would be a guess. A folder not yet read still offers the choice.
 */
export function useInboxChatWorktree(
  newChat: { readonly projectId: string | null; readonly worktree?: boolean | null } | null,
  projects: readonly Project[],
  agents: Pick<InboxAgents, "settings" | "settingsReady">,
): boolean | null {
  const project = newChat?.projectId
    ? projects.find((candidate) => candidate.id === newChat.projectId)
    : null;
  const repository = useQuery(repositoryOf(project));
  if (!newChat?.projectId || (repository.isSuccess && repository.data === null)) return null;
  if (newChat.worktree != null) return newChat.worktree;
  return agents.settingsReady ? agents.settings.newChatsUseWorktrees : null;
}
