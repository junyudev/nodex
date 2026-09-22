import { useCallback, useLayoutEffect, useMemo } from "react";
import type {
  CodexComposerAppshotContext,
  CodexLiveFileAttachment,
  CodexPastedTextAttachment,
  CodexReviewDiffCommentAttachment,
} from "@/lib/types";
import {
  getReviewDiffCommentAttachmentsSnapshot,
  subscribeReviewDiffCommentAttachments,
} from "@/lib/review-diff-comment-attachment-store";
import { ComposerScope, RouteScope } from "@/lib/workbench-ui-scopes";
import {
  appScope,
  atomWithExternalStore,
  persistedAtom,
  scopedAtom,
  scopedAtomFamily,
  scopedWritableAtom,
  usePersistedAtomValue,
  useMaitaiStore,
  getConcretePersistedAtom,
  useScopeHandle,
  useSetPersistedAtom,
  type PersistedLoadable,
  type ScopeHandle,
} from "@/lib/maitai";
import type { ComposerImageAttachment } from "./image-attachments/composer-image-attachment-model";

export type { ComposerImageAttachment } from "./image-attachments/composer-image-attachment-model";

export interface ComposerFileAttachment {
  readonly uiId: string;
  readonly attachment: CodexLiveFileAttachment;
}

interface ComposerPastedTextAttachmentBase {
  readonly id: string;
  readonly preview: string;
  readonly characterCount: number;
}

export type ComposerPastedTextAttachment =
  | (ComposerPastedTextAttachmentBase & {
      readonly status: "pending";
      readonly generation: number;
    })
  | (ComposerPastedTextAttachmentBase & {
      readonly status: "ready";
      readonly attachment: CodexPastedTextAttachment;
    })
  | (ComposerPastedTextAttachmentBase & {
      readonly status: "failed";
      readonly generation: number;
      readonly error: string;
    });

export interface ComposerCompletedDraftSnapshot {
  readonly prompt: string;
  readonly fileAttachments: readonly ComposerFileAttachment[];
  readonly addedFiles: readonly ComposerFileAttachment[];
  readonly imageAttachments: readonly ComposerImageAttachment[];
  readonly appshotContexts: readonly CodexComposerAppshotContext[];
  readonly pastedTextAttachments: readonly ComposerPastedTextAttachment[];
  readonly commentAttachments: readonly CodexReviewDiffCommentAttachment[];
  readonly goalModeActive: boolean;
}

export interface ComposerDraftTransfer extends ComposerCompletedDraftSnapshot {
  readonly transferId: string;
  readonly targetConversationId: string;
}

export type ComposerPromptDraftMap = Record<string, string>;

export interface ComposerPromptLinkMark {
  readonly from: number;
  readonly to: number;
  readonly href: string;
}

export interface ComposerPromptMention {
  readonly from: number;
  readonly to: number;
  readonly kind:
    | "skill"
    | "plugin"
    | "app"
    | "agent"
    | "chatgpt-conversation"
    | "file"
    | "site"
    | "thread";
  readonly id: string;
  readonly label: string;
  readonly path?: string;
}

export interface ComposerPromptDocument {
  readonly text: string;
  readonly links: readonly ComposerPromptLinkMark[];
  readonly mentions: readonly ComposerPromptMention[];
}

export const COMPOSER_PROMPT_DRAFTS_STORAGE_KEY = "composer-prompt-drafts-v1";

function decodeComposerPromptDraftMap(value: unknown): ComposerPromptDraftMap {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] =>
        entry[0].trim().length > 0 && typeof entry[1] === "string",
    ),
  );
}

export const composerPromptDraftsAtom = persistedAtom<ComposerPromptDraftMap>({
  debugLabel: "composer-prompt-drafts",
  storageKey: COMPOSER_PROMPT_DRAFTS_STORAGE_KEY,
  defaultValue: {},
  hydration: "eager",
  synchronization: "cross-window",
  optimistic: true,
  writeFailure: "retain-and-error",
  decode: decodeComposerPromptDraftMap,
  encode: (value) => ({ ...value }),
});

export const activeComposerFocusNonceAtom = scopedAtom<number | null>(RouteScope, null, {
  debugLabel: "active-composer-focus-nonce",
});

export const composerDraftInitializedAtom = scopedAtom(ComposerScope, false, {
  debugLabel: "composer-draft-initialized",
});

export const composerConsumedIntentNonceAtom = scopedAtom<number | null>(ComposerScope, null, {
  debugLabel: "composer-consumed-intent-nonce",
});

export const composerFileAttachmentsAtom = scopedAtom<readonly ComposerFileAttachment[]>(
  ComposerScope,
  [],
  { debugLabel: "composer-file-attachments" },
);

export const composerAddedFilesAtom = scopedAtom<readonly ComposerFileAttachment[]>(
  ComposerScope,
  [],
  { debugLabel: "composer-added-files" },
);

export const composerImageAttachmentsAtom = scopedAtom<readonly ComposerImageAttachment[]>(
  ComposerScope,
  [],
  { debugLabel: "composer-image-attachments" },
);

export const composerAppshotContextsAtom = scopedAtom<readonly CodexComposerAppshotContext[]>(
  ComposerScope,
  [],
  { debugLabel: "composer-appshot-contexts" },
);

export const composerPastedTextAttachmentsAtom = scopedAtom<
  readonly ComposerPastedTextAttachment[]
>(ComposerScope, [], { debugLabel: "composer-pasted-text-attachments" });

export const composerGoalModeActiveAtom = scopedAtom(ComposerScope, false, {
  debugLabel: "composer-goal-mode-active",
});

export const composerResetGenerationAtom = scopedAtom(ComposerScope, 0, {
  debugLabel: "composer-reset-generation",
});

export const clearComposerCompletedDraftAtom = scopedWritableAtom(
  ComposerScope,
  (get) => get(composerResetGenerationAtom),
  (get, set) => {
    set(composerFileAttachmentsAtom, []);
    set(composerAddedFilesAtom, []);
    set(composerImageAttachmentsAtom, []);
    set(composerAppshotContextsAtom, []);
    set(composerPastedTextAttachmentsAtom, []);
    set(composerGoalModeActiveAtom, false);
    set(composerResetGenerationAtom, get(composerResetGenerationAtom) + 1);
  },
  { debugLabel: "clear-composer-completed-draft" },
);

export const composerDraftTransferFamily = scopedAtomFamily({
  scope: appScope,
  debugLabel: "composer-draft-transfer",
  key: (conversationId: string) => conversationId.trim(),
  create: () =>
    scopedAtom<ComposerDraftTransfer | null>(appScope, null, {
      debugLabel: "composer-draft-transfer-value",
    }),
});

export const composerReviewCommentAttachmentsFamily = scopedAtomFamily({
  scope: ComposerScope,
  debugLabel: "composer-review-comment-attachments",
  key: (threadId: string | null) => threadId?.trim() || "none",
  create: (threadId: string | null) =>
    atomWithExternalStore(ComposerScope, {
      debugLabel: "review-comment-attachments",
      getSnapshot: () => getReviewDiffCommentAttachmentsSnapshot(threadId),
      subscribe: subscribeReviewDiffCommentAttachments,
    }),
});

export function createComposerDraftTransfer(
  targetConversationId: string,
  snapshot: ComposerCompletedDraftSnapshot,
): ComposerDraftTransfer {
  const normalizedConversationId = targetConversationId.trim();
  if (!normalizedConversationId)
    throw new Error("Composer transfer requires a target conversation id");
  return {
    ...snapshot,
    pastedTextAttachments: snapshot.pastedTextAttachments.filter(
      (attachment) => attachment.status === "ready",
    ),
    transferId: createTransferId(),
    targetConversationId: normalizedConversationId,
  };
}

export function publishComposerDraftTransfer(
  appHandle: ScopeHandle,
  transfer: ComposerDraftTransfer,
): void {
  appHandle.set(composerDraftTransferFamily(transfer.targetConversationId), transfer);
}

export function consumeComposerDraftTransfer(
  appHandle: ScopeHandle,
  targetConversationId: string,
): ComposerDraftTransfer | null {
  const definition = composerDraftTransferFamily(targetConversationId);
  const transfer = appHandle.get(definition);
  if (!transfer) return null;
  appHandle.set(definition, null);
  return transfer;
}

export function buildComposerPromptAliases(
  primaryIdentity: string,
  threadId: string | null | undefined,
): readonly string[] {
  const primary = primaryIdentity.trim();
  if (!primary) throw new Error("Composer prompt requires a primary identity");
  const localAlias = threadId?.trim() ? `local:${threadId.trim()}` : null;
  return localAlias && localAlias !== primary ? [primary, localAlias] : [primary];
}

export function readComposerPromptDraft(
  drafts: ComposerPromptDraftMap,
  aliases: readonly string[],
): string {
  for (const alias of aliases) {
    if (Object.prototype.hasOwnProperty.call(drafts, alias)) {
      return deserializeComposerPromptDraft(drafts[alias] ?? "").text;
    }
  }
  return "";
}

export function updateComposerPromptDrafts(
  drafts: ComposerPromptDraftMap,
  aliases: readonly string[],
  prompt: string,
): ComposerPromptDraftMap {
  const next = { ...drafts };
  if (prompt.length === 0) {
    for (const alias of aliases) delete next[alias];
    return next;
  }
  const serialized = serializeComposerPromptDraft({ text: prompt, links: [], mentions: [] });
  for (const alias of aliases) next[alias] = serialized;
  return next;
}

export function backfillComposerPromptAliases(
  drafts: ComposerPromptDraftMap,
  aliases: readonly string[],
): ComposerPromptDraftMap {
  const source = aliases
    .map((alias) => drafts[alias])
    .find((candidate): candidate is string => candidate !== undefined);
  if (source === undefined || deserializeComposerPromptDraft(source).text.length === 0)
    return drafts;
  if (aliases.every((alias) => drafts[alias] === source)) return drafts;
  return Object.fromEntries([
    ...Object.entries(drafts),
    ...aliases.map((alias) => [alias, source] as const),
  ]);
}

export function serializeComposerPromptDraft(document: ComposerPromptDocument): string {
  return JSON.stringify({
    version: 1,
    text: document.text,
    links: document.links.map((link) => ({ ...link })),
    mentions: document.mentions.map((mention) => ({ ...mention })),
  });
}

export function deserializeComposerPromptDraft(serialized: string): ComposerPromptDocument {
  const legacy = { text: serialized, links: [], mentions: [] } satisfies ComposerPromptDocument;
  if (!serialized.trimStart().startsWith("{")) return legacy;
  try {
    const value: unknown = JSON.parse(serialized);
    if (!isRecord(value) || value.version !== 1 || typeof value.text !== "string") return legacy;
    const text = value.text;
    return {
      text,
      links: Array.isArray(value.links)
        ? value.links.flatMap((candidate) => decodePromptLink(candidate, text.length))
        : [],
      mentions: Array.isArray(value.mentions)
        ? value.mentions.flatMap((candidate) => decodePromptMention(candidate, text.length))
        : [],
    };
  } catch {
    return legacy;
  }
}

export interface ComposerPromptDraftController {
  readonly loadable: PersistedLoadable<ComposerPromptDraftMap>;
  readonly aliases: readonly string[];
  readonly prompt: string;
  readPrompt(): string;
  setPrompt(prompt: string): Promise<void>;
  clear(): Promise<void>;
}

export function useComposerPromptDraft(
  threadId: string | null | undefined,
): ComposerPromptDraftController {
  const composerHandle = useScopeHandle(ComposerScope);
  const store = useMaitaiStore();
  const loadable = usePersistedAtomValue(composerPromptDraftsAtom);
  const setDrafts = useSetPersistedAtom(composerPromptDraftsAtom);
  const aliases = useMemo(
    () => buildComposerPromptAliases(composerHandle.path, threadId),
    [composerHandle.path, threadId],
  );
  const prompt = readComposerPromptDraft(loadable.value, aliases);
  useLayoutEffect(() => {
    if (loadable.status !== "ready") return;
    const backfilled = backfillComposerPromptAliases(loadable.value, aliases);
    if (backfilled === loadable.value) return;
    void setDrafts(backfilled);
  }, [aliases, loadable, setDrafts]);
  const setPrompt = useCallback(
    (nextPrompt: string) =>
      setDrafts((current) => updateComposerPromptDrafts(current, aliases, nextPrompt)),
    [aliases, setDrafts],
  );
  const clear = useCallback(() => setPrompt(""), [setPrompt]);
  const readPrompt = useCallback(
    () =>
      readComposerPromptDraft(
        store.jotaiStore.get(getConcretePersistedAtom(store, composerPromptDraftsAtom)).value,
        aliases,
      ),
    [aliases, store],
  );
  return useMemo(
    () => ({ loadable, aliases, prompt, readPrompt, setPrompt, clear }),
    [aliases, clear, loadable, prompt, readPrompt, setPrompt],
  );
}

function createTransferId(): string {
  return typeof crypto?.randomUUID === "function"
    ? crypto.randomUUID()
    : `composer-transfer:${Date.now()}:${Math.random()}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodePromptRange(
  value: Record<string, unknown>,
  textLength: number,
): { readonly from: number; readonly to: number } | null {
  if (!Number.isInteger(value.from) || !Number.isInteger(value.to)) return null;
  const from = Number(value.from);
  const to = Number(value.to);
  if (from < 0 || to <= from || to > textLength) return null;
  return { from, to };
}

function decodePromptLink(value: unknown, textLength: number): readonly ComposerPromptLinkMark[] {
  if (!isRecord(value) || typeof value.href !== "string" || !value.href.trim()) return [];
  const range = decodePromptRange(value, textLength);
  return range ? [{ ...range, href: value.href }] : [];
}

function decodePromptMention(value: unknown, textLength: number): readonly ComposerPromptMention[] {
  if (!isRecord(value)) return [];
  const range = decodePromptRange(value, textLength);
  if (!range) return [];
  if (
    value.kind !== "skill" &&
    value.kind !== "plugin" &&
    value.kind !== "app" &&
    value.kind !== "agent" &&
    value.kind !== "chatgpt-conversation" &&
    value.kind !== "file" &&
    value.kind !== "site" &&
    value.kind !== "thread"
  )
    return [];
  if (typeof value.id !== "string" || !value.id.trim()) return [];
  if (typeof value.label !== "string" || !value.label.trim()) return [];
  if (value.path !== undefined && typeof value.path !== "string") return [];
  return [
    {
      ...range,
      kind: value.kind,
      id: value.id,
      label: value.label,
      ...(value.path === undefined ? {} : { path: value.path }),
    },
  ];
}
