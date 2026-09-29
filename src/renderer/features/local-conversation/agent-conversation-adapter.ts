import { readPastedTextAttachment } from "../../lib/api";
import { toast } from "../../components/ui/toast";
import { workspaceSessionCommands } from "../../lib/workspace-catalog-commands";
import { prepareAgentPrompt } from "../../../shared/agent-prompt";
import {
  GIT_ACTION_COMMIT_OR_PUSH_PROMPT,
  GIT_ACTION_CREATE_PR_PROMPT,
} from "../../lib/git-action-prompts";
import type { ThreadActionControllerInput } from "./thread-action-controller";
import { writeTextToClipboardStrict } from "../../lib/clipboard";
import { renderConversationMarkdown } from "./conversation-markdown";
import { selectVisibleConversationTurnEntries } from "./selectors";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  type AgentConversationOwnerPort,
  acquireAgentConversationOwner,
} from "./agent-conversation-owner";
import { projectAgentConversation } from "../../../shared/agent-conversation-presentation";
import type { AgentBackendBinding } from "../../../shared/agent-backend";
import type {
  CodexConversationSnapshot,
  CodexModelOption,
  CodexThreadSummary,
} from "../../../shared/types";
import type { ConversationRuntime } from "./conversation-runtime";
import type { ThreadStageActions } from "./thread-stage-types";
import { agentBackendRuntime } from "../../lib/agent-backend-runtime";
import { sessionFirstSubmissionOwner } from "../conversation-launch/session-first-submission-owner";
import { useClaudeModelCatalog } from "./use-claude-model-catalog";
import type { AgentSessionConfigSelectOption } from "../../../shared/agent-conversation";
import { isClaudeEffortLevel, type ClaudeEffortSelection } from "../../../shared/claude-models";

export type ExternalAgentBinding = Exclude<AgentBackendBinding, { kind: "codex" }>;
type AgentSelection = Pick<ExternalAgentBinding, "kind" | "instanceConfigId">;
const emptyChildren: ReturnType<ConversationRuntime["children"]> = [];
const connected = { status: "connected", retries: 0 } as const;
const idle = { status: "idle" } as const;

const modelOption = (
  option: AgentSessionConfigSelectOption,
  isDefault = false,
): CodexModelOption => ({
  id: option.value,
  model: option.value,
  displayName: option.name,
  description: option.description ?? "",
  hidden: false,
  supportedReasoningEfforts: option.reasoningEfforts?.length
    ? [
        { reasoningEffort: "default", description: "Use the model's default effort" },
        ...option.reasoningEfforts.map((reasoningEffort) => ({ reasoningEffort, description: "" })),
      ]
    : [],
  defaultReasoningEffort: "default",
  inputModalities: ["text"],
  multiAgentVersion: null,
  serviceTiers: [],
  defaultServiceTier: null,
  isDefault,
});

/** Native sessions publish product snapshots; they never acquire a Codex document writer. */
export function createAgentConversationRuntime(
  kind: AgentSelection["kind"],
  summary: CodexThreadSummary | null,
  owner: AgentConversationOwnerPort | null,
  sessionId: string,
): ConversationRuntime {
  let lastState: ReturnType<AgentConversationOwnerPort["getSnapshot"]> | null = null;
  let conversation: CodexConversationSnapshot | null = null;
  const read = (id: string | null) => {
    if (!owner || !summary || id !== owner.threadId) return null;
    const state = owner.getSnapshot();
    if (state !== lastState) {
      lastState = state;
      conversation = state.presentation
        ? projectAgentConversation(state.presentation, summary)
        : null;
    }
    return conversation;
  };
  return {
    kind,
    hostId: "local",
    read,
    subscribe: (_id, listener) => owner?.subscribe(listener) ?? (() => {}),
    attachment: (id) => {
      if (!owner || id !== owner.threadId) return idle;
      const state = owner.getSnapshot();
      if (
        state.connection === "failed" ||
        state.presentation?.snapshot.status === "failed" ||
        state.presentation?.snapshot.status === "closed"
      )
        return {
          status: "failed",
          message:
            state.error ?? state.presentation?.snapshot.error ?? "Could not open Agent session",
        };
      return state.connection === "ready" ? { status: "attached" } : { status: "attaching" };
    },
    connection: () => connected,
    role: (id) => (read(id) ? "follower" : null),
    primaryRequest: (id) => read(id)?.requests[0] ?? null,
    children: () => emptyChildren,
    retain: () => () => {},
    resume: async () => {
      const state = owner?.getSnapshot();
      if (
        state?.connection === "failed" ||
        state?.presentation?.snapshot.status === "failed" ||
        state?.presentation?.snapshot.status === "closed"
      )
        owner?.retry();
    },
    markRead: async () => {
      await workspaceSessionCommands.markUnread(sessionId, { unread: false });
    },
    setPresented: async () => {},
  };
}

const emptyOwnerState = {
  connection: "connecting",
  presentation: null,
  promptPending: false,
  controlPending: null,
  error: null,
} as const;
const subscribeEmpty = () => () => {};
const readEmpty = () => emptyOwnerState;

export function useAgentConversationAdapter(input: {
  binding: AgentSelection | null;
  summary: CodexThreadSummary | null;
  onRefresh: (projectId: string | null) => Promise<unknown>;
  sessionProjectId: string | null;
  modelProjectId: string | null;
  sessionId: string;
  materializeDraft?: ThreadActionControllerInput["onMaterializeProjectDraft"];
  commitDraft?: ThreadActionControllerInput["onCommitMaterializedProjectDraft"];
  ensureDraft: ThreadActionControllerInput["onEnsureDefaultDraftSessionForProject"];
}) {
  const { binding, summary, sessionId } = input;
  const threadId = binding ? (summary?.threadId ?? null) : null;
  const acquired = useMemo(
    () => (threadId ? acquireAgentConversationOwner(threadId) : null),
    [threadId],
  );
  const owner = acquired?.owner ?? null;
  const state = useSyncExternalStore(
    owner?.subscribe ?? subscribeEmpty,
    owner?.getSnapshot ?? readEmpty,
  );
  useEffect(() => acquired?.retain(), [acquired]);
  const kind = binding?.kind;
  const runtime = useMemo(
    () => (kind ? createAgentConversationRuntime(kind, summary, owner, sessionId) : null),
    [kind, summary, owner, sessionId],
  );
  const draftKey = `${binding?.kind}:${binding?.instanceConfigId}:${input.modelProjectId}`;
  const claudeCatalog = useClaudeModelCatalog(
    binding?.kind === "claude" && !owner ? binding.instanceConfigId : null,
    input.modelProjectId,
  );
  const [drafts, setDrafts] = useState<
    Record<string, { model: string; mode: "default" | "plan"; effort: ClaudeEffortSelection }>
  >({});
  const draftModel = drafts[draftKey]?.model ?? "default";
  const draftMode = drafts[draftKey]?.mode ?? "default";
  const draftEffort = drafts[draftKey]?.effort ?? "default";
  const setDraftModel = (model: string, effort: ClaudeEffortSelection = "default") =>
    setDrafts((current) => ({
      ...current,
      [draftKey]: { model, mode: current[draftKey]?.mode ?? "default", effort },
    }));
  const setDraftMode = (mode: "default" | "plan") =>
    setDrafts((current) => ({
      ...current,
      [draftKey]: {
        mode,
        model: current[draftKey]?.model ?? "default",
        effort: current[draftKey]?.effort ?? "default",
      },
    }));
  const modelConfig = state.presentation?.configOptions.find(
    (option) => option.category === "model",
  );
  const options =
    modelConfig?.type === "select"
      ? modelConfig.options.flatMap((option) => ("group" in option ? option.options : [option]))
      : binding?.kind === "claude"
        ? claudeCatalog.options
        : [{ value: "default", name: "Default", description: null }];
  const models = options.map((option, index) => modelOption(option, index === 0));
  const selectedModel = modelConfig?.type === "select" ? modelConfig.currentValue : draftModel;
  const effortConfig = state.presentation?.configOptions.find((option) => option.id === "effort");
  const selectedEffort = effortConfig?.type === "select" ? effortConfig.currentValue : draftEffort;
  const reasoningEffortOptions =
    models.find(({ id }) => id === selectedModel)?.supportedReasoningEfforts ?? [];
  const selectedMode = owner
    ? state.presentation?.modes?.currentModeId === "plan"
      ? "plan"
      : "default"
    : draftMode;
  const modes = owner
    ? (state.presentation?.modes?.availableModes ?? []).flatMap((mode) =>
        mode.id === "plan" || mode.id === "default" || mode.id === "code"
          ? [
              {
                name: mode.name,
                mode: mode.id === "plan" ? ("plan" as const) : ("default" as const),
                model: null,
              },
            ]
          : [],
      )
    : [
        { name: "Code", mode: "default" as const, model: null },
        ...(binding?.kind === "claude"
          ? [{ name: "Plan", mode: "plan" as const, model: null }]
          : []),
      ];
  const commands =
    state.presentation?.snapshot.turns
      .flatMap((turn) => turn.updates)
      .findLast((update) => update.kind === "commands")?.commands ?? [];
  const requireSuccess = async (operation: Promise<boolean>) => {
    if (await operation) return;
    throw new Error(owner?.getSnapshot().error ?? "Agent operation was not accepted");
  };
  const changeModel = async (model: string) => {
    if (!owner) {
      setDraftModel(model);
      return;
    }
    if (!modelConfig) throw new Error("This Agent does not expose model selection");
    await requireSuccess(owner.setConfigOption(modelConfig.id, model));
  };
  const changeMode = async (mode: "default" | "plan") => {
    if (!owner) {
      setDraftMode(mode);
      return;
    }
    const nativeMode = state.presentation?.modes?.availableModes.find((candidate) =>
      mode === "plan"
        ? candidate.id === "plan"
        : candidate.id === "code" || candidate.id === "default",
    );
    if (!nativeMode) throw new Error("This Agent does not expose this mode");
    await requireSuccess(owner.setMode(nativeMode.id));
  };
  const changeEffort = async (value: string) => {
    if (binding?.kind !== "claude" || (value !== "default" && !isClaudeEffortLevel(value)))
      throw new Error("This Agent does not expose this effort level");
    if (!owner) {
      setDraftModel(draftModel, value);
      return;
    }
    await requireSuccess(owner.setConfigOption("effort", value));
  };
  const unsupported = async () => {
    throw new Error("This operation is unavailable for this Agent connection");
  };
  const authenticate = async (methodId: string) => {
    if (owner) await requireSuccess(owner.authenticate(methodId));
  };
  const actions: Partial<ThreadStageActions> = binding
    ? {
        onModelChange: changeModel,
        onReasoningEffortChange: changeEffort,
        onCollaborationModeChange: (mode) =>
          changeMode(mode).catch((cause: unknown) => {
            toast.danger(cause instanceof Error ? cause.message : "Could not change mode");
          }),
        onIntelligenceSelectionChange: async (selection) => {
          if (binding.kind !== "claude") return changeModel(selection.model);
          const effort = isClaudeEffortLevel(selection.reasoningEffort)
            ? selection.reasoningEffort
            : "default";
          if (!owner) {
            setDraftModel(selection.model, effort);
            return;
          }
          if (selection.model !== selectedModel) await changeModel(selection.model);
          await requireSuccess(owner.setConfigOption("effort", effort));
        },
        onStartThreadForSession: async (request) => {
          if (!binding.instanceConfigId)
            throw new Error("Select an Agent instance before starting");
          const prompt = await prepareAgentPrompt(request.prompt, request.promptInput, (file) =>
            readPastedTextAttachment({ file }),
          );
          const submission = sessionFirstSubmissionOwner.begin({
            backend: binding.kind,
            originProjectId: request.projectId,
            originSessionId: request.sessionId,
            prompt: request.prompt,
          });
          try {
            const target =
              request.projectDraftId && request.projectId && input.materializeDraft
                ? await input.materializeDraft({
                    projectId: request.projectId,
                    draftId: request.projectDraftId,
                  })
                : request.projectId !== input.sessionProjectId
                  ? await input.ensureDraft(request.projectId)
                  : null;
            if (request.projectDraftId && !target)
              throw new Error("Project draft materialization is unavailable");
            const targetSessionId = target?.id ?? request.sessionId;
            sessionFirstSubmissionOwner.update(submission.launchId, {
              targetProjectId: request.projectId,
              targetSessionId,
              phase: "startingThread",
            });
            const result = await agentBackendRuntime.startThread({
              sessionId: targetSessionId,
              instanceConfigId: binding.instanceConfigId,
              backendKind: binding.kind,
              prompt,
              ...(binding.kind === "claude"
                ? { model: draftModel, mode: draftMode, effort: draftEffort }
                : {}),
              firstSubmission: {
                launchId: submission.launchId,
                clientUserMessageId: submission.clientUserMessageId,
              },
            });
            sessionFirstSubmissionOwner.update(submission.launchId, {
              threadId: result.thread.threadId,
              phase: "startingTurn",
            });
            if (request.projectDraftId && request.projectId)
              input.commitDraft?.({
                projectId: request.projectId,
                draftId: request.projectDraftId,
                sessionId: targetSessionId,
              });
            await input.onRefresh(request.projectId);
          } catch (cause) {
            sessionFirstSubmissionOwner.fail(submission.launchId, {
              stage: "startingThread",
              message: cause instanceof Error ? cause.message : String(cause),
            });
            throw cause;
          }
        },
        onSendPrompt: async (prompt, options) => {
          if (!owner) throw new Error("An attached Agent session is required");
          const prepared = await prepareAgentPrompt(prompt, options?.promptInput, (file) =>
            readPastedTextAttachment({ file }),
          );
          await requireSuccess(owner.submit(prepared));
        },
        onInterruptTurn: async () => {
          if (owner) await requireSuccess(owner.cancel());
        },
        onRespondApproval: async (id, response) => {
          if (owner)
            await requireSuccess(
              owner.respond(String(id), {
                decision: response.decision === "accept" ? "allow" : "deny",
              }),
            );
        },
        onRespondUserInput: async (id, answers) => {
          if (owner)
            await requireSuccess(
              owner.respond(String(id), {
                decision: "answer",
                answers: Object.fromEntries(
                  Object.entries(answers).map(([key, values]) => [key, values.join(", ")]),
                ),
              }),
            );
        },
        onUnarchiveThread: async () => {
          await workspaceSessionCommands.unarchive(sessionId);
          await input.onRefresh(input.sessionProjectId);
        },
        onDismissThreadGoalResumeConfirmation: undefined,
        onSteerPrompt: unsupported,
        onEnqueueQueuedFollowUp: unsupported,
        onRemoveQueuedFollowUp: unsupported,
        onReorderQueuedFollowUps: unsupported,
        onSendQueuedFollowUpNow: unsupported,
        onEditQueuedFollowUp: unsupported,
        onEditLastUserTurn: unsupported,
        onForkFromTurn: unsupported,
        onRespondMcpElicitation: unsupported,
        onResolvePlanImplementationRequest: unsupported,
        onCleanBackgroundTerminals: unsupported,
        onReplaceQueuedFollowUp: undefined,
        onResumeQueuedFollowUps: undefined,
        onResolveQueuedFollowUpsAfterFreshStart: undefined,
        onRespondPermissionRequest: undefined,
        onRespondNodexAgentAuthorization: undefined,
        onRespondOptionPicker: undefined,
        onRespondSetupCodexStep: undefined,
        onResumeInterruptedTurn: undefined,
        onOpenSideChat: undefined,
        onCopyConversationMarkdown: async () => {
          const conversation = runtime?.read(threadId);
          if (!conversation) return;
          await writeTextToClipboardStrict(
            renderConversationMarkdown({
              title: summary?.threadName,
              cwd: summary?.cwd,
              turns: selectVisibleConversationTurnEntries({ conversation }),
            }),
          );
        },
        onStartSummaryGitAction: async ({ action }) => {
          if (owner)
            await requireSuccess(
              owner.submit(
                action === "commit-or-push"
                  ? GIT_ACTION_COMMIT_OR_PUSH_PROMPT
                  : GIT_ACTION_CREATE_PR_PROMPT,
              ),
            );
        },
        onCompactThread: undefined,
        onGetThreadGoal: undefined,
        onSetThreadGoal: undefined,
        onClearThreadGoal: undefined,
        onSetThreadMemoryMode: undefined,
        onUploadFeedback: undefined,
        onOpenStatusPanel: undefined,
        onOpenSubagentsPanel: undefined,
        onCaptureSubmissionPresentation: undefined,
      }
    : {};
  return {
    runtime,
    state,
    models,
    selectedModel,
    selectedEffort,
    reasoningEffortOptions,
    selectedMode,
    modes,
    commands,
    actions,
    authenticate,
    modelCatalogError: claudeCatalog.error,
  };
}
