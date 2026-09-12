import { createSteerTurnInactiveError, normalizeSteerTurnError } from "../codex-steer-errors";
import type { Draft } from "immer";
import type {
  TurnStartParams,
  TurnSteerParams,
  TurnSteerResponse,
} from "@nodex/codex-app-server-protocol/v2";
import type {
  CodexCanonicalConversationState,
  CodexCanonicalSteeringRestoreMessage,
} from "./codex-conversation-state";
import {
  clearCodexUnconfirmedTurnSubmission,
  recordCodexUnconfirmedTurnSubmission,
  type CodexTurnDelivery,
} from "./codex-turn-delivery";
import { conversationTurnDraft, residentConversationTurnEntries } from "./codex-turn-mutation";
import { latestConversationTurn } from "./codex-turn-selectors";
import { buildCodexSteeringCompareKey } from "./codex-steering-compare";

export type CanonicalSteerNativeRequest =
  | { method: "turn/steer"; params: TurnSteerParams }
  | { method: "turn/start"; params: TurnStartParams };
export interface CanonicalOwnerSteerClient {
  read(): CodexCanonicalConversationState | null;
  update(recipe: (state: Draft<CodexCanonicalConversationState>) => void): void;
  subscribe(callback: () => void): Disposable;
  onDispose(callback: () => void): Disposable;
  createId(): string;
  sendNative(
    request: CanonicalSteerNativeRequest,
    options: { timeoutMs: number; onOutcomeUnknown(delivery: CodexTurnDelivery): void },
  ): Promise<TurnSteerResponse>;
  outcomeUnknown(error: unknown): CodexTurnDelivery | null;
  mismatchTurnId(error: unknown): string | null;
  readonly isLocalHost: boolean;
  emitSteered(): void;
}
export interface CanonicalOwnerSteerInput {
  readonly conversationId: string;
  readonly input: TurnSteerParams["input"];
  readonly restoreMessage: CodexCanonicalSteeringRestoreMessage;
  readonly attachments?: readonly unknown[];
  readonly clientUserMessageId: string;
  readonly additionalContext?: TurnSteerParams["additionalContext"];
  readonly serviceTier?: TurnStartParams["serviceTier"];
  readonly toolOutput?: TurnStartParams["toolOutput"];
  readonly onMessageAdded?: () => Promise<void>;
}
const activeTurnEntry = (state: CodexCanonicalConversationState | null) => {
  const turn = latestConversationTurn(state);
  return turn
    ? residentConversationTurnEntries(state).findLast((entry) => entry.turn === turn)
    : undefined;
};
const activeTurn = latestConversationTurn;
function waitForActiveTurnId(
  client: CanonicalOwnerSteerClient,
  conversationId: string,
): Promise<string> {
  const current = activeTurn(client.read());
  if (current?.status !== "inProgress")
    return Promise.reject(createSteerTurnInactiveError(conversationId));
  if (current.turnId != null) return Promise.resolve(current.turnId);
  return new Promise((resolve, reject) => {
    let subscription: Disposable | undefined;
    let disposal: Disposable | undefined;
    let settled = false;
    const finish = (error: Error | null, turnId?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      subscription?.[Symbol.dispose]();
      disposal?.[Symbol.dispose]();
      if (error) reject(error);
      else resolve(turnId!);
    };
    const timer = setTimeout(
      () => finish(new Error("Cannot steer without an active turn id")),
      30_000,
    );
    const check = () => {
      if (settled) return;
      try {
        const turn = activeTurn(client.read());
        if (turn?.status !== "inProgress")
          return finish(createSteerTurnInactiveError(conversationId));
        if (turn.turnId != null) finish(null, turn.turnId);
      } catch (cause) {
        finish(
          cause instanceof Error ? cause : new Error("Conversation is unavailable", { cause }),
        );
      }
    };
    disposal = client.onDispose(() => finish(new Error("Conversation manager disposed")));
    if (settled) {
      disposal[Symbol.dispose]();
      return;
    }
    subscription = client.subscribe(check);
    if (settled) subscription[Symbol.dispose]();
    else check();
  });
}
/** Runs only at the current stream owner; the caller handles peer routing and authorization. */
export async function runCanonicalOwnerSteer(
  client: CanonicalOwnerSteerClient,
  input: CanonicalOwnerSteerInput,
): Promise<TurnSteerResponse> {
  const state = client.read();
  if (state?.unconfirmedTurnSubmissions?.length)
    throw new Error("An earlier turn submission is not yet confirmed");
  const turn = activeTurn(state);
  if (!state || turn?.status !== "inProgress")
    throw createSteerTurnInactiveError(input.conversationId);
  const id = client.createId();
  let unknownRequestId: CodexTurnDelivery["requestId"] | null = null;
  const visit = (
    recipe: (
      item: Draft<import("./codex-conversation-state").CodexCanonicalSteeringUserMessageItem>,
    ) => void,
  ) =>
    client.update((draft) => {
      for (const entry of residentConversationTurnEntries(draft)) {
        const item = conversationTurnDraft(draft, entry.address)?.items.find(
          (item) => item.id === id,
        );
        if (item?.type === "steeringUserMessage") recipe(item);
      }
    });
  const clearUnknown = () =>
    client.update((draft) => {
      clearCodexUnconfirmedTurnSubmission(draft, unknownRequestId);
    });
  const recordUnknown = (delivery: CodexTurnDelivery) =>
    client.update((draft) => {
      unknownRequestId = delivery.requestId;
      recordCodexUnconfirmedTurnSubmission(draft, delivery, input.clientUserMessageId);
    });
  client.update((draft) => {
    const entry = activeTurnEntry(draft);
    if (!entry || input.toolOutput != null) return;
    const current = conversationTurnDraft(draft, entry.address)!;
    if (current.status !== "inProgress") return;
    current.items.push({
      type: "steeringUserMessage",
      id,
      status: "pending",
      targetTurnId: turn.turnId,
      targetTurnStartedAtMs: turn.turnStartedAtMs,
      serverUserMessageId: null,
      clientUserMessageId: input.clientUserMessageId,
      input: input.input,
      attachments: [...(input.attachments ?? [])],
      restoreMessage: input.restoreMessage,
      compareKey: buildCodexSteeringCompareKey(
        input.input,
        input.restoreMessage.context.commentAttachments,
      ),
    } as Draft<import("./codex-conversation-state").CodexCanonicalSteeringUserMessageItem>);
  });
  try {
    await input.onMessageAdded?.();
    const turnId = await waitForActiveTurnId(client, input.conversationId);
    visit((item) => {
      item.targetTurnId = turnId;
    });
    const send = (expectedTurnId: string) => {
      const metadata = {
        ...input.restoreMessage.responsesapiClientMetadata,
        workspace_kind: state.workspaceKind ?? "project",
      };
      const request: CanonicalSteerNativeRequest =
        input.toolOutput == null
          ? {
              method: "turn/steer",
              params: {
                threadId: input.conversationId,
                input: input.input,
                expectedTurnId,
                clientUserMessageId: input.clientUserMessageId,
                ...(input.additionalContext !== undefined
                  ? { additionalContext: input.additionalContext }
                  : {}),
                responsesapiClientMetadata: metadata,
              },
            }
          : {
              method: "turn/start",
              params: {
                threadId: input.conversationId,
                input: [],
                toolOutput: input.toolOutput,
                ...(input.additionalContext !== undefined
                  ? { additionalContext: input.additionalContext }
                  : {}),
                responsesapiClientMetadata: metadata,
              },
            };
      return client.sendNative(request, { timeoutMs: 30_000, onOutcomeUnknown: recordUnknown });
    };
    let result: TurnSteerResponse;
    try {
      result = await send(turnId);
    } catch (error) {
      if (client.outcomeUnknown(error)) throw error;
      const actualTurnId = client.mismatchTurnId(error);
      if (!actualTurnId) throw error;
      clearUnknown();
      unknownRequestId = null;
      let changed = false;
      client.update((draft) => {
        const entry = activeTurnEntry(draft);
        if (!entry) return;
        const current = conversationTurnDraft(draft, entry.address)!;
        if (
          current.status !== "inProgress" ||
          (current.turnId != null &&
            /^(.*)-berry-display-\d+$/.exec(current.turnId)?.[1] === actualTurnId)
        )
          return;
        current.turnId = actualTurnId;
        changed = true;
      });
      if (changed)
        visit((item) => {
          item.targetTurnId = actualTurnId;
        });
      result = await send(actualTurnId);
    }
    if (client.isLocalHost)
      visit((item) => {
        item.status = "accepted";
      });
    client.emitSteered();
    clearUnknown();
    return result;
  } catch (error) {
    const delivery = client.outcomeUnknown(error);
    if (delivery) {
      recordUnknown(delivery);
      throw error;
    }
    clearUnknown();
    client.update((draft) => {
      for (const entry of residentConversationTurnEntries(draft)) {
        const current = conversationTurnDraft(draft, entry.address)!;
        current.items = current.items.filter((item) => item.id !== id);
      }
    });
    throw normalizeSteerTurnError(error, input.conversationId);
  }
}
