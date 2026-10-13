import type { QueuedSubmission, UserInput } from "@nodex/codex-app-server-protocol/v2";
import type {
  ClientRequestParamsByMethod,
  ClientRequestResponsesByMethod,
} from "@nodex/effect-codex-app-server/rpc";
import { extractCodexCanonicalHydratedAttachments } from "../../../shared/codex-conversation-state/codex-conversation-state";
import { CODEX_INTERRUPTED_STEER_REASON } from "../../../shared/codex-queued-follow-up-state";
import { codexImageInputSource } from "../../../shared/codex-image-input";
import type { CodexQueuedMessage } from "../../../shared/codex-queued-message";
import { CodexTurnDeliveryError } from "../../../shared/codex-conversation-state/codex-turn-delivery";

import {
  equalCodexQueueValue,
  normalizeCodexNativeQueuedSubmission,
} from "../../../shared/codex-native-queued-submission";
export { equalCodexQueueValue } from "../../../shared/codex-native-queued-submission";

import { hasUntrustedAppInputPlaceholder } from "../../../shared/codex-untrusted-app-input";

export interface CodexServerQueueInput {
  readonly input: readonly UserInput[];
  readonly responseItems: readonly ClientRequestParamsByMethod["thread/inject_items"]["items"][number][];
}

type ServerQueueMethod =
  | "thread/queue/add"
  | "thread/queue/delete"
  | "thread/queue/list"
  | "thread/queue/reorder"
  | "thread/queue/start"
  | "thread/queue/update";

export interface CodexServerQueueEditPosition {
  readonly messageId?: string;
  readonly previousMessageId?: string | null;
  readonly nextMessageId?: string | null;
}

export interface CodexServerQueueRemoval {
  readonly index: number;
  readonly message: CodexQueuedMessage;
  readonly previousMessageId: string | null;
  readonly nextMessageId: string | null;
  readonly serverSubmission: QueuedSubmission;
}

export type CodexServerQueueSendResult =
  | { readonly status: "queued"; readonly messageId: string }
  | { readonly status: "sent"; readonly messageId: string; readonly turnId: string };

interface CodexServerQueueState {
  readonly generation: number;
  items: QueuedSubmission[];
  messagesById: Record<string, CodexQueuedMessage>;
}

export interface CodexServerQueuedMessagesOptions {
  readonly isEnabled?: (threadId: string) => boolean;
  readonly canEnqueue?: (threadId: string, message: CodexQueuedMessage) => boolean;
  readonly request: <Method extends ServerQueueMethod>(
    method: Method,
    params: ClientRequestParamsByMethod[Method],
  ) => Promise<ClientRequestResponsesByMethod[Method]>;
  readonly compileInput: (
    message: CodexQueuedMessage,
    previous: QueuedSubmission | undefined,
    preserveGeneratedText: boolean,
  ) => Promise<CodexServerQueueInput> | CodexServerQueueInput;
  readonly getConversationCwd: (threadId: string) => string | null;
  readonly isConversationInterrupted: (threadId: string) => boolean;
  readonly isConversationStreaming: (threadId: string) => boolean;
  readonly onQueueChanged: (threadId: string) => void;
  readonly captureMutationLifetime?: (
    threadId: string,
    operation: "enqueue" | "remove" | "reorder" | "resume" | "send-now" | "cleanup",
  ) => Disposable & { assertCurrent(): void };
  readonly onEnqueueUnknown?: (
    threadId: string,
    message: CodexQueuedMessage,
    input: readonly UserInput[],
    error: CodexTurnDeliveryError,
  ) => Promise<void>;
  readonly readAccepted?: (threadId: string) => readonly QueuedSubmission[];
  readonly recordAccepted?: (threadId: string, submission: QueuedSubmission) => void;
  readonly discardAccepted?: (threadId: string, submission: QueuedSubmission) => void;
}

const REQUEST_HEADING = /## My request(?: for Codex)?:/gu;
const CANONICAL_REQUEST_HEADING = "## My request:";

function currentRequestText(value: string): string {
  const parts = value.split(REQUEST_HEADING);
  return parts.length <= 1 ? value : parts[parts.length - 1]!.trim();
}

export function preserveGeneratedQueueText(previous: string, next: string): string {
  const request = currentRequestText(next);
  const matches = Array.from(previous.matchAll(REQUEST_HEADING));
  const last = matches.at(-1);
  if (!last || last.index === undefined) return request;
  return `${previous.slice(0, last.index).trimEnd()}\n${CANONICAL_REQUEST_HEADING}\n${request}\n`;
}

function insertionIndex(
  items: readonly QueuedSubmission[],
  position: CodexServerQueueEditPosition | undefined,
): number {
  if (!position) return items.length;
  const next = items.findIndex((item) => item.id === position.nextMessageId);
  if (next !== -1) return next;
  const previous = items.findIndex((item) => item.id === position.previousMessageId);
  return previous === -1 ? items.length : previous + 1;
}

function serverFallbackMessage(
  threadId: string,
  submission: QueuedSubmission,
  getConversationCwd: (threadId: string) => string | null,
): CodexQueuedMessage {
  const prompt = currentRequestText(
    submission.input.flatMap((entry) => (entry.type === "text" ? [entry.text] : [])).join("\n"),
  );
  return {
    id: submission.id,
    cwd: getConversationCwd(threadId) ?? "/",
    createdAt: 0,
    context: {
      prompt,
      addedFiles: [],
      fileAttachments: extractCodexCanonicalHydratedAttachments(submission.input).map(
        ({ label, path, fsPath }) => ({ label, path, fsPath }),
      ),
      commentAttachments: [],
      imageAttachments: submission.input.flatMap((entry) => {
        if (entry.type === "image" || entry.type === "localImage")
          return [{ source: codexImageInputSource(entry) }];
        return [];
      }),
    },
  };
}

/** App-server-owned follow-up queue with a local projection cache for composer state. */
export class CodexServerQueuedMessages implements Disposable {
  private readonly states = new Map<string, CodexServerQueueState>();
  private readonly loads = new Map<string, Promise<void>>();
  private readonly reloadRequested = new Set<string>();
  private generation = 0;
  private disposed = false;

  constructor(private readonly options: CodexServerQueuedMessagesOptions) {}

  findByClientMessageId(threadId: string, clientId: string): string | undefined {
    return this.states.get(threadId)?.items.find((item) => item.clientUserMessageId === clientId)
      ?.id;
  }

  readClientMessageId(threadId: string, messageId: string): string | undefined {
    return this.states.get(threadId)?.items.find((item) => item.id === messageId)
      ?.clientUserMessageId;
  }

  readNativeSubmission(threadId: string, messageId: string): QueuedSubmission | undefined {
    const submission = this.states.get(threadId)?.items.find((item) => item.id === messageId);
    return submission ? structuredClone(submission) : undefined;
  }

  /** Confirmation requires the native receipt's actual input, never just its client correlation. */
  async matchesClientReceipt(threadId: string, message: CodexQueuedMessage): Promise<boolean> {
    const state = await this.state(threadId);
    if (!state.items.some((item) => item.clientUserMessageId === message.id)) return false;
    const prepared = await this.options.compileInput(message, undefined, false);
    this.assertCurrent(threadId, state);
    if (prepared.responseItems.length || prepared.input.some(hasUntrustedAppInputPlaceholder))
      return false;
    const current = state.items.find((item) => item.clientUserMessageId === message.id);
    return current !== undefined && equalCodexQueueValue(current.input, prepared.input);
  }

  read(threadId: string): readonly CodexQueuedMessage[] | undefined {
    const state = this.states.get(threadId);
    if (!state) return undefined;
    const interrupted = this.options.isConversationInterrupted(threadId);
    return state.items.map((submission) => {
      const cached =
        state.messagesById[submission.id] ??
        serverFallbackMessage(threadId, submission, this.options.getConversationCwd);
      if (interrupted) return { ...cached, pausedReason: CODEX_INTERRUPTED_STEER_REASON };
      if (cached.pausedReason == null) return cached;
      const { pausedReason: _pausedReason, ...message } = cached;
      return message;
    });
  }

  async load(threadId: string): Promise<void> {
    const existing = this.loads.get(threadId);
    if (existing) return await existing;
    const generation = this.generation;
    const load = (async () => {
      let items: QueuedSubmission[];
      let previousItems: QueuedSubmission[] | undefined;
      do {
        this.reloadRequested.delete(threadId);
        previousItems = this.states.get(threadId)?.items;
        items = [];
        let cursor: string | null = null;
        do {
          if (this.disposed || this.generation !== generation) return;
          const response: ClientRequestResponsesByMethod["thread/queue/list"] =
            await this.options.request("thread/queue/list", { threadId, cursor });
          if (this.disposed || this.generation !== generation) return;
          items.push(...response.data.map(normalizeCodexNativeQueuedSubmission));
          cursor = response.nextCursor ?? null;
        } while (cursor !== null);
      } while (
        this.reloadRequested.has(threadId) ||
        this.states.get(threadId)?.items !== previousItems
      );
      const previous = this.states.get(threadId);
      const byId = new Map(previous?.items.map((item) => [item.id, item]));
      const messagesById: Record<string, CodexQueuedMessage> = {};
      for (const item of items) {
        const message = previous?.messagesById[item.id];
        if (message && equalCodexQueueValue(byId.get(item.id), item))
          messagesById[item.id] = message;
      }
      if (previous) {
        previous.items = items;
        previous.messagesById = messagesById;
      } else {
        this.states.set(threadId, { generation, items, messagesById });
      }
      this.options.onQueueChanged(threadId);
    })().finally(() => {
      if (this.loads.get(threadId) === load) this.loads.delete(threadId);
    });
    this.loads.set(threadId, load);
    await load;
  }

  private async state(threadId: string): Promise<CodexServerQueueState> {
    const generation = this.generation;
    if (!this.states.has(threadId)) await this.load(threadId);
    const state = this.states.get(threadId);
    if (!state || this.generation !== generation)
      throw new Error("App-server queued follow-ups are unavailable");
    this.assertCurrent(threadId, state);
    return state;
  }

  private assertCurrent(threadId: string, state: CodexServerQueueState): void {
    if (
      this.disposed ||
      state.generation !== this.generation ||
      this.states.get(threadId) !== state ||
      this.options.isEnabled?.(threadId) === false
    )
      throw new Error("App-server queue owner lifetime ended");
  }

  async enqueue(
    threadId: string,
    message: CodexQueuedMessage,
    position?: CodexServerQueueEditPosition,
    restore?: QueuedSubmission,
  ): Promise<{ status: "queued"; messageId: string }> {
    using lifetime = this.options.captureMutationLifetime?.(threadId, "enqueue");
    const state = await this.state(threadId);
    const assertCurrent = () => {
      lifetime?.assertCurrent();
      this.assertCurrent(threadId, state);
    };
    assertCurrent();
    const editedId = position?.messageId;
    const previousSubmission = editedId
      ? state.items.find((item) => item.id === editedId)
      : undefined;
    const previousMessage = editedId
      ? this.read(threadId)?.find((item) => item.id === editedId)
      : undefined;
    if (editedId && (!previousSubmission || !previousMessage)) {
      throw new Error("App-server queued follow-up no longer exists");
    }
    const nextMessage: CodexQueuedMessage = {
      ...message,
      id: previousMessage?.id ?? message.id,
      context:
        previousMessage?.context.isImageEditFollowUp === true
          ? { ...message.context, isImageEditFollowUp: true }
          : message.context,
      createdAt: previousMessage?.createdAt ?? message.createdAt,
    };
    const prepared = restore
      ? { input: restore.input, responseItems: [] }
      : await this.options.compileInput(
          nextMessage,
          previousSubmission,
          previousSubmission !== undefined &&
            state.messagesById[previousSubmission.id] === undefined,
        );
    assertCurrent();
    if (this.options.canEnqueue?.(threadId, nextMessage) === false)
      throw new Error("Queued follow-up changed before dispatch");
    if (
      previousSubmission &&
      !equalCodexQueueValue(
        state.items.find((item) => item.id === previousSubmission.id),
        previousSubmission,
      )
    )
      throw new Error("Queued follow-up changed before dispatch");
    if (prepared.responseItems.length > 0 || prepared.input.some(hasUntrustedAppInputPlaceholder))
      throw new Error("App input requires confirmation before queue delivery");
    const input = [...prepared.input];
    const accepted =
      editedId == null
        ? state.items.find((item) => item.clientUserMessageId === nextMessage.id)
        : undefined;
    if (accepted) {
      if (!equalCodexQueueValue(accepted.input, input))
        throw new Error("Queued message identity already has different input");
      state.messagesById[accepted.id] = { ...nextMessage, id: accepted.id };
      this.options.onQueueChanged(threadId);
      return { status: "queued", messageId: accepted.id };
    }
    let queuedSubmission: ClientRequestResponsesByMethod["thread/queue/add"]["queuedSubmission"];
    try {
      queuedSubmission = previousSubmission
        ? (
            await this.options.request("thread/queue/update", {
              threadId,
              queuedSubmissionId: previousSubmission.id,
              input,
            })
          ).queuedSubmission
        : (
            await this.options.request("thread/queue/add", {
              threadId,
              input,
              clientUserMessageId: restore?.clientUserMessageId ?? nextMessage.id,
            })
          ).queuedSubmission;
    } catch (error) {
      assertCurrent();
      if (
        !previousSubmission &&
        error instanceof CodexTurnDeliveryError &&
        error.delivery.stage === "outcome-unknown" &&
        error.delivery.method === "thread/queue/add"
      )
        await this.options.onEnqueueUnknown?.(threadId, nextMessage, input, error);
      throw error;
    }
    const normalizedSubmission = normalizeCodexNativeQueuedSubmission(queuedSubmission);
    assertCurrent();
    const projected = { ...nextMessage, id: normalizedSubmission.id };
    const withoutEdited = state.items.filter(
      (item) => item.id !== previousSubmission?.id && item.id !== normalizedSubmission.id,
    );
    withoutEdited.splice(insertionIndex(withoutEdited, position), 0, normalizedSubmission);
    state.items = withoutEdited;
    if (previousSubmission) delete state.messagesById[previousSubmission.id];
    state.messagesById[normalizedSubmission.id] = projected;
    this.options.onQueueChanged(threadId);
    if (position)
      await this.reorder(
        threadId,
        state.items.map((item) => item.id),
      );
    return { status: "queued", messageId: normalizedSubmission.id };
  }

  async remove(threadId: string, messageId: string): Promise<CodexServerQueueRemoval | null> {
    using lifetime = this.options.captureMutationLifetime?.(threadId, "remove");
    const state = await this.state(threadId);
    const assertCurrent = () => {
      lifetime?.assertCurrent();
      this.assertCurrent(threadId, state);
    };
    assertCurrent();
    const index = state.items.findIndex((item) => item.id === messageId);
    const serverSubmission = state.items[index];
    const message = this.read(threadId)?.[index];
    if (!serverSubmission || !message) return null;
    const previousMessageId = state.items[index - 1]?.id ?? null;
    const nextMessageId = state.items[index + 1]?.id ?? null;
    assertCurrent();
    const { deleted } = await this.options.request("thread/queue/delete", {
      threadId,
      queuedSubmissionId: messageId,
    });
    assertCurrent();
    if (!deleted) return null;
    state.items = state.items.filter((item) => item.id !== messageId);
    delete state.messagesById[messageId];
    this.options.onQueueChanged(threadId);
    return {
      index,
      message,
      previousMessageId,
      nextMessageId,
      serverSubmission,
    };
  }

  async reorder(threadId: string, messageIds: readonly string[]): Promise<void> {
    using lifetime = this.options.captureMutationLifetime?.(threadId, "reorder");
    const state = await this.state(threadId);
    const assertCurrent = () => {
      lifetime?.assertCurrent();
      this.assertCurrent(threadId, state);
    };
    assertCurrent();
    assertCurrent();
    await this.options.request("thread/queue/reorder", {
      threadId,
      queuedSubmissionIds: [...messageIds],
    });
    assertCurrent();
    const byId = new Map(state.items.map((item) => [item.id, item]));
    state.items = [
      ...messageIds.flatMap((id) => {
        const item = byId.get(id);
        byId.delete(id);
        return item ? [item] : [];
      }),
      ...byId.values(),
    ];
    this.options.onQueueChanged(threadId);
  }

  async clear(threadId: string): Promise<readonly CodexQueuedMessage[]> {
    await this.state(threadId);
    const messages = [...(this.read(threadId) ?? [])];
    for (const message of messages) {
      if ((await this.remove(threadId, message.id)) === null) {
        throw new Error("Failed to clear app-server queued follow-up");
      }
    }
    return messages;
  }

  async restore(threadId: string, removal: CodexServerQueueRemoval): Promise<void> {
    const result = await this.enqueue(
      threadId,
      removal.message,
      undefined,
      removal.serverSubmission,
    );
    Object.assign(removal.message, { id: result.messageId });
    const state = await this.state(threadId);
    const ids = state.items.map((item) => item.id);
    const inserted = ids.indexOf(result.messageId);
    if (inserted !== -1) ids.splice(inserted, 1);
    const next = ids.indexOf(removal.nextMessageId ?? "");
    const previous = ids.indexOf(removal.previousMessageId ?? "");
    let index = Math.min(removal.index, ids.length);
    if (next !== -1) index = next;
    else if (previous !== -1) index = previous + 1;
    ids.splice(index, 0, result.messageId);
    await this.reorder(threadId, ids);
  }

  async resume(threadId: string): Promise<void> {
    if (this.options.isConversationStreaming(threadId)) return;
    using lifetime = this.options.captureMutationLifetime?.(threadId, "resume");
    const state = await this.state(threadId);
    const assertCurrent = () => {
      lifetime?.assertCurrent();
      this.assertCurrent(threadId, state);
    };
    assertCurrent();
    const first = state.items[0];
    if (!first) return;
    assertCurrent();
    await this.options.request("thread/queue/start", {
      threadId,
      queuedSubmissionId: first.id,
    });
    assertCurrent();
    state.items = state.items.filter((item) => !equalCodexQueueValue(item, first));
    if (!state.items.some((item) => item.id === first.id)) delete state.messagesById[first.id];
    this.options.onQueueChanged(threadId);
  }

  async sendNow(
    threadId: string,
    messageId: string,
    steer: (
      message: CodexQueuedMessage,
      clientUserMessageId: string,
    ) => Promise<CodexServerQueueSendResult>,
    accepted?: () => void,
  ): Promise<CodexServerQueueSendResult | null> {
    using lifetime = this.options.captureMutationLifetime?.(threadId, "send-now");
    const state = await this.state(threadId);
    const assertCurrent = () => {
      lifetime?.assertCurrent();
      this.assertCurrent(threadId, state);
    };
    assertCurrent();
    const submission = state.items.find((item) => item.id === messageId);
    const message = this.read(threadId)?.find((entry) => entry.id === messageId);
    if (!submission || !message) return null;
    let result: CodexServerQueueSendResult;
    if (this.options.isConversationStreaming(threadId)) {
      result = await steer(message, submission.clientUserMessageId);
      if (result.status === "sent") accepted?.();
      assertCurrent();
      if (result.status !== "sent") return result;
      this.options.recordAccepted?.(threadId, submission);
      if (
        !equalCodexQueueValue(
          state.items.find((item) => item.id === messageId),
          submission,
        )
      )
        return result;
      const { deleted } = await this.options.request("thread/queue/delete", {
        threadId,
        queuedSubmissionId: messageId,
      });
      assertCurrent();
      if (!deleted) {
        await this.refresh(threadId);
        assertCurrent();
        if (state.items.some((item) => equalCodexQueueValue(item, submission)))
          throw new Error("Failed to remove steered app-server queued follow-up");
      }
    } else {
      const { turn } = await this.options.request("thread/queue/start", {
        threadId,
        queuedSubmissionId: messageId,
      });
      result = { status: "sent", messageId, turnId: turn.id };
      accepted?.();
    }
    assertCurrent();
    state.items = state.items.filter((item) => !equalCodexQueueValue(item, submission));
    if (!state.items.some((item) => item.id === messageId)) delete state.messagesById[messageId];
    this.options.discardAccepted?.(threadId, submission);
    this.options.onQueueChanged(threadId);
    return result;
  }

  /** Accepted steering recovers only native queue cleanup, never another delivery. */
  async reconcileAccepted(threadId: string): Promise<void> {
    const receipts = this.options.readAccepted?.(threadId) ?? [];
    if (!receipts.length) return;
    using lifetime = this.options.captureMutationLifetime?.(threadId, "cleanup");
    const state = await this.state(threadId);
    const assertCurrent = () => {
      lifetime?.assertCurrent();
      this.assertCurrent(threadId, state);
    };
    assertCurrent();
    for (const receipt of receipts) {
      assertCurrent();
      const current = state.items.find((item) => item.id === receipt.id);
      if (!current) {
        this.options.discardAccepted?.(threadId, receipt);
        continue;
      }
      if (!equalCodexQueueValue(current, receipt)) continue;
      const { deleted } = await this.options.request("thread/queue/delete", {
        threadId,
        queuedSubmissionId: receipt.id,
      });
      assertCurrent();
      if (!deleted) {
        await this.refresh(threadId);
        assertCurrent();
        if (state.items.some((item) => equalCodexQueueValue(item, receipt)))
          throw new Error("Accepted message remains in the app-server queue");
      } else {
        state.items = state.items.filter((item) => !equalCodexQueueValue(item, receipt));
        if (!state.items.some((item) => item.id === receipt.id))
          delete state.messagesById[receipt.id];
        this.options.onQueueChanged(threadId);
      }
      this.options.discardAccepted?.(threadId, receipt);
    }
  }

  refresh(threadId: string): Promise<void> {
    if (this.loads.has(threadId)) this.reloadRequested.add(threadId);
    return this.load(threadId);
  }

  retire(): void {
    this.generation += 1;
    this.states.clear();
    this.loads.clear();
    this.reloadRequested.clear();
  }

  [Symbol.dispose](): void {
    this.disposed = true;
    this.retire();
  }
}
