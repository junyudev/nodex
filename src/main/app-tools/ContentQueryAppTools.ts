import { captureAppToolAuthority } from "./AppToolCaller";
import * as Effect from "effect/Effect";
import {
  describeContentSchemaInput,
  sqlQuerySchema,
} from "../../shared/nodex-app-tools/query-schemas";
import { CodexTurnAuthority } from "../codex-application/CodexTurnAuthority";
import { CoreModuleResponseError } from "../core-client/core-client";
import { toCoreAgentTurnProvenance } from "../core-client/core-agent-execution-authorization";
import type { QueryRead } from "../core-client/types";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { CoreModules } from "../core-runtime/CoreModules";
import type { AppToolInvocation } from "./AppToolInvocationInbox";
import { toolFailure, toolSuccess } from "./app-tool-result";
import type { AppToolCaller } from "./AppToolCaller";
import type { NodexAgentTurnContext } from "../../shared/nodex-agent-authority";

export const makeWithCapture = (
  captureCaller: (caller: AppToolCaller) => Effect.Effect<NodexAgentTurnContext | null>,
) =>
  Effect.gen(function* () {
    const identity = yield* CoreAuthority;
    const core = yield* CoreModules;
    return Effect.fn("ContentQueryAppTools.execute")(function* (input: AppToolInvocation) {
      if (!input.caller.isActive()) return toolFailure("call_withdrawn");
      const authority = yield* captureCaller(input.caller);
      if (!authority) return toolFailure("authority_unavailable");
      const provenance = toCoreAgentTurnProvenance(identity.identity.profileId, authority);
      let read: QueryRead;
      if (input.name === "query_content") {
        const parsed = sqlQuerySchema.safeParse(input.arguments);
        if (!parsed.success) return toolFailure("invalid_arguments");
        read = { kind: "agent_query", provenance, query: parsed.data };
      } else {
        const parsed = describeContentSchemaInput.safeParse(input.arguments);
        if (!parsed.success) return toolFailure("invalid_arguments");
        read = {
          kind: "agent_schema",
          provenance,
          scope: parsed.data.scope,
          relation: parsed.data.relation ?? null,
        };
      }
      if (!input.caller.isActive()) return toolFailure("call_withdrawn");
      // SQL bindings and predicates select content; Session ownership is provenance.
      return yield* core.query.read(read, null, { deadlineMs: 20_000 }).pipe(
        Effect.map((snapshot) =>
          input.caller.isActive()
            ? toolSuccess({
                profileId: identity.identity.profileId,
                ...snapshot.value.value,
              })
            : toolFailure("call_withdrawn"),
        ),
        Effect.catch((error) =>
          Effect.succeed(
            error.cause instanceof CoreModuleResponseError
              ? toolFailure(error.cause.coreError.code, error.cause.coreError.message)
              : toolFailure("query_unavailable"),
          ),
        ),
      );
    });
  });

export const make = Effect.gen(function* () {
  const turns = yield* CodexTurnAuthority;
  return yield* makeWithCapture((caller) => captureAppToolAuthority(caller, turns));
});
