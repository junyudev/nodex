import * as Effect from "effect/Effect";
import type { NodexAgentTurnContext } from "../../shared/nodex-agent-authority";
import { reportWorkSchema, startWorkSchema } from "../../shared/nodex-app-tools/work-schema";
import { CodexTurnAuthority } from "../codex-application/CodexTurnAuthority";
import { toCoreAgentTurnProvenance } from "../core-client/core-agent-execution-authorization";
import { CoreModuleResponseError } from "../core-client/core-client";
import { CoreApplicationAgent } from "../core-runtime/CoreApplicationAgent";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { CoreModules } from "../core-runtime/CoreModules";
import { make as makeAppToolOperation } from "./AppToolOperation";
import { captureAppToolAuthority, type AppToolCaller } from "./AppToolCaller";
import type { AppToolInvocation } from "./AppToolInvocationInbox";
import { parseAppToolArguments, toolFailure, toolSuccess } from "./app-tool-result";

/** Core's refusal tells the Agent what to do instead; other failures keep a stable code. */
const coreFailure =
  (fallback: { readonly code: string; readonly message: string }) =>
  (error: { readonly cause?: unknown }) =>
    error.cause instanceof CoreModuleResponseError
      ? { code: error.cause.coreError.code, message: error.cause.coreError.message }
      : fallback;
const reportFailure = coreFailure({
  code: "report_unavailable",
  message: "The work report could not be recorded",
});

/** Appends with the captured execution provenance; Core atomically records the report and its work event. */
export const makeWithCapture = (
  captureCaller: (caller: AppToolCaller) => Effect.Effect<NodexAgentTurnContext | null>,
) =>
  Effect.gen(function* () {
    const admitOperation = yield* makeAppToolOperation;
    const identity = yield* CoreAuthority;
    const core = yield* CoreModules;
    const work = yield* WorkApplication;

    const admit = Effect.fn("WorkAppTools.admit")(function* (
      input: AppToolInvocation,
      args: Record<string, unknown>,
    ) {
      if (!input.caller.isActive())
        return { success: false as const, result: toolFailure("call_withdrawn") };
      const authority = yield* captureCaller(input.caller);
      if (!input.caller.isActive())
        return { success: false as const, result: toolFailure("call_withdrawn") };
      if (!authority)
        return { success: false as const, result: toolFailure("authority_unavailable") };
      const admitted = yield* admitOperation(input, authority, identity.identity.profileId, args);
      if (!admitted.success) return admitted;
      return { ...admitted, authority };
    });
    const start = Effect.fn("WorkAppTools.start")(function* (input: AppToolInvocation) {
      const parsed = parseAppToolArguments(startWorkSchema, input.arguments);
      if (!parsed.success) return parsed.result;
      const operation = yield* admit(input, parsed.data);
      if (!operation.success) return operation.result;
      // The start is the calling Agent's own command; Core attributes it and checks its consent.
      const result = yield* work
        .startWork({
          operationId: operation.operationId,
          pageId: parsed.data.pageId,
          ...(parsed.data.agent
            ? { selection: { ...parsed.data.agent, effort: parsed.data.agent.effort ?? null } }
            : {}),
        })
        .pipe(
          Effect.provideService(
            CoreApplicationAgent,
            toCoreAgentTurnProvenance(identity.identity.profileId, operation.authority),
          ),
          Effect.map((value) => ({ ok: true as const, value })),
          Effect.catch((error) =>
            Effect.succeed({
              ok: false as const,
              failure: coreFailure({ code: "start_unavailable", message: error.message })(error),
            }),
          ),
        );
      if (!result.ok)
        return toolFailure(result.failure.code, result.failure.message, {
          operationId: operation.operationId,
        });
      if (!input.caller.isActive()) return toolFailure("call_withdrawn");
      return toolSuccess({
        operationId: operation.operationId,
        recorded: true,
        ...result.value.value,
      });
    });
    return Effect.fn("WorkAppTools.execute")(function* (input: AppToolInvocation) {
      if (input.name === "start_work") return yield* start(input);
      const parsed = parseAppToolArguments(reportWorkSchema, input.arguments);
      if (!parsed.success) return parsed.result;
      const operation = yield* admit(input, parsed.data);
      if (!operation.success) return operation.result;
      const { operationId } = operation;
      const provenance = toCoreAgentTurnProvenance(
        identity.identity.profileId,
        operation.authority,
      );
      const sent = yield* core.workspace
        .apply(
          {
            operationId,
            intent: {
              kind: "agent_command",
              provenance,
              intent: {
                kind: "report_page_work",
                page_id: parsed.data.pageId ?? null,
                outcome: parsed.data.outcome,
                summary: parsed.data.summary,
              },
            },
          },
          undefined,
          provenance.authority.actor_project_id,
        )
        .pipe(
          Effect.map((applied) => ({ ok: true as const, replay: applied.receipt.duplicate })),
          Effect.catch((error) =>
            Effect.succeed({ ok: false as const, failure: reportFailure(error) }),
          ),
        );
      if (!sent.ok) return toolFailure(sent.failure.code, sent.failure.message, { operationId });
      if (!input.caller.isActive()) return toolFailure("call_withdrawn");
      return toolSuccess({ operationId, recorded: true, ...(sent.replay ? { replay: true } : {}) });
    });
  });

export const make = Effect.gen(function* () {
  const turns = yield* CodexTurnAuthority;
  return yield* makeWithCapture((caller) => captureAppToolAuthority(caller, turns));
});
