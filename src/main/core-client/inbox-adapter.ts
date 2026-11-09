import type { components } from "@nodex/core-protocol";
import type {
  InboxChat,
  InboxAgentChoice,
  InboxCounts,
  InboxDispatchAction,
  InboxItem,
  InboxLocation,
  InboxProposal,
  InboxScope,
  InboxSource,
  InboxSummary,
  InboxSuggestionStopInput,
  InboxThreadStatus,
  InboxPageBasis,
  InboxExecutionSelection,
} from "../../shared/inbox";
import { InboxExecutionSelectionSchema } from "../../shared/schemas/inbox";

type Schemas = components["schemas"];
export type CoreInboxDispatchAction = Schemas["ProjectWorkspaceInboxDispatchAction"];
export type CoreInboxItem = Schemas["CollectionWindow_ProjectWorkspaceInboxItem"]["items"][number];
export type CoreInboxProposal = Schemas["ProjectWorkspaceInboxProposal"];
/** Frozen File identity and digest; resolve a matching immutable File version before delivery. */
export type CoreInboxMessageImage = Schemas["ProjectWorkspaceInboxMessageImage"];
export type CoreInboxSuggestionInput = Schemas["ProjectWorkspaceInboxSuggestionInput"];
export type CoreInboxDispatchContext = Schemas["ProjectWorkspaceInboxDispatchContext"];
export type CoreInboxDispatchWork = Schemas["ProjectWorkspaceInboxDispatchWork"];
export type CoreInboxPageBasis = Schemas["ProjectWorkspaceInboxPageBasis"];
export type CoreInboxSuggestionRequest = Schemas["ProjectWorkspaceInboxSuggestionRequest"];
type CoreInboxExecutionSelection = Schemas["ProjectWorkspaceInboxExecutionSelection"];
type CoreInboxChatAgent = Schemas["ProjectWorkspaceInboxChatAgent"];
type CoreInboxSource = Schemas["ProjectWorkspaceInboxSource"];
type CoreInboxLocation = Schemas["ProjectWorkspaceInboxLocation"];
type CoreInboxChat = Schemas["ProjectWorkspaceInboxChat"];
type CoreInboxSummary = Schemas["ProjectWorkspaceInboxSummary"];
type CoreInboxCounts = Schemas["ProjectWorkspaceInboxCounts"];
export type CoreInboxScope = Schemas["ProjectWorkspaceInboxScope"];
type CoreThreadStatus = Schemas["ProjectWorkspaceThreadStatus"];

export const inboxDispatchActionFromCore = (
  action: CoreInboxDispatchAction,
): InboxDispatchAction => {
  switch (action.type) {
    case "plan":
      return {
        type: "plan",
        summary: action.summary,
        steps: action.steps.map((step) => ({
          key: step.key,
          projectId: step.project_id,
          title: step.title,
          body: step.body,
          agent: step.agent
            ? {
                instanceId: step.agent.instance_id,
                model: step.agent.model,
                effort: step.agent.effort,
              }
            : null,
          blockedBy: step.blocked_by,
        })),
      };
      return {
        agent: action.agent ? inboxChatAgentFromCore(action.agent) : null,
      };
    case "keep":
      return { type: "keep" };
    case "new_chat":
      return {
        type: "new_chat",
        projectId: action.project_id ?? null,
        prompt: action.prompt,
        agent: action.agent ? inboxChatAgentFromCore(action.agent) : null,
        additions: action.additions ?? [],
      };
    case "send_to_chat":
      return {
        type: "send_to_chat",
        sessionId: action.session_id,
        prompt: action.prompt,
        additions: action.additions ?? [],
      };
    case "move_to_project":
      return { type: "move_to_project", projectId: action.project_id };
  }
};

export const inboxChatAgentFromCore = (agent: CoreInboxChatAgent): InboxAgentChoice => ({
  instanceId: agent.instance_id,
  model: agent.model ?? null,
  reasoningEffort: agent.reasoning_effort ?? null,
  serviceTier: agent.service_tier ?? null,
});

const chatAgentToCore = (agent: InboxAgentChoice): CoreInboxChatAgent => ({
  instance_id: agent.instanceId,
  model: agent.model,
  reasoning_effort: agent.reasoningEffort,
  service_tier: agent.serviceTier,
});

export const inboxDispatchActionToCore = (action: InboxDispatchAction): CoreInboxDispatchAction => {
  switch (action.type) {
    case "plan":
      return {
        type: "plan",
        summary: action.summary,
        steps: action.steps.map((step) => ({
          key: step.key,
          project_id: step.projectId,
          title: step.title,
          body: step.body,
          agent: step.agent
            ? {
                instance_id: step.agent.instanceId,
                model: step.agent.model,
                effort: step.agent.effort,
              }
            : null,
          blocked_by: [...step.blockedBy],
        })),
      };
      return {
        type: "run_task",
        automation_id: action.automationId,
        dispatch_id: action.dispatchId,
        agent: action.agent ? chatAgentToCore(action.agent) : null,
      };
    case "keep":
      return { type: "keep" };
    case "new_chat":
      return {
        type: "new_chat",
        project_id: action.projectId,
        prompt: action.prompt,
        agent: action.agent ? chatAgentToCore(action.agent) : null,
        additions: [...action.additions],
      };
    case "send_to_chat":
      return {
        type: "send_to_chat",
        session_id: action.sessionId,
        prompt: action.prompt,
        additions: [...action.additions],
      };
    case "move_to_project":
      return { type: "move_to_project", project_id: action.projectId };
  }
};

export const inboxScopeFromCore = (scope: CoreInboxScope): InboxScope =>
  scope.kind === "project"
    ? { kind: "project", projectId: scope.project_id }
    : { kind: scope.kind };

export const inboxPageBasisFromCore = (basis: CoreInboxPageBasis): InboxPageBasis => ({
  pageId: basis.page_id,
  contentHash: basis.content_hash,
});
export const inboxPageBasisToCore = (basis: InboxPageBasis): CoreInboxPageBasis => ({
  page_id: basis.pageId,
  content_hash: basis.contentHash,
});
export const inboxStopSuggestionToCore = (
  input: InboxSuggestionStopInput,
): Extract<Schemas["ProjectWorkspaceIntent"], { kind: "stop_inbox_suggestion" }> => ({
  kind: "stop_inbox_suggestion",
  page_id: input.pageId,
});

export const inboxExecutionSelectionToCore = (
  selection: InboxExecutionSelection | null | undefined,
): CoreInboxExecutionSelection | null =>
  selection
    ? {
        model_selection: selection.modelSelection,
        interaction_mode: selection.interactionMode,
      }
    : null;
export const inboxExecutionSelectionFromCore = (
  selection: CoreInboxExecutionSelection,
): InboxExecutionSelection =>
  InboxExecutionSelectionSchema.parse({
    modelSelection: selection.model_selection,
    interactionMode: selection.interaction_mode,
  });

export const inboxScopeToCore = (scope: InboxScope): CoreInboxScope =>
  scope.kind === "project"
    ? { kind: "project", project_id: scope.projectId }
    : { kind: scope.kind };

export const inboxSourceFromCore = (source: CoreInboxSource): InboxSource => {
  switch (source.kind) {
    case "scheduled_task":
      return {
      return {
        automationId: source.automation_id,
        dispatchId: source.dispatch_id,
        projectId: source.project_id ?? null,
        label: source.label,
      };
    case "nodex":
      return {
        kind: "nodex",
        purpose: source.purpose,
        subjectSessionId: source.subject_session_id ?? null,
        subjectPageId: source.subject_page_id ?? null,
      };
    case "user":
      return { kind: "user" };
    case "agent":
      return {
        kind: "agent",
        sessionId: source.session_id ?? null,
        threadId: source.thread_id ?? null,
        runId: source.run_id ?? null,
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

export const inboxChatFromCore = (chat: CoreInboxChat): InboxChat => ({
  sessionId: chat.session_id,
  projectId: chat.project_id ?? null,
  projectName: chat.project_name ?? null,
  displayTitle: chat.display_title,
  threadId: chat.thread_id ?? null,
  executionRef: chat.execution_ref
    ? { runtimeId: chat.execution_ref.runtime_id, threadId: chat.execution_ref.thread_id }
    : null,
  status: threadStatusFromCore(chat.status),
  unread: chat.unread,
  archived: chat.archived,
});

const proposalFromCore = (proposal: CoreInboxProposal): InboxProposal => ({
  createdPageIds: proposal.created_page_ids ?? [],
  answeredQuestion: proposal.answered_question,
  proposalId: proposal.proposal_id,
  revision: proposal.revision,
  origin: proposal.origin,
  state: proposal.state,
  pageIds: [...proposal.page_ids],
  basis: proposal.basis.map(inboxPageBasisFromCore),
  outdated: proposal.outdated,
  explicitRequest: proposal.explicit_request,
  confirmedBy: proposal.confirmed_by ?? null,
  action: inboxDispatchActionFromCore(proposal.action),
  kind: proposal.kind ?? null,
  summary: proposal.summary,
  rationale: proposal.rationale ?? null,
  producedBy: proposal.produced_by ?? null,
  targetProjectName: proposal.target_project_name ?? null,
  chat: proposal.chat ? inboxChatFromCore(proposal.chat) : null,
  failureMessage: proposal.failure_message ?? null,
  failureKind: proposal.failure_kind ?? null,
  createdAt: proposal.created_at,
  updatedAt: proposal.updated_at,
});

export const inboxItemFromCore = (item: CoreInboxItem): InboxItem => ({
  handback: item.handback ?? null,
  rowKind: item.row_kind,
  turn: item.turn ?? null,
  pageId: item.page_id,
  pageKey: item.page_key ?? null,
  pageStatus: item.page_status ? { id: item.page_status.id, label: item.page_status.label } : null,
  title: item.title,
  body: item.body,
  bodyTruncated: item.body_truncated,
  bodyEditable: item.body_editable,
  submittedAt: item.submitted_at,
  source: inboxSourceFromCore(item.source),
  replyToPageId: item.reply_to_page_id ?? null,
  kind: item.kind ?? null,
  important: item.important,
  state: item.state,
  outcome: item.outcome ?? null,
  suggestionState: item.suggestion_state,
  suggestionError: item.suggestion_error ?? null,
  scope: inboxScopeFromCore(item.scope),
  location: locationFromCore(item.location),
  proposal: item.proposal ? proposalFromCore(item.proposal) : null,
  firing: item.firing
    ? {
        automationId: item.firing.automation_id,
        dispatchId: item.firing.dispatch_id,
        status: item.firing.status,
        firstScheduledFor: item.firing.first_scheduled_for_ms,
        lastScheduledFor: item.firing.last_scheduled_for_ms,
        missedCount: item.firing.missed_count,
        failureMessage: item.firing.failure_message ?? null,
      }
    : null,
  revision: item.revision,
  basis: inboxPageBasisFromCore(item.basis),
});

export const inboxSummaryFromCore = (
  summary: CoreInboxSummary,
  storeEpoch: string,
): InboxSummary => ({
  storeEpoch,
  databaseId: summary.database_id ?? null,
  viewId: summary.view_id ?? null,
  entryCount: summary.entry_count,
  inboxCount: summary.inbox_count,
  needsDecisionCount: summary.needs_decision_count,
  pendingSuggestionCount: summary.pending_suggestion_count,
  dispatchingCount: summary.dispatching_count,
  importantCount: summary.important_count,
  important: summary.important.map((message) => ({
    pageId: message.page_id,
    title: message.title,
    submittedAt: message.submitted_at,
  })),
});

export const inboxCountsFromCore = (counts: CoreInboxCounts): InboxCounts => ({
  library: counts.library_count,
  projects: Object.fromEntries(
    counts.projects.map((project) => [project.project_id, project.inbox_count]),
  ),
});
