import * as Effect from "effect/Effect";
import { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { CoreApplicationAgent } from "../core-runtime/CoreApplicationAgent";
import { CoreModules } from "../core-runtime/CoreModules";
import { CodexTurnAuthority } from "../codex-application/CodexTurnAuthority";
import { readCodexLinkedRootSession } from "../codex-application/CodexLinkedRootSession";
import { createStableOperationId } from "../core-runtime/operation-identity";
import { toCoreAgentTurnProvenance } from "../core-client/core-agent-execution-authorization";
import { createSessionSchema } from "../../shared/nodex-app-tools/session-launch-schema";
import { sessionForkSchema } from "../../shared/nodex-app-tools/session-fork-schema";
import { sessionMergeSchema } from "../../shared/nodex-app-tools/session-merge-schema";
import { sessionMessageSchema } from "../../shared/nodex-app-tools/session-message-schema";
import { captureAppToolAuthority, readHostedAppToolSessionContext } from "./AppToolCaller";
import type { AppToolInvocation } from "./AppToolInvocationInbox";
import { deriveSessionDispatchIdentity } from "./session-dispatch-identity";
import { toolFailure, toolSuccess } from "./app-tool-result";

/** Product Session commands use the canonical execution writer and stable command identities. */
export const make = Effect.gen(function* () {
  const application = yield* AgentRuntimeApplication;
  const core = yield* CoreAuthority;
  const modules = yield* CoreModules;
  const turns = yield* CodexTurnAuthority;
  return Effect.fn("RuntimeSessionCommands.execute")(function* (input: AppToolInvocation) {
    if (!input.caller.isActive()) return toolFailure("call_withdrawn");
    const authority = yield* captureAppToolAuthority(input.caller, turns);
    if (!authority || !input.caller.isActive()) return toolFailure("authority_unavailable");
    const hosted = readHostedAppToolSessionContext(input.caller);
    const native = hosted
      ? null
      : yield* readCodexLinkedRootSession(modules, {
          hostId: input.caller.hostId,
          threadId: input.caller.threadId,
        }).pipe(Effect.catch(() => Effect.succeed(null)));
    if (!hosted && (!native || native.archived)) return toolFailure("session_unavailable");
    if (!input.caller.isActive()) return toolFailure("call_withdrawn");
    const sessionId = hosted?.sessionId ?? native?.id;
    if (!sessionId) return toolFailure("session_unavailable");

    const provenance = toCoreAgentTurnProvenance(core.identity.profileId, authority);
    const stableOperation = (supplied: string | undefined) =>
      supplied ??
      createStableOperationId(`app.${input.name}`, authority.admittedAtMs, [
        core.identity.profileId,
        input.caller.threadId,
        input.caller.turnId,
        input.caller.callId,
      ]);
    const execute = Effect.gen(function* () {
      if (input.name === "send_message_to_session") {
        const parsed = sessionMessageSchema.safeParse(input.arguments);
        if (!parsed.success) return toolFailure("invalid_arguments");
        const request = parsed.data;
        if (request.sessionId === sessionId) return toolFailure("cannot_message_calling_session");
        const operationId = stableOperation(request.operationId);
        const target = yield* application.inspect({ sessionId: request.sessionId });
        if (!input.caller.isActive()) return toolFailure("call_withdrawn");
        // A choice belongs to this message's Run. Another Agent starts from its model's defaults.
        const current = target.thread.modelSelection;
        const modelSelection =
          request.model === undefined
            ? undefined
            : request.providerInstanceId && request.providerInstanceId !== current.instanceId
              ? { instanceId: request.providerInstanceId, model: request.model }
              : { ...current, model: request.model };
        yield* application.message({
          sessionId: request.sessionId,
          message: {
            messageId: operationId,
            text: request.prompt,
            ...(modelSelection ? { modelSelection } : {}),
          },
        });
        return toolSuccess({
          operationId,
          sessionId: request.sessionId,
          threadId: target.threadId,
          deliveryState: "accepted",
        });
      }
      if (input.name === "fork_session") {
        const parsed = sessionForkSchema.safeParse(input.arguments);
        if (!parsed.success) return toolFailure("invalid_arguments");
        const request = parsed.data;
        const operationId = stableOperation(request.operationId);
        const sourceSessionId = request.sessionId ?? sessionId;
        const result = yield* application.fork({
          source: {
            sessionId: sourceSessionId,
            ...(hosted && sourceSessionId === sessionId ? { threadId: hosted.threadId } : {}),
          },
          sessionId: deriveSessionDispatchIdentity(operationId, "session"),
          requestId: operationId,
          acceptedAt: Number(operationId.split(":")[2]),
          environment: request.environment.type,
        });
        return toolSuccess({ ...result, operationId, forkState: "attached" });
      }
      if (input.name === "merge_session_back") {
        const parsed = sessionMergeSchema.safeParse(input.arguments);
        if (!parsed.success) return toolFailure("invalid_arguments");
        const request = parsed.data;
        // A fork's own running reply cannot be merged; its finished work is merged from elsewhere.
        if (request.sessionId === sessionId) return toolFailure("cannot_merge_calling_session");
        const operationId = stableOperation(request.operationId);
        const merged = yield* application.mergeBack({
          sessionId: request.sessionId,
          requestId: operationId,
        });
        return toolSuccess({ ...merged, operationId, mergeState: "pending_next_message" });
      }
      if (input.name !== "create_session") return toolFailure("unknown_tool");
      const parsed = createSessionSchema.safeParse(input.arguments);
      if (!parsed.success) return toolFailure("invalid_arguments");
      const request = parsed.data;
      const projectId = request.target.type === "project" ? request.target.projectId : null;
      const current = hosted
        ? yield* application.inspect({ sessionId, threadId: hosted.threadId })
        : null;
      const nativeProvider = current
        ? null
        : (yield* application.catalog()).find(
            (provider) =>
              provider.instanceId === "codex" &&
              provider.enabled &&
              provider.installed &&
              provider.status !== "error" &&
              provider.status !== "disabled",
          );
      const nativeModel = request.model
        ? nativeProvider?.models.find((model) => model.slug === request.model)
        : (nativeProvider?.models.find((model) => model.isDefault) ?? nativeProvider?.models[0]);
      const selection:
        | import("../../shared/agent-runtime-api").AgentRuntimeLaunch["modelSelection"]
        | null =
        current?.thread.modelSelection ??
        (nativeProvider && nativeModel
          ? { instanceId: nativeProvider.instanceId, model: nativeModel.slug }
          : null);
      if (!selection) return toolFailure("model_unavailable");
      const operationId = stableOperation(request.operationId);
      const environment = request.target.type === "project" ? request.target.environment : null;
      const result = yield* application.launch({
        launchId: operationId,
        acceptedAt: Number(operationId.split(":")[2]),
        sessionId: deriveSessionDispatchIdentity(operationId, "session"),
        projectId,
        title: request.title ?? "New chat",
        modelSelection: {
          ...selection,
          ...(request.model ? { model: request.model } : {}),
          ...(request.reasoningEffort
            ? {
                options: [
                  ...(selection.options ?? []).filter((option) => option.id !== "reasoningEffort"),
                  { id: "reasoningEffort", value: request.reasoningEffort },
                ],
              }
            : {}),
        },
        interactionMode: current?.thread.interactionMode ?? "default",
        runInTarget: environment?.type === "worktree" ? "newWorktree" : "localProject",
        ...(environment?.type === "worktree" && environment.startingState
          ? { worktreeStartingState: environment.startingState }
          : {}),
        message: {
          messageId: deriveSessionDispatchIdentity(operationId, "message"),
          text: request.prompt,
        },
      });
      return toolSuccess({ ...result, operationId, launchState: "attached" });
    });
    return yield* execute.pipe(
      Effect.provideService(CoreApplicationAgent, provenance),
      Effect.catch((error) => Effect.succeed(toolFailure("session_command_failed", error.message))),
    );
  });
});
