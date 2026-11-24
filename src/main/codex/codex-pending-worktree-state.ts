import type {
  CodexPendingWorktreeEntry,
  CodexPendingWorktreeRequest,
  CodexPendingWorktreeThreadResolution,
} from "../../shared/codex-pending-worktree";
import { appendTextTail } from "../../shared/bounded-text";
import { WORKTREE_OUTPUT_TAIL_MAX_CHARS } from "../../shared/worktree-output";
import { rewriteExecutionWorkspaceRoots } from "./codex-execution-workspace-roots";

export type {
  CodexPendingForkConversationRequest,
  CodexPendingStableWorktreeRequest,
  CodexPendingStartConversationRequest,
  CodexPendingWorktreeEntry,
  CodexPendingWorktreePhase,
  CodexPendingWorktreeRequest,
  CodexPendingWorktreeStartingState,
  CodexPendingWorktreeThreadResolution,
} from "../../shared/codex-pending-worktree";

export const CODEX_PENDING_WORKTREE_CREATION_STARTED_OUTPUT = "[info] Starting worktree creation\n";
export const CODEX_PENDING_WORKTREE_CONTINUE_WITHOUT_SETUP_OUTPUT =
  "[info] Continuing without local environment setup\n";

export type CodexPendingWorktreeMetadataUpdate =
  | { readonly type: "isPinned"; readonly isPinned: boolean }
  | { readonly type: "label"; readonly label: string }
  | { readonly type: "labelEdited"; readonly labelEdited: boolean }
  | { readonly type: "needsAttention"; readonly needsAttention: boolean };

export type CodexPendingWorktreeConversationStartState =
  | { readonly state: "waiting" }
  | { readonly state: "starting" }
  | { readonly state: "failed"; readonly errorMessage: string | null };

interface CodexPendingWorktreeConversationStart {
  readonly clientThreadId: string;
  readonly value: CodexPendingWorktreeConversationStartState;
}

export interface CodexPendingWorktreeState {
  readonly entriesById: ReadonlyMap<string, CodexPendingWorktreeEntry>;
  readonly conversationStartsByPendingWorktreeId: ReadonlyMap<
    string,
    CodexPendingWorktreeConversationStart
  >;
}

export type CodexPendingWorktreeEffect =
  | {
      readonly type: "startWorktree";
      readonly pendingWorktreeId: string;
      readonly attempt: number;
    }
  | { readonly type: "abort"; readonly pendingWorktreeId: string }
  | {
      readonly type: "delete";
      readonly pendingWorktreeId: string;
      readonly hostId: string;
      readonly worktreeGitRoot: string;
      readonly reason: "new-branch-cleanup";
    }
  | {
      readonly type: "remove";
      readonly pendingWorktreeId: string;
      readonly clientThreadId: string | null;
    }
  | {
      readonly type: "cleanupGoalSources";
      readonly pendingWorktreeId: string;
      readonly entry: CodexPendingWorktreeEntry;
    }
  | {
      readonly type: "launchConversation";
      readonly pendingWorktreeId: string;
      readonly workspaceRoot: string;
      readonly attempt: number;
      readonly entry: CodexPendingWorktreeEntry;
      readonly includeWorktreeInit: boolean;
    }
  | {
      readonly type: "registerStableProject";
      readonly pendingWorktreeId: string;
      readonly attempt: number;
      readonly workspaceRoots: readonly string[];
      readonly label: string;
    };

export type CodexPendingWorktreeAction =
  | {
      readonly type: "create";
      readonly request: CodexPendingWorktreeRequest;
      readonly createdAt: number;
    }
  | { readonly type: "start"; readonly pendingWorktreeId: string; readonly attempt: number }
  | {
      readonly type: "setupStarted";
      readonly pendingWorktreeId: string;
      readonly attempt: number;
    }
  | {
      readonly type: "appendOutput";
      readonly pendingWorktreeId: string;
      readonly attempt: number;
      readonly phase: "worktree" | "setup";
      readonly output: string;
    }
  | {
      readonly type: "setupFailed";
      readonly pendingWorktreeId: string;
      readonly attempt: number;
      readonly errorMessage: string;
      readonly worktreeGitRoot: string;
      readonly worktreeWorkspaceRoot: string;
    }
  | {
      readonly type: "worktreeReady";
      readonly pendingWorktreeId: string;
      readonly attempt: number;
      readonly worktreeGitRoot: string;
      readonly worktreeWorkspaceRoot: string;
    }
  | {
      readonly type: "worktreeFailed";
      readonly pendingWorktreeId: string;
      readonly attempt: number;
      readonly errorMessage: string;
    }
  | {
      readonly type: "stableProjectRegistered";
      readonly pendingWorktreeId: string;
      readonly attempt: number;
    }
  | {
      readonly type: "workspaceRootAddFailed";
      readonly pendingWorktreeId: string;
      readonly attempt: number;
      readonly errorMessage: string;
    }
  | { readonly type: "retry"; readonly pendingWorktreeId: string }
  | { readonly type: "workLocally"; readonly pendingWorktreeId: string }
  | { readonly type: "continueWithoutSetup"; readonly pendingWorktreeId: string }
  | { readonly type: "cancel"; readonly pendingWorktreeId: string }
  | { readonly type: "dismiss"; readonly pendingWorktreeId: string }
  | {
      readonly type: "updateMetadata";
      readonly pendingWorktreeId: string;
      readonly update: CodexPendingWorktreeMetadataUpdate;
    }
  | {
      readonly type: "conversationStartFailed";
      readonly pendingWorktreeId: string;
      readonly attempt: number;
      readonly errorMessage: string | null;
    }
  | { readonly type: "retryConversationStart"; readonly pendingWorktreeId: string }
  | {
      readonly type: "conversationStartSucceeded";
      readonly pendingWorktreeId: string;
      readonly attempt: number;
    };

export interface CodexPendingWorktreeTransition {
  readonly state: CodexPendingWorktreeState;
  readonly effects: readonly CodexPendingWorktreeEffect[];
}

export function createCodexPendingWorktreeState(): CodexPendingWorktreeState {
  return {
    entriesById: new Map(),
    conversationStartsByPendingWorktreeId: new Map(),
  };
}

export function appendCodexPendingWorktreeOutputTail(current: string, output: string): string {
  if (!output) return current;
  return appendTextTail({
    current,
    delta: output,
    maxChars: WORKTREE_OUTPUT_TAIL_MAX_CHARS,
  }).text;
}

export function getCodexPendingWorktreeSnapshot(
  state: CodexPendingWorktreeState,
): readonly CodexPendingWorktreeEntry[] {
  return [...state.entriesById.values()].sort((left, right) => left.createdAt - right.createdAt);
}

export function getCodexPendingWorktreeConversationStartSnapshot(
  state: CodexPendingWorktreeState,
): readonly (CodexPendingWorktreeConversationStartState & {
  readonly pendingWorktreeId: string;
  readonly clientThreadId: string;
})[] {
  return [...state.conversationStartsByPendingWorktreeId].map(([pendingWorktreeId, start]) => ({
    pendingWorktreeId,
    clientThreadId: start.clientThreadId,
    ...start.value,
  }));
}

function clientThreadIdForEntry(entry: CodexPendingWorktreeEntry): string | null {
  if (entry.launchMode === "create-stable-worktree") return null;
  return entry.clientThreadId;
}

function goalSourceCleanupEffects(
  entry: CodexPendingWorktreeEntry,
): readonly CodexPendingWorktreeEffect[] {
  return entry.launchMode === "start-conversation" && entry.threadGoalDraft != null
    ? [{ type: "cleanupGoalSources", pendingWorktreeId: entry.id, entry }]
    : [];
}

export function resolveCodexPendingWorktreeThread(
  state: CodexPendingWorktreeState,
  clientThreadId: string,
): CodexPendingWorktreeThreadResolution | null {
  const entry = [...state.entriesById.values()].find(
    (candidate) => clientThreadIdForEntry(candidate) === clientThreadId,
  );
  if (!entry) {
    const pendingStart = [...state.conversationStartsByPendingWorktreeId].find(
      ([, candidate]) => candidate.clientThreadId === clientThreadId,
    );
    if (!pendingStart) return null;
    const [pendingWorktreeId, start] = pendingStart;
    if (start.value.state === "failed") {
      return {
        state: "failed",
        clientThreadId,
        pendingWorktreeId,
        errorMessage: start.value.errorMessage,
      };
    }
    return {
      state: start.value.state === "starting" ? "starting" : "waiting",
      clientThreadId,
      pendingWorktreeId,
    };
  }

  const conversationStart = state.conversationStartsByPendingWorktreeId.get(entry.id)?.value;
  if (entry.phase === "failed" || conversationStart?.state === "failed") {
    return {
      state: "failed",
      clientThreadId,
      pendingWorktreeId: entry.id,
      errorMessage:
        conversationStart?.state === "failed" ? conversationStart.errorMessage : entry.errorMessage,
    };
  }
  if (conversationStart?.state === "starting") {
    return { state: "starting", clientThreadId, pendingWorktreeId: entry.id };
  }
  return { state: "waiting", clientThreadId, pendingWorktreeId: entry.id };
}

function unchanged(state: CodexPendingWorktreeState): CodexPendingWorktreeTransition {
  return { state, effects: [] };
}

function assertNeverCodexPendingWorktreeVariant(value: never, owner: string): never {
  throw new Error(`Unhandled ${owner}: ${JSON.stringify(value)}`);
}

function entryForAttempt(
  state: CodexPendingWorktreeState,
  pendingWorktreeId: string,
  attempt: number,
): CodexPendingWorktreeEntry | null {
  const entry = state.entriesById.get(pendingWorktreeId);
  return entry?.attempt === attempt ? entry : null;
}

function withEntry(
  state: CodexPendingWorktreeState,
  entry: CodexPendingWorktreeEntry,
): CodexPendingWorktreeState {
  const entriesById = new Map(state.entriesById);
  entriesById.set(entry.id, entry);
  return { ...state, entriesById };
}

function withConversationStart(
  state: CodexPendingWorktreeState,
  pendingWorktreeId: string,
  start: CodexPendingWorktreeConversationStart,
): CodexPendingWorktreeState {
  const conversationStartsByPendingWorktreeId = new Map(
    state.conversationStartsByPendingWorktreeId,
  );
  conversationStartsByPendingWorktreeId.set(pendingWorktreeId, start);
  return { ...state, conversationStartsByPendingWorktreeId };
}

function removePendingWorktree(
  state: CodexPendingWorktreeState,
  entry: CodexPendingWorktreeEntry,
): CodexPendingWorktreeState {
  const entriesById = new Map(state.entriesById);
  const conversationStartsByPendingWorktreeId = new Map(
    state.conversationStartsByPendingWorktreeId,
  );
  entriesById.delete(entry.id);
  conversationStartsByPendingWorktreeId.delete(entry.id);
  return { ...state, entriesById, conversationStartsByPendingWorktreeId };
}

function beginConversationStartIfReady(
  state: CodexPendingWorktreeState,
  pendingWorktreeId: string,
  effects: readonly CodexPendingWorktreeEffect[],
): CodexPendingWorktreeTransition {
  const entry = state.entriesById.get(pendingWorktreeId);
  if (!entry || entry.phase !== "worktree-ready") return { state, effects };
  if (!entry.worktreeWorkspaceRoot) return { state, effects };
  const start = state.conversationStartsByPendingWorktreeId.get(pendingWorktreeId);
  if (!start || start.value.state !== "waiting") return { state, effects };

  const nextState = withConversationStart(state, pendingWorktreeId, {
    clientThreadId: start.clientThreadId,
    value: { state: "starting" },
  });
  return {
    state: nextState,
    effects: [
      ...effects,
      {
        type: "launchConversation",
        pendingWorktreeId,
        workspaceRoot: entry.worktreeWorkspaceRoot,
        attempt: entry.attempt,
        entry,
        includeWorktreeInit: true,
      },
    ],
  };
}

function createPendingWorktree(
  state: CodexPendingWorktreeState,
  action: Extract<CodexPendingWorktreeAction, { readonly type: "create" }>,
): CodexPendingWorktreeTransition {
  if (state.entriesById.has(action.request.id)) return unchanged(state);
  const entry: CodexPendingWorktreeEntry = {
    ...action.request,
    createdAt: action.createdAt,
    attempt: 1,
    phase: "queued",
    labelEdited: false,
    worktreeOutputText: "",
    setupOutputText: "",
    errorMessage: null,
    worktreeWorkspaceRoot: null,
    worktreeGitRoot: null,
    needsAttention: false,
    isPinned: false,
  };
  let nextState = withEntry(state, entry);
  const clientThreadId = clientThreadIdForEntry(entry);
  if (clientThreadId) {
    nextState = withConversationStart(nextState, entry.id, {
      clientThreadId,
      value: { state: "waiting" },
    });
  }
  return {
    state: nextState,
    effects: [{ type: "startWorktree", pendingWorktreeId: entry.id, attempt: 1 }],
  };
}

function startPendingWorktree(
  state: CodexPendingWorktreeState,
  pendingWorktreeId: string,
  attempt: number,
): CodexPendingWorktreeTransition {
  const entry = entryForAttempt(state, pendingWorktreeId, attempt);
  if (!entry || entry.phase !== "queued") return unchanged(state);
  return {
    state: withEntry(state, {
      ...entry,
      phase: "creating",
      worktreeOutputText: CODEX_PENDING_WORKTREE_CREATION_STARTED_OUTPUT,
    }),
    effects: [],
  };
}

function appendPendingWorktreeOutput(
  state: CodexPendingWorktreeState,
  pendingWorktreeId: string,
  attempt: number,
  phase: "worktree" | "setup",
  output: string,
): CodexPendingWorktreeTransition {
  const entry = entryForAttempt(state, pendingWorktreeId, attempt);
  if (!entry || !output || (entry.phase !== "creating" && entry.phase !== "setting-up"))
    return unchanged(state);
  if (phase === "setup") {
    return {
      state: withEntry(state, {
        ...entry,
        setupOutputText: appendCodexPendingWorktreeOutputTail(entry.setupOutputText, output),
      }),
      effects: [],
    };
  }
  return {
    state: withEntry(state, {
      ...entry,
      worktreeOutputText: appendCodexPendingWorktreeOutputTail(entry.worktreeOutputText, output),
    }),
    effects: [],
  };
}

function setPendingWorktreeReady(
  state: CodexPendingWorktreeState,
  action: Extract<CodexPendingWorktreeAction, { readonly type: "worktreeReady" }>,
): CodexPendingWorktreeTransition {
  const entry = entryForAttempt(state, action.pendingWorktreeId, action.attempt);
  if (!entry || (entry.phase !== "creating" && entry.phase !== "setting-up"))
    return unchanged(state);
  const readyEntry: CodexPendingWorktreeEntry = {
    ...entry,
    phase: "worktree-ready",
    worktreeGitRoot: action.worktreeGitRoot,
    worktreeWorkspaceRoot: action.worktreeWorkspaceRoot,
  };
  const nextState = withEntry(state, readyEntry);
  if (readyEntry.launchMode !== "create-stable-worktree") {
    return beginConversationStartIfReady(nextState, readyEntry.id, []);
  }

  return {
    state: nextState,
    effects: [
      {
        type: "registerStableProject",
        pendingWorktreeId: readyEntry.id,
        attempt: readyEntry.attempt,
        workspaceRoots: rewriteExecutionWorkspaceRoots({
          sourcePrimary: readyEntry.sourceWorkspaceRoot,
          targetPrimary: action.worktreeWorkspaceRoot,
          workspaceRoots: readyEntry.sourceWorkspaceRoots,
        }),
        label: readyEntry.label,
      },
    ],
  };
}

function completeStableWorkspaceRootRegistration(
  state: CodexPendingWorktreeState,
  pendingWorktreeId: string,
  attempt: number,
): CodexPendingWorktreeTransition {
  const entry = state.entriesById.get(pendingWorktreeId);
  if (
    !entry ||
    entry.launchMode !== "create-stable-worktree" ||
    entry.phase !== "worktree-ready" ||
    entry.attempt !== attempt
  ) {
    return unchanged(state);
  }

  return {
    state: removePendingWorktree(state, entry),
    effects: [{ type: "remove", pendingWorktreeId, clientThreadId: null }],
  };
}

function failStableWorkspaceRootRegistration(
  state: CodexPendingWorktreeState,
  pendingWorktreeId: string,
  attempt: number,
  errorMessage: string,
): CodexPendingWorktreeTransition {
  const entry = state.entriesById.get(pendingWorktreeId);
  if (
    !entry ||
    entry.launchMode !== "create-stable-worktree" ||
    entry.phase !== "worktree-ready" ||
    entry.attempt !== attempt
  ) {
    return unchanged(state);
  }

  return {
    state: withEntry(state, {
      ...entry,
      phase: "failed",
      errorMessage,
      needsAttention: true,
      worktreeOutputText: appendCodexPendingWorktreeOutputTail(
        entry.worktreeOutputText,
        `[stderr] ${errorMessage}\n`,
      ),
    }),
    effects: [],
  };
}

function retryPendingWorktree(
  state: CodexPendingWorktreeState,
  pendingWorktreeId: string,
): CodexPendingWorktreeTransition {
  const entry = state.entriesById.get(pendingWorktreeId);
  if (!entry) return unchanged(state);
  const retryCleanupRoot = entry.phase === "failed" ? entry.worktreeGitRoot : null;
  const nextEntry: CodexPendingWorktreeEntry = {
    ...entry,
    attempt: entry.attempt + 1,
    phase: "queued",
    worktreeOutputText: "",
    setupOutputText: "",
    errorMessage: null,
    worktreeWorkspaceRoot: null,
    worktreeGitRoot: null,
    needsAttention: false,
  };
  let nextState = withEntry(state, nextEntry);
  const clientThreadId = clientThreadIdForEntry(nextEntry);
  if (clientThreadId) {
    nextState = withConversationStart(nextState, pendingWorktreeId, {
      clientThreadId,
      value: { state: "waiting" },
    });
  }

  const effects: CodexPendingWorktreeEffect[] = [{ type: "abort", pendingWorktreeId }];
  if (retryCleanupRoot) {
    effects.push({
      type: "delete",
      pendingWorktreeId,
      hostId: entry.hostId,
      worktreeGitRoot: retryCleanupRoot,
      reason: "new-branch-cleanup",
    });
  }
  effects.push({
    type: "startWorktree",
    pendingWorktreeId,
    attempt: nextEntry.attempt,
  });
  return { state: nextState, effects };
}

function continuePendingWorktreeWithoutSetup(
  state: CodexPendingWorktreeState,
  pendingWorktreeId: string,
): CodexPendingWorktreeTransition {
  const entry = state.entriesById.get(pendingWorktreeId);
  if (!entry || entry.phase !== "failed") return unchanged(state);
  if (!entry.worktreeGitRoot || !entry.worktreeWorkspaceRoot) return unchanged(state);

  let nextState = withEntry(state, {
    ...entry,
    phase: "worktree-ready",
    needsAttention: false,
    setupOutputText: appendCodexPendingWorktreeOutputTail(
      entry.setupOutputText,
      CODEX_PENDING_WORKTREE_CONTINUE_WITHOUT_SETUP_OUTPUT,
    ),
  });
  const clientThreadId = clientThreadIdForEntry(entry);
  if (clientThreadId) {
    nextState = withConversationStart(nextState, pendingWorktreeId, {
      clientThreadId,
      value: { state: "waiting" },
    });
  }
  return beginConversationStartIfReady(nextState, pendingWorktreeId, []);
}

function workLocallyFromPendingWorktree(
  state: CodexPendingWorktreeState,
  pendingWorktreeId: string,
): CodexPendingWorktreeTransition {
  const entry = state.entriesById.get(pendingWorktreeId);
  if (!entry || entry.launchMode === "create-stable-worktree") return unchanged(state);
  if (entry.phase !== "queued" && entry.phase !== "creating" && entry.phase !== "setting-up") {
    return unchanged(state);
  }

  const start = state.conversationStartsByPendingWorktreeId.get(pendingWorktreeId);
  if (!start) return unchanged(state);

  const nextState = removePendingWorktree(state, entry);
  const effects: CodexPendingWorktreeEffect[] = [
    ...goalSourceCleanupEffects(entry),
    { type: "abort", pendingWorktreeId },
  ];
  if (entry.worktreeGitRoot) {
    effects.push({
      type: "delete",
      pendingWorktreeId,
      hostId: entry.hostId,
      worktreeGitRoot: entry.worktreeGitRoot,
      reason: "new-branch-cleanup",
    });
  }
  effects.push({
    type: "launchConversation",
    pendingWorktreeId,
    workspaceRoot: entry.sourceWorkspaceRoot,
    attempt: entry.attempt,
    entry,
    includeWorktreeInit: false,
  });
  return { state: nextState, effects };
}

function removePendingWorktreeWithEffects(
  state: CodexPendingWorktreeState,
  pendingWorktreeId: string,
  mode: "cancel" | "dismiss",
): CodexPendingWorktreeTransition {
  const entry = state.entriesById.get(pendingWorktreeId);
  if (!entry) {
    const start = state.conversationStartsByPendingWorktreeId.get(pendingWorktreeId);
    if (!start) return unchanged(state);
    const conversationStartsByPendingWorktreeId = new Map(
      state.conversationStartsByPendingWorktreeId,
    );
    conversationStartsByPendingWorktreeId.delete(pendingWorktreeId);
    const nextState = { ...state, conversationStartsByPendingWorktreeId };
    return {
      state: nextState,
      effects: [
        { type: "abort", pendingWorktreeId },
        { type: "remove", pendingWorktreeId, clientThreadId: start.clientThreadId },
      ],
    };
  }
  const clientThreadId = clientThreadIdForEntry(entry);
  const shouldDelete =
    entry.worktreeGitRoot !== null && (mode === "cancel" || entry.phase === "failed");
  const effects: CodexPendingWorktreeEffect[] = [
    ...goalSourceCleanupEffects(entry),
    { type: "abort", pendingWorktreeId },
    { type: "remove", pendingWorktreeId, clientThreadId },
  ];
  if (shouldDelete && entry.worktreeGitRoot) {
    effects.push({
      type: "delete",
      pendingWorktreeId,
      hostId: entry.hostId,
      worktreeGitRoot: entry.worktreeGitRoot,
      reason: "new-branch-cleanup",
    });
  }
  return {
    state: removePendingWorktree(state, entry),
    effects,
  };
}

function updatePendingWorktreeMetadata(
  state: CodexPendingWorktreeState,
  pendingWorktreeId: string,
  update: CodexPendingWorktreeMetadataUpdate,
): CodexPendingWorktreeTransition {
  const entry = state.entriesById.get(pendingWorktreeId);
  if (!entry) return unchanged(state);
  switch (update.type) {
    case "isPinned":
      return { state: withEntry(state, { ...entry, isPinned: update.isPinned }), effects: [] };
    case "label":
      return { state: withEntry(state, { ...entry, label: update.label }), effects: [] };
    case "labelEdited":
      return {
        state: withEntry(state, { ...entry, labelEdited: update.labelEdited }),
        effects: [],
      };
    case "needsAttention":
      return {
        state: withEntry(state, { ...entry, needsAttention: update.needsAttention }),
        effects: [],
      };
    default:
      return assertNeverCodexPendingWorktreeVariant(
        update,
        "Codex pending worktree metadata update",
      );
  }
}

function failPendingWorktreeConversationStart(
  state: CodexPendingWorktreeState,
  pendingWorktreeId: string,
  attempt: number,
  errorMessage: string | null,
): CodexPendingWorktreeTransition {
  if (!entryForAttempt(state, pendingWorktreeId, attempt)) return unchanged(state);
  const start = state.conversationStartsByPendingWorktreeId.get(pendingWorktreeId);
  if (!start) return unchanged(state);
  return {
    state: withConversationStart(state, pendingWorktreeId, {
      clientThreadId: start.clientThreadId,
      value: { state: "failed", errorMessage },
    }),
    effects: [],
  };
}

function retryPendingWorktreeConversationStart(
  state: CodexPendingWorktreeState,
  pendingWorktreeId: string,
): CodexPendingWorktreeTransition {
  const start = state.conversationStartsByPendingWorktreeId.get(pendingWorktreeId);
  if (!start || start.value.state !== "failed") return unchanged(state);
  const nextState = withConversationStart(state, pendingWorktreeId, {
    clientThreadId: start.clientThreadId,
    value: { state: "waiting" },
  });
  return beginConversationStartIfReady(nextState, pendingWorktreeId, []);
}

function succeedPendingWorktreeConversationStart(
  state: CodexPendingWorktreeState,
  pendingWorktreeId: string,
  attempt: number,
): CodexPendingWorktreeTransition {
  const entry = state.entriesById.get(pendingWorktreeId);
  if (!entry || entry.attempt !== attempt) return unchanged(state);
  const start = state.conversationStartsByPendingWorktreeId.get(pendingWorktreeId);
  if (!start) return unchanged(state);

  let nextState = state;
  if (entry) {
    nextState = removePendingWorktree(nextState, entry);
  } else {
    const conversationStartsByPendingWorktreeId = new Map(
      nextState.conversationStartsByPendingWorktreeId,
    );
    conversationStartsByPendingWorktreeId.delete(pendingWorktreeId);
    nextState = { ...nextState, conversationStartsByPendingWorktreeId };
  }
  return {
    state: nextState,
    effects: [
      ...(entry ? goalSourceCleanupEffects(entry) : []),
      {
        type: "remove",
        pendingWorktreeId,
        clientThreadId: start.clientThreadId,
      },
    ],
  };
}

export function reduceCodexPendingWorktreeState(
  state: CodexPendingWorktreeState,
  action: CodexPendingWorktreeAction,
): CodexPendingWorktreeTransition {
  switch (action.type) {
    case "create":
      return createPendingWorktree(state, action);
    case "start":
      return startPendingWorktree(state, action.pendingWorktreeId, action.attempt);
    case "setupStarted": {
      const entry = entryForAttempt(state, action.pendingWorktreeId, action.attempt);
      if (!entry || entry.phase !== "creating") return unchanged(state);
      return {
        state: withEntry(state, { ...entry, phase: "setting-up" }),
        effects: [],
      };
    }
    case "appendOutput":
      return appendPendingWorktreeOutput(
        state,
        action.pendingWorktreeId,
        action.attempt,
        action.phase,
        action.output,
      );
    case "setupFailed": {
      const entry = entryForAttempt(state, action.pendingWorktreeId, action.attempt);
      if (!entry || entry.phase !== "setting-up") return unchanged(state);
      return {
        state: withEntry(state, {
          ...entry,
          phase: "failed",
          errorMessage: action.errorMessage,
          worktreeGitRoot: action.worktreeGitRoot,
          worktreeWorkspaceRoot: action.worktreeWorkspaceRoot,
          needsAttention: true,
        }),
        effects: [],
      };
    }
    case "worktreeReady":
      return setPendingWorktreeReady(state, action);
    case "worktreeFailed": {
      const entry = entryForAttempt(state, action.pendingWorktreeId, action.attempt);
      if (!entry || (entry.phase !== "creating" && entry.phase !== "setting-up"))
        return unchanged(state);
      const failed: CodexPendingWorktreeEntry = {
        ...entry,
        phase: "failed",
        errorMessage: action.errorMessage,
        needsAttention: true,
        ...(entry.phase === "setting-up"
          ? {
              setupOutputText: appendCodexPendingWorktreeOutputTail(
                entry.setupOutputText,
                `[stderr] ${action.errorMessage}\n`,
              ),
            }
          : {
              worktreeOutputText: appendCodexPendingWorktreeOutputTail(
                entry.worktreeOutputText,
                `[stderr] ${action.errorMessage}\n`,
              ),
            }),
      };
      return { state: withEntry(state, failed), effects: [] };
    }
    case "stableProjectRegistered":
      return completeStableWorkspaceRootRegistration(
        state,
        action.pendingWorktreeId,
        action.attempt,
      );
    case "workspaceRootAddFailed":
      return failStableWorkspaceRootRegistration(
        state,
        action.pendingWorktreeId,
        action.attempt,
        action.errorMessage,
      );
    case "retry":
      return retryPendingWorktree(state, action.pendingWorktreeId);
    case "workLocally":
      return workLocallyFromPendingWorktree(state, action.pendingWorktreeId);
    case "continueWithoutSetup":
      return continuePendingWorktreeWithoutSetup(state, action.pendingWorktreeId);
    case "cancel":
      return removePendingWorktreeWithEffects(state, action.pendingWorktreeId, "cancel");
    case "dismiss":
      return removePendingWorktreeWithEffects(state, action.pendingWorktreeId, "dismiss");
    case "updateMetadata":
      return updatePendingWorktreeMetadata(state, action.pendingWorktreeId, action.update);
    case "conversationStartFailed":
      return failPendingWorktreeConversationStart(
        state,
        action.pendingWorktreeId,
        action.attempt,
        action.errorMessage,
      );
    case "retryConversationStart":
      return retryPendingWorktreeConversationStart(state, action.pendingWorktreeId);
    case "conversationStartSucceeded":
      return succeedPendingWorktreeConversationStart(
        state,
        action.pendingWorktreeId,
        action.attempt,
      );
    default:
      return assertNeverCodexPendingWorktreeVariant(action, "Codex pending worktree action");
  }
}
