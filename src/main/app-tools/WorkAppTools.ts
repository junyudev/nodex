import * as Effect from "effect/Effect";
import type { NodexAgentTurnContext } from "../../shared/nodex-agent-authority";
import { CodexTurnAuthority } from "../codex-application/CodexTurnAuthority";
import { toCoreAgentTurnProvenance } from "../core-client/core-agent-execution-authorization";
import { CoreModuleResponseError } from "../core-client/core-client";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { CoreModules } from "../core-runtime/CoreModules";
import { make as makeAppToolOperation } from "./AppToolOperation";
import { captureAppToolAuthority, type AppToolCaller } from "./AppToolCaller";
import type { AppToolInvocation } from "./AppToolInvocationInbox";
import { parseAppToolArguments, toolFailure, toolSuccess } from "./app-tool-result";


/** Appends with the captured execution provenance; Core atomically records the report and its work event. */
export const makeWithCapture = (
  captureCaller: (caller: AppToolCaller) => Effect.Effect<NodexAgentTurnContext | null>,
) =>
  Effect.gen(function* () {
    const admitOperation = yield* makeAppToolOperation;
    const identity = yield* CoreAuthority;
    const core = yield* CoreModules;

    return Effect.fn("WorkAppTools.execute")(function* (input: AppToolInvocation) {
      const parsed = parseAppToolArguments(reportWorkSchema, input.arguments);
      if (!parsed.success) return parsed.result;
      if (!operation.success) return operation.result;
      const { operationId } = operation;
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
