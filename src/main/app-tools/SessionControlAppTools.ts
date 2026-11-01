import * as Schema from "effect/Schema";
import { createHash } from "node:crypto";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import * as Effect from "effect/Effect";
import { sessionControlSchemas } from "../../shared/nodex-app-tools/session-control-schemas";
import { runtimeSessionTarget } from "../../shared/nodex-app-tools/session-execution-target";
import { stableStringifyBlockPropertyJson } from "../../shared/block-property-mutations";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { CoreApplicationAgent } from "../core-runtime/CoreApplicationAgent";
import { make as makeAppToolOperation } from "./AppToolOperation";
import { toCoreAgentTurnProvenance } from "../core-client/core-agent-execution-authorization";
import { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import { CodexTurnAuthority } from "../codex-application/CodexTurnAuthority";
import { CodexThreadReadState } from "../codex-application/CodexThreadReadState";
import { make as makeNativeControls } from "../codex-application/CodexSessionControls";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { resolveAppToolCallingSession } from "./AppToolCallingSession";
import {
  captureAppToolAuthority,
  readHostedAppToolSessionContext,
  type AppToolAuthorityCapture,
} from "./AppToolCaller";
import type { AppToolInvocation } from "./AppToolInvocationInbox";
import { sessionMessageCeilingError } from "./session-message-policy";
import { make as makeAuthority, denied } from "./SessionControlAuthority";
import { parseAppToolArguments, toolFailure, toolSuccess } from "./app-tool-result";

const receiptCodec = Schema.fromJsonString(Schema.Unknown);
const decodeReceipt = Schema.decodeUnknownSync(receiptCodec);
const encodeReceipt = Schema.encodeSync(receiptCodec);

const failure = (error: unknown): ReturnType<typeof toolFailure> => {
  if (error && typeof error === "object") {
    if ("engineReason" in error && typeof error.engineReason === "string")
      return toolFailure(error.engineReason);
    if ("reason" in error && typeof error.reason === "string" && error.reason !== "rejected")
      return toolFailure(error.reason, error instanceof Error ? error.message : undefined);
    if ("cause" in error && error.cause) return failure(error.cause);
  }
  return toolFailure(
    "session_control_failed",
    error instanceof Error ? error.message : "Session control is unavailable",
  );
};

export const makeWithCapture = (capture: AppToolAuthorityCapture) =>
  Effect.gen(function* () {
    const core = yield* CoreAuthority;
    const admitOperation = yield* makeAppToolOperation;
    const workspace = yield* ProjectWorkspace;
    const application = yield* AgentRuntimeApplication;
    const readState = yield* CodexThreadReadState;
    const native = yield* makeNativeControls;
    const access = yield* makeAuthority;
    return Effect.fn("SessionControlAppTools.execute")(function* (input: AppToolInvocation) {
      if (!input.caller.isActive()) return toolFailure("call_withdrawn");
      const authority = yield* capture(input.caller);
      if (!authority) return toolFailure("authority_unavailable");
      const schema = sessionControlSchemas[input.name as keyof typeof sessionControlSchemas];
      if (!schema) return toolFailure("unknown_tool");
      const parsed = parseAppToolArguments(schema, input.arguments);
      if (!parsed.success) return parsed.result;
      const caller = yield* resolveAppToolCallingSession(input.caller, workspace);
      if (!caller) return toolFailure("session_unavailable");
      const request = parsed.data;
      const sessionId = request.sessionId ?? caller.sessionId;
      const target = {
        sessionId,
        ...("execution" in request && request.execution ? { execution: request.execution } : {}),
      };
      const callerTarget = {
        sessionId: caller.sessionId,
        ...(readHostedAppToolSessionContext(input.caller)
          ? { execution: { threadId: caller.threadId } }
          : {}),
      };
      const operation = yield* admitOperation(input, authority, core.identity.profileId, request);
      if (!operation.success) return operation.result;
      const { operationId } = operation;
      const provenance = toCoreAgentTurnProvenance(core.identity.profileId, authority);
      const execute = Effect.gen(function* () {
        if (input.name === "stop_session" && sessionId === caller.sessionId)
          return toolFailure("cannot_stop_calling_session");
        if (input.name === "set_session_unread") yield* access.authorize(sessionId);
        else yield* access.check(callerTarget, target);
        const source =
          input.name === "set_session_unread" ? null : yield* access.inspect(callerTarget);
        const modeLimit = source
          ? { runtimeMode: source.runtimeMode, interactionMode: source.interactionMode }
          : undefined;
        if (!input.caller.isActive()) return toolFailure("call_withdrawn");
        const perform = Effect.gen(function* () {
          // Revalidate lifecycle and permission facts immediately before crossing the control owner.
          const session =
            input.name === "set_session_unread"
              ? yield* access.authorize(sessionId)
              : (yield* access.check(callerTarget, target)).session;
          const beforeNativeControl = Effect.gen(function* () {
            const { session: current, facts } = yield* access.check(callerTarget, target);
            const ceilingError = source && facts ? sessionMessageCeilingError(source, facts) : null;
            if (ceilingError) return yield* denied(ceilingError);
            if (!input.caller.isActive()) return yield* denied("call_withdrawn");
            if (
              current.session.execution_ref ||
              current.thread?.thread_id !== session.thread?.thread_id ||
              current.thread?.execution_host_id !== session.thread?.execution_host_id
            )
              return yield* denied(
                "session_binding_changed",
                "The Session execution changed before control dispatch",
              );
          });
          if (!input.caller.isActive()) return toolFailure("call_withdrawn");
          if (input.name === "set_session_unread") {
            const args = sessionControlSchemas.set_session_unread.parse(input.arguments);
            if (
              session.thread &&
              !session.session.execution_ref &&
              session.thread.backend_binding.kind === "codex"
            ) {
              const changed = yield* readState.set({
                threadId: session.thread.thread_id,
                hasUnreadTurn: args.unread,
              });
              return toolSuccess({
                operationId,
                sessionId,
                unread: args.unread,
                receipt: { changed },
              });
            }
            const result = yield* workspace.markProjectSessionUnread({
              operationId,
              payload: { sessionId, unread: args.unread },
            });
            return toolSuccess({
              operationId,
              sessionId,
              unread: result.value.unread,
              receipt: result.apply,
            });
          }
          if (input.name === "stop_session") {
            const args = sessionControlSchemas.stop_session.parse(input.arguments);
            const reason = args.reason
              ? `Stopped by another agent: ${args.reason}`
              : "Stopped by another agent";
            const result = session.session.execution_ref
              ? yield* application.stopSession({
                  ...runtimeSessionTarget(target),
                  requestId: operationId,
                  reason,
                  modeLimit,
                })
              : {
                  threadId: session.thread?.thread_id ?? null,
                  stopped: session.thread
                    ? yield* native.stop(
                        session.thread.execution_host_id,
                        session.thread.thread_id,
                        beforeNativeControl,
                      )
                    : false,
                };
            return toolSuccess({
              operationId,
              sessionId,
              threadId: result.threadId,
              status: result.stopped ? "stop_requested" : "idle",
            });
          }
          const args = sessionControlSchemas.session_queue.parse(input.arguments);
          const result = session.session.execution_ref
            ? yield* application.controlSessionQueue({
                ...args,
                ...runtimeSessionTarget(target),
                requestId: operationId,
                modeLimit,
              })
            : session.thread
              ? yield* native.queue(
                  session.thread.execution_host_id,
                  session.thread.thread_id,
                  args,
                  beforeNativeControl,
                )
              : yield* denied("unsupported", "This Session has no queue");
          return toolSuccess({ operationId, sessionId, ...result }, 32 * 1024);
        });
        if ("action" in request && (request.action === "list" || request.action === "read"))
          return yield* perform;
        const fingerprint = createHash("sha256")
          .update(
            stableStringifyBlockPropertyJson({
              tool: input.name,
              request: { ...request, sessionId, operationId },
              callerSessionId: caller.sessionId,
            }),
          )
          .digest("hex");
        const identity = {
          sessionId,
          operationId,
          fingerprint,
          expiresAt: operation.expiresAtMs,
        };
        const previous = yield* application.sessionControlReceipt(identity);
        if (!previous.admitted) {
          if (previous.resultJson !== null)
            return yield* Effect.try(() =>
              CallToolResultSchema.parse(decodeReceipt(previous.resultJson!)),
            );
          return toolFailure(
            "session_operation_unconfirmed",
            "This operation was already admitted. It will not be sent again.",
            { operationId },
          );
        }
        const result = yield* perform.pipe(Effect.catch((error) => Effect.succeed(failure(error))));
        yield* application.sessionControlReceipt({
          ...identity,
          resultJson: encodeReceipt(result),
        });
        return result;
      });
      return yield* execute.pipe(
        Effect.provideService(CoreApplicationAgent, provenance),
        Effect.catch((error) => Effect.succeed(failure(error))),
      );
    });
  });
export const make = Effect.gen(function* () {
  const turns = yield* CodexTurnAuthority;
  return yield* makeWithCapture((caller) => captureAppToolAuthority(caller, turns));
});
