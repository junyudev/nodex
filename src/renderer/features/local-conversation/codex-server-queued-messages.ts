import type { QueuedSubmission, UserInput } from "@nodex/codex-app-server-protocol/v2";
import type {
  ClientRequestParamsByMethod,
  ClientRequestResponsesByMethod,
} from "@nodex/effect-codex-app-server/rpc";
import { extractCodexCanonicalHydratedAttachments } from "../../../shared/codex-conversation-state/codex-conversation-state";
import { CODEX_INTERRUPTED_STEER_REASON } from "../../../shared/codex-queued-follow-up-state";
import type { CodexQueuedMessage } from "../../../shared/codex-queued-message";

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
  items: QueuedSubmission[];
  messagesById: Record<string, CodexQueuedMessage>;
}

export interface CodexServerQueuedMessagesOptions {
  readonly request: <Method extends ServerQueueMethod>(
    method: Method,
    params: ClientRequestParamsByMethod[Method],
  ) => Promise<ClientRequestResponsesByMethod[Method]>;
  readonly compileInput: (
    message: CodexQueuedMessage,
    previous: QueuedSubmission | undefined,
    preserveGeneratedText: boolean,
  ) => Promise<UserInput[]> | UserInput[];
  readonly getConversationCwd: (threadId: string) => string | null;
  readonly isConversationInterrupted: (threadId: string) => boolean;
  readonly isConversationStreaming: (threadId: string) => boolean;
  readonly onQueueChanged: (threadId: string) => void;
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

function equalUnknown(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((entry, index) => equalUnknown(entry, right[index]));
  }
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  if (leftEntries.length !== rightEntries.length) return false;
  const rightRecord = right as Readonly<Record<string, unknown>>;
  return leftEntries.every(
    ([key, value]) =>
      Object.prototype.hasOwnProperty.call(rightRecord, key) &&
      equalUnknown(value, rightRecord[key]),
  );
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
        if (entry.type === "image") return [{ source: entry.url }];
        if (entry.type === "localImage") return [{ source: entry.path }];
        return [];
      }),
    },
  };
}

function normalizeServerInput(
  input: ClientRequestResponsesByMethod["thread/queue/list"]["data"][number]["input"][number],
): UserInput {
  if (input.type === "text") {
    return {
      type: "text",
      text: input.text,
      text_elements: (input.text_elements ?? []).map((element) => ({
        byteRange: { ...element.byteRange },
        placeholder: element.placeholder ?? null,
      })),
    };
  }
  if (input.type === "image") {
    return {
      type: "image",
      url: input.url,
      ...(input.detail == null ? {} : { detail: input.detail }),
    };
  }
  if (input.type === "localImage") {
    return {
      type: "localImage",
      path: input.path,
      ...(input.detail == null ? {} : { detail: input.detail }),
    };
  }
  return { ...input };
}

function normalizeServerSubmission(input: {
  readonly id: string;
  readonly clientUserMessageId: string;
  readonly input: ReadonlyArray<
    ClientRequestResponsesByMethod["thread/queue/list"]["data"][number]["input"][number]
  >;
}): QueuedSubmission {
  return {
    id: input.id,
    clientUserMessageId: input.clientUserMessageId,
    input: input.input.map(normalizeServerInput),
  };
}

/** App-server-owned follow-up queue with a local projection cache for composer state. */
export class CodexServerQueuedMessages implements Disposable {
  private readonly states = new Map<string, CodexServerQueueState>();
  private readonly loads = new Map<string, Promise<void>>();
  private generation = 0;
  private disposed = false;

  constructor(private readonly options: CodexServerQueuedMessagesOptions) {}

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
      const items: QueuedSubmission[] = [];
      let cursor: string | null = null;
      do {
        const response: ClientRequestResponsesByMethod["thread/queue/list"] =
          await this.options.request("thread/queue/list", { threadId, cursor });
        items.push(...response.data.map(normalizeServerSubmission));
        cursor = response.nextCursor ?? null;
      } while (cursor !== null);
      if (this.disposed || this.generation !== generation) return;
      const previous = this.states.get(threadId);
      const previousItems = new Map(previous?.items.map((item) => [item.id, item]));
      const messagesById: Record<string, CodexQueuedMessage> = {};
      for (const item of items) {
        const message = previous?.messagesById[item.id];
        if (message && equalUnknown(previousItems.get(item.id), item))
          messagesById[item.id] = message;
      }
      this.states.set(threadId, { items, messagesById });
      this.options.onQueueChanged(threadId);
    })().finally(() => {
      if (this.loads.get(threadId) === load) this.loads.delete(threadId);
    });
    this.loads.set(threadId, load);
    await load;
  }

  private async state(threadId: string): Promise<CodexServerQueueState> {
    if (!this.states.has(threadId)) await this.load(threadId);
    const state = this.states.get(threadId);
    if (!state) throw new Error("App-server queued follow-ups are unavailable");
    return state;
  }

  async enqueue(
    threadId: string,
    message: CodexQueuedMessage,
    position?: CodexServerQueueEditPosition,
    restore?: QueuedSubmission,
  ): Promise<{ status: "queued"; messageId: string }> {
    const state = await this.state(threadId);
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
    const input =
      restore?.input ??
      (await this.options.compileInput(
        nextMessage,
        previousSubmission,
        previousSubmission !== undefined && state.messagesById[previousSubmission.id] === undefined,
      ));
    const queuedSubmission = previousSubmission
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
    const normalizedSubmission = normalizeServerSubmission(queuedSubmission);
    const projected = { ...nextMessage, id: normalizedSubmission.id };
    const withoutEdited = state.items.filter((item) => item.id !== previousSubmission?.id);
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
    const state = await this.state(threadId);
    const index = state.items.findIndex((item) => item.id === messageId);
    const serverSubmission = state.items[index];
    const message = this.read(threadId)?.[index];
    if (!serverSubmission || !message) return null;
    const { deleted } = await this.options.request("thread/queue/delete", {
      threadId,
      queuedSubmissionId: messageId,
    });
    if (!deleted) return null;
    state.items.splice(index, 1);
    delete state.messagesById[messageId];
    this.options.onQueueChanged(threadId);
    return {
      index,
      message,
      previousMessageId: state.items[index - 1]?.id ?? null,
      nextMessageId: state.items[index]?.id ?? null,
      serverSubmission,
    };
  }

  async reorder(threadId: string, messageIds: readonly string[]): Promise<void> {
    const state = await this.state(threadId);
    await this.options.request("thread/queue/reorder", {
      threadId,
      queuedSubmissionIds: [...messageIds],
    });
    const byId = new Map(state.items.map((item) => [item.id, item]));
    state.items = messageIds.flatMap((id) => {
      const item = byId.get(id);
      return item ? [item] : [];
    });
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
    const state = await this.state(threadId);
    const first = state.items[0];
    if (!first) return;
    await this.options.request("thread/queue/start", {
      threadId,
      queuedSubmissionId: first.id,
    });
    state.items = state.items.filter((item) => item.id !== first.id);
    delete state.messagesById[first.id];
    this.options.onQueueChanged(threadId);
  }

  async sendNow(
    threadId: string,
    messageId: string,
    steer: (
      message: CodexQueuedMessage,
      clientUserMessageId: string,
    ) => Promise<CodexServerQueueSendResult>,
  ): Promise<CodexServerQueueSendResult | null> {
    const state = await this.state(threadId);
    const submission = state.items.find((item) => item.id === messageId);
    const message = this.read(threadId)?.find((entry) => entry.id === messageId);
    if (!submission || !message) return null;
    let result: CodexServerQueueSendResult;
    if (this.options.isConversationStreaming(threadId)) {
      result = await steer(message, submission.clientUserMessageId);
      const { deleted } = await this.options.request("thread/queue/delete", {
        threadId,
        queuedSubmissionId: messageId,
      });
      if (!deleted) throw new Error("Failed to remove steered app-server queued follow-up");
    } else {
      const { turn } = await this.options.request("thread/queue/start", {
        threadId,
        queuedSubmissionId: messageId,
      });
      result = { status: "sent", messageId, turnId: turn.id };
    }
    state.items = state.items.filter((item) => item.id !== messageId);
    delete state.messagesById[messageId];
    this.options.onQueueChanged(threadId);
    return result;
  }

  refresh(threadId: string): Promise<void> {
    return this.load(threadId);
  }

  retire(): void {
    this.generation += 1;
    this.states.clear();
    this.loads.clear();
  }

  [Symbol.dispose](): void {
    this.disposed = true;
    this.retire();
  }
}
