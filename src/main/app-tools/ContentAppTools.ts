import { captureAppToolAuthority } from "./AppToolCaller";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import { nodexAgentAuthorityFingerprint } from "../../shared/nodex-agent-authority";
import {
  appContentToolContracts,
  isContentTool,
} from "../../shared/nodex-app-tools/content-catalog";
import { CodexTurnAuthority } from "../codex-application/CodexTurnAuthority";
import { createStableOperationId } from "../core-runtime/operation-identity";
import { executeNodexAgentV3Tool } from "../nodex-agent-application/NodexAgentDynamicExecution";
import { NodexAgentApplication } from "../nodex-agent-application/NodexAgentApplication";
import { NodexAgentDynamicToolFailure } from "../nodex-agent-application/NodexAgentDynamicExecutionContext";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { make as makeAppToolOperation } from "./AppToolOperation";
import type { AppToolInvocation } from "./AppToolInvocationInbox";
import { NodexAppToolAuthority } from "./NodexAppToolAuthority";
import { parseAppToolArguments, toolFailure, toolSuccess } from "./app-tool-result";
import type { AppToolCaller } from "./AppToolCaller";
import type { NodexAgentTurnContext } from "../../shared/nodex-agent-authority";

export const makeWithCapture = (
  captureCaller: (caller: AppToolCaller) => Effect.Effect<NodexAgentTurnContext | null>,
) =>
  Effect.gen(function* () {
    const authorities = yield* NodexAppToolAuthority;
    const application = yield* NodexAgentApplication;
    const core = yield* CoreAuthority;
    const admit = yield* makeAppToolOperation;
    return Effect.fn("ContentAppTools.execute")(function* (input: AppToolInvocation) {
      if (!isContentTool(input.name)) return toolFailure("unknown_tool");
      const contract = appContentToolContracts[input.name];
      const parsed = parseAppToolArguments(contract.inputSchema, input.arguments);
      if (!parsed.success) return parsed.result;
      if (!input.caller.isActive()) return toolFailure("call_withdrawn");
      const capture = captureCaller(input.caller);
      const authority = yield* capture;
      if (!authority) return toolFailure("authority_unavailable");
      const fingerprint = nodexAgentAuthorityFingerprint(authority);
      const isCurrent = Effect.gen(function* () {
        if (!input.caller.isActive()) return false;
        const current = yield* capture;
        return (
          current !== null &&
          nodexAgentAuthorityFingerprint(current) === fingerprint &&
          input.caller.isActive()
        );
      });
      const bound = yield* authorities.bind({
        authority,

        isCurrent,
      });
      if (!bound.authority) return toolFailure("authority_unavailable");
      const { idempotencyKey, ...args } = parsed.data as Record<string, unknown>;
      let operationId = createStableOperationId(`app.${input.name}`, authority.admittedAtMs, [
        input.caller.threadId,
        input.caller.turnId,
        input.caller.callId,
      ]);
      if (typeof idempotencyKey === "string") {
        const operation = yield* admit(input, authority, core.identity.profileId, {
          ...args,
          idempotencyKey,
        });
        if (!operation.success) return operation.result;
        if (!(yield* isCurrent)) return toolFailure("call_withdrawn");
        operationId = operation.operationId;
      }
      return yield* executeNodexAgentV3Tool(input.name, args, {
        ...bound,
        threadId: input.caller.threadId,
        callId: input.caller.callId,
        operationId,
      }).pipe(
        Effect.provideService(NodexAgentApplication, application),
        Effect.map((output) => {
          const validated = contract.outputSchema.safeParse(output);
          if (!validated.success) return toolFailure("invalid_result", undefined, { operationId });
          if (!input.caller.isActive())
            return toolFailure("call_withdrawn", undefined, { operationId });
          return toolSuccess(validated.data);
        }),
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
          const error = Cause.squash(cause);
          return Effect.succeed(
            error instanceof NodexAgentDynamicToolFailure
              ? toolFailure(error.failure.error.code, error.failure.error.message, {
                  ...error.failure.error,
                  operationId,
                })
              : toolFailure("content_command_failed", undefined, { operationId }),
          );
        }),
      );
    });
  });

export const make = Effect.gen(function* () {
  const turns = yield* CodexTurnAuthority;
  return yield* makeWithCapture((caller) => captureAppToolAuthority(caller, turns));
});
