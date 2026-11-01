import * as Effect from "effect/Effect";
import type { CoreModules } from "../core-runtime/CoreModules";
import { CoreApplicationAgent } from "../core-runtime/CoreApplicationAgent";
import { createOperationId } from "../core-runtime/operation-identity";

/** Core deduplicates accepted message identities, including retries after an execution restart. */
export const recordAcceptedUserMessage = (
  core: CoreModules["Service"],
  sessionId: string,
  messageId: string,
) =>
  core.workspace
    .apply({
      operationId: createOperationId("session.user-message"),
      intent: {
        kind: "mutate_session",
        session_id: sessionId,
        intent: { kind: "record_user_message", message_id: messageId },
      },
    })
    .pipe(Effect.provideService(CoreApplicationAgent, null), Effect.asVoid);
