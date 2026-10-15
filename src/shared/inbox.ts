import type { CodexThreadActiveFlag, CodexThreadStatusType } from "./types";

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
  readonly proposalId: string;
  readonly revision: number;
  readonly origin: InboxProposalOrigin;
  readonly state: InboxProposalState;
  readonly pageIds: readonly string[];
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
  readonly pageId: string;
  readonly pageKey: string | null;
  readonly title: string;
  readonly body: string;
  readonly bodyTruncated: boolean;
  readonly submittedAt: string;
  readonly source: InboxSource;
  readonly kind: InboxEntryKind | null;
  readonly state: InboxEntryState;
  readonly suggestionState: InboxSuggestionState;
  readonly suggestionError: string | null;
  readonly location: InboxLocation;
  readonly proposal: InboxProposal | null;
  readonly revision: number;
}

export interface InboxWindow {
  readonly items: readonly InboxItem[];
  readonly nextCursor: string | null;
  readonly projectionRevision: number;
}

export interface InboxSummary {
  readonly databaseId: string | null;
  readonly viewId: string | null;
  readonly entryCount: number;
  /** Messages still in the Inbox; the goal is zero. */
  readonly inboxCount: number;
  readonly needsDecisionCount: number;
  readonly pendingSuggestionCount: number;
  readonly dispatchingCount: number;
}

export interface InboxWindowInput {
  readonly filter: InboxWindowFilter;
  readonly after?: string | null;
  readonly first?: number;
}

export interface InboxSendInput {
  readonly text: string;
}

export interface InboxSendResult {
  readonly pageId: string;
}

export interface InboxConfirmInput {
  readonly proposalId: string;
  readonly expectedRevision: number;
  /** Present when the user edited the suggestion before confirming it. */
  readonly action?: InboxDispatchAction;
}

export interface InboxDispatchInput {
  readonly pageIds: readonly string[];
  readonly action: InboxDispatchAction;
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
export type InboxAgentBinding =
  | { readonly kind: "codex" }
  | { readonly kind: "claude"; readonly instanceConfigId: string };

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
  suggestionAgent: { kind: "codex" },
  suggestionModel: null,
  instructions: "",
  chatAgent: { kind: "codex" },
};

export const encodeInboxAgentBinding = (binding: InboxAgentBinding): string =>
  binding.kind === "codex" ? "codex" : `claude:${binding.instanceConfigId}`;

export const decodeInboxAgentBinding = (value: unknown): InboxAgentBinding | null => {
  if (value === "codex") return { kind: "codex" };
  if (typeof value !== "string" || !value.startsWith("claude:")) return null;
  const instanceConfigId = value.slice("claude:".length).trim();
  return instanceConfigId ? { kind: "claude", instanceConfigId } : null;
};
