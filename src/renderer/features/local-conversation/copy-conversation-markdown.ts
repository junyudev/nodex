import { toast, type ToastHandle } from "@/components/ui/toast";
import { writeTextToClipboardStrict } from "@/lib/clipboard";
import type {
  CodexConversationHistoryExportNextResult,
  CodexConversationHistoryExportStartResult,
  CodexConversationTurn,
} from "@/lib/types";
import { buildCodexTurnOccurrenceKey } from "../../../shared/codex-turn-identity";
import { readLocalConversation, requestLocalConversationResume } from "./local-conversation-store";
import { runConversationOperation } from "./local-conversation-operations";
import {
  renderConversationMarkdownHeader,
  renderConversationTurnMarkdown,
} from "./conversation-markdown";
import type { VisibleConversationTurnEntry } from "./selectors";

export const CONVERSATION_MARKDOWN_CLIPBOARD_MAX_BYTES = 16 * 1024 * 1_024;

export interface CopyConversationMarkdownInput {
  conversationId: string;
  parentConversationId?: string | null;
  title: string;
}

export interface ConversationMarkdownExportProgress {
  readonly completedTurnCount: number;
  readonly totalTurnCount: number | null;
}

interface CopyConversationMarkdownDependencies {
  streamMarkdown: (
    signal: AbortSignal,
    onProgress: (progress: ConversationMarkdownExportProgress) => void,
  ) => AsyncIterable<string>;
  writeText: (value: string) => Promise<void>;
  signal?: AbortSignal;
  onProgress?: (progress: ConversationMarkdownExportProgress) => void;
  showSuccess: () => void;
  showTooLarge: (limitBytes: number) => void;
  showError: () => void;
}

class ConversationMarkdownClipboardLimitError extends Error {
  constructor() {
    super("Conversation Markdown exceeds the bounded clipboard allocation");
    this.name = "ConversationMarkdownClipboardLimitError";
  }
}

class ConversationMarkdownExportCancelled extends Error {
  constructor() {
    super("Conversation Markdown export was cancelled");
    this.name = "ConversationMarkdownExportCancelled";
  }
}

const utf8Bytes = (value: string): number => new TextEncoder().encode(value).byteLength;

async function collectBoundedMarkdown(
  stream: AsyncIterable<string>,
  signal: AbortSignal,
): Promise<string | null> {
  const chunks: string[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    if (signal.aborted) throw new ConversationMarkdownExportCancelled();
    bytes += utf8Bytes(chunk);
    if (bytes > CONVERSATION_MARKDOWN_CLIPBOARD_MAX_BYTES) {
      throw new ConversationMarkdownClipboardLimitError();
    }
    chunks.push(chunk);
  }
  if (signal.aborted) throw new ConversationMarkdownExportCancelled();
  return chunks.length === 0 ? null : chunks.join("");
}

export async function runCopyConversationMarkdown(
  dependencies: CopyConversationMarkdownDependencies,
): Promise<void> {
  const controller = dependencies.signal ? null : new AbortController();
  const signal = dependencies.signal ?? controller!.signal;
  try {
    const markdown = await collectBoundedMarkdown(
      dependencies.streamMarkdown(signal, dependencies.onProgress ?? (() => undefined)),
      signal,
    );
    if (markdown == null || markdown.trim().length === 0) return;
    await dependencies.writeText(markdown);
    dependencies.showSuccess();
  } catch (error) {
    if (error instanceof ConversationMarkdownExportCancelled || signal.aborted) return;
    if (error instanceof ConversationMarkdownClipboardLimitError) {
      dependencies.showTooLarge(CONVERSATION_MARKDOWN_CLIPBOARD_MAX_BYTES);
      return;
    }
    dependencies.showError();
  }
}

async function ensureConversationAvailable(conversationId: string): Promise<void> {
  const current = readLocalConversation(conversationId);
  if (!current || current.resumeState !== "resumed") {
    await requestLocalConversationResume(conversationId);
  }
}

function exportEntry(turn: CodexConversationTurn, index: number): VisibleConversationTurnEntry {
  const turnKey = buildCodexTurnOccurrenceKey(turn.turnId, index);
  return {
    turn,
    turnId: turn.turnId,
    turnKey,
    turnSearchKey: turnKey,
    requests: [],
    isMostRecentTurn: false,
  };
}

async function* streamExportTurns(
  threadId: string,
  signal: AbortSignal,
  onProgress: (progress: ConversationMarkdownExportProgress) => void,
): AsyncGenerator<CodexConversationTurn> {
  const started = (await runConversationOperation(
    "codex:thread:history-export:start",
    threadId,
  )) as CodexConversationHistoryExportStartResult;
  const cancel = (): void => {
    void runConversationOperation("codex:thread:history-export:cancel", started.jobId).catch(
      () => undefined,
    );
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      if (signal.aborted) throw new ConversationMarkdownExportCancelled();
      const page = (await runConversationOperation(
        "codex:thread:history-export:next",
        started.jobId,
      )) as CodexConversationHistoryExportNextResult;
      if (signal.aborted) throw new ConversationMarkdownExportCancelled();
      onProgress({
        completedTurnCount: page.completedTurnCount,
        totalTurnCount: page.totalTurnCount,
      });
      if (page.turn) yield page.turn;
      if (page.done) return;
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    await runConversationOperation("codex:thread:history-export:cancel", started.jobId).catch(
      () => false,
    );
  }
}

/**
 * A forked side conversation contains its inherited parent prefix. Walk both exports in lockstep
 * until their stable Turn identities diverge, then emit only the side conversation's own suffix.
 */
async function* streamConversationTurns(input: {
  readonly conversationId: string;
  readonly parentConversationId: string | null;
  readonly signal: AbortSignal;
  readonly onProgress: (progress: ConversationMarkdownExportProgress) => void;
}): AsyncGenerator<CodexConversationTurn> {
  const child = streamExportTurns(input.conversationId, input.signal, input.onProgress);
  if (!input.parentConversationId) {
    yield* child;
    return;
  }

  const parent = streamExportTurns(input.parentConversationId, input.signal, () => undefined);
  let compareSharedPrefix = true;
  try {
    let [childStep, parentStep] = await Promise.all([child.next(), parent.next()]);
    while (!childStep.done) {
      if (
        compareSharedPrefix &&
        !parentStep.done &&
        childStep.value.turnId !== null &&
        childStep.value.turnId === parentStep.value.turnId
      ) {
        [childStep, parentStep] = await Promise.all([child.next(), parent.next()]);
        continue;
      }
      if (compareSharedPrefix) {
        compareSharedPrefix = false;
        await parent.return(undefined);
      }
      yield childStep.value;
      childStep = await child.next();
    }
  } finally {
    await Promise.allSettled([child.return(undefined), parent.return(undefined)]);
  }
}

async function* streamConversationMarkdown(input: {
  readonly conversationId: string;
  readonly parentConversationId: string | null;
  readonly title: string;
  readonly cwd: string | null;
  readonly signal: AbortSignal;
  readonly onProgress: (progress: ConversationMarkdownExportProgress) => void;
}): AsyncGenerator<string> {
  let renderedTurnCount = 0;
  let turnIndex = 0;
  for await (const turn of streamConversationTurns(input)) {
    const rendered = renderConversationTurnMarkdown(exportEntry(turn, turnIndex), input.cwd);
    turnIndex += 1;
    if (!rendered) continue;
    if (renderedTurnCount === 0) yield renderConversationMarkdownHeader(input.title);
    yield `\n\n${rendered}`;
    renderedTurnCount += 1;
  }
  if (renderedTurnCount > 0) yield "\n";
}

export async function copyConversationMarkdown({
  conversationId,
  parentConversationId = null,
  title,
}: CopyConversationMarkdownInput): Promise<void> {
  const controller = new AbortController();
  const progressToastId = `conversation-markdown-export:${conversationId}`;
  let progressToast: ToastHandle = toast.info("Preparing conversation Markdown…", {
    id: progressToastId,
    duration: 0,
    action: {
      label: "Cancel",
      onClick: () => {
        controller.abort();
      },
    },
  });

  try {
    await ensureConversationAvailable(conversationId);
    if (parentConversationId) await ensureConversationAvailable(parentConversationId);
    const conversation = readLocalConversation(conversationId);
    if (!conversation) throw new Error("Conversation is unavailable");

    await runCopyConversationMarkdown({
      signal: controller.signal,
      streamMarkdown: (signal, onProgress) =>
        streamConversationMarkdown({
          conversationId,
          parentConversationId,
          title,
          cwd: conversation.cwd ?? null,
          signal,
          onProgress,
        }),
      writeText: writeTextToClipboardStrict,
      onProgress: ({ completedTurnCount, totalTurnCount }) => {
        progressToast.close();
        progressToast = toast.info("Preparing conversation Markdown…", {
          id: progressToastId,
          duration: 0,
          description:
            totalTurnCount === null
              ? `${completedTurnCount} turns processed`
              : `${completedTurnCount} of ${totalTurnCount} turns processed`,
          action: {
            label: "Cancel",
            onClick: () => {
              controller.abort();
            },
          },
        });
      },
      showSuccess: () => toast.success("Conversation copied as Markdown"),
      showTooLarge: (limitBytes) =>
        toast.danger("Conversation is too large to copy", {
          description: `Clipboard export is limited to ${Math.floor(limitBytes / 1024 / 1024)} MB. The complete history was not retained in memory.`,
        }),
      showError: () => toast.danger("Failed to copy conversation as Markdown"),
    });
  } catch {
    if (!controller.signal.aborted) toast.danger("Failed to copy conversation as Markdown");
  } finally {
    progressToast.close();
  }
}
