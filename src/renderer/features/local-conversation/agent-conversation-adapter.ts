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
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  type AgentConversationOwnerPort,
  acquireAgentConversationOwner,
} from "./agent-conversation-owner";
import {
  agentConversationTurnId,
  agentInteractionResponseFromAnswers,
  filterAgentConversationForTask,
  projectAgentConversation,
} from "../../../shared/agent-conversation-presentation";
import { nativeAgentDraftOwner } from "../../lib/native-agent-draft-owner";
import { createUuidV7 } from "../../../shared/uuid-v7";
import { isAgentConversationTaskLiveInSnapshot } from "../../../shared/agent-conversation";
import type { AgentBackendBinding } from "../../../shared/agent-backend";
import type {
  CodexConversationSnapshot,
  CodexConversationChildMembership,
  CodexThreadSummary,
} from "../../../shared/types";
import type { ConversationRuntime } from "./conversation-runtime";
import type { ThreadStageActions } from "./thread-stage-types";
import { agentBackendRuntime } from "../../lib/agent-backend-runtime";
import { sessionFirstSubmissionOwner } from "../conversation-launch/session-first-submission-owner";
import { useClaudeModelCatalog } from "./use-claude-model-catalog";
import { projectNativeModelOption } from "../../lib/native-model-option";
import {
  isClaudeEffortLevel,
  type ClaudeEffortSelection,
  type ClaudeModelSelection,
} from "../../../shared/claude-models";
import type { AgentNativeIntelligencePresentation } from "../../components/shared/agent-runtime/agent-intelligence-dropdown";
import type { NativePermissionMode } from "../../../shared/agent-backend-api";
import {
  resolveNativeIntelligenceSelection,
  selectNativeModel,
} from "../../lib/native-intelligence-selection";

export type ExternalAgentBinding = Exclude<AgentBackendBinding, { kind: "codex" }>;
type AgentSelection = Pick<ExternalAgentBinding, "kind" | "instanceConfigId">;
const connected = { status: "connected", retries: 0 } as const;
const idle = { status: "idle" } as const;
const emptyChildren: readonly CodexConversationChildMembership[] = [];

/** Native sessions publish product snapshots; they never acquire a Codex document writer. */
export function createAgentConversationRuntime(
  kind: AgentSelection["kind"],
  summary: CodexThreadSummary | null,
  owner: AgentConversationOwnerPort | null,
  sessionId: string,
): ConversationRuntime {
  const cache = new Map<
    string,
    {
      state: ReturnType<AgentConversationOwnerPort["getSnapshot"]>;
      conversation: CodexConversationSnapshot | null;
    }
  >();
  let childrenCache: {
    state: ReturnType<AgentConversationOwnerPort["getSnapshot"]>;
    children: readonly CodexConversationChildMembership[];
  } | null = null;
  let attachmentCache: {
    state: ReturnType<AgentConversationOwnerPort["getSnapshot"]>;
    attachment: ReturnType<ConversationRuntime["attachment"]>;
  } | null = null;
  const childId = (taskId: string) => `agent-task:${owner?.threadId}:${taskId}`;
  const read = (id: string | null) => {
    if (!owner || !summary || !id) return null;
    const state = owner.getSnapshot();
    const previous = cache.get(id);
    if (previous?.state === state) return previous.conversation;
    const task = state.presentation?.snapshot.tasks?.find((entry) => childId(entry.id) === id);
    if (id !== owner.threadId && !task) return null;
    const childSummary = task
      ? {
          ...summary,
          threadId: id,
          threadName: task.description,
          agentRole: task.role,
          model: task.model,
        }
      : summary;
    const presentation = state.presentation;
    const conversation = presentation
      ? projectAgentConversation(
          task
            ? {
                ...presentation,
                snapshot: {
                  ...filterAgentConversationForTask(presentation.snapshot, task.id),
                  threadId: id,
                },
              }
            : presentation,
          childSummary,
        )
      : null;
    cache.set(id, { state, conversation });
    return conversation;
  };
  const children = (id: string | null): readonly CodexConversationChildMembership[] => {
    if (!owner || id !== owner.threadId) return emptyChildren;
    const state = owner.getSnapshot();
    if (childrenCache?.state === state) return childrenCache.children;
    const snapshot = state.presentation?.snapshot;
    const memberships = (snapshot?.tasks ?? []).map((task): CodexConversationChildMembership => ({
      threadId: childId(task.id),
      parentThreadId: owner.threadId,
      task,
      role: "backgroundChild",
      displayName: task.description,
      actorName: task.description,
      agentRole: task.role,
      thread: { displayName: task.description, model: task.model, agentRole: task.role },
      statusType:
        snapshot && isAgentConversationTaskLiveInSnapshot(task, snapshot)
          ? "active"
          : task.status === "failed"
            ? "systemError"
            : "idle",
      showInlineActivity: true,
    }));
    childrenCache = { state, children: memberships.length ? memberships : emptyChildren };
    return childrenCache.children;
  };
  return {
    kind,
    hostId: "local",
    read,
    subscribe: (_id, listener) => owner?.subscribe(listener) ?? (() => {}),
    attachment: (id) => {
      if (!owner || id !== owner.threadId) return idle;
      const state = owner.getSnapshot();
      if (attachmentCache?.state === state) return attachmentCache.attachment;
      if (
        state.connection === "failed" ||
        state.presentation?.snapshot.status === "failed" ||
        state.presentation?.snapshot.status === "closed"
      )
        attachmentCache = {
          state,
          attachment: {
            status: "failed",
            message:
              state.error ?? state.presentation?.snapshot.error ?? "Could not open Agent session",
          },
        };
      else
        attachmentCache = {
          state,
          attachment:
            state.connection === "ready" ? { status: "attached" } : { status: "attaching" },
        };
      return attachmentCache.attachment;
    },
    connection: () => connected,
    role: (id) => (read(id) ? "follower" : null),
    primaryRequest: (id) => read(id)?.requests[0] ?? null,
    children,
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
  onOpenThread?: ThreadStageActions["onOpenThread"];
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
  const [permission, setPermission] = useState<{
    projectId: string | null;
    mode: NativePermissionMode;
  } | null>(null);
  const permissionRequest = useRef(0);
  useEffect(() => {
    const request = ++permissionRequest.current;
    if (kind !== "claude") return;
    let disposed = false;
    void agentBackendRuntime
      .readPermissionMode(input.modelProjectId)
      .then((mode) => {
        if (disposed || request !== permissionRequest.current) return;
        setPermission({ projectId: input.modelProjectId, mode });
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, [kind, input.modelProjectId]);
  const runtime = useMemo(
    () => (kind ? createAgentConversationRuntime(kind, summary, owner, sessionId) : null),
    [kind, summary, owner, sessionId],
  );
  const draftKey = JSON.stringify([
    sessionId,
    input.modelProjectId,
    binding?.kind,
    binding?.instanceConfigId,
  ]);
  const claudeInstanceConfigId = binding?.kind === "claude" ? binding.instanceConfigId : null;
  const claudeCatalog = useClaudeModelCatalog(
    binding?.kind === "claude" && summary
      ? { kind: "thread", threadId: summary.threadId }
      : claudeInstanceConfigId
        ? {
            kind: "project",
            instanceConfigId: claudeInstanceConfigId,
            projectId: input.modelProjectId,
          }
        : null,
    { observedExecutionLocation: summary?.cwd ?? null },
  );
  const draft = useSyncExternalStore(
    (listener) => nativeAgentDraftOwner.subscribe(draftKey, listener),
    () => nativeAgentDraftOwner.read(draftKey),
  );
  const draftModel = draft.selection.model;
  const draftMode = draft.mode;
  const draftEffort = draft.selection.effort;
  const setDraftModel = (model: string, effort: ClaudeEffortSelection = "default") => {
    const selection = { ...selectNativeModel(draft.selection, model, effort, options) };
    const target = options.find((option) => option.value === model);
    if (selection.thinking === false && !target?.disableThinking) delete selection.thinking;
    if (selection.fast === true && target?.fastMode === false) selection.fast = false;
    nativeAgentDraftOwner.write(draftKey, { selection });
  };
  const setDraftMode = (mode: "default" | "plan") =>
    nativeAgentDraftOwner.write(draftKey, { mode });
  const modelConfig = state.presentation?.configOptions.find(
    (option) => option.category === "model",
  );
  const options =
    modelConfig?.type === "select"
      ? modelConfig.options.flatMap((option) => ("group" in option ? option.options : [option]))
      : binding?.kind === "claude"
        ? claudeCatalog.options
        : [{ value: "default", name: "Default", description: null }];
  const selected = state.presentation?.snapshot.metadata?.requestedSelection;
  const requested: ClaudeModelSelection = selected
    ? { ...selected, effort: isClaudeEffortLevel(selected.effort) ? selected.effort : "default" }
    : draft.selection;
  const effective = owner
    ? state.presentation?.snapshot.metadata?.effectiveSelection
    : claudeCatalog.discovery?.intelligence;
  const intelligence = resolveNativeIntelligenceSelection(requested, effective, !owner);
  const selectedModel =
    binding?.kind === "claude"
      ? intelligence.model
      : modelConfig?.type === "select"
        ? modelConfig.currentValue
        : draftModel;
  const models = options.map((option, index) =>
    projectNativeModelOption(
      option,
      binding?.kind === "claude" ? option.value === effective?.model : index === 0,
      binding?.kind === "claude",
    ),
  );
  const effortConfig = state.presentation?.configOptions.find((option) => option.id === "effort");
  const selectedEffort =
    binding?.kind === "claude"
      ? intelligence.effort
      : effortConfig?.type === "select"
        ? effortConfig.currentValue
        : draftEffort;
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
      .findLast((update) => update.kind === "commands")?.commands ??
    claudeCatalog.discovery?.commands.map((command) => ({
      name: command.name,
      description: command.description,
      inputHint: command.argumentHint,
    })) ??
    [];
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
    if (binding?.kind === "claude") {
      await requireSuccess(
        owner.setIntelligence(selectNativeModel(requested, model, "default", options)),
      );
      return;
    }
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
      nativeAgentDraftOwner.write(draftKey, {
        selection: {
          ...draft.selection,
          effort: value,
          ...(value !== "default" ? { thinking: true } : {}),
        },
      });
      return;
    }
    await requireSuccess(
      owner.setIntelligence({
        ...requested,
        effort: value,
        ...(value !== "default" ? { thinking: true } : {}),
      }),
    );
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
          await requireSuccess(
            owner.setIntelligence(selectNativeModel(requested, selection.model, effort, options)),
          );
        },
        onStartThreadForSession: async (request) => {
          if (!binding.instanceConfigId)
            throw new Error("Select an Agent instance before starting");
          if (request.runInTarget === "cloud")
            throw new Error("This Agent requires a local workspace");
          const prompt = await prepareAgentPrompt(
            request.prompt,
            request.promptInput,
            (file) => readPastedTextAttachment({ file }),
            { images: binding.kind === "claude", nativeSkills: binding.kind === "claude" },
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
              runInTarget: request.runInTarget,
              runInEnvironmentPath: request.runInEnvironmentPath,
              worktreeStartingState: request.worktreeStartingState,
              prompt,
              ...(binding.kind === "claude"
                ? { images: agentPromptImages(request.promptInput) }
                : {}),
              ...(binding.kind === "claude" ? { selection: draft.selection, mode: draftMode } : {}),
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
            nativeAgentDraftOwner.clear(draftKey);
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
          const prepared = await prepareAgentPrompt(
            prompt,
            options?.promptInput,
            (file) => readPastedTextAttachment({ file }),
            { images: binding.kind === "claude", nativeSkills: binding.kind === "claude" },
          );
          await requireSuccess(
            owner.submit(
              prepared,
              binding.kind === "claude" ? agentPromptImages(options?.promptInput) : undefined,
            ),
          );
        },
        onInterruptTurn: async () => {
          if (owner) await requireSuccess(owner.cancel());
        },
        onRespondApproval: async (id, response) => {
          if (owner)
            await requireSuccess(
              owner.respond(String(id), {
                decision:
                  response.decision === "accept"
                    ? "allow"
                    : response.decision === "acceptForSession"
                      ? "allow-for-session"
                      : "deny",
              }),
            );
        },
        onRespondUserInput: async (id, answers) => {
          if (owner)
            await requireSuccess(
              owner.respond(
                String(id),
                (() => {
                  const request = owner
                    .getSnapshot()
                    .presentation?.snapshot.requests?.find((entry) => entry.id === String(id));
                  return request
                    ? agentInteractionResponseFromAnswers(request, answers)
                    : { decision: "deny" as const };
                })(),
              ),
            );
        },
        onUnarchiveThread: async () => {
          await workspaceSessionCommands.unarchive(sessionId);
          await input.onRefresh(input.sessionProjectId);
        },
        onDismissThreadGoalResumeConfirmation: undefined,
        onPermissionModeChange: async (mode) => {
          if (mode === "custom") throw new Error("Custom permissions are only available for Codex");
          const request = ++permissionRequest.current;
          let applied: NativePermissionMode = mode;
          if (owner) {
            await requireSuccess(owner.control({ kind: "permission-mode", mode }));
          } else {
            applied = await agentBackendRuntime.setPermissionMode(input.modelProjectId, mode);
          }
          if (request !== permissionRequest.current) return;
          setPermission({ projectId: input.modelProjectId, mode: applied });
        },
        onSteerPrompt: async ({ prompt, promptInput }) => {
          if (!owner) return unsupported();
          const prepared = await prepareAgentPrompt(
            prompt,
            promptInput,
            (file) => readPastedTextAttachment({ file }),
            { images: binding.kind === "claude", nativeSkills: binding.kind === "claude" },
          );
          await requireSuccess(
            owner.control({
              kind: "steer",
              prompt: prepared,
              images: binding.kind === "claude" ? agentPromptImages(promptInput) : undefined,
              clientUserMessageId: createUuidV7(),
            }),
          );
        },
        onEnqueueQueuedFollowUp: unsupported,
        onRemoveQueuedFollowUp: unsupported,
        onReorderQueuedFollowUps: unsupported,
        onSendQueuedFollowUpNow: unsupported,
        onEditQueuedFollowUp: unsupported,
        onEditLastUserTurn: async ({ turnId, message }) => {
          if (!owner) return unsupported();
          const snapshot = owner.getSnapshot().presentation?.snapshot;
          const last = snapshot?.turns.at(-1);
          if (!snapshot || !last || agentConversationTurnId(snapshot, last) !== turnId)
            throw new Error("Only the last native user turn can be edited");
          await requireSuccess(owner.control({ kind: "rollback", numTurns: 1 }));
          await requireSuccess(owner.submit(message));
        },
        onForkFromTurn: async ({ turnId }) => {
          if (!owner || !threadId) return unsupported();
          const snapshot = owner.getSnapshot().presentation?.snapshot;
          const turn = snapshot?.turns.find(
            (entry) => agentConversationTurnId(snapshot, entry) === turnId,
          );
          const nativeMessageId =
            turn?.updates
              .filter((update) => !update.actor?.taskId && !update.actor?.parentToolUseId)
              .flatMap((update) => update.recordIds ?? [])
              .at(-1) ?? turn?.nativeUserMessageId;
          if (!nativeMessageId) throw new Error("This native turn is not saved yet");
          const forked = await agentBackendRuntime.fork({ threadId, nativeMessageId });
          await input.onRefresh(input.sessionProjectId);
          await input.onOpenThread?.(forked.thread.threadId);
        },
        onRespondMcpElicitation: async (id, response) => {
          if (!owner) return unsupported();
          const content =
            typeof response !== "string" &&
            response.content &&
            typeof response.content === "object" &&
            !Array.isArray(response.content)
              ? response.content
              : undefined;
          await requireSuccess(
            owner.respond(
              String(id),
              typeof response === "string"
                ? { decision: "elicitation", action: response }
                : {
                    decision: "elicitation",
                    action: response.action,
                    ...(content ? { content } : {}),
                  },
            ),
          );
        },
        onResolvePlanImplementationRequest: async () => {
          const request = owner
            ?.getSnapshot()
            .presentation?.snapshot.requests?.find((entry) => entry.toolName === "ExitPlanMode");
          if (!owner || !request) return unsupported();
          await requireSuccess(owner.respond(request.id, { decision: "allow" }));
        },
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
        onCompactThread: state.presentation?.capabilities.controls?.compact
          ? async () => {
              if (owner) await requireSuccess(owner.control({ kind: "compact" }));
            }
          : undefined,
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
  const selectedOption = options.find((option) => option.value === selectedModel);
  const nativeIntelligence: AgentNativeIntelligencePresentation | undefined =
    binding?.kind === "claude"
      ? {
          selected: {
            fast: intelligence.fast,
            thinking: intelligence.thinking,
            context: intelligence.context,
            contextInherited: requested.context === undefined,
          },
          capabilities: {
            fastMode: selectedOption?.fastMode,
            disableThinking: selectedOption?.disableThinking,
            contextWindows: selectedOption?.contextWindows,
          },
          change: async (patch) => {
            const next = { ...requested };
            for (const key of ["fast", "thinking", "context"] as const) {
              if (patch[key] === null) delete next[key];
            }
            const selection = {
              ...next,
              ...(patch.effort ? { effort: patch.effort } : {}),
              ...(typeof patch.fast === "boolean" ? { fast: patch.fast } : {}),
              ...(typeof patch.thinking === "boolean" ? { thinking: patch.thinking } : {}),
              ...(typeof patch.context === "string" ? { context: patch.context } : {}),
            };
            if (
              patch.thinking === false &&
              selectedOption?.disabledThinkingEfforts?.length &&
              !selectedOption.disabledThinkingEfforts.includes(selectedEffort)
            ) {
              const effort = selectedOption.disabledThinkingEfforts.at(-1);
              if (isClaudeEffortLevel(effort)) selection.effort = effort;
            }
            if (!owner) {
              nativeAgentDraftOwner.write(draftKey, { selection });
              return;
            }
            await requireSuccess(owner.setIntelligence(selection));
          },
        }
      : undefined;
  return {
    permissionMode:
      state.presentation?.snapshot.metadata?.permissionMode ??
      (permission?.projectId === input.modelProjectId ? permission.mode : "auto"),
    runtime,
    history:
      binding?.kind === "claude" && owner
        ? {
            hasOlder: state.presentation?.snapshot.history?.hasOlder === true,
            windowFull: state.presentation?.snapshot.history?.windowFull,
            loading: state.controlPending !== null,
            loadOlder: async () => {
              await requireSuccess(
                owner.control({
                  kind: "load-older",
                  before: owner.getSnapshot().presentation?.snapshot.history?.cursor,
                  limit: 50,
                }),
              );
            },
          }
        : undefined,
    resolveHistoryImage:
      binding?.kind === "claude" && threadId
        ? (reference: import("../../../shared/agent-history-images").AgentHistoryImageReference) =>
            agentBackendRuntime.historyImage({
              threadId,
              expectedSessionId: reference.sessionId,
              nativeMessageId: reference.nativeMessageId,
              index: reference.index,
            })
        : undefined,
    readToolOutput:
      binding?.kind === "claude" && threadId
        ? (reference: import("../../../shared/agent-tool-output").AgentToolOutputReference) =>
            agentBackendRuntime.toolOutput({
              threadId,
              expectedSessionId: reference.sessionId,
              nativeMessageId: reference.nativeMessageId,
              toolUseId: reference.toolUseId,
            })
        : undefined,
    nativeIntelligence,
    diagnostics:
      binding?.kind === "claude" && threadId
        ? () => agentBackendRuntime.inspect(threadId)
        : undefined,
    generateTitle:
      binding?.kind === "claude" && threadId
        ? async () => {
            const title = await agentBackendRuntime.generateTitle(threadId);
            if (title) await input.onRefresh(input.sessionProjectId);
            return title;
          }
        : undefined,
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
    refreshSkills: binding?.kind === "claude" ? claudeCatalog.refresh : undefined,
    skills:
      claudeCatalog.discovery?.skills
        .filter((skill) => skill.enabled && skill.userInvocable)
        .map((skill) => ({
          name: skill.name,
          displayName: skill.name,
          description: skill.description,
          path: skill.path,
          scope: "user" as const,
          iconUrl: null,
          brandColor: null,
        })) ?? [],
    controls: {
      images: binding?.kind === "claude",
      steer: state.presentation?.capabilities.controls?.steer === true,
      permissionMode:
        binding?.kind === "claude" &&
        (state.presentation?.snapshot.metadata?.permissionMode !== undefined ||
          permission?.projectId === input.modelProjectId),
      skills: binding?.kind === "claude",
      nativeTaskDetails: binding?.kind === "claude",
      stopTask: state.presentation?.capabilities.controls?.stopTask === true,
    },
    stopTask: async (taskId: string) => {
      if (owner) await requireSuccess(owner.control({ kind: "stop-task", taskId }));
    },
  };
}

const agentPromptImages = (input: import("../../../shared/types").CodexPromptInput | undefined) => [
  ...(input?.images ?? []),
  ...(input?.appshots ?? []).map((appshot) => ({
    source: appshot.imageDataUrl,
    caption: appshot.imageName,
  })),
  ...(input?.browserAnnotationAttachments ?? []).flatMap((attachment) =>
    attachment.evidence ? [{ source: attachment.evidence.source, caption: attachment.note }] : [],
  ),
];
