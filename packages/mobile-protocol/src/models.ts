import { z } from "zod";

/**
 * What a phone sees of a Desktop Host's Profile. These are view models owned by this contract, not
 * Core or Agent Runtime shapes, so a phone and a Host of different versions keep working: Objects
 * are loose (a newer Host may add fields) and the Host maps its own models onto them.
 */

const isoTime = z.string();

export const InboxScopeSchema = z.discriminatedUnion("kind", [
  z.looseObject({ kind: z.literal("library") }),
  z.looseObject({ kind: z.literal("project"), projectId: z.string() }),
]);
export type InboxScope = z.infer<typeof InboxScopeSchema>;

export const LIBRARY_INBOX: InboxScope = { kind: "library" };

export const inboxScopeKey = (scope: InboxScope): string =>
  scope.kind === "library" ? "library" : `project:${scope.projectId}`;

export const HostInfoSchema = z.looseObject({
  /** Stable for the Profile; derived from the Host's static key. */
  id: z.string(),
  name: z.string(),
  platform: z.string(),
  appVersion: z.string(),
});
export type HostInfo = z.infer<typeof HostInfoSchema>;

/** The first message on every channel. */
export const HelloSchema = z.looseObject({
  protocol: z.number().int(),
  host: HostInfoSchema,
  deviceId: z.string(),
  /** Where this Host can be reached right now, best first. Replaces the phone's learned routes. */
  routes: z.array(z.string()),
});
export type Hello = z.infer<typeof HelloSchema>;

export const ProjectSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  /** Whether a chat here can start in a new worktree. */
  supportsWorktree: z.boolean(),
  inboxCount: z.number().int(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const ProjectListSchema = z.looseObject({
  projects: z.array(ProjectSchema),
  libraryInboxCount: z.number().int(),
});
export type ProjectList = z.infer<typeof ProjectListSchema>;

// ---------------------------------------------------------------------------------------------
// Agents

export const AgentModelSchema = z.looseObject({
  id: z.string(),
  label: z.string(),
});
export type AgentModel = z.infer<typeof AgentModelSchema>;

export const AgentProviderSchema = z.looseObject({
  instanceId: z.string(),
  label: z.string(),
  /** Why a chat cannot start on it right now, such as a missing sign-in. Null when ready. */
  unavailableReason: z.string().nullable(),
  models: z.array(AgentModelSchema),
});
export type AgentProvider = z.infer<typeof AgentProviderSchema>;

export const AgentChoiceSchema = z.looseObject({
  providerInstanceId: z.string(),
  model: z.string(),
});
export type AgentChoice = z.infer<typeof AgentChoiceSchema>;

export const AgentCatalogSchema = z.looseObject({
  providers: z.array(AgentProviderSchema),
  /** What a new chat runs on when the phone chooses nothing. */
  defaultChoice: AgentChoiceSchema.nullable(),
});
export type AgentCatalog = z.infer<typeof AgentCatalogSchema>;

// ---------------------------------------------------------------------------------------------
// Inbox

export const InboxProposalActionSchema = z.discriminatedUnion("type", [
  z.looseObject({ type: z.literal("keep") }),
  z.looseObject({
    type: z.literal("new_chat"),
    projectId: z.string().nullable(),
    projectName: z.string().nullable(),
    prompt: z.string(),
    /** What the suggestion adds of its own, sent after the prompt. */
    additions: z.array(z.string()).default([]),
    /** What the chat runs on when the suggestion chose it; the Inbox's own when null. */
    agent: AgentChoiceSchema.nullable().default(null),
  }),
  z.looseObject({
    type: z.literal("send_to_chat"),
    sessionId: z.string(),
    chatTitle: z.string().nullable(),
    prompt: z.string(),
    additions: z.array(z.string()).default([]),
  }),
  z.looseObject({
    type: z.literal("move_to_project"),
    projectId: z.string(),
    projectName: z.string().nullable(),
  }),
  z.looseObject({ type: z.literal("run_task"), name: z.string().nullable() }),
]);
export type InboxProposalAction = z.infer<typeof InboxProposalActionSchema>;

export const InboxProposalSchema = z.looseObject({
  proposalId: z.string(),
  revision: z.number().int(),
  state: z.enum(["open", "superseded", "dismissed", "dispatching", "completed", "failed"]),
  /** The message changed after this was written. It can still be confirmed as reviewed. */
  outdated: z.boolean(),
  summary: z.string(),
  rationale: z.string().nullable(),
  // A phone and its desktop update separately, so what a suggestion adds has defaults to read as.
  origin: z.enum(["agent", "user", "schedule"]).default("agent"),
  /** Who wrote it, when that is known. */
  producedBy: z.string().nullable().default(null),
  action: InboxProposalActionSchema,
  failureMessage: z.string().nullable(),
});
export type InboxProposal = z.infer<typeof InboxProposalSchema>;

export const InboxMessageSchema = z.looseObject({
  pageId: z.string(),
  pageKey: z.string().nullable(),
  title: z.string(),
  /** Nodex Markdown. File references use `nodex://files/ID`, readable through `files.read`. */
  body: z.string(),
  bodyTruncated: z.boolean(),
  submittedAt: isoTime,
  source: z.looseObject({
    kind: z.enum(["user", "agent", "command_line", "scheduled_task"]),
    label: z.string().nullable(),
  }),
  important: z.boolean(),
  state: z.enum(["open", "kept", "done"]),
  outcome: z.enum(["kept", "done", "moved", "chat"]).nullable(),
  suggestion: z.looseObject({
    state: z.enum(["none", "waiting", "pending", "settled", "failed"]),
    error: z.string().nullable(),
  }),
  proposal: InboxProposalSchema.nullable(),
  /** The chat this message went to, once it has one. */
  chatSessionId: z.string().nullable(),
  scope: InboxScopeSchema,
  revision: z.number().int(),
});
export type InboxMessage = z.infer<typeof InboxMessageSchema>;

export const InboxWindowSchema = z.looseObject({
  items: z.array(InboxMessageSchema),
  nextCursor: z.string().nullable(),
});
export type InboxWindow = z.infer<typeof InboxWindowSchema>;

export const InboxDecisionSchema = z.discriminatedUnion("type", [
  /** Authorize the message's current suggestion exactly as the phone showed it. */
  z.looseObject({
    type: z.literal("accept"),
    proposalId: z.string(),
    revision: z.number().int(),
  }),
  z.looseObject({
    type: z.literal("start_chat"),
    projectId: z.string().nullable(),
    prompt: z.string().nullable(),
    agent: AgentChoiceSchema.nullable(),
  }),
  z.looseObject({ type: z.literal("keep") }),
  z.looseObject({ type: z.literal("done") }),
  z.looseObject({ type: z.literal("reopen") }),
  z.looseObject({ type: z.literal("delete") }),
  z.looseObject({ type: z.literal("important"), important: z.boolean() }),
  z.looseObject({ type: z.literal("request_suggestion") }),
  z.looseObject({ type: z.literal("retry"), proposalId: z.string() }),
]);
export type InboxDecision = z.infer<typeof InboxDecisionSchema>;

// ---------------------------------------------------------------------------------------------
// Chats

/**
 * `waiting`: something needs the person (an approval or a question). `background`: no foreground Run
 * but delegated or background work is live.
 */
export const ChatStatusSchema = z.enum(["idle", "running", "waiting", "background", "failed"]);
export type ChatStatus = z.infer<typeof ChatStatusSchema>;

export const ChatActivitySchema = z.looseObject({
  sessionId: z.string(),
  status: ChatStatusSchema,
  pendingRequestCount: z.number().int(),
  /** A one-line ask suitable for a list row, when something needs the person. */
  attention: z.string().nullable(),
});
export type ChatActivity = z.infer<typeof ChatActivitySchema>;

export const ChatSummarySchema = z.looseObject({
  sessionId: z.string(),
  title: z.string(),
  preview: z.string(),
  projectId: z.string().nullable(),
  projectName: z.string().nullable(),
  agentLabel: z.string().nullable(),
  status: ChatStatusSchema,
  pendingRequestCount: z.number().int(),
  attention: z.string().nullable(),
  unread: z.boolean(),
  pinned: z.boolean(),
  archived: z.boolean(),
  /** Epoch milliseconds of the last activity the list sorts by. */
  activityAt: z.number().nullable(),
  /** False for a conversation only its desktop owner can continue. */
  canSend: z.boolean(),
});
export type ChatSummary = z.infer<typeof ChatSummarySchema>;

export const ChatListSchema = z.looseObject({
  items: z.array(ChatSummarySchema),
  nextCursor: z.string().nullable(),
});
export type ChatList = z.infer<typeof ChatListSchema>;

/** A file a phone can read through `files.read`; `ref` is opaque apart from `nodex://files/ID`. */
export const FileRefSchema = z.looseObject({
  ref: z.string(),
  name: z.string(),
  mimeType: z.string().nullable(),
  size: z.number().int().nullable(),
});
export type FileRef = z.infer<typeof FileRefSchema>;

export const ChatItemSchema = z.discriminatedUnion("kind", [
  z.looseObject({
    kind: z.literal("user"),
    id: z.string(),
    at: isoTime,
    text: z.string(),
    files: z.array(FileRefSchema),
    /** Accepted but waiting behind the current Run. */
    queued: z.boolean(),
  }),
  z.looseObject({
    kind: z.literal("assistant"),
    id: z.string(),
    at: isoTime,
    text: z.string(),
    streaming: z.boolean(),
    /** The head of the text is omitted; `chat.item` returns all of it. */
    truncated: z.boolean(),
  }),
  z.looseObject({
    kind: z.literal("thinking"),
    id: z.string(),
    at: isoTime,
    text: z.string(),
    streaming: z.boolean(),
    truncated: z.boolean(),
  }),
  z.looseObject({
    kind: z.literal("activity"),
    id: z.string(),
    at: isoTime,
    category: z.enum(["command", "file", "search", "web", "tool", "agent", "plan", "other"]),
    title: z.string(),
    detail: z.string().nullable(),
    status: z.enum(["running", "done", "failed", "declined"]),
    /** A bounded excerpt; `chat.item` returns the rest. */
    output: z.string().nullable(),
    outputTruncated: z.boolean(),
  }),
  z.looseObject({
    kind: z.literal("notice"),
    id: z.string(),
    at: isoTime,
    tone: z.enum(["info", "warning", "danger"]),
    text: z.string(),
  }),
]);
export type ChatItem = z.infer<typeof ChatItemSchema>;

export const ChatQuestionSchema = z.looseObject({
  id: z.string(),
  prompt: z.string(),
  header: z.string().nullable(),
  multiSelect: z.boolean(),
  options: z.array(
    z.looseObject({ id: z.string(), label: z.string(), description: z.string().nullable() }),
  ),
  allowsText: z.boolean(),
});
export type ChatQuestion = z.infer<typeof ChatQuestionSchema>;

export const ChatRequestSchema = z.discriminatedUnion("kind", [
  z.looseObject({
    kind: z.literal("approval"),
    requestId: z.string(),
    runId: z.string().nullable(),
    title: z.string(),
    /** The exact command, path or diff excerpt being approved. */
    detail: z.string().nullable(),
    options: z.array(
      z.looseObject({
        id: z.string(),
        label: z.string(),
        tone: z.enum(["primary", "default", "danger"]),
      }),
    ),
  }),
  z.looseObject({
    kind: z.literal("question"),
    requestId: z.string(),
    runId: z.string().nullable(),
    questions: z.array(ChatQuestionSchema),
  }),
]);
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

export const ChatStateSchema = z.looseObject({
  status: ChatStatusSchema,
  activeRunId: z.string().nullable(),
  queuedCount: z.number().int(),
  requests: z.array(ChatRequestSchema),
  agentLabel: z.string().nullable(),
  /** Null when this phone can send; otherwise why it cannot. */
  sendBlockedReason: z.string().nullable(),
});
export type ChatState = z.infer<typeof ChatStateSchema>;

export const ChatSnapshotSchema = z.looseObject({
  sessionId: z.string(),
  /**
   * Counts what the Host has told this channel about this chat. A patch carries the revision it
   * produces: a phone drops one at or below what it holds, applies the next, and re-opens on a gap.
   */
  revision: z.number().int(),
  title: z.string(),
  projectName: z.string().nullable(),
  state: ChatStateSchema,
  /** Oldest first: the newest bounded window of the transcript. */
  items: z.array(ChatItemSchema),
  /** Pass to `chat.history` for the items before this window. */
  historyCursor: z.string().nullable(),
});
export type ChatSnapshot = z.infer<typeof ChatSnapshotSchema>;

export const ChatPatchOpSchema = z.discriminatedUnion("op", [
  z.looseObject({ op: z.literal("upsert"), item: ChatItemSchema }),
  /**
   * Text appended to an assistant or thinking item. `offset` is the UTF-16 length the phone must
   * already hold; on a mismatch it re-opens the chat.
   */
  z.looseObject({
    op: z.literal("append"),
    itemId: z.string(),
    offset: z.number().int(),
    text: z.string(),
  }),
  z.looseObject({ op: z.literal("remove"), itemId: z.string() }),
  z.looseObject({ op: z.literal("state"), state: ChatStateSchema }),
  z.looseObject({ op: z.literal("title"), title: z.string() }),
]);
export type ChatPatchOp = z.infer<typeof ChatPatchOpSchema>;

export const ChatResponseSchema = z.discriminatedUnion("kind", [
  z.looseObject({
    kind: z.literal("option"),
    optionId: z.string(),
    feedback: z.string().nullable(),
  }),
  /** Answers by question id; each is the chosen option ids or free text. */
  z.looseObject({ kind: z.literal("answers"), answers: z.record(z.string(), z.array(z.string())) }),
]);
export type ChatResponse = z.infer<typeof ChatResponseSchema>;

export const RpcErrorSchema = z.looseObject({
  code: z.enum([
    "invalid_params",
    "unknown_method",
    "not_found",
    "conflict",
    "rejected",
    "unavailable",
    "internal",
  ]),
  message: z.string(),
  /** Whether repeating the same request, with the same identities, may succeed. */
  retryable: z.boolean(),
});
export type RpcError = z.infer<typeof RpcErrorSchema>;
