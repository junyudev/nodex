import { castDraft, type Draft } from "immer";
import type { TurnStartParams } from "@nodex/codex-app-server-protocol/v2";
import type { TurnEnvironmentParams } from "@nodex/codex-app-server-protocol/v2/TurnEnvironmentParams";
import type {
  CodexCanonicalConversationState,
  CodexCanonicalLiveTurnParams,
  CodexCanonicalPermissionContext,
} from "./codex-conversation-state";
import type { CodexEnvironmentSelectionEvidence } from "./codex-environment-selection";
import {
  conversationTurnDraft,
  residentConversationTurnEntries,
  removeConversationTurnDraft,
} from "./codex-turn-mutation";

/** Prepared execution changes live context without becoming a next-Turn settings update. */
export interface CodexPreparedTurnExecution {
  readonly model: string | null;
  readonly reasoningEffort: NonNullable<TurnStartParams["effort"]> | null;
  readonly shouldUpdateReasoningEffort: boolean;
  readonly collaborationMode: NonNullable<TurnStartParams["collaborationMode"]> | null;
  readonly permissions: CodexCanonicalPermissionContext;
  readonly previousPermissions?: CodexCanonicalPermissionContext;
  /** Prepared sticky environments commit only after native Turn acceptance. */
  readonly environments?: readonly TurnEnvironmentParams[] | null;
  readonly environmentSelectionEvidence?: CodexEnvironmentSelectionEvidence;
  readonly workspaceKind?: "project" | "projectless";
  /** Owner-time generated or reused projectless workspace published before dispatch. */
  readonly projectlessWorkspace?: {
    readonly cwd: string;
    readonly workspaceRoot: string;
  } | null;
  /** Owner-time pending workspace becomes the accepted cwd only after native Turn acceptance. */
  readonly pendingWorkspace?: {
    readonly projectSources: readonly string[];
    readonly cwd: string;
    readonly runtimeWorkspaceRoots: readonly string[];
  } | null;
}

export interface CodexInspectedTurnStart extends CodexPreparedTurnExecution {
  readonly request: TurnStartParams;
  readonly params: CodexCanonicalLiveTurnParams;
}

export function mutateCodexTurnExecution(
  state: Draft<CodexCanonicalConversationState>,
  execution: CodexPreparedTurnExecution,
): void {
  state.latestModel = execution.model ?? state.latestModel;
  state.latestReasoningEffort = execution.shouldUpdateReasoningEffort
    ? execution.reasoningEffort
    : (execution.reasoningEffort ?? state.latestReasoningEffort);
  state.latestCollaborationMode = execution.collaborationMode ?? state.latestCollaborationMode;
  if (execution.pendingWorkspace == null) {
    state.currentPermissions = castDraft(execution.permissions);
  }
  if (execution.pendingWorkspace == null && execution.projectlessWorkspace) {
    state.workspaceKind = "projectless";
    state.workspaceBrowserRoot = execution.projectlessWorkspace.workspaceRoot;
    state.cwd = execution.projectlessWorkspace.cwd;
  }
}

/** A rejected request restores permissions, while already-observed execution metadata remains. */
export function mutateCodexTurnStartRejection(
  state: Draft<CodexCanonicalConversationState>,
  input: {
    readonly clientUserMessageId: string;
    readonly previousPermissions?: CodexCanonicalPermissionContext;
    readonly message: string;
    readonly failureItemId: string;
    readonly retainTurn?: boolean;
    readonly restoreRuntimeStatus?: CodexCanonicalConversationState["threadRuntimeStatus"];
  },
): void {
  const entry = residentConversationTurnEntries(state).findLast(
    ({ turn }) =>
      turn.turnId === null &&
      turn.status === "inProgress" &&
      turn.params.clientUserMessageId === input.clientUserMessageId,
  );
  if (entry) {
    const turn = conversationTurnDraft(state, entry.address)!;
    if (
      !input.retainTurn &&
      turn.turnId === null &&
      turn.items.every((item) => item.type === "modelChanged")
    ) {
      removeConversationTurnDraft(state, entry.address);
    } else {
      const message = input.message.trim() ? input.message : "Error submitting message";
      turn.items.push({
        id: input.failureItemId,
        type: "error",
        message,
        willRetry: false,
        errorInfo: null,
        additionalDetails: null,
      });
      turn.status = "failed";
      turn.error = { message, codexErrorInfo: null, additionalDetails: null, misalignment: null };
    }
    if (input.restoreRuntimeStatus) state.threadRuntimeStatus = input.restoreRuntimeStatus;
  }
  if (input.previousPermissions === undefined) delete state.currentPermissions;
  else state.currentPermissions = castDraft(input.previousPermissions);
}

export type CodexTurnStartRejection = Parameters<typeof mutateCodexTurnStartRejection>[1];
