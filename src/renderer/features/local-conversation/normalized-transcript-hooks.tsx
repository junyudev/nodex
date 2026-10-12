import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  useCodexAppServerManagerForConversationId,
  useCodexConversationValue,
} from "./local-conversation-store";
import { useConversationRuntimeOverride } from "./conversation-runtime";
import type { CodexConversationTurn } from "../../../shared/types";
import type { ThreadTranscriptBlockModel } from "./thread-stage-types";
import {
  CodexTranscriptReadOwner,
  type CodexTranscriptTurnSlice,
} from "./normalized-transcript-read-owner";
import { resolveCodexReasoningSummaryPresentation } from "../../../shared/codex-reasoning-presentation";

export const CodexTranscriptReadOwnerContext = createContext<CodexTranscriptReadOwner | null>(null);
export const CodexTranscriptTurnEntityContext = createContext<string | null>(null);
export const CodexTranscriptTurnStatusContext =
  createContext<CodexTranscriptTurnSlice["presentationStatus"]>(undefined);
const subscribeNothing = () => () => {};
const readEmptyStructure = () => null;

export function CodexTranscriptReadOwnerProvider({
  conversationId,
  hostId,
  children,
}: {
  readonly conversationId: string | null;
  readonly hostId: string;
  readonly children: ReactNode;
}) {
  const owner = useCodexTranscriptReadOwner(conversationId, hostId);
  return (
    <CodexTranscriptReadOwnerContext.Provider value={owner}>
      {children}
    </CodexTranscriptReadOwnerContext.Provider>
  );
}

export function useCodexTranscriptReadOwner(conversationId: string | null, hostId?: string) {
  const override = useConversationRuntimeOverride();
  const manager = useCodexAppServerManagerForConversationId(conversationId, hostId);
  const hasCanonicalState = useCodexConversationValue(
    conversationId,
    (conversation) => conversation?.canonicalState != null,
  );
  return useMemo(
    () =>
      !override && hasCanonicalState && conversationId
        ? manager.getTranscriptReadOwner(conversationId)
        : null,
    [conversationId, hasCanonicalState, manager, override],
  );
}

export function useCodexConversationTranscriptStructure(conversationId: string | null) {
  const owner = useCodexTranscriptReadOwner(conversationId);
  const structure = useSyncExternalStore(
    owner?.subscribeStructure ?? subscribeNothing,
    owner?.readStructure ?? readEmptyStructure,
  );
  return { owner, structure };
}

export function useCodexTranscriptStructure() {
  const owner = useContext(CodexTranscriptReadOwnerContext);
  const structure = useSyncExternalStore(
    owner?.subscribeStructure ?? subscribeNothing,
    owner?.readStructure ?? readEmptyStructure,
  );
  return { owner, structure };
}

/** Raw text is deliberately absent from this snapshot; only row topology wakes the row. */
export function useCodexTranscriptTurn(
  entityKey: string | null,
  fallback: CodexConversationTurn | null,
  slice?: CodexTranscriptTurnSlice,
): CodexConversationTurn | null {
  const owner = useContext(CodexTranscriptReadOwnerContext);
  return useCodexTranscriptTurnFromOwner(owner, entityKey, fallback, slice);
}

export function useCodexTranscriptTurnFromOwner(
  owner: CodexTranscriptReadOwner | null,
  entityKey: string | null,
  fallback: CodexConversationTurn | null,
  slice?: CodexTranscriptTurnSlice,
): CodexConversationTurn | null {
  const subscribe = useCallback(
    (listener: () => void) =>
      owner && entityKey ? owner.subscribeTurn(entityKey, listener) : () => {},
    [entityKey, owner],
  );
  const version = useSyncExternalStore(subscribe, () =>
    owner && entityKey ? owner.readTurnVersion(entityKey) : 0,
  );
  return useMemo(() => {
    if (!owner || !entityKey) return fallback;
    if (owner.readTurnVersion(entityKey) !== version) return null;
    return slice ? owner.readTurnSlice(entityKey, slice) : owner.readTurn(entityKey);
  }, [entityKey, fallback, owner, slice, version]);
}

/** Canonical text leaves retain their display identity while reading only their raw owner. */
export function useCodexTranscriptBlock(
  block: ThreadTranscriptBlockModel,
): ThreadTranscriptBlockModel {
  const owner = useContext(CodexTranscriptReadOwnerContext);
  const entityKey = useContext(CodexTranscriptTurnEntityContext);
  const presentationStatus = useContext(CodexTranscriptTurnStatusContext);
  const itemId =
    block.type === "assistantMessage" ||
    block.type === "reasoning" ||
    block.type === "proposedPlan" ||
    block.type === "exec"
      ? block.entry.rawItemId
      : undefined;
  const subscribe = useCallback(
    (listener: () => void) =>
      owner && entityKey && itemId ? owner.subscribeItem(entityKey, itemId, listener) : () => {},
    [entityKey, itemId, owner],
  );
  const item = useSyncExternalStore(subscribe, () =>
    owner && entityKey && itemId
      ? owner.readProjectedItem(entityKey, itemId, block.entry.itemId, presentationStatus)
      : null,
  );
  if (!item) return block;
  return { ...block, entry: item, status: item.status, updatedAt: item.updatedAt };
}

/** The compact thinking label is a separate keyed consumer from the complete Turn model. */
export function CodexTranscriptReasoningSummary({
  item,
  fallback,
}: {
  readonly item: ThreadTranscriptBlockModel | null;
  readonly fallback: string | null;
}) {
  const block = useCodexTranscriptBlock(item ?? EMPTY_REASONING_BLOCK);
  const summary = item
    ? resolveCodexReasoningSummaryPresentation([
        {
          itemId: block.entry.itemId,
          normalizedKind: block.entry.kind,
          semanticKind: block.entry.semanticKind,
          markdownText: block.entry.markdownText,
        },
      ])
    : null;
  return <>{summary?.text ?? fallback ?? "Thinking"}</>;
}

const EMPTY_REASONING_BLOCK: ThreadTranscriptBlockModel = {
  id: "unbound-reasoning",
  turnId: null,
  createdAt: 0,
  updatedAt: 0,
  searchableText: "",
  type: "reasoning",
  entry: {
    threadId: "",
    turnId: null,
    itemId: "",
    type: "reasoning",
    kind: "reasoning",
    createdAt: 0,
    updatedAt: 0,
  },
};
