import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { AgentAcpFailure } from "@nodex/agent-runtime/contracts";
import type { AgentRuntimeApplication } from "./AgentRuntimeApplication";

export class AgentManagementError extends Schema.TaggedError<AgentManagementError>()(
  "AgentManagementError",
  {
    message: Schema.String,
    reason: Schema.optional(
      Schema.Literals(["disabled", "operation_expired", "invalid_request", "busy"]),
    ),
  },
) {}

export const makeAgentManagementFailurePresenter =
  (application: Pick<AgentRuntimeApplication["Service"], "sessionsForThreads">) =>
  (failure: AgentAcpFailure) =>
    !failure.affectedThreadIds?.length
      ? Effect.succeed(failure)
      : application.sessionsForThreads(failure.affectedThreadIds).pipe(
          Effect.map((affectedSessions) => ({
            ...failure,
            ...(affectedSessions.length ? { affectedSessions } : {}),
          })),
          Effect.catch(() => Effect.succeed(failure)),
        );
