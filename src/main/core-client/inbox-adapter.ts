import type { components } from "@nodex/core-protocol";
import type {
  InboxChat,
  InboxDispatchAction,
  InboxItem,
  InboxLocation,
  InboxProposal,
  InboxSource,
  InboxSummary,
  InboxThreadStatus,
} from "../../shared/inbox";

type Schemas = components["schemas"];
export type CoreInboxDispatchAction = Schemas["ProjectWorkspaceInboxDispatchAction"];
export type CoreInboxItem = Schemas["CollectionWindow_ProjectWorkspaceInboxItem"]["items"][number];
export type CoreInboxProposal = Schemas["ProjectWorkspaceInboxProposal"];
export type CoreInboxSuggestionInput = Schemas["ProjectWorkspaceInboxSuggestionInput"];
export type CoreInboxDispatchContext = Schemas["ProjectWorkspaceInboxDispatchContext"];
export type CoreInboxDispatchWork = Schemas["ProjectWorkspaceInboxDispatchWork"];
export type CoreInboxPageBasis = Schemas["ProjectWorkspaceInboxPageBasis"];
type CoreInboxSource = Schemas["ProjectWorkspaceInboxSource"];
type CoreInboxLocation = Schemas["ProjectWorkspaceInboxLocation"];
type CoreInboxChat = Schemas["ProjectWorkspaceInboxChat"];
type CoreInboxSummary = Schemas["ProjectWorkspaceInboxSummary"];
type CoreThreadStatus = Schemas["ProjectWorkspaceThreadStatus"];

export const inboxDispatchActionFromCore = (
  action: CoreInboxDispatchAction,
): InboxDispatchAction => {
  switch (action.type) {
    case "keep":
      return { type: "keep" };
    case "new_chat":
      return { type: "new_chat", projectId: action.project_id ?? null, prompt: action.prompt };
    case "send_to_chat":
      return { type: "send_to_chat", sessionId: action.session_id, prompt: action.prompt };
    case "move_to_project":
      return { type: "move_to_project", projectId: action.project_id };
  }
};

export const inboxDispatchActionToCore = (action: InboxDispatchAction): CoreInboxDispatchAction => {
  switch (action.type) {
    case "keep":
      return { type: "keep" };
    case "new_chat":
      return { type: "new_chat", project_id: action.projectId, prompt: action.prompt };
    case "send_to_chat":
      return { type: "send_to_chat", session_id: action.sessionId, prompt: action.prompt };
    case "move_to_project":
      return { type: "move_to_project", project_id: action.projectId };
  }
};

export const inboxSourceFromCore = (source: CoreInboxSource): InboxSource => {
  switch (source.kind) {
    case "user":
      return { kind: "user" };
    case "agent":
      return {
        kind: "agent",
        sessionId: source.session_id ?? null,
        threadId: source.thread_id ?? null,
        projectId: source.project_id ?? null,
        label: source.label,
      };
    case "command_line":
      return {
        kind: "command_line",
        projectId: source.project_id ?? null,
        label: source.label,
      };
  }
};

const locationFromCore = (location: CoreInboxLocation): InboxLocation => {
  if (location.kind === "inbox" || location.kind === "other") return { kind: location.kind };
  return {
    kind: "database",
    databaseId: location.database_id,
    databaseName: location.database_name,
    projectId: location.project_id ?? null,
    projectName: location.project_name ?? null,
  };
};

const threadStatusFromCore = (
  status: CoreThreadStatus | null | undefined,
): InboxThreadStatus | null =>
  status ? { statusType: status.status_type, activeFlags: [...status.active_flags] } : null;

const chatFromCore = (chat: CoreInboxChat): InboxChat => ({
  sessionId: chat.session_id,
  projectId: chat.project_id ?? null,
  projectName: chat.project_name ?? null,
  displayTitle: chat.display_title,
  threadId: chat.thread_id ?? null,
  status: threadStatusFromCore(chat.status),
  unread: chat.unread,
  archived: chat.archived,
});

const proposalFromCore = (proposal: CoreInboxProposal): InboxProposal => ({
  proposalId: proposal.proposal_id,
  revision: proposal.revision,
  origin: proposal.origin,
  state: proposal.state,
  pageIds: [...proposal.page_ids],
  action: inboxDispatchActionFromCore(proposal.action),
  kind: proposal.kind ?? null,
  summary: proposal.summary,
  rationale: proposal.rationale ?? null,
  producedBy: proposal.produced_by ?? null,
  targetProjectName: proposal.target_project_name ?? null,
  chat: proposal.chat ? chatFromCore(proposal.chat) : null,
  failureMessage: proposal.failure_message ?? null,
  createdAt: proposal.created_at,
  updatedAt: proposal.updated_at,
});

export const inboxItemFromCore = (item: CoreInboxItem): InboxItem => ({
  pageId: item.page_id,
  pageKey: item.page_key ?? null,
  title: item.title,
  body: item.body,
  bodyTruncated: item.body_truncated,
  submittedAt: item.submitted_at,
  source: inboxSourceFromCore(item.source),
  kind: item.kind ?? null,
  state: item.state,
  suggestionState: item.suggestion_state,
  suggestionError: item.suggestion_error ?? null,
  location: locationFromCore(item.location),
  proposal: item.proposal ? proposalFromCore(item.proposal) : null,
  revision: item.revision,
});

export const inboxSummaryFromCore = (summary: CoreInboxSummary): InboxSummary => ({
  databaseId: summary.database_id ?? null,
  viewId: summary.view_id ?? null,
  entryCount: summary.entry_count,
  inboxCount: summary.inbox_count,
  needsDecisionCount: summary.needs_decision_count,
  pendingSuggestionCount: summary.pending_suggestion_count,
  dispatchingCount: summary.dispatching_count,
});
