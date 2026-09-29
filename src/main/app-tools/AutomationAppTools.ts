import { captureAppToolAuthority } from "./AppToolCaller";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  automationSchema,
  type AutomationToolInput,
} from "../../shared/nodex-app-tools/automation-schema";
import {
  AutomationApplication,
  AutomationApplicationError,
} from "../automation-application/AutomationApplication";
import { CodexTurnAuthority } from "../codex-application/CodexTurnAuthority";
import { toCoreAgentTurnProvenance } from "../core-client/core-agent-execution-authorization";
import { CoreModuleResponseError } from "../core-client/core-client";
import { CoreApplicationAgent } from "../core-runtime/CoreApplicationAgent";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { CoreRuntimeError } from "../core-runtime/CoreRuntimeError";
import { createStableOperationId } from "../core-runtime/operation-identity";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import type { AppToolInvocation } from "./AppToolInvocationInbox";
import { toolFailure, toolSuccess } from "./app-tool-result";
import { NativeConversationExtension } from "./NativeConversationExtension";

const definitionInput = (request: Extract<AutomationToolInput, { kind: "cron" | "heartbeat" }>) => {
  if (request.mode === "update" || request.mode === "suggested_update") {
    const {
      mode: _mode,
      operationId: _operationId,
      id: _id,
      status: _status,
      expectedRevision: _revision,
      ...definition
    } = request;
    return definition;
  }
  const { mode: _mode, operationId: _operationId, ...definition } = request;
  return definition;
};

export const make = Effect.gen(function* () {
  const application = yield* AutomationApplication;
  const workspace = yield* ProjectWorkspace;
  const turns = yield* CodexTurnAuthority;
  const identity = yield* CoreAuthority;
  const native = yield* Effect.serviceOption(NativeConversationExtension);

  const dispatch = Effect.fn("AutomationAppTools.dispatch")(function* (
    input: AppToolInvocation,
    request: AutomationToolInput,
    operationId: string,
  ) {
    if (request.mode === "list") {
      const { mode: _mode, ...query } = request;
      const result = yield* application.definitions.listWindow(query);
      return input.caller.isActive() ? toolSuccess({ ...result }) : toolFailure("call_withdrawn");
    }
    if (request.mode === "view") {
      const item = yield* application.definitions.get(request.id);
      return input.caller.isActive() ? toolSuccess({ item }) : toolFailure("call_withdrawn");
    }
    if (request.mode === "delete") {
      const result = yield* application.definitions.delete(request.id, {
        operationId,
        expectedRevision: request.expectedRevision,
      });
      if (!input.caller.isActive())
        return toolFailure("call_withdrawn", undefined, { operationId, committed: true });
      return toolSuccess({ ...result, operationId });
    }
    const targetSessionId =
      request.kind === "heartbeat"
        ? (request.targetSessionId ??
          (yield* workspace
            .getThread(input.caller.threadId)
            .pipe(Effect.catch(() => Effect.succeed(null))))?.sessionId)
        : undefined;
    if (request.kind === "heartbeat" && !targetSessionId) return toolFailure("session_unavailable");
    if (!input.caller.isActive()) return toolFailure("call_withdrawn", undefined, { operationId });
    const fields = definitionInput(request);
    const current =
      request.mode === "update" || request.mode === "suggested_update"
        ? yield* application.definitions.get(request.id)
        : null;
    const target =
      request.kind === "heartbeat" && targetSessionId
        ? (yield* workspace.getProjectSession(targetSessionId))?.thread
        : yield* workspace.getThread(input.caller.threadId);
    const backendBinding =
      fields.backendBinding ?? current?.backendBinding ?? target?.backendBinding;
    if (!backendBinding || backendBinding.kind === "acp")
      return toolFailure("automation_backend_unavailable");
    const definition =
      request.kind === "heartbeat"
        ? { ...fields, backendBinding, targetSessionId }
        : { ...fields, backendBinding };
    if (backendBinding.kind === "claude") {
      if (Option.isNone(native)) return toolFailure("automation_backend_unavailable");
      yield* native.value
        .validateAutomation({
          backendBinding,
          model: "model" in fields ? (fields.model ?? null) : null,
          reasoningEffort: "reasoningEffort" in fields ? (fields.reasoningEffort ?? null) : null,
          serviceTier: "serviceTier" in fields ? (fields.serviceTier ?? null) : null,
          executionEnvironment:
            "executionEnvironment" in fields ? fields.executionEnvironment : "local",
          localEnvironmentConfigPath:
            "localEnvironmentConfigPath" in fields
              ? (fields.localEnvironmentConfigPath ?? null)
              : null,
        })
        .pipe(
          Effect.mapError(
            (cause) => new AutomationApplicationError({ operation: "validate-native", cause }),
          ),
        );
    }
    if (request.mode === "suggested_create" || request.mode === "suggested_update") {
      if (request.mode === "suggested_update") {
        const current = yield* application.definitions.get(request.id);
        if (!current) return toolFailure("not_found");
        if (current.definitionRevision !== request.expectedRevision) return toolFailure("conflict");
      }
      if (!input.caller.isActive()) return toolFailure("call_withdrawn");
      return toolSuccess({
        proposal: {
          ...definition,
          mode: request.mode,
          ...(request.mode === "suggested_update"
            ? { id: request.id, expectedRevision: request.expectedRevision, status: request.status }
            : {}),
        },
        committed: false,
      });
    }
    const item =
      request.mode === "create"
        ? yield* application.definitions.create(definition, { operationId })
        : yield* application.definitions.update(
            { ...definition, id: request.id, status: request.status },
            {
              operationId,
              expectedRevision: request.expectedRevision,
            },
          );
    if (!input.caller.isActive())
      return toolFailure("call_withdrawn", undefined, { operationId, committed: true });
    return toolSuccess({ item, operationId });
  });

  return Effect.fn("AutomationAppTools.execute")(function* (input: AppToolInvocation) {
    const parsed = automationSchema.safeParse(input.arguments);
    if (!parsed.success) return toolFailure("invalid_arguments");
    if (!input.caller.isActive()) return toolFailure("call_withdrawn");
    const authority = yield* captureAppToolAuthority(input.caller, turns);
    if (!authority) return toolFailure("authority_unavailable");
    const request = parsed.data;
    const writes =
      request.mode === "create" || request.mode === "update" || request.mode === "delete";
    if (writes && authority.readOnly) return toolFailure("read_only_turn");
    if (!input.caller.isActive()) return toolFailure("call_withdrawn");
    const operationId =
      ("operationId" in request ? request.operationId : undefined) ??
      createStableOperationId("app.automation_update", authority.frozenAtMs, [
        identity.identity.profileId,
        input.caller.threadId,
        input.caller.turnId,
        input.caller.callId,
      ]);
    return yield* dispatch(input, request, operationId).pipe(
      Effect.provideService(
        CoreApplicationAgent,
        toCoreAgentTurnProvenance(identity.identity.profileId, authority),
      ),
      Effect.catch((error) => {
        const cause = error.cause instanceof CoreRuntimeError ? error.cause.cause : error.cause;
        return Effect.succeed(
          cause instanceof CoreModuleResponseError
            ? toolFailure(cause.coreError.code, cause.coreError.message, { operationId })
            : toolFailure("automation_command_failed", undefined, { operationId }),
        );
      }),
    );
  });
});
