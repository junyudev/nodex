import type { QueuedSubmission, UserInput } from "@nodex/codex-app-server-protocol/v2";
import type { ClientRequestResponsesByMethod } from "@nodex/effect-codex-app-server/rpc";
import { current, isDraft, type Draft } from "immer";
import type { CodexCanonicalConversationState } from "./codex-conversation-state/codex-conversation-state";
import type { CodexCanonicalTurnState } from "./codex-conversation-state/codex-conversation-state";
import {
  conversationTurnDraft,
  residentConversationTurnEntries,
} from "./codex-conversation-state/codex-turn-mutation";

export function equalCodexQueueValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((entry, index) => equalCodexQueueValue(entry, right[index]));
  }
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  if (leftEntries.length !== rightEntries.length) return false;
  const rightRecord = right as Readonly<Record<string, unknown>>;
  return leftEntries.every(
    ([key, value]) =>
      Object.prototype.hasOwnProperty.call(rightRecord, key) &&
      equalCodexQueueValue(value, rightRecord[key]),
  );
}

function normalizeNativeInput(
  input: ClientRequestResponsesByMethod["thread/queue/list"]["data"][number]["input"][number],
): UserInput {
  if (input.type === "text")
    return {
      type: "text",
      text: input.text,
      text_elements: (input.text_elements ?? []).map((element) => ({
        byteRange: { ...element.byteRange },
        placeholder: element.placeholder ?? null,
      })),
    };
  if (input.type === "image") {
    const detail = input.detail == null ? {} : { detail: input.detail };
    if (typeof input.url === "string") return { type: "image", url: input.url, ...detail };
    if (typeof input.fileId === "string") return { type: "image", fileId: input.fileId, ...detail };
    throw new Error("Invalid queued image input");
  }
  if (input.type === "localImage")
    return {
      type: "localImage",
      path: input.path,
      ...(input.detail == null ? {} : { detail: input.detail }),
    };
  return { ...input };
}

/** Main admissions and renderer projections compare the same normalized native value. */
export function normalizeCodexNativeQueuedSubmission(input: {
  readonly id: string;
  readonly clientUserMessageId: string;
  readonly input: ReadonlyArray<
    ClientRequestResponsesByMethod["thread/queue/list"]["data"][number]["input"][number]
  >;
}): QueuedSubmission {
  return {
    id: input.id,
    clientUserMessageId: input.clientUserMessageId,
    input: input.input.map(normalizeNativeInput),
  };
}

/** Only the executing owner calls this after a native acceptance, before queue-only cleanup. */
export function appendCodexAcceptedServerQueueSubmission(
  draft: Draft<CodexCanonicalConversationState>,
  submission: QueuedSubmission,
): void {
  if (
    draft.unconfirmedServerQueueMessages?.some((current) =>
      equalCodexQueueValue(current, submission),
    )
  )
    return;
  const snapshot = isDraft(submission) ? current(submission) : submission;
  draft.unconfirmedServerQueueMessages = [
    ...(draft.unconfirmedServerQueueMessages ?? []),
    structuredClone(snapshot),
  ];
}

/** Hydration callers pass only the turns they just restored, never the whole transcript. */
export function collectCodexAcceptedServerQueueSubmissions(
  turns: readonly CodexCanonicalTurnState[],
): readonly QueuedSubmission[] {
  return turns.flatMap((turn) =>
    turn.items.flatMap((item) => {
      if (
        item.type !== "steeringUserMessage" ||
        item.status !== "accepted" ||
        (item.serverUserMessageId != null &&
          turn.completedItemIds?.[item.serverUserMessageId] === false) ||
        !item.serverQueuedSubmission ||
        item.clientUserMessageId !== item.serverQueuedSubmission.clientUserMessageId ||
        !equalCodexQueueValue(item.input, item.serverQueuedSubmission.input) ||
        !equalCodexQueueValue(item.acceptedInput, item.serverQueuedSubmission.input)
      )
        return [];
      return [item.serverQueuedSubmission];
    }),
  );
}

/** Queue cleanup also retires its pending correlation so a late echo cannot resurrect it. */
export function discardCodexAcceptedServerQueueSubmission(
  draft: Draft<CodexCanonicalConversationState>,
  submission: QueuedSubmission,
): void {
  draft.unconfirmedServerQueueMessages = (draft.unconfirmedServerQueueMessages ?? []).filter(
    (item) => !equalCodexQueueValue(item, submission),
  );
  if (!draft.unconfirmedServerQueueMessages.length) delete draft.unconfirmedServerQueueMessages;
  // This is a cleanup event, not a projection or streaming notification walk.
  for (const { address } of residentConversationTurnEntries(draft)) {
    const turn = conversationTurnDraft(draft, address);
    if (!turn) continue;
    for (const item of turn.items) {
      if (
        item.type === "steeringUserMessage" &&
        equalCodexQueueValue(item.serverQueuedSubmission, submission)
      )
        delete item.serverQueuedSubmission;
    }
  }
}
