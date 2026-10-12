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
  type CodexTranscriptGeneratedImage,
} from "./normalized-transcript-read-owner";
import { resolveCodexReasoningSummaryPresentation } from "../../../shared/codex-reasoning-presentation";
import type { ConversationTurnListEntry } from "./selectors";
import { isNormalizedConversationTurnEntry } from "./selectors";
import { isCodexTimelineTurnEntry } from "./projection/normalized-timeline-entries";
import {
  resolveThreadLatestTurnPhase,
  type ThreadLatestTurnPhase,
} from "./view/local-conversation-turn-virtualization";

export const CodexTranscriptReadOwnerContext = createContext<CodexTranscriptReadOwner | null>(null);
export const CodexTranscriptTurnEntityContext = createContext<string | null>(null);
export const CodexTranscriptTurnStatusContext =
  createContext<CodexTranscriptTurnSlice["presentationStatus"]>(undefined);
const subscribeNothing = () => () => {};
const readEmptyStructure = () => null;
const emptyGeneratedImages: readonly CodexTranscriptGeneratedImage[] = Object.freeze([]);
const readEmptyGeneratedImages = () => emptyGeneratedImages;

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

/** Generated image presentation shares the resident index without subscribing to unrelated transcript text. */
export function useCodexTranscriptGeneratedImages(owner: CodexTranscriptReadOwner | null) {
  return useSyncExternalStore(
    owner?.subscribeGeneratedImages ?? subscribeNothing,
    owner?.readGeneratedImages ?? readEmptyGeneratedImages,
  );
}

/** Placement reads only latest-Turn lifecycle and keyed raw slots; stream text never projects a full Turn. */
export function useCodexTranscriptLatestTurnMetadata(entry: ConversationTurnListEntry | null): {
  readonly isInProgress: boolean;
  readonly phase: ThreadLatestTurnPhase;
  readonly latestSteeringUserMessageKey: string | null;
} | null {
  const owner = useContext(CodexTranscriptReadOwnerContext);
  const entityKey =
    entry && isNormalizedConversationTurnEntry(entry) ? entry.historyEntityKey : null;
  const subscribe = useCallback(
    (listener: () => void) =>
      owner && entityKey ? owner.subscribeTurn(entityKey, listener) : () => {},
    [entityKey, owner],
  );
  const version = useSyncExternalStore(subscribe, () =>
    owner && entityKey ? owner.readTurnVersion(entityKey) : 0,
  );
  return useMemo(() => {
    if (!entry) return null;
    if (!isNormalizedConversationTurnEntry(entry) || !owner || !entityKey) {
      const turn = isNormalizedConversationTurnEntry(entry) ? entry.readTurn() : entry.turn;
      if (!turn) return null;
      const steering = turn.items.findLast(
        (item) => item.rawItemType === "steeringUserMessage" || item.type === "steeringUserMessage",
      );
      return {
        isInProgress: turn.status === "inProgress",
        phase: resolveThreadLatestTurnPhase(turn),
        latestSteeringUserMessageKey: steering?.rawItemId ?? steering?.itemId ?? null,
      };
    }
    const details = owner.readTurnDetails(entityKey);
    if (owner.readTurnVersion(entityKey) !== version) return null;
    if (!details) return null;
    const slice = isCodexTimelineTurnEntry(entry) ? entry.timelineSlice : undefined;
    const itemIds =
      slice?.itemIds ?? owner.readItemSlots(entityKey)?.entries.map(({ itemId }) => itemId) ?? [];
    const items = itemIds.flatMap((itemId) => {
      const item = owner.readItem(entityKey, itemId);
      return item ? [item] : [];
    });
    const steering = owner.readLatestSteeringItem(entityKey);
    const activeVoice = slice?.work?.presentation === "voice-work" && slice.work.state === "active";
    let commentary = false;
    let phase: ThreadLatestTurnPhase = "idle";
    if (entry.turnStatus === "inProgress") {
      for (const item of items) {
        if (item.type !== "agentMessage" || activeVoice) continue;
        if (item.phase === "commentary") {
          commentary = true;
          continue;
        }
        phase = "final_answer";
        break;
      }
      if (phase === "idle")
        phase =
          activeVoice || commentary || details.firstTurnWorkItemStartedAtMs != null
            ? "prework"
            : details.finalAssistantStartedAtMs == null
              ? "idle"
              : "final_answer";
    }
    return {
      isInProgress: entry.turnStatus === "inProgress",
      phase,
      latestSteeringUserMessageKey:
        steering?.type === "steeringUserMessage" ? (steering.restoreMessage.id ?? null) : null,
    };
  }, [entityKey, entry, owner, version]);
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
