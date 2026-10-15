import type { BlockNoteEditorOptions } from "@blocknote/core";
import { withCollaboration, type CollaborationOptions } from "@blocknote/core/yjs";
import type { Awareness } from "y-protocols/awareness";
import type { ContentRoutingContext } from "../../../../shared/content-routing-context";
import { contentRoutingContextKey } from "../../../../shared/content-routing-context";
import type * as Y from "yjs";

/**
 * A mounted NFM editor is always a view over an existing collaborative
 * Document. NFM parsing belongs to explicit import/export boundaries and must
 * never be used to rehydrate an editor after collaboration has started.
 */
export interface NfmEditorSource {
  readonly kind: "collaborative-document";
  readonly documentId: string;
  readonly storeEpoch: string;
  readonly generation: number;
  readonly clientSessionId: string;
  readonly fragment: Y.XmlFragment;
  readonly user: {
    readonly name: string;
    readonly color: string;
  };
  readonly provider?: {
    readonly awareness?: Awareness;
  };
  /** Stable EditorSurface identity used to keep collaborative undo local. */
  readonly transactionOrigin?: object;
  /** Editor-local invalidation hint. It is not a persistence callback. */
  readonly onDocumentChange?: () => void;
}

export type NfmEditorCollaborativeDocumentSource = NfmEditorSource;

const transactionOriginsByFragment = new WeakMap<Y.XmlFragment, Map<string, object>>();

const resolveTransactionOrigin = (source: NfmEditorSource): object => {
  if (source.transactionOrigin) return source.transactionOrigin;
  const origins = transactionOriginsByFragment.get(source.fragment) ?? new Map<string, object>();
  transactionOriginsByFragment.set(source.fragment, origins);
  const existing = origins.get(source.clientSessionId);
  if (existing) return existing;
  const origin = Object.freeze({ clientSessionId: source.clientSessionId });
  origins.set(source.clientSessionId, origin);
  return origin;
};

export function createNfmEditorCollaborationOptions(source: NfmEditorSource): CollaborationOptions {
  return {
    fragment: source.fragment,
    user: source.user,
    ...(source.provider ? { provider: source.provider } : {}),
    transactionOrigin: resolveTransactionOrigin(source),
  };
}

/**
 * Installs BlockNote's extension-backed collaboration mode around the complete
 * editor option set so its history and extension decisions cannot be
 * overwritten by later object spreads.
 */
export function createNfmEditorModeOptions<
  Options extends Partial<BlockNoteEditorOptions<any, any, any>> = Partial<
    BlockNoteEditorOptions<any, any, any>
  >,
>(source: NfmEditorSource, options?: Options): Options {
  return withCollaboration({
    ...(options ?? ({} as Options)),
    collaboration: createNfmEditorCollaborationOptions(source),
  });
}

const collaborativeFragmentIds = new WeakMap<Y.XmlFragment, number>();
let nextCollaborativeFragmentId = 1;

function getCollaborativeFragmentId(fragment: Y.XmlFragment): number {
  const existing = collaborativeFragmentIds.get(fragment);
  if (existing !== undefined) return existing;

  const next = nextCollaborativeFragmentId;
  nextCollaborativeFragmentId += 1;
  collaborativeFragmentIds.set(fragment, next);
  return next;
}

export function getNfmEditorInstanceKey(input: {
  readonly routingContext: ContentRoutingContext;
  readonly source: NfmEditorSource;
}): string {
  return [
    "collaborative-document",
    contentRoutingContextKey(input.routingContext),
    input.source.documentId,
    input.source.generation,
    getCollaborativeFragmentId(input.source.fragment),
  ].join(":");
}

export function resolveNfmEditorBlockActionCapabilities(
  hasSourcePageContext: boolean,
  executionProjectId: string | null,
): {
  readonly canMoveBlocks: boolean;
  readonly canSendBlocksToThread: boolean;
} {
  return {
    canMoveBlocks: hasSourcePageContext && executionProjectId !== null,
    canSendBlocksToThread: hasSourcePageContext && executionProjectId !== null,
  };
}
