import type { GeneratedImageDescriptor } from "../model/types";
import type { CodexConversationSnapshot } from "@/lib/types";
import { buildCodexTurnOccurrenceKey } from "../../../../shared/codex-turn-identity";
import { projectCodexMarkdownLabel } from "../../../../shared/codex-markdown-text";
import { resolveGeneratedImageOutputState } from "@/features/local-conversation/projection/generated-image-output";
import { OPTIMISTIC_IMAGE_EDIT_PREFIX } from "../model/generated-image-collection";

export interface GeneratedImageLiveGroup {
  readonly id: string;
  readonly images: readonly GeneratedImageDescriptor[];
  readonly pendingImageCount: number;
  readonly turnStartedAtMs: number | null;
}

export interface GeneratedImageLiveCollectionSnapshot {
  readonly groups: readonly GeneratedImageLiveGroup[];
  readonly images: readonly GeneratedImageDescriptor[];
  readonly revision: number;
}

export interface GeneratedImageLiveGroupInput {
  readonly id: string;
  readonly images: readonly GeneratedImageDescriptor[];
  readonly pendingImageCount: number;
  readonly turnStartedAtMs: number | null;
}

const EMPTY_SNAPSHOT: GeneratedImageLiveCollectionSnapshot = Object.freeze({
  groups: Object.freeze([]),
  images: Object.freeze([]),
  revision: 0,
});

interface Registration<T> {
  readonly order: number;
  readonly value: T;
}

interface OptimisticGeneratedImageEdit {
  readonly baselineReadyImageIds: ReadonlySet<string>;
  readonly createdAtMs: number;
  readonly id: string;
  readonly liveTailGroupId: string | null;
  readonly liveTailImageCount: number;
}

export interface OptimisticGeneratedImageEditTransaction {
  readonly createdAtMs: number;
  readonly id: string;
  rollback(): void;
}

const mountedGroupRegistrationsByThreadId = new Map<
  string,
  Map<string, Map<symbol, Registration<GeneratedImageLiveGroupInput>>>
>();
const canonicalGroupRegistrationsByThreadId = new Map<
  string,
  Map<symbol, Registration<readonly GeneratedImageLiveGroupInput[]>>
>();
const snapshotsByThreadId = new Map<string, GeneratedImageLiveCollectionSnapshot>();
const optimisticEditsByThreadId = new Map<string, Map<string, OptimisticGeneratedImageEdit>>();
const listeners = new Set<() => void>();
let registrationOrder = 0;

function resolveGroupStartedAt(turn: CodexConversationSnapshot["turns"][number]): number | null {
  return (
    turn.turnStartedAtMs ??
    turn.startedAt ??
    turn.items.reduce<number | null>(
      (earliest, item) => (earliest === null ? item.createdAt : Math.min(earliest, item.createdAt)),
      null,
    )
  );
}

/** Projects every loaded turn, including virtualized history, into Canvas groups. */
export function projectGeneratedImageCanonicalGroups(
  conversation: CodexConversationSnapshot | null,
): readonly GeneratedImageLiveGroupInput[] {
  if (!conversation) return [];
  const conversationTitle = projectCodexMarkdownLabel(conversation.threadName);
  let imageNumber = 0;
  return conversation.turns.flatMap((turn, turnIndex) => {
    const output = resolveGeneratedImageOutputState({
      endResourcePaths: [],
      isTurnInProgress: turn.status === "inProgress",
      items: turn.items,
    });
    if (!output.shouldRender) return [];
    const id = `${buildCodexTurnOccurrenceKey(turn.turnId, turnIndex, turn.entityKey)}:generated-image-gallery`;
    const turnStartedAtMs = resolveGroupStartedAt(turn);
    return [
      {
        id,
        images: output.visibleCompletedItems.flatMap((item) => {
          const src = item.generatedImage?.src;
          if (!src) return [];
          imageNumber += 1;
          const alt = `Generated image ${imageNumber}`;
          return [
            {
              id: item.itemId,
              alt,
              attachmentId: item.itemId.startsWith("image-playground:")
                ? item.itemId
                : `image-playground:${item.itemId}`,
              attachmentSrc: src,
              downloadSrc: src,
              generatedOrdinal: imageNumber,
              groupId: id,
              previewSrc: src,
              referrerPolicy: "no-referrer" as const,
              source: "generated" as const,
              src,
              status: "ready" as const,
              tabTitle: conversationTitle ? `${conversationTitle} - ${alt}` : alt,
              turnId: turn.turnId ?? undefined,
              turnStartedAtMs: turnStartedAtMs ?? undefined,
            },
          ];
        }),
        pendingImageCount: output.pendingImageCount,
        turnStartedAtMs,
      },
    ];
  });
}

export function areGeneratedImageLiveGroupsEqual(
  left: readonly GeneratedImageLiveGroupInput[],
  right: readonly GeneratedImageLiveGroupInput[],
): boolean {
  return (
    left.length === right.length &&
    left.every((group, index) => {
      const candidate = right[index];
      return (
        candidate !== undefined &&
        group.id === candidate.id &&
        group.pendingImageCount === candidate.pendingImageCount &&
        group.turnStartedAtMs === candidate.turnStartedAtMs &&
        group.images.length === candidate.images.length &&
        group.images.every((image, imageIndex) => {
          const other = candidate.images[imageIndex];
          return (
            other !== undefined &&
            image.id === other.id &&
            image.alt === other.alt &&
            image.attachmentSrc === other.attachmentSrc &&
            image.downloadSrc === other.downloadSrc &&
            image.error === other.error &&
            image.generatedOrdinal === other.generatedOrdinal &&
            image.loading === other.loading &&
            image.previewSrc === other.previewSrc &&
            image.src === other.src &&
            image.status === other.status &&
            image.tabTitle === other.tabTitle
          );
        })
      );
    })
  );
}

function notify(): void {
  for (const listener of listeners) listener();
}

function latestRegistration<T>(
  registrations: ReadonlyMap<symbol, Registration<T>> | undefined,
): T | null {
  let latest: Registration<T> | null = null;
  for (const registration of registrations?.values() ?? []) {
    if (!latest || registration.order > latest.order) latest = registration;
  }
  return latest?.value ?? null;
}

function resolveCanonicalGroups(threadId: string): readonly GeneratedImageLiveGroupInput[] {
  return latestRegistration(canonicalGroupRegistrationsByThreadId.get(threadId)) ?? [];
}

function mergeMountedGroupWithCanonical(
  mounted: GeneratedImageLiveGroupInput,
  canonical: GeneratedImageLiveGroupInput | undefined,
): GeneratedImageLiveGroupInput {
  if (!canonical) return mounted;
  const canonicalImagesById = new Map(canonical.images.map((image) => [image.id, image]));
  return {
    ...mounted,
    images: mounted.images.map((image) => {
      const canonicalImage = canonicalImagesById.get(image.id);
      if (!canonicalImage) return image;
      return {
        ...image,
        alt: canonicalImage.alt,
        tabTitle: canonicalImage.tabTitle,
      };
    }),
  };
}

function reconcileOptimisticEdits(
  threadId: string,
  groups: readonly GeneratedImageLiveGroupInput[],
): readonly OptimisticGeneratedImageEdit[] {
  const edits = optimisticEditsByThreadId.get(threadId);
  if (!edits || edits.size === 0) return [];
  const claimedReplacementIds = new Set<string>();
  for (const edit of edits.values()) {
    const liveTail = groups.at(-1);
    const positionalReplacement =
      liveTail?.id === edit.liveTailGroupId
        ? liveTail.images[edit.liveTailImageCount]
        : liveTail?.images.at(-1);
    const replacement =
      positionalReplacement?.status === "ready" &&
      positionalReplacement.loading !== true &&
      !edit.baselineReadyImageIds.has(positionalReplacement.id) &&
      !claimedReplacementIds.has(positionalReplacement.id)
        ? positionalReplacement
        : undefined;
    if (!replacement) continue;
    claimedReplacementIds.add(replacement.id);
    edits.delete(edit.id);
  }
  if (edits.size === 0) optimisticEditsByThreadId.delete(threadId);
  return [...edits.values()];
}

function makeOptimisticGroup(edit: OptimisticGeneratedImageEdit): GeneratedImageLiveGroupInput {
  return {
    id: edit.id,
    images: [
      {
        id: edit.id,
        alt: "Generating image…",
        attachmentSrc: "",
        generatedOrdinal: 0,
        groupId: edit.id,
        loading: true,
        source: "generated",
        src: "",
        status: "loading",
      },
    ],
    pendingImageCount: 0,
    turnStartedAtMs: null,
  };
}

function orderMergedGroups(
  groups: readonly GeneratedImageLiveGroupInput[],
  canonicalGroups: readonly GeneratedImageLiveGroupInput[],
): readonly GeneratedImageLiveGroupInput[] {
  const canonicalIndex = new Map(canonicalGroups.map((group, index) => [group.id, index]));
  return groups
    .map((group, insertionIndex) => ({ group, insertionIndex }))
    .sort((left, right) => {
      const leftOptimistic = left.group.id.startsWith(OPTIMISTIC_IMAGE_EDIT_PREFIX);
      const rightOptimistic = right.group.id.startsWith(OPTIMISTIC_IMAGE_EDIT_PREFIX);
      if (leftOptimistic !== rightOptimistic) return leftOptimistic ? 1 : -1;

      const leftCanonicalIndex = canonicalIndex.get(left.group.id);
      const rightCanonicalIndex = canonicalIndex.get(right.group.id);
      if (leftCanonicalIndex !== undefined && rightCanonicalIndex !== undefined) {
        return leftCanonicalIndex - rightCanonicalIndex;
      }

      const leftStartedAt = left.group.turnStartedAtMs;
      const rightStartedAt = right.group.turnStartedAtMs;
      if (leftStartedAt !== null && rightStartedAt !== null && leftStartedAt !== rightStartedAt) {
        return leftStartedAt - rightStartedAt;
      }
      return left.insertionIndex - right.insertionIndex;
    })
    .map(({ group }) => group);
}

function rebuild(threadId: string): void {
  const previous = snapshotsByThreadId.get(threadId) ?? EMPTY_SNAPSHOT;
  const canonicalGroups = resolveCanonicalGroups(threadId);
  const canonicalGroupsById = new Map(canonicalGroups.map((group) => [group.id, group]));
  const groupsById = new Map(canonicalGroupsById);
  const mountedGroups = mountedGroupRegistrationsByThreadId.get(threadId);
  for (const [groupId, registrations] of mountedGroups ?? []) {
    const mounted = latestRegistration(registrations);
    if (!mounted) continue;
    groupsById.set(
      groupId,
      mergeMountedGroupWithCanonical(mounted, canonicalGroupsById.get(groupId)),
    );
  }
  const orderedConcreteGroups = orderMergedGroups([...groupsById.values()], canonicalGroups);
  const optimisticEdits = reconcileOptimisticEdits(threadId, orderedConcreteGroups);
  for (const edit of optimisticEdits) {
    groupsById.set(edit.id, makeOptimisticGroup(edit));
  }
  if (groupsById.size === 0) {
    snapshotsByThreadId.delete(threadId);
    return;
  }
  const groups = orderMergedGroups([...groupsById.values()], canonicalGroups);
  let ordinal = 0;
  const normalizedGroups = groups.map((group) => {
    const images = group.images.map((image) => ({
      ...image,
      generatedOrdinal: ++ordinal,
      groupId: group.id,
      turnStartedAtMs: group.turnStartedAtMs ?? image.turnStartedAtMs,
    }));
    const pending = Array.from({ length: group.pendingImageCount }, (_, index) => ({
      id: `${group.id}:pending:${index}`,
      alt: "Generating image…",
      attachmentSrc: "",
      generatedOrdinal: ++ordinal,
      groupId: group.id,
      loading: true,
      source: "generated" as const,
      src: "",
      status: "loading" as const,
      turnStartedAtMs: group.turnStartedAtMs ?? undefined,
    }));
    return Object.freeze({ ...group, images: Object.freeze([...images, ...pending]) });
  });
  const images = normalizedGroups.flatMap((group) => group.images);
  snapshotsByThreadId.set(
    threadId,
    Object.freeze({
      groups: Object.freeze(normalizedGroups),
      images: Object.freeze(images),
      revision: previous.revision + 1,
    }),
  );
}

export function replaceGeneratedImageLiveGroup(
  threadId: string,
  group: GeneratedImageLiveGroupInput,
): () => void {
  const normalizedThreadId = threadId.trim();
  if (!normalizedThreadId) return () => {};
  const groups = mountedGroupRegistrationsByThreadId.get(normalizedThreadId) ?? new Map();
  const registrations = groups.get(group.id) ?? new Map();
  const token = Symbol(group.id);
  groups.set(group.id, registrations);
  mountedGroupRegistrationsByThreadId.set(normalizedThreadId, groups);
  registrations.set(token, {
    order: ++registrationOrder,
    value: group,
  });
  rebuild(normalizedThreadId);
  notify();
  return () => {
    const currentGroups = mountedGroupRegistrationsByThreadId.get(normalizedThreadId);
    const currentRegistrations = currentGroups?.get(group.id);
    currentRegistrations?.delete(token);
    if (currentRegistrations?.size === 0) currentGroups?.delete(group.id);
    if (currentGroups?.size === 0) {
      mountedGroupRegistrationsByThreadId.delete(normalizedThreadId);
    }
    rebuild(normalizedThreadId);
    notify();
  };
}

/** Registers the full thread snapshot so virtualized historic groups remain in Canvas. */
export function replaceGeneratedImageCanonicalGroups(
  threadId: string,
  groups: readonly GeneratedImageLiveGroupInput[],
): () => void {
  const normalizedThreadId = threadId.trim();
  if (!normalizedThreadId) return () => {};
  const registrations = canonicalGroupRegistrationsByThreadId.get(normalizedThreadId) ?? new Map();
  const token = Symbol(normalizedThreadId);
  canonicalGroupRegistrationsByThreadId.set(normalizedThreadId, registrations);
  registrations.set(token, {
    order: ++registrationOrder,
    value: groups.map((group) => Object.freeze({ ...group })),
  });
  rebuild(normalizedThreadId);
  notify();
  return () => {
    const current = canonicalGroupRegistrationsByThreadId.get(normalizedThreadId);
    current?.delete(token);
    if (current?.size === 0) {
      canonicalGroupRegistrationsByThreadId.delete(normalizedThreadId);
    }
    rebuild(normalizedThreadId);
    notify();
  };
}

export function getGeneratedImageLiveCollectionSnapshot(
  threadId: string,
): GeneratedImageLiveCollectionSnapshot {
  return snapshotsByThreadId.get(threadId.trim()) ?? EMPTY_SNAPSHOT;
}

export function subscribeGeneratedImageLiveCollections(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Adds one generated-edit placeholder until a newer generated image replaces it. */
export function beginOptimisticGeneratedImageEdit(
  threadId: string,
): OptimisticGeneratedImageEditTransaction | null {
  const normalizedThreadId = threadId.trim();
  if (!normalizedThreadId) return null;
  const createdAtMs = Date.now();
  const id = `${OPTIMISTIC_IMAGE_EDIT_PREFIX}${crypto.randomUUID()}`;
  const baselineReadyImageIds = new Set(
    getGeneratedImageLiveCollectionSnapshot(normalizedThreadId).images.flatMap((image) =>
      image.status === "ready" && image.loading !== true ? [image.id] : [],
    ),
  );
  const liveTail = getGeneratedImageLiveCollectionSnapshot(normalizedThreadId).groups.findLast(
    (group) => !group.id.startsWith(OPTIMISTIC_IMAGE_EDIT_PREFIX),
  );
  const edits = optimisticEditsByThreadId.get(normalizedThreadId) ?? new Map();
  optimisticEditsByThreadId.set(normalizedThreadId, edits);
  edits.set(id, {
    baselineReadyImageIds,
    createdAtMs,
    id,
    liveTailGroupId: liveTail?.id ?? null,
    liveTailImageCount: liveTail?.images.length ?? 0,
  });
  rebuild(normalizedThreadId);
  notify();
  return {
    createdAtMs,
    id,
    rollback() {
      const current = optimisticEditsByThreadId.get(normalizedThreadId);
      if (!current?.delete(id)) return;
      if (current.size === 0) optimisticEditsByThreadId.delete(normalizedThreadId);
      rebuild(normalizedThreadId);
      notify();
    },
  };
}

export function clearOptimisticGeneratedImageEdits(threadId: string): void {
  const normalizedThreadId = threadId.trim();
  if (!optimisticEditsByThreadId.delete(normalizedThreadId)) return;
  rebuild(normalizedThreadId);
  notify();
}
