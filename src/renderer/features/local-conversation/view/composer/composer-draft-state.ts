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
  preloadPersistedAtom,
  useScopeHandle,
  useSetPersistedAtom,
  type PersistedLoadable,
  type MaitaiStore,
  type ScopeHandle,
} from "@/lib/maitai";
import {
  createResolvedComposerImageAttachment,
  isAbsoluteComposerImagePath,
  isManagedComposerImageSource,
  type ComposerImageAttachment,
} from "./image-attachments/composer-image-attachment-model";
import type { CodexAppModelContextAttachment } from "../../../../../shared/codex-untrusted-app-input";
import type { BrowserAnnotationAttachment } from "../../../../../shared/browser-annotation";
import type { ImageEditComposerDraftSnapshot } from "@/lib/image-edit-composer-channel";

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

export interface ComposerCompletedDraftSnapshot extends Partial<
  import("../../thread-text-selection-draft").ThreadTextSelectionDraftSnapshot
> {
  readonly prompt: string;
  readonly promptDocument?: ComposerPromptDocument;
  readonly fileAttachments: readonly ComposerFileAttachment[];
  readonly addedFiles: readonly ComposerFileAttachment[];
  readonly imageAttachments: readonly ComposerImageAttachment[];
  readonly appshotContexts: readonly CodexComposerAppshotContext[];
  readonly pastedTextAttachments: readonly ComposerPastedTextAttachment[];
  readonly commentAttachments: readonly CodexReviewDiffCommentAttachment[];
  readonly appModelContextAttachments?: readonly CodexAppModelContextAttachment[];
  readonly browserAnnotationAttachments?: readonly BrowserAnnotationAttachment[];
  readonly imageEditDraft?: ImageEditComposerDraftSnapshot;
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

export const COMPOSER_IMAGE_DRAFTS_STORAGE_KEY = "composer-image-drafts-v1";

/** An image in a saved draft, kept by where it was already saved, never by its bytes. */
export interface PersistedComposerImage {
  readonly id: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly hostId: string;
  readonly managedSource: string | null;
  readonly localPath: string | null;
}

export type ComposerImageDraftMap = Record<string, readonly PersistedComposerImage[]>;

const optionalString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value : null;

function decodePersistedComposerImage(value: unknown): readonly PersistedComposerImage[] {
  if (!isRecord(value)) return [];
  const id = optionalString(value.id);
  const filename = optionalString(value.filename);
  const mimeType = optionalString(value.mimeType);
  const hostId = optionalString(value.hostId);
  const managedSource = optionalString(value.managedSource);
  const localPath = optionalString(value.localPath);
  if (!id || !filename || !mimeType || !hostId) return [];
  if (managedSource && !isManagedComposerImageSource(managedSource)) return [];
  if (localPath && !isAbsoluteComposerImagePath(localPath)) return [];
  if (!managedSource && !localPath) return [];
  return [{ id, filename, mimeType, hostId, managedSource, localPath }];
}

function decodeComposerImageDraftMap(value: unknown): ComposerImageDraftMap {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([alias, images]) =>
      alias.trim() && Array.isArray(images)
        ? [[alias, images.flatMap(decodePersistedComposerImage)] as const]
        : [],
    ),
  );
}

export const composerImageDraftsAtom = persistedAtom<ComposerImageDraftMap>({
  debugLabel: "composer-image-drafts",
  storageKey: COMPOSER_IMAGE_DRAFTS_STORAGE_KEY,
  defaultValue: {},
  hydration: "eager",
  synchronization: "cross-window",
  optimistic: true,
  writeFailure: "retain-and-error",
  decode: decodeComposerImageDraftMap,
  encode: (value) => ({ ...value }),
});

/** The draft's images that can come back after a restart: those already saved somewhere. */
export function persistableComposerImages(
  attachments: readonly ComposerImageAttachment[],
): readonly PersistedComposerImage[] {
  return attachments.flatMap((attachment): PersistedComposerImage[] => {
    const saved = attachment.materialization;
    if (attachment.materializationStatus !== "ready" || !saved) return [];
    if (!saved.managedSource && !saved.localPath) return [];
    return [
      {
        id: attachment.id,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        hostId: saved.hostId,
        managedSource: saved.managedSource,
        localPath: saved.localPath,
      },
    ];
  });
}

/** A saved draft's images as attachments again, shown from where they were saved. */
export function restoreComposerImages(
  images: readonly PersistedComposerImage[],
  generation: number,
): readonly ComposerImageAttachment[] {
  return images.flatMap((image) => {
    const attachment = createResolvedComposerImageAttachment({
      value: {
        id: image.id,
        filename: image.filename,
        mimeType: image.mimeType,
        src: image.managedSource ?? image.localPath ?? "",
        origin: "restored",
        localPath: image.localPath,
        managedSource: image.managedSource,
        hostId: image.hostId,
      },
      id: image.id,
      generation,
    });
    return attachment ? [attachment] : [];
  });
}

export function updateComposerImageDrafts(
  drafts: ComposerImageDraftMap,
  aliases: readonly string[],
  images: readonly PersistedComposerImage[],
): ComposerImageDraftMap {
  const next = { ...drafts };
  for (const alias of aliases) {
    if (images.length === 0) delete next[alias];
    else next[alias] = images;
  }
  return next;
}

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
  assertComposerDraftTransferReady(snapshot);
  return {
    ...snapshot,
    transferId: createTransferId(),
    targetConversationId: normalizedConversationId,
  };
}

function assertComposerDraftTransferReady(snapshot: ComposerCompletedDraftSnapshot): void {
  if (snapshot.pastedTextAttachments.some((attachment) => attachment.status !== "ready")) {
    throw new Error("Finish or remove pasted text attachments before saving this draft");
  }
  if (
    snapshot.imageAttachments.some(
      (attachment) =>
        attachment.materializationStatus !== "ready" ||
        attachment.materialization === null ||
        attachment.uploadStatus !== "idle",
    )
  ) {
    throw new Error("Finish or remove image attachments before saving this draft");
  }
}

/** Saves the target's restart-safe draft before its conversation is mounted. */
export async function persistComposerDraftTransfer(
  store: MaitaiStore,
  transfer: ComposerDraftTransfer,
): Promise<void> {
  const targetConversationId = transfer.targetConversationId.trim();
  if (!targetConversationId) throw new Error("Composer transfer requires a target conversation id");
  assertComposerDraftTransferReady(transfer);
  const images = persistableComposerImages(transfer.imageAttachments);
  if (
    images.length !== transfer.imageAttachments.length ||
    images.some((image) => decodePersistedComposerImage(image).length !== 1)
  ) {
    throw new Error("Image attachments must be saved locally before saving this draft");
  }
  await Promise.all([
    preloadPersistedAtom(store, composerPromptDraftsAtom),
    preloadPersistedAtom(store, composerImageDraftsAtom),
  ]);
  const promptAtom = getConcretePersistedAtom(store, composerPromptDraftsAtom);
  const imageAtom = getConcretePersistedAtom(store, composerImageDraftsAtom);
  for (const loadable of [store.jotaiStore.get(promptAtom), store.jotaiStore.get(imageAtom)]) {
    if (loadable.status !== "ready") {
      throw loadable.error ?? new Error("Composer draft storage is not ready");
    }
  }
  const aliases = [`local:${targetConversationId}`];
  const document = transfer.promptDocument ?? { text: transfer.prompt, links: [], mentions: [] };
  const expectedDocument = JSON.stringify(
    deserializeComposerPromptDraft(serializeComposerPromptDraft(document)),
  );
  const expectedImages = JSON.stringify(images.flatMap(decodePersistedComposerImage));
  const assertPromptUnchanged = (drafts: ComposerPromptDraftMap): void => {
    const existing = readComposerPromptDocument(drafts, aliases);
    if (existing.text.length > 0 && JSON.stringify(existing) !== expectedDocument) {
      throw new Error("The saved conversation's draft changed. Keep this side chat open.");
    }
  };
  const assertImagesUnchanged = (drafts: ComposerImageDraftMap): void => {
    const existing = drafts[aliases[0]!] ?? [];
    if (existing.length > 0 && JSON.stringify(existing) !== expectedImages) {
      throw new Error("The saved conversation's images changed. Keep this side chat open.");
    }
  };
  assertPromptUnchanged(store.jotaiStore.get(promptAtom).value);
  assertImagesUnchanged(store.jotaiStore.get(imageAtom).value);
  const writes = await Promise.allSettled([
    store.jotaiStore.set(promptAtom, (drafts) => {
      assertPromptUnchanged(drafts);
      return updateComposerPromptDocumentDrafts(drafts, aliases, document);
    }),
    store.jotaiStore.set(imageAtom, (drafts) => {
      assertImagesUnchanged(drafts);
      return updateComposerImageDrafts(drafts, aliases, images);
    }),
  ]);
  for (const write of writes) {
    if (write.status === "rejected") throw write.reason;
  }
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
  return readComposerPromptDocument(drafts, aliases).text;
}

export function readComposerPromptDocument(
  drafts: ComposerPromptDraftMap,
  aliases: readonly string[],
): ComposerPromptDocument {
  for (const alias of aliases) {
    if (Object.prototype.hasOwnProperty.call(drafts, alias)) {
      return deserializeComposerPromptDraft(drafts[alias] ?? "");
    }
  }
  return { text: "", links: [], mentions: [] };
}

export function updateComposerPromptDrafts(
  drafts: ComposerPromptDraftMap,
  aliases: readonly string[],
  prompt: string,
): ComposerPromptDraftMap {
  return updateComposerPromptDocumentDrafts(drafts, aliases, {
    text: prompt,
    links: [],
    mentions: [],
  });
}

export function updateComposerPromptDocumentDrafts(
  drafts: ComposerPromptDraftMap,
  aliases: readonly string[],
  document: ComposerPromptDocument,
): ComposerPromptDraftMap {
  const next = { ...drafts };
  if (document.text.length === 0) {
    for (const alias of aliases) delete next[alias];
    return next;
  }
  const serialized = serializeComposerPromptDraft(document);
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
  readDocument(): ComposerPromptDocument;
  setPrompt(prompt: string): Promise<void>;
  setDocument(document: ComposerPromptDocument): Promise<void>;
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
  const setDocument = useCallback(
    (document: ComposerPromptDocument) =>
      setDrafts((current) => updateComposerPromptDocumentDrafts(current, aliases, document)),
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
  const readDocument = useCallback(
    () =>
      readComposerPromptDocument(
        store.jotaiStore.get(getConcretePersistedAtom(store, composerPromptDraftsAtom)).value,
        aliases,
      ),
    [aliases, store],
  );
  return useMemo(
    () => ({ loadable, aliases, prompt, readPrompt, readDocument, setPrompt, setDocument, clear }),
    [aliases, clear, loadable, prompt, readPrompt, readDocument, setPrompt, setDocument],
  );
}

export interface ComposerImageDraftController {
  readonly loadable: PersistedLoadable<ComposerImageDraftMap>;
  readonly images: readonly PersistedComposerImage[];
  setImages(images: readonly PersistedComposerImage[]): Promise<void>;
}

/** The thread Composer's saved images, kept under the same draft identities as its text. */
export function useComposerImageDraft(
  threadId: string | null | undefined,
): ComposerImageDraftController {
  const composerHandle = useScopeHandle(ComposerScope);
  const loadable = usePersistedAtomValue(composerImageDraftsAtom);
  const setDrafts = useSetPersistedAtom(composerImageDraftsAtom);
  const aliases = useMemo(
    () => buildComposerPromptAliases(composerHandle.path, threadId),
    [composerHandle.path, threadId],
  );
  const images = useMemo(
    () => aliases.map((alias) => loadable.value[alias]).find((saved) => saved !== undefined) ?? [],
    [aliases, loadable.value],
  );
  const setImages = useCallback(
    (next: readonly PersistedComposerImage[]) =>
      setDrafts((current) => updateComposerImageDrafts(current, aliases, next)),
    [aliases, setDrafts],
  );
  return useMemo(() => ({ loadable, images, setImages }), [images, loadable, setImages]);
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
