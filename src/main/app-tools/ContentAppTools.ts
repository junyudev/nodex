import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import { nodexAgentAuthorityFingerprint } from "../../shared/nodex-agent-authority";
import { isContentTool } from "../../shared/nodex-app-tools/content-catalog";
import { NODEX_AGENT_V6_TOOL_CONTRACTS } from "../../shared/nodex-agent-tools/v6-contracts";
import { CodexTurnAuthority } from "../codex-application/CodexTurnAuthority";
import { createStableOperationId } from "../core-runtime/operation-identity";
import { executeNodexAgentV3Tool } from "../nodex-agent-application/NodexAgentDynamicExecution";
import { NodexAgentApplication } from "../nodex-agent-application/NodexAgentApplication";
import { NodexAgentDynamicToolFailure } from "../nodex-agent-application/NodexAgentDynamicPolicy";
import type { AppToolInvocation } from "./AppToolInvocationInbox";
import { NodexAppToolAuthority } from "./NodexAppToolAuthority";
import { toolFailure, toolSuccess } from "./app-tool-result";

export const make = Effect.gen(function* () {
  const turns = yield* CodexTurnAuthority;
  const authorities = yield* NodexAppToolAuthority;
  const application = yield* NodexAgentApplication;
  return Effect.fn("ContentAppTools.execute")(function* (input: AppToolInvocation) {
    if (!isContentTool(input.name)) return toolFailure("unknown_tool");
    const contract = NODEX_AGENT_V6_TOOL_CONTRACTS[input.name];
    const parsed = contract.inputSchema.safeParse(input.arguments);
    if (!parsed.success) return toolFailure("invalid_arguments");
    if (!input.caller.isActive()) return toolFailure("call_withdrawn");
    const capture = turns
      .capture(input.caller.threadId, input.caller.turnId)
      .pipe(Effect.catch(() => Effect.succeed(null)));
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
      callId: input.caller.callId,
      presentation: null,
      isCurrent,
    });
    if (!bound.authority) return toolFailure("authority_unavailable");
    const operationId = createStableOperationId(`app.${input.name}`, authority.frozenAtMs, [
      input.caller.threadId,
      input.caller.turnId,
      input.caller.callId,
    ]);
    return yield* executeNodexAgentV3Tool(input.name, parsed.data, {
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
