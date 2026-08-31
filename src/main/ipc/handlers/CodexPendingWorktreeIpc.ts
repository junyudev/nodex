import type { IpcMainInvokeEvent } from "electron";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { CodexPendingWorktreeCreateInput } from "../../../shared/codex-pending-worktree";
import { requireCodexWorktreeEnvironmentConfigPath } from "../../../shared/codex-worktree-environment-path";
import type { CodexAgentMode } from "../../../shared/types";
import { MainConfig } from "../../app/MainConfig";
import { CodexClientThreadIdentity } from "../../codex-application/CodexClientThreadIdentity";
import { CodexForkSidePanelTransfer } from "../../codex-application/CodexForkSidePanelTransferRuntime";
import { CodexPendingWorktreeRuntime } from "../../codex-application/CodexPendingWorktreeRuntime";
import { executionWorkspacePathKey } from "../../codex/codex-execution-workspace-roots";
import { allocateCodexPendingWorktreeRequest } from "../../codex/codex-pending-worktree-request";
import { ElectronIpc, mapElectronIpcHandlers } from "../../platform/electron/ElectronIpc";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";
import { ProjectWorkspace } from "../../project-application/ProjectWorkspace";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";

export class CodexPendingWorktreeIpcError extends Schema.TaggedError<CodexPendingWorktreeIpcError>()(
  "CodexPendingWorktreeIpcError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

const requireIdentifier = (value: string, label: string): string => {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is required`);
  return value;
};

const requireLabel = (value: string): string => {
  const label = requireIdentifier(value, "Pending worktree label").trim();
  if (!label) throw new Error("Pending worktree label is required");
  return label;
};

const requireAgentMode = (value: CodexAgentMode): CodexAgentMode => {
  if (
    value === "read-only" ||
    value === "auto" ||
    value === "granular" ||
    value === "guardian-approvals" ||
    value === "full-access" ||
    value === "custom"
  ) {
    return value;
  }
  throw new Error("Agent mode is invalid");
};

const requireSourceWorkspaceRoots = (
  value: readonly string[],
  sourceWorkspaceRoot: string,
): readonly string[] => {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Source workspace roots are required");
  }
  for (const root of value) requireIdentifier(root, "Source workspace root");
  const primaryKey = executionWorkspacePathKey(sourceWorkspaceRoot);
  if (!value.some((root) => executionWorkspacePathKey(root) === primaryKey)) {
    throw new Error("Source workspace roots must contain the primary root");
  }
  return value;
};

const requireCreateInput = (
  value: CodexPendingWorktreeCreateInput,
): CodexPendingWorktreeCreateInput => {
  if (!value || typeof value !== "object") {
    throw new Error("Pending worktree create input is required");
  }
  requireIdentifier(value.hostId, "Host id");
  requireLabel(value.label);
  requireIdentifier(value.sourceWorkspaceRoot, "Source workspace root");
  requireIdentifier(value.prompt, "Pending worktree prompt");
  if (value.localEnvironmentConfigPath != null) {
    requireCodexWorktreeEnvironmentConfigPath(value.localEnvironmentConfigPath);
  }
  if (
    value.launchMode !== "create-stable-worktree" &&
    value.launchMode !== "fork-conversation" &&
    value.launchMode !== "start-conversation"
  ) {
    throw new Error("Pending worktree launch mode is invalid");
  }
  if (value.launchMode === "fork-conversation" || value.launchMode === "create-stable-worktree") {
    requireSourceWorkspaceRoots(value.sourceWorkspaceRoots, value.sourceWorkspaceRoot);
  }
  if (value.launchMode === "fork-conversation") {
    requireIdentifier(value.sourceConversationId, "Source conversation id");
  }
  if (value.launchMode === "start-conversation" && !value.startConversationParamsInput) {
    throw new Error("Pending worktree start parameters are required");
  }
  return value;
};

export const live: Layer.Layer<
  never,
  never,
  | CodexClientThreadIdentity
  | CodexForkSidePanelTransfer
  | CodexPendingWorktreeRuntime
  | ElectronIpc
  | MainConfig
  | ProjectWorkspace
  | WindowRuntime
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const clientIdentity = yield* CodexClientThreadIdentity;
    const config = yield* MainConfig;
    const forkTransfers = yield* CodexForkSidePanelTransfer;
    const ipc = yield* ElectronIpc;
    const pending = yield* CodexPendingWorktreeRuntime;
    const projects = yield* ProjectWorkspace;
    const windows = yield* WindowRuntime;
    const fail = (operation: string, cause: unknown) =>
      new CodexPendingWorktreeIpcError({ operation, cause });
    const authorize = (event: IpcMainInvokeEvent) =>
      Effect.try({
        try: () => {
          requireTrustedAppRendererSender(event, "Codex pending worktree", config.rendererUrl);
          if (!windows.has(event.sender.id)) {
            throw new Error("Codex pending worktree access requires an active Nodex window");
          }
        },
        catch: (cause) => fail("authorize-renderer", cause),
      });
    const validate = <A>(operation: string, evaluate: () => A) =>
      Effect.try({ try: evaluate, catch: (cause) => fail(operation, cause) });
    const { handleControl, handlePlainCommand, handleQuery } = mapElectronIpcHandlers(
      ipc,
      (channel, handler) =>
        (event, ...args) =>
          authorize(event).pipe(
            Effect.andThen(handler(event, ...args)),
            Effect.mapError((cause) =>
              cause instanceof CodexPendingWorktreeIpcError ? cause : fail(channel, cause),
            ),
          ),
    );
    const requireOwned = (hostId: string, pendingWorktreeId: string) =>
      validate("resolve-pending-worktree", () => {
        requireIdentifier(hostId, "Host id");
        requireIdentifier(pendingWorktreeId, "Pending worktree id");
        const entry = pending.list().find((candidate) => candidate.id === pendingWorktreeId);
        if (!entry || entry.hostId !== hostId) {
          throw new Error(`Pending worktree is unavailable on host '${hostId}'`);
        }
        return entry;
      });

    yield* handleQuery("codex:pending-worktrees:list", () => Effect.succeed([...pending.list()]));
    yield* handlePlainCommand("codex:pending-worktree:create", (_, input) =>
      validate("create", () => allocateCodexPendingWorktreeRequest(requireCreateInput(input))).pipe(
        Effect.tap((allocated) => pending.create(allocated.request)),
        Effect.map((allocated) => allocated.result),
      ),
    );
    yield* handlePlainCommand(
      "codex:pending-worktree:auto-fix",
      (_, hostId, pendingWorktreeId, agentMode) =>
        validate("auto-fix", () => ({
          hostId: requireIdentifier(hostId, "Host id"),
          pendingWorktreeId: requireIdentifier(pendingWorktreeId, "Pending worktree id"),
          agentMode: requireAgentMode(agentMode),
        })).pipe(
          Effect.flatMap((input) =>
            pending.createSetupRepair(input.hostId, input.pendingWorktreeId, input.agentMode),
          ),
        ),
    );
    yield* handlePlainCommand("codex:pending-worktree:retry", (_, hostId, pendingWorktreeId) =>
      requireOwned(hostId, pendingWorktreeId).pipe(
        Effect.andThen(pending.retry(pendingWorktreeId)),
      ),
    );
    yield* handlePlainCommand(
      "codex:pending-worktree:work-locally",
      (_, hostId, pendingWorktreeId) =>
        requireOwned(hostId, pendingWorktreeId).pipe(
          Effect.andThen(pending.workLocally(pendingWorktreeId)),
        ),
    );
    yield* handlePlainCommand("codex:pending-worktree:continue", (_, hostId, pendingWorktreeId) =>
      requireOwned(hostId, pendingWorktreeId).pipe(
        Effect.andThen(pending.continueWithoutSetup(pendingWorktreeId)),
      ),
    );
    yield* handlePlainCommand("codex:pending-worktree:cancel", (_, hostId, pendingWorktreeId) =>
      requireOwned(hostId, pendingWorktreeId).pipe(
        Effect.andThen(pending.cancel(pendingWorktreeId)),
      ),
    );
    yield* handlePlainCommand("codex:pending-worktree:dismiss", (_, hostId, pendingWorktreeId) =>
      requireOwned(hostId, pendingWorktreeId).pipe(
        Effect.andThen(pending.dismiss(pendingWorktreeId)),
      ),
    );
    yield* handlePlainCommand(
      "codex:pending-worktree:rename",
      (_, hostId, pendingWorktreeId, label) =>
        requireOwned(hostId, pendingWorktreeId).pipe(
          Effect.andThen(validate("rename", () => requireLabel(label))),
          Effect.flatMap((validated) => pending.rename(pendingWorktreeId, validated)),
        ),
    );
    yield* handlePlainCommand(
      "codex:pending-worktree:set-pinned",
      (_, hostId, pendingWorktreeId, isPinned) =>
        requireOwned(hostId, pendingWorktreeId).pipe(
          Effect.andThen(pending.setPinned(pendingWorktreeId, isPinned)),
        ),
    );
    yield* handlePlainCommand(
      "codex:pending-worktree:set-pinned-before-thread",
      (_, hostId, pendingWorktreeId, beforeThreadId) =>
        requireOwned(hostId, pendingWorktreeId).pipe(
          Effect.andThen(
            validate("set-pinned-before-thread", () =>
              beforeThreadId === null
                ? null
                : requireIdentifier(beforeThreadId, "Before thread id"),
            ),
          ),
          Effect.flatMap((validated) =>
            pending.setPinnedBeforeThreadId(pendingWorktreeId, validated),
          ),
        ),
    );
    yield* handlePlainCommand(
      "codex:pending-worktree:clear-attention",
      (_, hostId, pendingWorktreeId) =>
        requireOwned(hostId, pendingWorktreeId).pipe(
          Effect.andThen(pending.clearAttention(pendingWorktreeId)),
        ),
    );
    yield* handlePlainCommand("codex:pending-worktree:resolve-thread", (_, clientThreadId) =>
      validate("resolve-thread", () => requireIdentifier(clientThreadId, "Client thread id")).pipe(
        Effect.flatMap((validated) => {
          // Identity persistence can finish just before the launch fiber publishes its terminal
          // state. While the pending owner still exists, its state is the readiness authority.
          const resolution = pending.resolveThread(validated);
          if (resolution) return Effect.succeed(resolution);
          return clientIdentity
            .threadIdFor(validated)
            .pipe(
              Effect.map((threadId) =>
                threadId
                  ? { state: "succeeded" as const, clientThreadId: validated, threadId }
                  : null,
              ),
            );
        }),
      ),
    );
    yield* handleControl(
      "codex:pending-worktree:discard-fork-side-panel-transfer",
      (_, pendingWorktreeId) =>
        validate("discard-fork-side-panel-transfer", () =>
          requireIdentifier(pendingWorktreeId, "Pending worktree id"),
        ).pipe(Effect.flatMap(forkTransfers.discardPending)),
    );
    yield* handleControl("codex:fork-side-panel-transfer:consume", (event, input) =>
      Effect.gen(function* () {
        if (windows.resolveSessionId(event.sender.id) !== input.targetBrowserViewScopeId) {
          return yield* fail(
            "consume-fork-side-panel-transfer",
            new Error("Browser view scope does not belong to the requesting window"),
          );
        }
        const session = yield* projects.getProjectSession(input.targetProjectSessionId);
        if (!session || session.thread?.threadId !== input.targetConversationId) {
          return yield* fail(
            "consume-fork-side-panel-transfer",
            new Error("Target project session does not own the conversation"),
          );
        }
        return yield* forkTransfers.consumeTarget(input);
      }),
    );
  }),
);
