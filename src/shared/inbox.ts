import type { CodexThreadActiveFlag, CodexThreadStatusType } from "./types";
import type { AgentRuntimeLaunch } from "./agent-runtime-api";
import { agentRuntimeProviderId, applyAgentRuntimeOptionIntent } from "./agent-runtime-provider";
import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";

/** User-editable classification. It never authorizes work. */
export type InboxEntryKind = "note" | "todo" | "question";
export type InboxEntryState = "open" | "kept" | "done";
/**
 * Where a message's advice stands. Only a send or a rewrite in the stream queues it as `waiting`
 * for automatic advice; `pending` has a suggestion running; `none` has no advice requested.
 */
export type InboxSuggestionState = "none" | "waiting" | "pending" | "settled" | "failed";
/** `schedule` proposals are written by a scheduled task for its own firing. */
export type InboxProposalOrigin = "agent" | "user" | "schedule";
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
  | {
      readonly type: "new_chat";
      readonly projectId: string | null;
      readonly prompt: string;
      /** What the chat runs on when chosen for this decision; the Inbox's own when null. */
      readonly agent: InboxChatAgent | null;
      /** Parts of the work the chat's Agent hands to other Agents. */
      readonly delegates: readonly InboxDelegate[];
      /** How the chat's Agent should run the work, written to it. */
      readonly plan: string | null;
    }
  | { readonly type: "send_to_chat"; readonly sessionId: string; readonly prompt: string }
  | { readonly type: "move_to_project"; readonly projectId: string }
  | {
      /** Run a scheduled task's waiting firing; the message's reviewed text is its instructions. */
      readonly type: "run_task";
      readonly automationId: string;
      readonly dispatchId: string;
      /** What this run uses instead of the task's own Agent selection. */
      readonly agent: InboxChatAgent | null;
    };

/** One part of a new chat's work that its Agent delegates to another Agent. */
export interface InboxDelegate {
  readonly work: string;
  readonly agent: InboxChatAgent;
}

/** A new chat with nothing chosen beyond its destination and prompt. */
export const inboxNewChatAction = (
  projectId: string | null,
  prompt: string,
): Extract<InboxDispatchAction, { type: "new_chat" }> => ({
  type: "new_chat",
  projectId,
  prompt,
  agent: null,
  delegates: [],
  plan: null,
});

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
    }
  | {
      /** A due firing of a scheduled task that asks before it runs. */
      readonly kind: "scheduled_task";
      readonly automationId: string;
      readonly dispatchId: string;
      readonly projectId: string | null;
      /** The task's name when the firing arrived. */
      readonly label: string;
    };

export type InboxFiringStatus =
  | "held"
  | "admitted"
  | "completed"
  | "failed"
  | "skipped"
  | "withdrawn";

/** The firing behind a scheduled task's message, as it stands now. */
export interface InboxFiring {
  readonly automationId: string;
  readonly dispatchId: string;
  readonly status: InboxFiringStatus;
  readonly firstScheduledFor: number;
  readonly lastScheduledFor: number;
  /** Later firings that fell due while this one waited. */
  readonly missedCount: number;
  /** Why its execution failed before reaching a chat. */
  readonly failureMessage: string | null;
}

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
  /** Present for Runtime-bound Sessions, whose status comes from Session activity. */
  readonly executionRef: { readonly runtimeId: string; readonly threadId: string } | null;
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
  /** Each member's content as it is now, which a confirmation fences. */
  readonly basis: readonly InboxPageBasis[];
  /**
   * A member's content changed after this suggestion was written. It stays visible and can still
   * be confirmed as the user reviews it; editing the text back makes it current again.
   */
  readonly outdated: boolean;
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

/** The message Page's current workflow Status option and display name. */
export interface InboxPageStatus {
  readonly id: string;
  readonly label: string;
}

export interface InboxItem {
  readonly outcome: "kept" | "done" | "moved" | "chat" | null;
  readonly pageId: string;
  readonly pageKey: string | null;
  readonly pageStatus: InboxPageStatus | null;
  readonly title: string;
  readonly body: string;
  readonly bodyTruncated: boolean;
  /** Whether the bounded stream contains the whole editable body. */
  readonly bodyEditable: boolean;
  readonly submittedAt: string;
  readonly source: InboxSource;
  readonly kind: InboxEntryKind | null;
  /** Marked by the user, so the message stays in view while it waits. */
  readonly important: boolean;
  readonly state: InboxEntryState;
  readonly suggestionState: InboxSuggestionState;
  readonly suggestionError: string | null;
  readonly scope: InboxScope;
  readonly location: InboxLocation;
  /** The current suggestion. An outdated one stays here while new advice waits, runs or fails. */
  readonly proposal: InboxProposal | null;
  /** Present for a scheduled task's firing. */
  readonly firing: InboxFiring | null;
  readonly revision: number;
  readonly basis: InboxPageBasis;
}

/**
 * The message content the user reviewed: a fingerprint of exactly the text a suggestion reads.
 * Writes that leave that text unchanged, such as a move or an editor normalization, keep it.
 */
export interface InboxPageBasis {
  readonly pageId: string;
  readonly contentHash: string;
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
  /** Important messages still in the Inbox. */
  readonly importantCount: number;
  /** The longest-waiting important messages still in the Inbox, oldest first. */
  readonly important: readonly InboxImportantMessage[];
}

/** An important message still waiting, as the stream points back to it. */
export interface InboxImportantMessage {
  readonly pageId: string;
  readonly title: string;
  readonly submittedAt: string;
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
  /** The message in Nodex Markdown: its text, then its images. */
  readonly body: string;
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

/**
 * Frozen by Main before the first confirmation is submitted. A new chat runs on its action's
 * Agent, or else the Inbox's own; its delegation instructions are written from the confirmed plan.
 */
export interface InboxExecutionSelection {
  readonly modelSelection: AgentRuntimeLaunch["modelSelection"];
  readonly interactionMode: AgentRuntimeLaunch["interactionMode"];
  readonly orchestration?: string | null;
}

/** What the user reviewed before deciding. */
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

export interface InboxSetImportantInput {
  readonly pageId: string;
  readonly important: boolean;
}

/** Rewrites a waiting message; `originalBody` is the Nodex Markdown the user started from. */
export interface InboxEditInput {
  readonly pageId: string;
  readonly basis: InboxPageBasis;
  readonly originalBody: string;
  readonly body: string;
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

/** The Agent runtime that suggests dispatches. */
export interface InboxAgentBinding {
  readonly instanceId: string;
}

/**
 * What a chat the Inbox starts runs on: an Agent and, when chosen, its model, effort and speed.
 * A null model is the Agent's catalog default. A null effort or speed, or one the model does not
 * offer, is the model's own default.
 */
export interface InboxChatAgent extends InboxAgentBinding {
  readonly model: string | null;
  readonly reasoningEffort: string | null;
  /** A non-standard speed tier such as `fast`; null runs at the model's default speed. */
  readonly serviceTier: string | null;
}

type InboxProvider = AgentRuntimeOperations["providers.read"]["output"][number];
type InboxProviderModel = InboxProvider["models"][number];

/** Native utility implementations currently exposing generateStructured. */
export const supportsInboxStructuredGeneration = (
  provider: Pick<InboxProvider, "driver">,
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

/** A model an omitted chat model resolves to: the Agent's catalog default. */
export const inboxDefaultChatModel = <
  Model extends { readonly slug: string; readonly isDefault?: boolean },
>(provider: {
  readonly models: readonly Model[];
}): Model | undefined => provider.models.find((model) => model.isDefault) ?? provider.models[0];

/**
 * Suggestions choose models and plan delegation as well as routing, so they reason at a steady
 * effort that does not follow any chat preference.
 */
const inboxSuggestionEffort = (provider: Pick<InboxProvider, "driver">) =>
  provider.driver === "claudeAgent" ? "medium" : "high";

export const isInboxProviderUsable = (provider: InboxProvider): boolean =>
  provider.enabled &&
  provider.status !== "error" &&
  provider.status !== "disabled" &&
  provider.availability !== "unavailable";

export type InboxModelResolution =
  | {
      readonly kind: "ready";
      readonly selection: AgentRuntimeLaunch["modelSelection"];
      readonly provider: InboxProvider;
      readonly model: InboxProviderModel;
    }
  /** The Agent is usable but has not reported its models yet; a catalog refresh probes it. */
  | { readonly kind: "pending"; readonly provider: InboxProvider }
  | { readonly kind: "unavailable"; readonly message: string };

/**
 * The exact Model Selection an Inbox chat or suggestion runs on, read from one catalog. Main
 * freezes this selection at confirmation and the Inbox shows the same one before the user decides.
 */
export function resolveInboxModel(
  providers: readonly InboxProvider[],
  choice: InboxChatAgent,
  purpose: "chat" | "suggestion",
): InboxModelResolution {
  const provider = providers.find((candidate) => candidate.instanceId === choice.instanceId);
  if (!provider || !isInboxProviderUsable(provider))
    return { kind: "unavailable", message: "The configured Agent is unavailable" };
  if (purpose === "suggestion" && !supportsInboxStructuredGeneration(provider))
    return {
      kind: "unavailable",
      message: "The configured Agent cannot generate Inbox suggestions",
    };
  // A cold boot snapshot is enabled but not yet installed/probed. Refresh owns the probe.
  if (!provider.installed || provider.models.length === 0) return { kind: "pending", provider };
  const model = choice.model
    ? provider.models.find((candidate) => candidate.slug === choice.model)
    : purpose === "suggestion"
      ? inboxDefaultSuggestionModel(provider)
      : inboxDefaultChatModel(provider);
  if (!model) return { kind: "unavailable", message: "The selected model is unavailable" };
  const reasoningEffort =
    purpose === "suggestion" ? inboxSuggestionEffort(provider) : choice.reasoningEffort;
  const serviceTier = purpose === "suggestion" ? null : choice.serviceTier;
  // An effort or speed the model does not offer falls back to the model's own.
  const options = applyAgentRuntimeOptionIntent(
    model.capabilities?.optionDescriptors ?? [],
    undefined,
    {
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(serviceTier ? { serviceTier } : {}),
    },
  );
  return {
    kind: "ready",
    provider,
    model,
    selection: {
      instanceId: provider.instanceId,
      model: model.slug,
      ...(options.length ? { options } : {}),
    },
  };
}

/** The suggestion Agent and model as a choice the shared resolver reads. */
export const inboxSuggestionChoice = (
  settings: Pick<InboxSettings, "suggestionAgent" | "suggestionModel">,
): InboxChatAgent => ({
  instanceId: settings.suggestionAgent.instanceId,
  model: settings.suggestionModel,
  reasoningEffort: null,
  serviceTier: null,
});

/**
 * When suggestions run: `automatic` advises each message as it is sent or rewritten, unless the
 * suggestion Agent's usage runs short; `on_request` only when the user asks; `off` never, leaving
 * manual dispatch only.
 */
export type InboxSuggestionMode = "automatic" | "on_request" | "off";

export const INBOX_SUGGESTION_MODES: readonly InboxSuggestionMode[] = [
  "automatic",
  "on_request",
  "off",
];

export interface InboxSettings {
  readonly suggestions: InboxSuggestionMode;
  readonly suggestionAgent: InboxAgentBinding;
  /** Optional exact model for suggestions; the runtime default applies when null. */
  readonly suggestionModel: string | null;
  /** Durable routing preferences given to the suggestion Agent. */
  readonly instructions: string;
  /**
   * What chats the Inbox starts run on, unless their decision chooses otherwise. With
   * `suggestionsChooseModels`, it is what a suggestion falls back to.
   */
  readonly chatAgent: InboxChatAgent;
  /** Suggestions choose each new chat's Agent, model and effort, and which Agents help it. */
  readonly suggestionsChooseModels: boolean;
  /** Suggestions read Nodex's guide to what each model does well, under the user's preferences. */
  readonly useModelGuide: boolean;
  /** Show the message's Page in the right panel of a new chat started by the Inbox. */
  readonly showPageBesideNewChats: boolean;
}

export type UpdateInboxSettingsInput = Partial<InboxSettings>;

export const MAX_INBOX_INSTRUCTIONS_CHARS = 4_000;

export const DEFAULT_INBOX_SETTINGS: InboxSettings = {
  suggestions: "automatic",
  suggestionAgent: { instanceId: "codex" },
  suggestionModel: null,
  instructions: "",
  chatAgent: { instanceId: "codex", model: null, reasoningEffort: null, serviceTier: null },
  suggestionsChooseModels: true,
  useModelGuide: true,
  showPageBesideNewChats: true,
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
