import type { UserInput } from "@nodex/codex-app-server-protocol/v2";
import * as Effect from "effect/Effect";
import {
  parseCodexDelegationText,
  parseCodexRealtimeDelegationText,
} from "../../shared/codex-delegation";
import type { CoreModules } from "../core-runtime/CoreModules";
import { recordAcceptedUserMessage } from "../project-application/SessionMessageReminder";
import { readCodexLinkedRootSession } from "./CodexLinkedRootSession";

/** Native acknowledgements and live observations share one sender-aware acceptance boundary. */
export const recordAcceptedNativeUserMessage = Effect.fn("CodexSessionMessageReminders.accept")(
  function* (
    core: CoreModules["Service"],
    input: {
      readonly hostId: string;
      readonly threadId: string;
      readonly messageId: string;
      readonly content: readonly UserInput[];
      readonly toolOutput?: unknown;
      readonly turnTrigger?: string | null;
    },
  ) {
    if (
      input.toolOutput != null ||
      (input.turnTrigger && input.turnTrigger !== "edit_user_message")
    )
      return;
    if (
      input.content.some(
        (part) =>
          part.type === "text" &&
          (parseCodexDelegationText(part.text) || parseCodexRealtimeDelegationText(part.text)),
      )
    )
      return;
    const session = yield* readCodexLinkedRootSession(core, {
      hostId: input.hostId,
      threadId: input.threadId,
    });
    if (!session) return;
    yield* recordAcceptedUserMessage(core, session.id, input.messageId);
  },
);
