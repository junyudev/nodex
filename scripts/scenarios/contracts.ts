import type { AgentSelection } from "../../src/shared/work-graph";
import type { PageDocumentEnvelope } from "../../src/shared/block-documents/page-document";
import type {
  ActivityRow,
  InboxDispatchAction,
  InboxEntryKind,
  InboxItem,
  InboxScope,
  InboxWindow,
} from "../../src/shared/inbox";
import type {
  CodexScheduledAutomation,
  CodexScheduledAutomationCreateInput,
  CodexThreadActiveFlag,
  CodexThreadStatusType,
  PageChatActivitySummaryResult,
  PageChatWindow,
  Project,
  ProjectCreateInput,
} from "../../src/shared/types";
import type { WorkflowStatus } from "../../src/shared/workflow-status";
import type {
  DatabaseApplyResultV2,
  DatabaseApplyV2,
  DatabaseModuleReadRequestV2,
  DatabaseModuleReadResultV2,
} from "../../src/shared/database-module-v2";
import type {
  SidebarSectionCreateInput,
  SidebarSectionItemWindow,
  SidebarSectionMoveItemInput,
  SidebarSectionSessionCreateInput,
  SidebarSectionSummary,
} from "../../src/shared/sidebar-sections";
import type { ProjectSession } from "../../src/shared/types";
import type {
  LibraryFile,
  LibraryPageFileEntryReceipt,
  LibraryPageFileInventory,
} from "../../src/shared/library-files";

import type { PageWork } from "../../src/shared/work-graph";

export const SCENARIO_MANIFEST_VERSION = 1 as const;

/** The messages an Activity window's message facts are about, newest decision first. */
export const handledMessagesOf = (rows: readonly ActivityRow[]): readonly InboxItem[] => {
  const seen = new Set<string>();
  return rows.flatMap((row) => {
    if (!row.message || seen.has(row.message.pageId)) return [];
    seen.add(row.message.pageId);
    return [row.message];
  });
};

/** A committed Block's identity, type and place, enough to seed against an existing Document. */
export interface ScenarioBlockNode {
  readonly id: string;
  readonly type: string;
  readonly children: readonly ScenarioBlockNode[];
}

export interface ScenarioPageSeed {
  readonly key: string;
  readonly pageId: string;
  readonly operationId: string;
  readonly projectId: string;
  readonly status: WorkflowStatus;
  readonly title: string;
  readonly markdown: string;
}

export interface ScenarioStandalonePageSeed {
  readonly parentPageId?: string;
  readonly beforeBlockId?: string;
  readonly pageId: string;
  readonly documentId: string;
  readonly operationId: string;
  readonly projectId: string;
  readonly title: string;
}

export interface ScenarioDocumentReplacement {
  readonly mutationId: string;
  readonly operationId: string;
  readonly clientSessionId: string;
  readonly projectId: string;
  readonly pageId: string;
  readonly markdown: string;
}

export interface ScenarioLibraryFileSeed {
  readonly operationId: string;
  readonly projectId: string;
  readonly fileId: string;
  readonly defaultName: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}

export interface ScenarioPageFileEntrySeed {
  readonly operationId: string;
  readonly projectId: string;
  readonly pageId: string;
  readonly fileId: string;
  readonly logicalPath: string;
  readonly expectedManifestRevision: number;
  /** Attaches as this chat's Agent, through the credential Core issues for it. */
  readonly attachedByAgent?: {
    readonly sessionId: string;
    readonly backend: "codex" | "claude" | "opencode" | "acp";
  };
}

export interface ScenarioDocumentCheckpointSeed {
  readonly operationId: string;
  readonly projectId: string;
  readonly pageId: string;
  readonly documentId: string;
  readonly label: string;
}

export interface ScenarioPageObservation {
  readonly pageId: string;
  readonly title: string;
  readonly descriptionPreview: string;
  readonly documentReadiness: "pending_genesis" | "ready" | "failed";
  readonly commitSeq: number;
  readonly pageWork?: PageWork | null;
}

export interface ScenarioBoardObservation {
  readonly totalRows: number;
  readonly commitSeq: number;
  readonly groups: Readonly<Record<WorkflowStatus, number>>;
}

/** A Chat with linked Pages; ordinary recipes use related-only links. */
export interface ScenarioRelatedChatSeed {
  /** Explicitly hands work to this chat and selects it as each Page's active chat. */
  readonly handOff?: boolean;
  readonly projectId: string | null;
  readonly relatedPageIds: readonly string[];
  readonly noThreadFallbackTitle: string;
  readonly pinned?: boolean;
  readonly thread?: {
    readonly threadId: string;
    readonly threadName: string;
    readonly threadPreview: string;
    readonly statusType: CodexThreadStatusType;
    readonly statusActiveFlags: readonly CodexThreadActiveFlag[];
    readonly unread: boolean;
  };
}

export interface ScenarioInboxProposalSeed {
  readonly pageIds: readonly string[];
  readonly action: InboxDispatchAction;
  readonly kind: InboxEntryKind | null;
  readonly summary: string;
  readonly rationale: string | null;
}

export interface ScenarioInboxDispatchSeed {
  readonly pageIds: readonly string[];
  readonly action: InboxDispatchAction;
  readonly scope?: InboxScope;
}

export interface ScenarioRelatedChatSeedResult {
  readonly sessionId: string;
  readonly threadId: string | null;
}

export interface ScenarioTurnNoteSeed {
  readonly coordinatorSessionId: string;
  readonly pageId: string;
  readonly sessionId?: string;
  readonly body: string;
  readonly notify: boolean;
}
export interface ScenarioCoordinatorSuggestionSeed extends ScenarioInboxProposalSeed {
  readonly coordinatorSessionId: string;
  readonly explicitRequest?: boolean;
  readonly automaticDispatch?: boolean;
}
export interface ScenarioRecoveryDraftSeed {
  readonly projectId: string;
  readonly documentId: string;
  readonly draftId: string;
  readonly createdAt: string;
  /** Applied to the canonical Page; Core never saw these edits. */
  readonly edit: (document: PageDocumentEnvelope) => void;
}

export interface ScenarioPageWorkspaceSeed {
  readonly projectId: string;
  readonly pageId: string;
  readonly sessionId: string;
  /** The Project's source repository. */
  readonly repositoryRoot: string;
  readonly branchName: string;
  readonly pullRequest?: { readonly number: number; readonly state: "OPEN" | "MERGED" | "CLOSED" };
}

export interface ScenarioSeedPort {
  recordSourceProblem(): Promise<string>;
  /** Holds Agent work for a scope as a person's Pause does. Core seeding only. */
  pauseWork(
    scope: import("@nodex/core-protocol").components["schemas"]["ExecutionHoldScope"],
  ): Promise<void>;
  /**
   * Hands a Page to a new Agent chat as starting its work does, without launching anything.
   * Core seeding only; its execution stays unavailable until a runtime observes it.
   */
  createWorkChat(input: {
    readonly projectId: string;
    readonly pageId: string;
    readonly title: string;
  }): Promise<{ readonly sessionId: string; readonly threadId: null }>;
  /**
   * Records the checkout Host allocation would have prepared for a Page's chat, and optionally
   * the pull request GitHub would report for its branch. Core seeding only; nothing is checked out.
   */
  recordPageWorkspace(input: ScenarioPageWorkspaceSeed): Promise<void>;
  /** Every Inbox's Activity, newest first. */
  readActivity(): Promise<readonly ActivityRow[]>;
  recordSessionExecution(
    sessionId: string,
    observation: import("@nodex/core-protocol").components["schemas"]["SessionExecutionObservation"],
  ): Promise<void>;
  readPageTurn(pageId: string): Promise<import("../../src/shared/page-turn").PageTurn>;
  /** Host admission binds Nodex without starting an execution process. Core seeding only. */
  createCoordinatorSession(): Promise<string>;
  setSessionManaged(sessionId: string, managed: boolean): Promise<void>;
  setPageWork(projectId: string, pageId: string, work: Omit<PageWork, "owner">): Promise<void>;
  /** Uses a persisted Agent execution identity; never writes report columns directly. */
  reportPageWork(input: {
    readonly sessionId: string;
    readonly pageId: string;
    readonly outcome: "ready" | "blocked" | "failed" | "dropped";
    readonly summary: string;
  }): Promise<void>;
  writeTurnNote(input: ScenarioTurnNoteSeed): Promise<void>;
  handBackChatMessage(input: {
    readonly body: string;
    readonly reason: string;
  }): Promise<{ readonly pageId: string; readonly sessionId: string }>;
  answerInboxQuestion(input: {
    readonly coordinatorSessionId: string;
    readonly questionPageId: string;
    readonly body: string;
  }): Promise<{ readonly pageId: string }>;
  /** Begins Host routing and settles the same request as inbox_suggest. */
  settleCoordinatorSuggestion(input: ScenarioCoordinatorSuggestionSeed): Promise<string>;
  confirmInboxRequestByNodex(proposalId: string, selection: AgentSelection): Promise<void>;
  createProject(input: ProjectCreateInput): Promise<Project>;
  createPage(input: ScenarioPageSeed): Promise<{ readonly documentId: string }>;
  createStandalonePage(input: ScenarioStandalonePageSeed): Promise<void>;
  createStandaloneCanvas(input: {
    readonly projectId: string;
    readonly canvasId: string;
    readonly documentId: string;
    readonly name: string;
  }): Promise<void>;
  ensurePrimaryDataSourcePropertyCount(
    projectId: string,
    count: number,
  ): Promise<{ readonly commitSeq: number; readonly propertyCount: number }>;
  readPrimaryDataSourcePropertyCount(projectId: string): Promise<number>;
  readDatabase(request: DatabaseModuleReadRequestV2): Promise<DatabaseModuleReadResultV2>;
  applyDatabase(request: DatabaseApplyV2): Promise<DatabaseApplyResultV2>;
  /** Created identities exclude retained Blocks; readPageBlockTree supplies committed order. */
  replaceOwnedDocument(
    input: ScenarioDocumentReplacement,
  ): Promise<{ readonly commitSeq: number; readonly createdBlockIds: readonly string[] }>;
  readPageBlockTree(projectId: string, pageId: string): Promise<readonly ScenarioBlockNode[]>;
  createLibraryFile(input: ScenarioLibraryFileSeed): Promise<LibraryFile>;
  addPageFileEntry(input: ScenarioPageFileEntrySeed): Promise<LibraryPageFileEntryReceipt>;
  readPageFileInventory(projectId: string, pageId: string): Promise<LibraryPageFileInventory>;
  createDocumentCheckpoint(input: ScenarioDocumentCheckpointSeed): Promise<string>;
  /** Hands Core the unsaved edits a lost window would have, for it to analyse like any other. */
  captureRecoveryDraft(input: ScenarioRecoveryDraftSeed): Promise<void>;
  readPage(
    projectId: string,
    pageId: string,
    minimumCommitSeq?: number,
  ): Promise<ScenarioPageObservation>;
  readBoard(
    projectId: string,
    databaseViewId: string,
    minimumCommitSeq?: number,
  ): Promise<ScenarioBoardObservation>;
  createRelatedChat(input: ScenarioRelatedChatSeed): Promise<ScenarioRelatedChatSeedResult>;
  readSession(sessionId: string): Promise<ProjectSession | null>;
  /** Threadless Session unread remains independent of native read-state identities. */
  setSessionUnread(sessionId: string, unread: boolean): Promise<void>;
  setSessionReminder(sessionId: string, remindAt: string | null): Promise<void>;
  readPageChatActivity(pageIds: readonly string[]): Promise<PageChatActivitySummaryResult>;
  readPageChats(pageId: string): Promise<PageChatWindow>;
  createSidebarSection(input: SidebarSectionCreateInput): Promise<SidebarSectionSummary>;
  createSessionInSidebarSection(input: SidebarSectionSessionCreateInput): Promise<ProjectSession>;
  moveSidebarSectionItem(input: SidebarSectionMoveItemInput): Promise<void>;
  listSidebarSections(): Promise<readonly SidebarSectionSummary[]>;
  listSidebarSectionItems(sectionId: string): Promise<SidebarSectionItemWindow>;
  /** Sends into the Library Inbox unless a Project's Inbox is named. */
  sendInboxMessage(text: string, scope?: InboxScope): Promise<{ readonly pageId: string }>;
  /** Admits or clears sends waiting for automatic advice, without starting Agents. */
  prepareInboxSuggestions(automatic: boolean): Promise<void>;
  /** Records an Agent-shaped suggestion for current message content. Core seeding only. */
  proposeInboxDispatch(input: ScenarioInboxProposalSeed): Promise<void>;
  dispatchInboxEntries(input: ScenarioInboxDispatchSeed): Promise<void>;
  keepInboxEntries(pageIds: readonly string[]): Promise<void>;
  recordInboxSuggestionFailure(pageIds: readonly string[], message: string): Promise<void>;
  /** Marks a confirmed chat dispatch delivered without launching a runtime. Core seeding only. */
  completeInboxDispatch(proposalId: string, threadId: string | null): Promise<void>;
  /** What still needs the user in one Inbox, newest first. */
  readInbox(scope?: InboxScope): Promise<InboxWindow>;
  /** One Inbox's handled messages as Activity holds them: by their newest decision, once each. */
  readHandledMessages(scope?: InboxScope): Promise<readonly InboxItem[]>;
}

export interface ScenarioManifest {
  readonly version: typeof SCENARIO_MANIFEST_VERSION;
  readonly scenarioId: string;
  readonly scenarioRevision: number;
  readonly projectId: string;
  readonly databaseViewId: string;
  readonly pageIdsByKey: Readonly<Record<string, string>>;
  /** Stable identities for non-Page entities needed by inspection and UI acceptance. */
  readonly entityIdsByKey?: Readonly<Record<string, string>>;
  readonly minimumCommitSeq: number;
  readonly materializedAt: string;
}

export interface ScenarioFacts {
  readonly scenarioId: string;
  readonly scenarioRevision: number;
}

export interface ScenarioDomainRecipe {
  readonly id: string;
  readonly revision: number;
  /** Harness-owned disposable source, never a developer checkout. Non-Git tests supply their own. */
  materialize(port: ScenarioSeedPort, workspace: string): Promise<ScenarioManifest>;
  inspect(port: ScenarioSeedPort, manifest: ScenarioManifest): Promise<ScenarioFacts>;
  parseFacts(value: unknown): ScenarioFacts;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

export const parseScenarioManifest = (value: unknown): ScenarioManifest => {
  if (!isRecord(value) || value.version !== SCENARIO_MANIFEST_VERSION) {
    throw new Error("Scenario manifest is invalid or unsupported");
  }
  if (
    !isNonEmptyString(value.scenarioId) ||
    typeof value.scenarioRevision !== "number" ||
    !isNonEmptyString(value.projectId) ||
    !isNonEmptyString(value.databaseViewId) ||
    typeof value.minimumCommitSeq !== "number" ||
    value.minimumCommitSeq < 0 ||
    !isNonEmptyString(value.materializedAt) ||
    !isRecord(value.pageIdsByKey) ||
    !Object.values(value.pageIdsByKey).every(isNonEmptyString) ||
    (value.entityIdsByKey !== undefined &&
      (!isRecord(value.entityIdsByKey) ||
        !Object.values(value.entityIdsByKey).every(isNonEmptyString)))
  ) {
    throw new Error("Scenario manifest is invalid or unsupported");
  }
  return value as unknown as ScenarioManifest;
};

export const parseScenarioFacts = (value: unknown): ScenarioFacts => {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.scenarioId) ||
    typeof value.scenarioRevision !== "number"
  ) {
    throw new Error("Scenario facts are invalid");
  }
  return value as unknown as ScenarioFacts;
};
