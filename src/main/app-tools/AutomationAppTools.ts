import {
  captureAppToolAuthority,
  readHostedAppToolSessionContext,
  type AppToolAuthorityCapture,
} from "./AppToolCaller";
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
import { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import { ApplicationSettings } from "../settings/ApplicationSettings";
import { agentRuntimeProviderId } from "../../shared/agent-runtime-provider";
import type { AgentBackendBinding } from "../../shared/agent-backend";
import { resolveAppToolCallingSession } from "./AppToolCallingSession";
import {
  AgentBackendRegistryError,
  resolveAgentBackendBinding,
} from "../agent-backend/AgentBackendRegistry";

const AGENT_UNAVAILABLE = "automation_backend_unavailable";
const AGENT_UNAVAILABLE_MESSAGE =
  "The selected Agent is off, removed or not ready. Ask the user to check it in Settings, or choose another Agent.";

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

export const makeWithCapture = (capture: AppToolAuthorityCapture) =>
  Effect.gen(function* () {
    const application = yield* AutomationApplication;
    const workspace = yield* ProjectWorkspace;
    const identity = yield* CoreAuthority;
    const runtime = yield* Effect.serviceOption(AgentRuntimeApplication);
    const settings = yield* Effect.serviceOption(ApplicationSettings);
    const runtimeTarget = (sessionId: string) =>
      Effect.gen(function* () {
        if (Option.isNone(runtime)) return null;
        const loaded = yield* runtime.value
          .inspect({ sessionId })
          .pipe(
            Effect.mapError(
              (cause) => new AutomationApplicationError({ operation: "runtime-target", cause }),
            ),
          );
        if (loaded.thread.providerInstanceId === "codex") return { kind: "codex" } as const;
        if (Option.isNone(settings)) return null;
        const configured = yield* settings.value
          .snapshot()
          .pipe(
            Effect.mapError(
              (cause) => new AutomationApplicationError({ operation: "runtime-target", cause }),
            ),
          );
        const candidates: AgentBackendBinding[] = [
          ...configured.claudeAgents.instances
            .filter((instance) => instance.enabled)
            .map((instance) => ({ kind: "claude" as const, instanceConfigId: instance.id })),
          ...configured.openCodeAgents.instances
            .filter((instance) => instance.enabled)
            .map((instance) => ({ kind: "opencode" as const, instanceConfigId: instance.id })),
          ...configured.acpAgents.instances
            .filter((instance) => instance.enabled)
            .map((instance) => ({
              kind: "acp" as const,
              instanceConfigId: instance.id,
              agentDefinitionId: instance.agentDefinitionId,
            })),
        ];
        return (
          candidates.find(
            (binding) => agentRuntimeProviderId(binding) === loaded.thread.providerInstanceId,
          ) ?? null
        );
      });

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
            (yield* resolveAppToolCallingSession(input.caller, workspace))?.sessionId)
          : undefined;
      if (request.kind === "heartbeat" && !targetSessionId)
        return toolFailure("session_unavailable");
      if (!input.caller.isActive())
        return toolFailure("call_withdrawn", undefined, { operationId });
      const fields = definitionInput(request);
      const current =
        request.mode === "update" || request.mode === "suggested_update"
          ? yield* application.definitions.get(request.id)
          : null;
      const hosted = readHostedAppToolSessionContext(input.caller);
      const runtimeBinding = hosted
        ? yield* runtimeTarget(targetSessionId ?? hosted.sessionId)
        : null;
      const target = hosted
        ? null
        : request.kind === "heartbeat" && targetSessionId
          ? (yield* workspace.getProjectSession(targetSessionId))?.thread
          : yield* workspace.getThread(input.caller.threadId);
      const backendBinding =
        fields.backendBinding ??
        current?.backendBinding ??
        runtimeBinding ??
        target?.backendBinding;
      if (!backendBinding)
        return toolFailure(
          AGENT_UNAVAILABLE,
          "No Agent is known for this task. Pass backendBinding from a task returned by view.",
        );
      if (request.kind === "heartbeat") {
        const sessionBinding = runtimeBinding ?? target?.backendBinding;
        if (!sessionBinding)
          return toolFailure(
            AGENT_UNAVAILABLE,
            "The target Session is unavailable or its Agent is off or removed. Ask the user to check that Agent in Settings, or target another Session.",
          );
        // Update resolves an omitted backendBinding from the task, not from a new target Session.
        if (agentRuntimeProviderId(sessionBinding) !== agentRuntimeProviderId(backendBinding))
          return toolFailure(
            AGENT_UNAVAILABLE,
            request.mode === "update" || request.mode === "suggested_update"
              ? "A Heartbeat runs on its target Session's Agent, and update keeps the task's current backendBinding when it is omitted. Pass the backendBinding included here."
              : "A Heartbeat runs on its target Session's Agent. Omit backendBinding, or pass the one included here.",
            { backendBinding: sessionBinding },
          );
      }
      if (backendBinding.kind === "acp") {
        if (Option.isNone(settings) || Option.isNone(runtime))
          return toolFailure(AGENT_UNAVAILABLE, AGENT_UNAVAILABLE_MESSAGE);
        const configured = yield* settings.value
          .snapshot()
          .pipe(
            Effect.mapError(
              (cause) => new AutomationApplicationError({ operation: "validate-runtime", cause }),
            ),
          );
        if (
          resolveAgentBackendBinding(backendBinding, configured) instanceof
          AgentBackendRegistryError
        )
          return toolFailure(AGENT_UNAVAILABLE, AGENT_UNAVAILABLE_MESSAGE);
      }
      const definition =
        request.kind === "heartbeat"
          ? { ...fields, backendBinding, targetSessionId }
          : { ...fields, backendBinding };
      if (hosted || backendBinding.kind === "acp") {
        if (Option.isNone(runtime))
          return toolFailure(AGENT_UNAVAILABLE, AGENT_UNAVAILABLE_MESSAGE);
        const providers = yield* runtime.value
          .catalog()
          .pipe(
            Effect.mapError(
              (cause) => new AutomationApplicationError({ operation: "validate-runtime", cause }),
            ),
          );
        const provider = providers.find(
          (provider) => provider.instanceId === agentRuntimeProviderId(backendBinding),
        );
        if (
          !provider?.enabled ||
          !provider.installed ||
          provider.status === "error" ||
          provider.availability === "unavailable"
        )
          return toolFailure(AGENT_UNAVAILABLE, AGENT_UNAVAILABLE_MESSAGE);
        const model = "model" in fields ? fields.model : null;
        if (model && !provider.models.some((candidate) => candidate.slug === model))
          return toolFailure(
            "automation_model_unavailable",
            "The selected Agent doesn't offer this model. Omit model to use its first available model.",
          );
      }
      if (request.mode === "suggested_create" || request.mode === "suggested_update") {
        if (request.mode === "suggested_update") {
          const current = yield* application.definitions.get(request.id);
          if (!current) return toolFailure("not_found");
          if (current.definitionRevision !== request.expectedRevision)
            return toolFailure("conflict");
        }
        if (!input.caller.isActive()) return toolFailure("call_withdrawn");
        return toolSuccess({
          proposal: {
            ...definition,
            mode: request.mode,
            ...(request.mode === "suggested_update"
              ? {
                  id: request.id,
                  expectedRevision: request.expectedRevision,
                  status: request.status,
                }
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
      const authority = yield* capture(input.caller);
      if (!authority) return toolFailure("authority_unavailable");
      const request = parsed.data;
      const writes =
        request.mode === "create" || request.mode === "update" || request.mode === "delete";

      if (!input.caller.isActive()) return toolFailure("call_withdrawn");
      const operationId =
        ("operationId" in request ? request.operationId : undefined) ??
        createStableOperationId("app.automation_update", authority.admittedAtMs, [
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

export const make = Effect.gen(function* () {
  const turns = yield* CodexTurnAuthority;
  return yield* makeWithCapture((caller) => captureAppToolAuthority(caller, turns));
});
