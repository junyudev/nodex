import { getIntl } from "@/lib/i18n";
import type {
  BlockTransferReceipt,
  BlockTransferDocumentHead,
  BlockTransferIntentSource,
  BlockTransferDataSourcePlacement,
  BlockTransferMode,
  PagePromotionPolicy,
} from "../../../../shared/block-transfer";
import type { PublicBlockTransferIntent } from "../../../../shared/block-transfer-transport";

export const NODEX_BLOCK_TRANSFER_DRAG_MIME = "application/vnd.nodex.block-transfer.v2+json";

const VERSION = 2 as const;
const MAX_ITEMS = 128;
const MAX_PAYLOAD_LENGTH = 256 * 1024;
const MAX_ID_LENGTH = 512;

export interface CrossSurfaceBlockTransferPayload {
  readonly version: typeof VERSION;
  readonly kind: "block_transfer";
  readonly sessionId: string;
  readonly sourceSurfaceId: string;
  readonly projectId: string | null;
  readonly storeEpoch: string;
  readonly source: BlockTransferIntentSource;
  readonly rootBlockIds: readonly string[];
  readonly displayHints: readonly string[];
}

export const containsCanvasBlockDrag = (
  payload: Pick<CrossSurfaceBlockTransferPayload, "displayHints">,
): boolean => payload.displayHints.includes("canvas");

export const containsDatabaseBlockDrag = (
  payload: Pick<CrossSurfaceBlockTransferPayload, "displayHints">,
): boolean => payload.displayHints.includes("database");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isBoundedIdentity = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= MAX_ID_LENGTH &&
  value === value.trim();

const parseSource = (value: unknown): BlockTransferIntentSource | null => {
  if (!isRecord(value)) return null;
  if (
    value.kind === "library" &&
    Object.keys(value).length === 2 &&
    isBoundedIdentity(value.libraryId)
  ) {
    return { kind: "library", libraryId: value.libraryId };
  }
  if (value.kind === "page" && Object.keys(value).length === 2 && isBoundedIdentity(value.pageId)) {
    return { kind: "page", pageId: value.pageId };
  }
  if (
    value.kind === "document" &&
    Object.keys(value).length === 2 &&
    isBoundedIdentity(value.documentId)
  ) {
    return { kind: "document", documentId: value.documentId };
  }
  if (
    value.kind === "data_source" &&
    Object.keys(value).length === 2 &&
    isBoundedIdentity(value.dataSourceId)
  ) {
    return { kind: "data_source", dataSourceId: value.dataSourceId };
  }
  return null;
};

export const encodeBlockTransferDragPayload = (
  payload: Omit<CrossSurfaceBlockTransferPayload, "version" | "kind">,
): string => JSON.stringify({ version: VERSION, kind: "block_transfer", ...payload });

export const parseBlockTransferDragPayload = (
  serialized: string,
): CrossSurfaceBlockTransferPayload | null => {
  if (!serialized || serialized.length > MAX_PAYLOAD_LENGTH) return null;
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  if (value.version !== VERSION || value.kind !== "block_transfer") return null;
  if (
    !isBoundedIdentity(value.sessionId) ||
    !isBoundedIdentity(value.sourceSurfaceId) ||
    (value.projectId !== null && !isBoundedIdentity(value.projectId)) ||
    !isBoundedIdentity(value.storeEpoch)
  ) {
    return null;
  }
  const source = parseSource(value.source);
  if (!source) return null;
  if (
    !Array.isArray(value.rootBlockIds) ||
    value.rootBlockIds.length < 1 ||
    value.rootBlockIds.length > MAX_ITEMS ||
    !value.rootBlockIds.every(isBoundedIdentity) ||
    new Set(value.rootBlockIds).size !== value.rootBlockIds.length
  ) {
    return null;
  }
  if (
    !Array.isArray(value.displayHints) ||
    value.displayHints.length !== value.rootBlockIds.length ||
    !value.displayHints.every((hint) => typeof hint === "string" && hint.length <= MAX_ID_LENGTH)
  ) {
    return null;
  }
  return {
    version: VERSION,
    kind: "block_transfer",
    sessionId: value.sessionId,
    sourceSurfaceId: value.sourceSurfaceId,
    projectId: value.projectId,
    storeEpoch: value.storeEpoch,
    source,
    rootBlockIds: value.rootBlockIds,
    displayHints: value.displayHints,
  };
};

export const resolveCrossSurfaceTransferMode = (event: {
  readonly altKey: boolean;
}): BlockTransferMode => (event.altKey ? "copy" : "move");

export const resolvePagePromotionPolicy = (input: {
  readonly preferenceEnabled: boolean;
  readonly shiftKey: boolean;
}): PagePromotionPolicy =>
  input.preferenceEnabled && !input.shiftKey ? "task_shorthand_v1" : "literal";

export const blockTransferDropLabel = (
  mode: BlockTransferMode,
  target: "page" | "data_source",
): string =>
  mode === "copy"
    ? target === "data_source"
      ? getIntl().formatMessage({
          id: "database.crossSurfaceDrag.copyAsPage",
          defaultMessage: "Copy as Page",
        })
      : getIntl().formatMessage({
          id: "database.crossSurfaceDrag.copyIntoPage",
          defaultMessage: "Copy into page",
        })
    : target === "data_source"
      ? getIntl().formatMessage({
          id: "database.crossSurfaceDrag.moveToDatabase",
          defaultMessage: "Move to Database",
        })
      : getIntl().formatMessage({
          id: "database.crossSurfaceDrag.moveIntoPage",
          defaultMessage: "Move into page",
        });

export const buildBlockToDataSourceTransferIntent = (input: {
  readonly operationId: string;
  readonly projectId: string | null;
  readonly storeEpoch: string;
  readonly payload: CrossSurfaceBlockTransferPayload;
  readonly dataSourceId: string;
  readonly placement: BlockTransferDataSourcePlacement;
  readonly altKey: boolean;
  readonly promotionPolicy: PagePromotionPolicy;
  readonly causalDependencies?: readonly BlockTransferDocumentHead[];
}): PublicBlockTransferIntent => ({
  operationId: input.operationId,
  projectId: input.projectId,
  storeEpoch: input.storeEpoch,
  mode: resolveCrossSurfaceTransferMode(input),
  rootBlockIds: input.payload.rootBlockIds,
  causalDependencies: input.causalDependencies ?? [],
  source: input.payload.source,
  target: {
    kind: "data_source",
    dataSourceId: input.dataSourceId,
    placement: input.placement,
  },
  promotionPolicy: input.promotionPolicy,
});

export const hasDragType = (dataTransfer: Pick<DataTransfer, "types">, mime: string): boolean =>
  Array.from(dataTransfer.types).includes(mime);

export interface LocalBlockDragSession {
  readonly sessionId: string;
  readonly sourceSurfaceId: string;
  readonly payload: CrossSurfaceBlockTransferPayload;
  readonly taskShorthandPreviewHints?: readonly TaskShorthandPreviewHint[];
  readonly promotionPreviews?: readonly BlockPromotionPreview[];
}

export interface BlockPromotionPreview {
  readonly rootBlockId: string;
  readonly resultPageId?: string;
  readonly title: string;
}

export interface TaskShorthandPreviewHint {
  readonly rootBlockId: string;
  readonly priority: 0 | 1 | 2 | 3;
  readonly estimate: "XS" | "S" | "M" | "L" | "XL" | null;
  readonly tagCount: number;
}

export const summarizeBlockPagePromotionPreview = (input: {
  readonly mode: BlockTransferMode;
  readonly rootCount: number;
  readonly hints: readonly TaskShorthandPreviewHint[];
  readonly literal: boolean;
}): string => {
  const intl = getIntl();
  const action = intl.formatMessage(
    {
      id: "database.crossSurfaceDrag.promotionAction",
      defaultMessage:
        "{mode, select, copy {Copy} other {Move}} {count, plural, one {as Page} other {{count} as Pages}}",
    },
    { mode: input.mode, count: input.rootCount },
  );
  if (input.literal) {
    return intl.formatMessage(
      { id: "database.crossSurfaceDrag.literalPromotion", defaultMessage: "{action} · Literal" },
      { action },
    );
  }
  if (input.rootCount > 1 && input.hints.length > 0) {
    return intl.formatMessage(
      {
        id: "database.crossSurfaceDrag.shorthandPreview",
        defaultMessage: "{action} · {count} shorthand",
      },
      { action, count: input.hints.length },
    );
  }
  const hint = input.hints[0];
  if (!hint) return action;
  const details = [
    `P${hint.priority}`,
    hint.estimate,
    hint.tagCount > 0
      ? intl.formatMessage(
          {
            id: "database.crossSurfaceDrag.tagCount",
            defaultMessage: "{count, plural, one {{count} tag} other {{count} tags}}",
          },
          { count: hint.tagCount },
        )
      : null,
  ].filter(Boolean);
  return intl.formatMessage(
    { id: "database.crossSurfaceDrag.promotionDetails", defaultMessage: "{action} · {details}" },
    { action, details: details.join(" · ") },
  );
};

export const summarizeBlockPagePromotionReceipt = (
  receipt: BlockTransferReceipt,
): { readonly tone: "success" | "info"; readonly message: string } | null => {
  const promotions = receipt.transformationEvidence.map((evidence) => evidence.promotion);
  const applied = promotions.filter((promotion) => promotion.kind === "applied").length;
  const preserved = promotions.filter((promotion) => promotion.kind === "preserved").length;
  const candidates = applied + preserved;
  if (preserved > 0) {
    return {
      tone: "info",
      message: getIntl().formatMessage(
        {
          id: "database.crossSurfaceDrag.shorthandPreserved",
          defaultMessage:
            "{preserved, plural, one {{preserved} of {candidates} shorthand prefix wasn't applied; titles were kept.} other {{preserved} of {candidates} shorthand prefixes weren't applied; titles were kept.}}",
        },
        { preserved, candidates },
      ),
    };
  }
  if (applied > 0) {
    return {
      tone: "success",
      message: getIntl().formatMessage(
        {
          id: "database.crossSurfaceDrag.shorthandApplied",
          defaultMessage:
            "{applied, plural, one {Task shorthand applied.} other {{applied} task shorthands applied.}}",
        },
        { applied },
      ),
    };
  }
  return null;
};

export const summarizeBlockPageTransferSuccess = (
  mode: BlockTransferMode,
  rootCount: number,
): string =>
  getIntl().formatMessage(
    {
      id: "database.crossSurfaceDrag.transferSucceeded",
      defaultMessage:
        "{mode, select, copy {Copied} other {Moved}} {count, plural, one {as a Page} other {{count} blocks as Pages}}",
    },
    { mode, count: rootCount },
  );

export interface RegisterLocalBlockDragDropTarget {
  readonly surfaceId: string;
  readonly element: HTMLElement;
  readonly deactivate: () => void;
}

type LocalBlockDragDropTarget = RegisterLocalBlockDragDropTarget;

export interface ClaimLocalBlockDragDropTarget {
  readonly surfaceId: string;
  readonly event: Pick<Event, "composedPath">;
}

export class BlockDragSessionCoordinator {
  private active: LocalBlockDragSession | null = null;
  private readonly dropTargetsByElement = new WeakMap<HTMLElement, LocalBlockDragDropTarget>();
  private activeDropTarget: LocalBlockDragDropTarget | null = null;

  constructor(private readonly createSessionId: () => string = () => crypto.randomUUID()) {}

  start(
    input: Omit<
      CrossSurfaceBlockTransferPayload,
      "version" | "kind" | "sessionId" | "sourceSurfaceId"
    > & {
      readonly sourceSurfaceId: string;
      readonly taskShorthandPreviewHints?: readonly TaskShorthandPreviewHint[];
      readonly promotionPreviews?: readonly BlockPromotionPreview[];
    },
    dataTransfer: DataTransfer,
  ): LocalBlockDragSession {
    this.setActiveDropTarget(null);
    const sessionId = this.createSessionId();
    const payload: CrossSurfaceBlockTransferPayload = {
      version: VERSION,
      kind: "block_transfer",
      sessionId,
      sourceSurfaceId: input.sourceSurfaceId,
      projectId: input.projectId,
      storeEpoch: input.storeEpoch,
      source: input.source,
      rootBlockIds: [...input.rootBlockIds],
      displayHints: [...input.displayHints],
    };
    const session = {
      sessionId,
      sourceSurfaceId: input.sourceSurfaceId,
      payload,
      taskShorthandPreviewHints: [...(input.taskShorthandPreviewHints ?? [])],
      promotionPreviews: [...(input.promotionPreviews ?? [])],
    } satisfies LocalBlockDragSession;

    dataTransfer.setData(NODEX_BLOCK_TRANSFER_DRAG_MIME, encodeBlockTransferDragPayload(payload));
    dataTransfer.effectAllowed = "copyMove";
    this.active = session;
    return session;
  }

  registerDropTarget(input: RegisterLocalBlockDragDropTarget): () => void {
    const existing = this.dropTargetsByElement.get(input.element);
    if (existing) {
      throw new Error(`Block drag drop target ${existing.surfaceId} already owns this element`);
    }
    const target = { ...input } satisfies LocalBlockDragDropTarget;
    this.dropTargetsByElement.set(input.element, target);
    return () => {
      if (this.dropTargetsByElement.get(input.element) !== target) return;
      this.dropTargetsByElement.delete(input.element);
      if (this.activeDropTarget === target) this.setActiveDropTarget(null);
    };
  }

  claimDropTarget(input: ClaimLocalBlockDragDropTarget): boolean {
    if (!this.active) {
      this.setActiveDropTarget(null);
      return false;
    }
    const target = this.resolveDeepestDropTarget(input.event.composedPath());
    this.setActiveDropTarget(target);
    return target?.surfaceId === input.surfaceId;
  }

  releaseDropTarget(surfaceId: string): void {
    if (this.activeDropTarget?.surfaceId !== surfaceId) return;
    this.setActiveDropTarget(null);
  }

  resolve(
    dataTransfer: Pick<DataTransfer, "types"> | null | undefined,
  ): LocalBlockDragSession | null {
    if (!this.active || !dataTransfer) return null;
    if (!hasDragType(dataTransfer, NODEX_BLOCK_TRANSFER_DRAG_MIME)) return null;
    return this.active;
  }

  resolveDrop(
    dataTransfer: Pick<DataTransfer, "types" | "getData"> | null | undefined,
  ): LocalBlockDragSession | null {
    const session = this.resolve(dataTransfer);
    if (!session || !dataTransfer) return null;
    const token = parseBlockTransferDragPayload(
      dataTransfer.getData(NODEX_BLOCK_TRANSFER_DRAG_MIME),
    );
    return token?.sessionId === session.sessionId ? session : null;
  }

  end(input?: { readonly sessionId?: string; readonly sourceSurfaceId?: string }): void {
    if (!this.active) return;
    if (input?.sessionId && input.sessionId !== this.active.sessionId) return;
    if (input?.sourceSurfaceId && input.sourceSurfaceId !== this.active.sourceSurfaceId) {
      return;
    }
    this.setActiveDropTarget(null);
    this.active = null;
  }

  private resolveDeepestDropTarget(
    composedPath: readonly EventTarget[],
  ): LocalBlockDragDropTarget | null {
    for (const entry of composedPath) {
      if (!(entry instanceof HTMLElement)) continue;
      const target = this.dropTargetsByElement.get(entry);
      if (target) return target;
    }
    return null;
  }

  private setActiveDropTarget(target: LocalBlockDragDropTarget | null): void {
    if (this.activeDropTarget === target) return;
    const previous = this.activeDropTarget;
    this.activeDropTarget = target;
    previous?.deactivate();
  }
}

export const blockDragSessionCoordinator = new BlockDragSessionCoordinator();

export const beginLocalBlockDragSession = (
  input: Parameters<BlockDragSessionCoordinator["start"]>[0],
  dataTransfer: DataTransfer,
): LocalBlockDragSession => blockDragSessionCoordinator.start(input, dataTransfer);

export const endLocalBlockDragSession = (
  input?: Parameters<BlockDragSessionCoordinator["end"]>[0],
): void => blockDragSessionCoordinator.end(input);

/** Resolve an active local session during dragenter/dragover/dragleave without reading protected data. */
export const resolveLocalBlockDragOverSession = (
  dataTransfer: Pick<DataTransfer, "types"> | null | undefined,
): LocalBlockDragSession | null => blockDragSessionCoordinator.resolve(dataTransfer);

export const registerLocalBlockDragDropTarget = (
  input: RegisterLocalBlockDragDropTarget,
): (() => void) => blockDragSessionCoordinator.registerDropTarget(input);

export const claimLocalBlockDragDropTarget = (input: ClaimLocalBlockDragDropTarget): boolean =>
  blockDragSessionCoordinator.claimDropTarget(input);

export const releaseLocalBlockDragDropTarget = (surfaceId: string): void =>
  blockDragSessionCoordinator.releaseDropTarget(surfaceId);

/** Resolve the authoritative session only after its drop-readable token matches. */
export const resolveLocalBlockDragDropSession = (
  dataTransfer: Pick<DataTransfer, "types" | "getData"> | null | undefined,
): LocalBlockDragSession | null => blockDragSessionCoordinator.resolveDrop(dataTransfer);

export const shouldBlockNoteYieldManagedDrag = (session: LocalBlockDragSession | null): boolean => {
  // A local Nodex session means the side-menu gesture has a domain-level
  // placement owner. This includes ordinary same-Document reorders: crossing a
  // typed-owner sibling changes that owner's placement even when the dragged
  // subtree itself contains only ordinary Blocks.
  return session !== null;
};

/** Native cross-surface DnD is intentionally renderer-window local. */
export const shouldHandleNativeCrossSurfaceDrag = (
  dataTransfer: Pick<DataTransfer, "types">,
): boolean => resolveLocalBlockDragOverSession(dataTransfer) !== null;

if (typeof window !== "undefined") {
  window.addEventListener("blur", () => blockDragSessionCoordinator.end());
}
