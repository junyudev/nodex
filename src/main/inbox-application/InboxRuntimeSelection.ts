import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import type { AgentRuntimeLaunch } from "../../shared/agent-runtime-api";
import { resolveInboxModel as resolveFromCatalog, type InboxChatAgent } from "../../shared/inbox";
import type { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import { InboxRuntimeError } from "./InboxRuntimeError";

/** Explicit Inbox work waits for the configured Runtime's bounded model metadata. */
export const resolveInboxModel = Effect.fn("InboxRuntimeSelection.resolve")(function* (
  runtime: Pick<AgentRuntimeApplication["Service"], "catalog">,
  choice: InboxChatAgent,
  purpose: "chat" | "suggestion" = "chat",
): Effect.fn.Return<AgentRuntimeLaunch["modelSelection"], InboxRuntimeError> {
  if (!choice.instanceId)
    return yield* new InboxRuntimeError({ message: "The Agent is not configured" });
  const read = Effect.gen(function* () {
    const resolution = resolveFromCatalog(yield* runtime.catalog(), choice, purpose);
    if (resolution.kind === "unavailable")
      return yield* new InboxRuntimeError({ message: resolution.message });
    return resolution.kind === "ready" ? resolution.selection : null;
  });
  const cached = yield* read.pipe(
    Effect.mapError((error) => new InboxRuntimeError({ message: error.message })),
  );
  if (cached) return cached;
  yield* runtime
    .catalog({ refresh: true })
    .pipe(Effect.mapError((error) => new InboxRuntimeError({ message: error.message })));
  const selection = yield* read.pipe(
    Effect.mapError((error) => new InboxRuntimeError({ message: error.message })),
    Effect.repeat({
      times: 75,
      schedule: Schedule.spaced("200 millis"),
      until: (value) => value !== null,
    }),
  );
  if (!selection)
    return yield* new InboxRuntimeError({
      message: "The Agent model catalog did not become ready",
    });
  return selection;
});
