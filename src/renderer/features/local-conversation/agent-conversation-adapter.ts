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
import {
  nativeAgentDraftKey,
  nativeAgentDraftOwner,
  nativeIntelligenceIntentOwner,
} from "../../lib/native-agent-draft-owner";
import { createUuidV7 } from "../../../shared/uuid-v7";
import { isAgentConversationTaskLiveInSnapshot } from "../../../shared/agent-conversation";
import type { AgentBackendBinding } from "../../../shared/agent-backend";
import type { AgentModelCatalog } from "../../../shared/agent-model-catalog";
import {
  agentModelConfigOptions,
  flattenAgentConfigOptions,
  resolveAgentConfigSelections,
} from "../../lib/agent-model-selection";
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
import { isClaudeEffortLevel, type ClaudeModelSelection } from "../../../shared/claude-models";
import type { AgentNativeIntelligencePresentation } from "../../components/shared/agent-runtime/agent-intelligence-dropdown";
import type { NativePermissionMode } from "../../../shared/agent-backend-api";
import {
  fitNativeSelection,
  nativeSelectionsMatch,
  resolveNativeIntelligenceSelection,
} from "../../lib/native-intelligence-selection";

export type ExternalAgentBinding = Exclude<AgentBackendBinding, { kind: "codex" }>;
type AgentSelection = ExternalAgentBinding;
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
    subscribeChildObservations: (_id, listener) => owner?.subscribe(listener) ?? (() => {}),
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
  catalog?: AgentModelCatalog | null;
  refreshCatalog?: () => void;
  draftUnavailableReason?: string | null;
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
  const draftKey = nativeAgentDraftKey(sessionId, input.modelProjectId, binding);
  const claudeInstanceConfigId = binding?.kind === "claude" ? binding.instanceConfigId : null;
  const nativeClaudeCatalog = useClaudeModelCatalog(
    input.catalog !== undefined
      ? null
      : binding?.kind === "claude" && summary
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
  const claudeCatalog =
    input.catalog !== undefined
      ? {
          options: input.catalog?.claudeDiscovery?.models ?? [],
          discovery: input.catalog?.claudeDiscovery ?? null,
          error: input.catalog?.health.error ?? null,
          refresh: input.refreshCatalog ? async () => input.refreshCatalog?.() : undefined,
        }
      : nativeClaudeCatalog;
  const draft = useSyncExternalStore(
    (listener) => nativeAgentDraftOwner.subscribe(draftKey, listener),
    () => nativeAgentDraftOwner.read(draftKey),
  );
  const draftModel = draft.selection.model;
  const draftMode = draft.mode;
  const draftEffort = draft.selection.effort;
  const storedIntent = useSyncExternalStore(
    (listener) => nativeIntelligenceIntentOwner.subscribe(threadId ?? "", listener),
    () => (threadId ? nativeIntelligenceIntentOwner.read(threadId) : undefined),
  );
  const setDraftModel = (model: string) => {
    nativeAgentDraftOwner.write(draftKey, {
      selection: { ...draft.selection, model },
      ...(binding?.kind !== "claude" && input.catalog
        ? {
            options: resolveAgentConfigSelections(
              agentModelConfigOptions(input.catalog, model),
              draft.options,
            ),
          }
        : {}),
    });
  };
  const setDraftMode = (mode: "default" | "plan") =>
    nativeAgentDraftOwner.write(draftKey, { mode });
  const modelConfig = state.presentation?.configOptions.find(
    (option) => option.category === "model",
  );
  const options: readonly import("../../../shared/agent-conversation").AgentSessionConfigSelectOption[] =
    modelConfig?.type === "select"
      ? modelConfig.options.flatMap((option) => ("group" in option ? option.options : [option]))
      : binding?.kind === "claude"
        ? claudeCatalog.options
        : (input.catalog?.models.map((model) => ({
            value: model.id,
            name: model.displayName,
            description: model.description,
          })) ?? []);
  const selected = state.presentation?.snapshot.metadata?.requestedSelection;
  const applied: ClaudeModelSelection | null = selected
    ? { ...selected, effort: isClaudeEffortLevel(selected.effort) ? selected.effort : "default" }
    : null;
  const effective = owner
    ? state.presentation?.snapshot.metadata?.effectiveSelection
    : claudeCatalog.discovery?.intelligence;
  const modelOption = (model: string) =>
    options.find((option) => option.value === (model === "default" ? effective?.model : model));
  // Intent is what the user chose; the requested selection is that intent fitted to one model.
  // A live runtime change made elsewhere supersedes intent that no longer explains it.
  const intent: ClaudeModelSelection = !applied
    ? draft.selection
    : storedIntent &&
        nativeSelectionsMatch(
          fitNativeSelection(storedIntent, modelOption(storedIntent.model)),
          applied,
        )
      ? storedIntent
      : applied;
  const requested = applied ?? fitNativeSelection(intent, modelOption(intent.model));
  const intelligence = resolveNativeIntelligenceSelection(requested, effective, !owner);
  const selectedModel =
    binding?.kind === "claude"
      ? intelligence.model
      : modelConfig?.type === "select"
        ? modelConfig.currentValue
        : draftModel !== "default"
          ? draftModel
          : (input.catalog?.defaultModel ?? "");
  const models =
    binding?.kind !== "claude" &&
    input.catalog?.health.status === "ready" &&
    !(binding?.kind === "acp" && modelConfig?.type === "select")
      ? [...input.catalog.models]
      : options.map((option) =>
          projectNativeModelOption(
            option,
            binding?.kind === "claude"
              ? option.value === effective?.model
              : option.value === selectedModel,
            binding?.kind === "claude",
          ),
        );
  const supportsImageInput =
    binding?.kind === "claude" ||
    (binding?.kind === "opencode" &&
      models.find((model) => model.id === selectedModel)?.inputModalities.includes("image") ===
        true);
  const configOptions =
    state.presentation?.configOptions ??
    (input.catalog ? agentModelConfigOptions(input.catalog, selectedModel) : []);
  const draftOptions = resolveAgentConfigSelections(configOptions, draft.options);
  const presentedConfigOptions = owner
    ? configOptions
    : configOptions.map((option) => {
        const value = draftOptions.find((entry) => entry.id === option.id)?.value;
        if (option.type === "boolean")
          return {
            ...option,
            currentValue: typeof value === "boolean" ? value : option.currentValue,
          };
        return { ...option, currentValue: typeof value === "string" ? value : option.currentValue };
      });
  const effortConfig = presentedConfigOptions.find(
    (option) => option.category === "thought_level" || option.id === "effort",
  );
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
    : binding?.kind === "claude"
      ? [
          { name: "Code", mode: "default" as const, model: null },
          { name: "Plan", mode: "plan" as const, model: null },
        ]
      : [];
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
  const applyIntent = async (next: ClaudeModelSelection) => {
    if (!owner) {
      nativeAgentDraftOwner.write(draftKey, { selection: next });
      return;
    }
    if (threadId) nativeIntelligenceIntentOwner.write(threadId, next);
    await requireSuccess(owner.setIntelligence(fitNativeSelection(next, modelOption(next.model))));
  };
  const changeModel = async (model: string) => {
    if (!owner) {
      setDraftModel(model);
      return;
    }
    if (!modelConfig) throw new Error("This Agent does not expose model selection");
    if (binding?.kind === "claude") return applyIntent({ ...intent, model });
    await requireSuccess(owner.setConfigOption(modelConfig.id, model));
  };
  const modeState = state.presentation?.modes ?? input.catalog?.modes ?? null;
  const changeNativeMode = async (modeId: string) => {
    if (!modeState?.availableModes.some((mode) => mode.id === modeId))
      throw new Error("This Agent does not expose this mode");
    if (owner) return requireSuccess(owner.setMode(modeId));
    nativeAgentDraftOwner.write(draftKey, { modeId });
  };
  const changeConfig = async (configId: string, value: string | boolean) => {
    const option = presentedConfigOptions.find((entry) => entry.id === configId);
    if (!option || option.category === "model")
      throw new Error("This Agent does not expose this option");
    if (option.type === "boolean" && typeof value !== "boolean")
      throw new Error("Choose On or Off");
    if (
      option.type === "select" &&
      !flattenAgentConfigOptions(option).some((entry) => entry.value === value)
    )
      throw new Error("This option is unavailable");
    if (owner) return requireSuccess(owner.setConfigOption(configId, value));
    nativeAgentDraftOwner.write(draftKey, {
      options: [...draftOptions.filter((entry) => entry.id !== configId), { id: configId, value }],
    });
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
    if (binding?.kind !== "claude") {
      if (!effortConfig) throw new Error("This Agent does not expose this effort level");
      return changeConfig(effortConfig.id, value);
    }
    if (binding?.kind !== "claude" || (value !== "default" && !isClaudeEffortLevel(value)))
      throw new Error("This Agent does not expose this effort level");
    await applyIntent({
      ...intent,
      effort: value,
      ...(value !== "default" ? { thinking: true } : {}),
    });
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
          // A model change keeps every preference; the effort shown for the previous model is
          // only a fitted value, so it becomes intent only when the model stays the same.
          if (selection.model !== requested.model)
            return applyIntent({ ...intent, model: selection.model });
          const effort = isClaudeEffortLevel(selection.reasoningEffort)
            ? selection.reasoningEffort
            : "default";
          await applyIntent({
            ...intent,
            effort,
            ...(effort !== "default" ? { thinking: true } : {}),
          });
        },
        onStartThreadForSession: async (request) => {
          if (input.draftUnavailableReason) throw new Error(input.draftUnavailableReason);
          if (!binding.instanceConfigId)
            throw new Error("Select an Agent instance before starting");
          if (request.runInTarget === "cloud")
            throw new Error("This Agent requires a local workspace");
          if (binding.kind === "opencode" && !selectedModel)
            throw new Error("Connect this Agent and choose a model before starting");
          if (binding.kind !== "acp" && input.catalog && input.catalog.health.status !== "ready")
            throw new Error(input.catalog.health.error ?? "Connect this Agent before starting");
          const prompt = await prepareAgentPrompt(
            request.prompt,
            request.promptInput,
            (file) => readPastedTextAttachment({ file }),
            { images: supportsImageInput, nativeSkills: binding.kind === "claude" },
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
              ...(supportsImageInput ? { images: agentPromptImages(request.promptInput) } : {}),
              ...(binding.kind === "claude" ? { selection: requested, mode: draftMode } : {}),
              ...(binding.kind !== "claude"
                ? {
                    ...(selectedModel ? { model: selectedModel } : {}),
                    configOptions: draftOptions,
                    ...((draft.modeId ?? modeState?.currentModeId)
                      ? { modeId: draft.modeId ?? modeState?.currentModeId }
                      : {}),
                  }
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
            { images: supportsImageInput, nativeSkills: binding.kind === "claude" },
          );
          await requireSuccess(
            owner.submit(
              prepared,
              supportsImageInput ? agentPromptImages(options?.promptInput) : undefined,
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
            const next = { ...intent };
            for (const key of ["fast", "thinking", "context"] as const) {
              if (patch[key] === null) delete next[key];
            }
            await applyIntent({
              ...next,
              ...(patch.effort ? { effort: patch.effort } : {}),
              ...(typeof patch.fast === "boolean" ? { fast: patch.fast } : {}),
              ...(typeof patch.thinking === "boolean" ? { thinking: patch.thinking } : {}),
              ...(typeof patch.context === "string" ? { context: patch.context } : {}),
            });
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
    genericIntelligence:
      binding && binding.kind !== "claude"
        ? {
            configOptions: presentedConfigOptions,
            changeConfig,
            modes: modeState
              ? {
                  ...modeState,
                  currentModeId: owner
                    ? modeState.currentModeId
                    : (draft.modeId ?? modeState.currentModeId),
                }
              : null,
            changeMode: changeNativeMode,
          }
        : undefined,
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
    modelCatalogError:
      binding?.kind === "claude" ? claudeCatalog.error : (input.catalog?.health.error ?? null),
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
      images: supportsImageInput,
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
