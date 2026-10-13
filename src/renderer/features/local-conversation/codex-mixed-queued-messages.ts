import type { CodexQueuedMessage } from "../../../shared/codex-queued-message";
import { requiresUntrustedAppInputConfirmation } from "../../../shared/codex-untrusted-app-input";

export interface CodexQueuedMessageDelivery {
  readonly owner: "local" | "server";
  readonly message: CodexQueuedMessage;
  readonly clientUserMessageId: string;
}

/** Native order and the captured local queue keep independent delivery authorities. */
export function readMixedCodexQueuedMessages(input: {
  readonly local: readonly CodexQueuedMessage[] | undefined;
  readonly server: readonly CodexQueuedMessage[] | undefined;
  readonly serverEnabled: boolean;
  readonly findServerByClientId: (id: string) => string | undefined;
  readonly readServerClientId: (id: string) => string | undefined;
}): readonly CodexQueuedMessageDelivery[] | undefined {
  const local = input.local?.map((message) => ({
    owner: "local" as const,
    message,
    clientUserMessageId: message.id,
  }));
  if (!input.serverEnabled) return local;
  if (input.server === undefined && !local?.length) return undefined;
  const represented = new Set(
    input.local?.map((message) => input.findServerByClientId(message.id)),
  );
  const server = (input.server ?? []).flatMap((message) =>
    represented.has(message.id)
      ? []
      : [
          {
            owner: "server" as const,
            message,
            clientUserMessageId: input.readServerClientId(message.id) ?? message.id,
          },
        ],
  );
  return [...server, ...(local ?? [])];
}

/** A captured ordinary local head must reach delivery before adding more native work. */
export function hasPendingOrdinaryLocalQueuedMessage(
  messages: readonly CodexQueuedMessage[],
): boolean {
  return messages.some((message) => {
    if (requiresUntrustedAppInputConfirmation(message.context)) return false;
    const submission = message.submission;
    return (
      submission == null ||
      (typeof submission === "object" && Reflect.get(submission, "status") === "queued")
    );
  });
}
