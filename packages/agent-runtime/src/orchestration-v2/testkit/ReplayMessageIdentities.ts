import type { OrchestrationV2Command, ProviderReplayTranscript } from "@t3tools/contracts";
import * as Predicate from "effect/Predicate";

/** Binds older recordings to the exact authored messages the fixture will dispatch. */
export function materializeReplayMessageIdentities(
  transcript: ProviderReplayTranscript,
  commands: readonly OrchestrationV2Command[],
): ProviderReplayTranscript {
  if (transcript.provider !== "codex") return transcript;
  const steerMessageIds = commands.flatMap((command) =>
    command.type === "message.dispatch" && command.dispatchMode?.type === "steer_active"
      ? [command.messageId]
      : [],
  );
  let steerIndex = 0;
  return {
    ...transcript,
    entries: transcript.entries.map((entry) => {
      if (entry.type !== "expect_outbound" || !Predicate.isObject(entry.frame)) return entry;
      const frame = entry.frame;
      if (frame.method !== "turn/steer" || !Predicate.isObject(frame.params)) return entry;
      const messageId = steerMessageIds[steerIndex++];
      if (frame.params.clientUserMessageId !== undefined) return entry;
      if (messageId === undefined)
        throw new Error("Recorded Codex steer has no authored fixture message identity");
      return {
        ...entry,
        frame: { ...frame, params: { ...frame.params, clientUserMessageId: messageId } },
      };
    }),
  };
}
