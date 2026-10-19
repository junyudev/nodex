import type { CodexThreadActiveFlag, CodexThreadStatusType } from "./types";
import type { AgentRuntimeLaunch } from "./agent-runtime-api";
import { agentRuntimeProviderId } from "./agent-runtime-provider";
import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";

/** User-editable classification. It never authorizes work. */
export type InboxEntryKind = "note" | "todo" | "question";
export type InboxEntryState = "open" | "kept" | "done";
export type InboxSuggestionState = "pending" | "settled" | "failed";
export type InboxProposalOrigin = "agent" | "user";
export type InboxProposalState =
  | "open"
  | "superseded"
  | "dismissed"
  | "dispatching"
  | "completed"
  | "failed";
/** `inbox` holds what still needs the user; `processed` is the handled history. */
export type InboxWindowFilter = "inbox" | "processed";

/**
 * Which Inbox owns a message's decision: the Library Inbox, for thoughts whose Project is not
 * known yet, or one Project's own Inbox. It is fixed when the message arrives.
 */
export type InboxScope =
  | { readonly kind: "library" }
  | { readonly kind: "project"; readonly projectId: string };

export const LIBRARY_INBOX: InboxScope = { kind: "library" };

export const projectInbox = (projectId: string): InboxScope => ({ kind: "project", projectId });

/** A stable identity for caches and keys. */
export const inboxScopeKey = (scope: InboxScope): string =>
  scope.kind === "library" ? "library" : `project:${scope.projectId}`;

export const inboxScopeProjectId = (scope: InboxScope): string | null =>
  scope.kind === "project" ? scope.projectId : null;

export const INBOX_ENTRY_KINDS = [
  "note",
  "todo",
  "question",
] as const satisfies readonly InboxEntryKind[];

/** The exact action a dispatch suggestion asks the user to authorize. */
export type InboxDispatchAction =
  | { readonly type: "keep" }
  | { readonly type: "new_chat"; readonly projectId: string | null; readonly prompt: string }
  | { readonly type: "send_to_chat"; readonly sessionId: string; readonly prompt: string }
  | { readonly type: "move_to_project"; readonly projectId: string };

export type InboxSource =
  | { readonly kind: "user" }
  | {
      readonly kind: "agent";
      readonly sessionId: string | null;
      readonly threadId: string | null;
      readonly runId: string | null;
      readonly projectId: string | null;
      readonly label: string;
    }
  | {
      /** Sent through the `nodex` command line, optionally from inside a Project. */
      readonly kind: "command_line";
      readonly projectId: string | null;
      readonly label: string;
    };

export type InboxLocation =
  | { readonly kind: "inbox" }
  | {
      readonly kind: "database";
      readonly databaseId: string;
      readonly databaseName: string;
      readonly projectId: string | null;
      readonly projectName: string | null;
    }
  | { readonly kind: "other" };

export interface InboxThreadStatus {
  readonly statusType: CodexThreadStatusType;
  readonly activeFlags: readonly CodexThreadActiveFlag[];
}

export interface InboxChat {
  readonly sessionId: string;
  readonly projectId: string | null;
  readonly projectName: string | null;
  readonly displayTitle: string;
  readonly threadId: string | null;
  readonly status: InboxThreadStatus | null;
  readonly unread: boolean;
  readonly archived: boolean;
}

export interface InboxProposal {
  readonly failureKind: "rejected" | "unavailable" | "unknown" | null;
  readonly proposalId: string;
  readonly revision: number;
  readonly origin: InboxProposalOrigin;
  readonly state: InboxProposalState;
  readonly pageIds: readonly string[];
  readonly basis: readonly InboxPageBasis[];
  readonly action: InboxDispatchAction;
  readonly kind: InboxEntryKind | null;
  readonly summary: string;
  readonly rationale: string | null;
  readonly producedBy: string | null;
  readonly targetProjectName: string | null;
  readonly chat: InboxChat | null;
  readonly failureMessage: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface InboxItem {
  readonly outcome: "kept" | "done" | "moved" | "chat" | null;
  readonly pageId: string;
  readonly pageKey: string | null;
  readonly title: string;
  readonly body: string;
  readonly bodyTruncated: boolean;
  /** Plain message text shown whole, so it can be rewritten in place; else edit its Page. */
  readonly bodyEditable: boolean;
  readonly submittedAt: string;
  readonly source: InboxSource;
  readonly kind: InboxEntryKind | null;
  readonly state: InboxEntryState;
  readonly suggestionState: InboxSuggestionState;
  readonly suggestionError: string | null;
  readonly scope: InboxScope;
  readonly location: InboxLocation;
  readonly proposal: InboxProposal | null;
  readonly revision: number;
  readonly basis: InboxPageBasis;
}

/** The exact Document revision the user reviewed. */
export interface InboxPageBasis {
  readonly pageId: string;
  readonly generation: number;
  readonly headSeq: number;
  readonly placementRevision: number;
}

export interface InboxChatTargetsInput {
  readonly scope: InboxScope;
  readonly query: string;
  readonly after?: string | null;
  readonly first?: number;
}

export interface InboxChatTargets {
  readonly items: readonly InboxChat[];
  readonly nextCursor: string | null;
}

export interface InboxWindow {
  readonly items: readonly InboxItem[];
  readonly nextCursor: string | null;
  readonly projectionRevision: number;
  readonly storeEpoch: string;
}

export interface InboxSummary {
  readonly storeEpoch: string;
  /** The Database this Inbox's messages become Pages in, once it exists. */
  readonly databaseId: string | null;
  readonly viewId: string | null;
  readonly entryCount: number;
  /** Messages still in the Inbox; the goal is zero. */
  readonly inboxCount: number;
  readonly needsDecisionCount: number;
  readonly pendingSuggestionCount: number;
  readonly dispatchingCount: number;
}

/** Messages still waiting in each Inbox, for navigation badges. */
export interface InboxCounts {
  readonly library: number;
  /** Active Projects whose Inbox holds at least one message, keyed by Project. */
  readonly projects: Readonly<Record<string, number>>;
}

export interface InboxSummaryInput {
  readonly scope: InboxScope;
}

export interface InboxWindowInput {
  readonly scope: InboxScope;
  readonly filter: InboxWindowFilter;
  readonly after?: string | null;
  readonly first?: number;
}

export interface InboxSendInput {
  readonly operationId: string;
  readonly pageId: string;
  readonly documentId: string;
  readonly issuedAt: number;
  readonly storeEpoch: string;
  readonly scope: InboxScope;
  readonly text: string;
}

export interface InboxSendResult {
  readonly pageId: string;
  readonly state: "saved" | "deleted";
}

export interface InboxConfirmInput {
  readonly storeEpoch: string;
  readonly operationId: string;
  readonly sessionId: string;
  readonly basis: readonly InboxPageBasis[];
  readonly executionSelection?: InboxExecutionSelection | null;
  readonly proposalId: string;
  readonly expectedRevision: number;
  /** Present when the user edited the suggestion before confirming it. */
  readonly action?: InboxDispatchAction;
}

export interface InboxDispatchInput {
  readonly storeEpoch: string;
  readonly operationId: string;
  readonly proposalId: string;
  readonly sessionId: string;
  readonly basis: readonly InboxPageBasis[];
  readonly executionSelection?: InboxExecutionSelection | null;
  readonly pageIds: readonly string[];
  readonly action: InboxDispatchAction;
}

/** Frozen by Main before the first confirmation is submitted. */
export interface InboxExecutionSelection {
  readonly modelSelection: AgentRuntimeLaunch["modelSelection"];
  readonly interactionMode: AgentRuntimeLaunch["interactionMode"];
}

export type InboxConfirmationDraft =
  | ({ readonly kind: "proposal" } & Omit<
      InboxConfirmInput,
      "operationId" | "sessionId" | "executionSelection"
    >)
  | ({ readonly kind: "direct" } & Omit<
      InboxDispatchInput,
      "operationId" | "proposalId" | "sessionId" | "executionSelection"
    >);

/** Retry this object unchanged after an uncertain confirmation response. */
export type InboxPreparedConfirmation =
  | ({ readonly kind: "proposal" } & InboxConfirmInput)
  | ({ readonly kind: "direct" } & InboxDispatchInput);

export interface InboxDecisionResult {
  readonly undoToken: string | null;
}

export interface InboxUndoInput {
  readonly operationId: string;
  readonly undoToken: string;
}

export interface InboxSuggestionRequestInput {
  readonly requestId: string;
  readonly mode: "auto" | "grouped" | "refine";
  readonly pageIds: readonly string[];
  readonly basis: readonly InboxPageBasis[];
  readonly proposalId?: string | null;
  readonly expectedRevision?: number | null;
  readonly correction?: string | null;
}

export interface InboxPageIdsInput {
  readonly pageIds: readonly string[];
}

export interface InboxSetStateInput extends InboxPageIdsInput {
  readonly state: InboxEntryState;
}

export interface InboxSetKindInput {
  readonly pageId: string;
  readonly kind: InboxEntryKind | null;
}

/** Rewrites a waiting message; `originalText` is the text the user started from. */
export interface InboxEditInput {
  readonly pageId: string;
  readonly basis: InboxPageBasis;
  readonly originalText: string;
  readonly text: string;
}

export interface InboxProposalInput {
  readonly proposalId: string;
}

/** Window-independent invalidation published whenever Inbox truth changes. */
export interface InboxChangedEvent {
  readonly reason: "inbox" | "sessions" | "content";
}

export const isInboxChatDispatch = (
  action: InboxDispatchAction,
): action is Extract<InboxDispatchAction, { type: "new_chat" | "send_to_chat" }> =>
  action.type === "new_chat" || action.type === "send_to_chat";

/** A suggestion that still needs the user's decision. */
export const inboxNeedsDecision = (item: InboxItem): boolean =>
  item.state === "open" && item.proposal?.state === "open";

/** The Agent runtime that suggests dispatches or runs dispatched chats. */
export interface InboxAgentBinding {
  readonly instanceId: string;
}

/** Native utility implementations currently exposing generateStructured. */
export const supportsInboxStructuredGeneration = (
  provider: Pick<AgentRuntimeOperations["providers.read"]["output"][number], "driver">,
): boolean => provider.driver === "codex" || provider.driver === "claudeAgent";

/**
 * Suggestions run for every captured message, so Codex defaults to its economical Sol model
 * rather than its catalog default.
 */
const INBOX_SUGGESTION_MODEL_PREFERENCES: Readonly<Partial<Record<string, string>>> = {
  codex: "gpt-6.1-sol",
};

/** The model an omitted suggestion model resolves to; the catalog default when the preference is absent. */
export const inboxDefaultSuggestionModel = <
  Model extends { readonly slug: string; readonly isDefault?: boolean },
>(provider: {
  readonly driver: string;
  readonly models: readonly Model[];
}): Model | undefined => {
  const preferred = INBOX_SUGGESTION_MODEL_PREFERENCES[provider.driver];
  return (
    provider.models.find((model) => model.slug === preferred) ??
    provider.models.find((model) => model.isDefault) ??
    provider.models[0]
  );
};

export interface InboxSettings {
  /** When off, the Inbox captures messages and supports manual dispatch only. */
  readonly suggestionsEnabled: boolean;
  readonly suggestionAgent: InboxAgentBinding;
  /** Optional exact model for suggestions; the runtime default applies when null. */
  readonly suggestionModel: string | null;
  /** Durable routing preferences given to the suggestion Agent. */
  readonly instructions: string;
  /** Runtime for chats the Inbox starts. Existing chats keep their own runtime. */
  readonly chatAgent: InboxAgentBinding;
}

export type UpdateInboxSettingsInput = Partial<InboxSettings>;

export const MAX_INBOX_INSTRUCTIONS_CHARS = 4_000;

export const DEFAULT_INBOX_SETTINGS: InboxSettings = {
  suggestionsEnabled: true,
  suggestionAgent: { instanceId: "codex" },
  suggestionModel: null,
  instructions: "",
  chatAgent: { instanceId: "codex" },
};

export const encodeInboxAgentBinding = (binding: InboxAgentBinding): string => binding.instanceId;

export const decodeInboxAgentBinding = (value: unknown): InboxAgentBinding | null => {
  if (typeof value !== "string" || !value.trim()) return null;
  // Older Profile preferences named the native account instead of its Runtime instance.
  if (value.startsWith("claude:")) {
    const instanceId = agentRuntimeProviderId({
      kind: "claude",
      instanceConfigId: value.slice("claude:".length).trim(),
    });
    return instanceId ? { instanceId } : null;
  }
  return value.trim() === value && value.length <= 512 ? { instanceId: value } : null;
};
