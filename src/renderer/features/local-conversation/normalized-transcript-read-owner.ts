import type {
  CodexCanonicalItem,
  CodexCanonicalTurnState,
  CodexConversationItem,
  CodexConversationTurn,
} from "../../../shared/types";
import {
  applyCodexTranscriptTextChange,
  codexTranscriptItemAddress,
  type CodexTranscriptChange,
  type CodexTranscriptEvent,
  type CodexTranscriptItemSlots,
  type CodexTranscriptKey,
  type CodexTranscriptMetadata,
  type CodexTranscriptSnapshot,
  type CodexTranscriptRealtimeItem,
  type CodexTranscriptTurn,
} from "../../../shared/codex-transcript-projection";
import {
  projectCodexCanonicalTurnItemViews,
  projectCodexCanonicalTurnViews,
} from "../../../shared/codex-canonical-item-projector";
import { projectCodexItemViewToTranscriptEntry } from "../../../shared/codex-transcript-entry-projection";
import {
  CodexHistoryViewportRegistry,
  type CodexHistoryViewportBoundary,
} from "../../../shared/codex-history-policy";

export type CodexTranscriptReadConnection = (() => void) & {
  readonly setHistoryViewport?: (
    boundaries: readonly (CodexHistoryViewportBoundary | null)[],
  ) => void;
};

export interface CodexTranscriptStructure extends CodexTranscriptMetadata {
  readonly turns: readonly {
    readonly entityKey: string;
    readonly value: CodexTranscriptTurn;
    readonly itemIds: readonly (string | undefined)[];
    readonly hasUserMessage: boolean;
    readonly hasAssistantMessage: boolean;
    readonly hasMcpApp: boolean;
    readonly isStartupPrewarm: boolean;
  }[];
}

type Listener = () => void;
const EMPTY_SLOTS: CodexTranscriptItemSlots = { length: 0, entries: [] };

function transcriptMetadata(value: CodexTranscriptMetadata): CodexTranscriptMetadata {
  return {
    resumeState: value.resumeState,
    historyComplete: value.historyComplete,
    itemTimeline: value.itemTimeline,
    timeline: value.timeline,
    turnEntityKeys: value.turnEntityKeys,
  };
}

function validateSlots(slots: CodexTranscriptItemSlots): void {
  if (!Number.isSafeInteger(slots.length) || slots.length < 0)
    throw new Error("Invalid transcript slot length");
  const indices = new Set<number>();
  const itemIds = new Set<string>();
  for (const { index, itemId } of slots.entries) {
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= slots.length ||
      indices.has(index) ||
      itemIds.has(itemId)
    )
      throw new Error("Invalid transcript slot address");
    indices.add(index);
    itemIds.add(itemId);
  }
}

/** These are content-independent bucket/visibility boundaries, not text revisions. */
function itemShape(item: CodexCanonicalItem | undefined | null): string {
  if (!item) return "absent";
  if (item.type === "agentMessage" || item.type === "plan")
    return `${item.type}:${"phase" in item ? item.phase : ""}:${item.text.trim().length > 0}`;
  if (item.type === "reasoning")
    return `${item.type}:${item.summary.some((part) => part.trim().length > 0)}`;
  if (item.type === "commandExecution") return `${item.type}:${item.status}`;
  return item.type;
}

function isTextOnlyReplacement(
  before: CodexCanonicalItem | undefined,
  after: CodexCanonicalItem,
): boolean {
  if (!before || before.type !== after.type) return false;
  const ignored =
    before.type === "reasoning"
      ? ["summary", "content"]
      : before.type === "commandExecution"
        ? ["aggregatedOutput"]
        : before.type === "agentMessage" || before.type === "plan"
          ? ["text"]
          : [];
  if (ignored.length === 0) return false;
  const left = before as unknown as Record<string, unknown>;
  const right = after as unknown as Record<string, unknown>;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => ignored.includes(key) || left[key] === right[key])
  );
}

/** Window-scoped, read-only query owner. Subscription lifetime owns all retained references. */
export class CodexTranscriptReadOwner {
  private metadata: CodexTranscriptMetadata | null = null;
  private turns = new Map<string, CodexTranscriptTurn>();
  private items = new Map<string, CodexCanonicalItem>();
  private realtimeItems = new Map<string, CodexTranscriptRealtimeItem>();
  private staged: CodexTranscriptSnapshot | null = null;
  private structure: CodexTranscriptStructure | null = null;
  private readonly structureListeners = new Set<Listener>();
  private readonly turnListeners = new Map<string, Set<Listener>>();
  private readonly itemListeners = new Map<string, Set<Listener>>();
  private readonly realtimeListeners = new Map<string, Set<Listener>>();
  private readonly turnVersions = new Map<string, number>();
  private readonly materializedTurns = new Map<string, CodexConversationTurn>();
  private readonly canonicalTurns = new Map<string, CodexCanonicalTurnState>();
  private readonly projectedItems = new Map<string, readonly CodexConversationItem[]>();
  private readonly structureRows = new Map<
    string,
    { readonly version: number; readonly row: CodexTranscriptStructure["turns"][number] }
  >();
  private subscriptionCount = 0;
  private disconnect: CodexTranscriptReadConnection | null = null;
  private disposed = false;
  private subscriptionGeneration = 0;
  private readonly viewports = new CodexHistoryViewportRegistry(() =>
    this.disconnect?.setHistoryViewport?.(this.viewports.getBoundaries()),
  );

  constructor(
    private readonly options: CodexTranscriptKey & {
      readonly connect?: (
        listener: (event: CodexTranscriptEvent) => Promise<void>,
      ) => CodexTranscriptReadConnection;
      readonly onIdle?: () => void;
    },
  ) {}

  get key(): CodexTranscriptKey {
    return { hostId: this.options.hostId, threadId: this.options.threadId };
  }

  private subscribe(listeners: Set<Listener>, listener: Listener): () => void {
    if (this.disposed) return () => {};
    listeners.add(listener);
    this.subscriptionCount += 1;
    if (this.subscriptionCount === 1 && this.options.connect) {
      const generation = ++this.subscriptionGeneration;
      this.disconnect = this.options.connect(async (event) => {
        if (generation === this.subscriptionGeneration && this.subscriptionCount > 0)
          this.applyEvent(event);
      });
      this.disconnect.setHistoryViewport?.(this.viewports.getBoundaries());
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      listeners.delete(listener);
      this.subscriptionCount -= 1;
      if (this.subscriptionCount > 0) return;
      this.subscriptionGeneration += 1;
      this.disconnect?.();
      this.disconnect = null;
      this.viewports.clear();
      this.clear();
      this.options.onIdle?.();
    };
  }

  subscribeStructure = (listener: Listener): (() => void) =>
    this.subscribe(this.structureListeners, listener);

  subscribeTurn = (entityKey: string, listener: Listener): (() => void) => {
    const listeners = this.turnListeners.get(entityKey) ?? new Set<Listener>();
    this.turnListeners.set(entityKey, listeners);
    const release = this.subscribe(listeners, listener);
    return () => {
      release();
      if (listeners.size === 0 && this.turnListeners.get(entityKey) === listeners)
        this.turnListeners.delete(entityKey);
    };
  };

  subscribeItem = (entityKey: string, itemId: string, listener: Listener): (() => void) => {
    const address = codexTranscriptItemAddress(entityKey, itemId);
    const listeners = this.itemListeners.get(address) ?? new Set<Listener>();
    this.itemListeners.set(address, listeners);
    const release = this.subscribe(listeners, listener);
    return () => {
      release();
      if (listeners.size === 0 && this.itemListeners.get(address) === listeners)
        this.itemListeners.delete(address);
    };
  };

  subscribeRealtimeItem = (itemId: string, listener: Listener): (() => void) => {
    const listeners = this.realtimeListeners.get(itemId) ?? new Set<Listener>();
    this.realtimeListeners.set(itemId, listeners);
    const release = this.subscribe(listeners, listener);
    return () => {
      release();
      if (listeners.size === 0 && this.realtimeListeners.get(itemId) === listeners)
        this.realtimeListeners.delete(itemId);
    };
  };
  readRealtimeItem = (itemId: string): CodexTranscriptRealtimeItem | null =>
    this.realtimeItems.get(itemId) ?? null;

  readStructure = (): CodexTranscriptStructure | null => this.structure;
  readTurnVersion = (entityKey: string): number => this.turnVersions.get(entityKey) ?? 0;
  readTurnDetails = (entityKey: string) => this.turns.get(entityKey)?.details ?? null;
  readItemSlots = (entityKey: string): CodexTranscriptItemSlots | null =>
    this.turns.get(entityKey)?.itemSlots ?? null;
  readItem = (entityKey: string, itemId: string): CodexCanonicalItem | null =>
    this.items.get(codexTranscriptItemAddress(entityKey, itemId)) ?? null;

  setHistoryViewport(
    viewer: symbol,
    boundary: CodexHistoryViewportBoundary | null | undefined,
  ): void {
    if (this.disposed) return;
    this.viewports.set(viewer, boundary);
  }

  /** Sparse raw materialization preserves the original index, including absent slots. */
  readCanonicalTurn(entityKey: string): CodexCanonicalTurnState | null {
    const cached = this.canonicalTurns.get(entityKey);
    if (cached) return cached;
    const turn = this.turns.get(entityKey);
    if (!turn) return null;
    const items = Array<CodexCanonicalItem>(turn.itemSlots.length);
    for (const { index, itemId } of turn.itemSlots.entries) {
      const item = this.readItem(entityKey, itemId);
      if (item) items[index] = item;
    }
    const value = { ...turn.details, items };
    this.canonicalTurns.set(entityKey, value);
    return value;
  }

  /** A mounted text leaf projects only its addressed raw item, regardless of Turn size. */
  readProjectedItem(
    entityKey: string,
    itemId: string,
    displayItemId: string,
  ): CodexConversationItem | null {
    const address = codexTranscriptItemAddress(entityKey, itemId);
    let entries = this.projectedItems.get(address);
    if (!entries) {
      const item = this.readItem(entityKey, itemId);
      const details = this.readTurnDetails(entityKey);
      if (!item || !details) return null;
      entries = projectCodexCanonicalTurnItemViews({
        threadId: this.options.threadId,
        turnId: details.turnId,
        items: [item],
        observedAtMs: details.turnStartedAtMs ?? 0,
        turnStatus: details.status,
        commandExecutionStartedAtMsById: details.commandExecutionStartedAtMsById,
        lifecycleStatusByItemId: details.lifecycleStatusByItemId,
        interruptedCommandExecutionItemIds: details.interruptedCommandExecutionItemIds,
        isBackgroundSubagentsEnabled: true,
      }).map((view, sequence) => projectCodexItemViewToTranscriptEntry(view, "live", sequence));
      this.projectedItems.set(address, entries);
    }
    return entries.find((entry) => entry.itemId === displayItemId) ?? null;
  }

  /** Full reads are explicit (row construction, search, export), never a text-subscription snapshot. */
  readTurn(entityKey: string): CodexConversationTurn | null {
    const cached = this.materializedTurns.get(entityKey);
    if (cached) return cached;
    const canonical = this.readCanonicalTurn(entityKey);
    if (!canonical) return null;
    const items = projectCodexCanonicalTurnViews({
      threadId: this.options.threadId,
      turn: canonical,
      turnKey: canonical.entityKey ?? canonical.turnId ?? entityKey,
      observedAtMs: canonical.turnStartedAtMs ?? 0,
      isBackgroundSubagentsEnabled: true,
    }).map((view, sequence) => projectCodexItemViewToTranscriptEntry(view, "live", sequence));
    const value: CodexConversationTurn = {
      threadId: this.options.threadId,
      entityKey,
      turnId: canonical.turnId,
      clientUserMessageId: canonical.params.clientUserMessageId ?? null,
      status: canonical.status,
      errorMessage: canonical.error?.message,
      diff: canonical.diff ?? undefined,
      itemIds: canonical.items.map((item) => item.id),
      items,
      turnStartedAtMs: canonical.turnStartedAtMs,
      firstTurnWorkItemStartedAtMs: canonical.firstTurnWorkItemStartedAtMs ?? null,
      finalAssistantStartedAtMs: canonical.finalAssistantStartedAtMs,
      assistantMessageStartedAtMsById: canonical.assistantMessageStartedAtMsById,
      commandExecutionStartedAtMsById: canonical.commandExecutionStartedAtMsById,
      interruptedCommandExecutionItemIds: canonical.interruptedCommandExecutionItemIds
        ? [...canonical.interruptedCommandExecutionItemIds]
        : undefined,
      hookRuns: canonical.hookRuns ? [...canonical.hookRuns] : undefined,
      safetyBuffering: canonical.safetyBuffering
        ? {
            ...canonical.safetyBuffering,
            reasons: [...canonical.safetyBuffering.reasons],
            useCases: [...canonical.safetyBuffering.useCases],
          }
        : undefined,
      startedAt: canonical.turnStartedAtMs,
      completedAt: canonical.completedAtMs ?? null,
      durationMs: canonical.durationMs,
    };
    this.materializedTurns.set(entityKey, value);
    return value;
  }

  applyEvent(event: CodexTranscriptEvent): void {
    if (this.disposed) return;
    if (event.type === "reset-start") {
      this.staged = {
        ...transcriptMetadata(event.value),
        turnsByKey: {},
        itemsByKey: {},
        realtimeItems: {},
      };
      return;
    }
    if (event.type === "reset-part") {
      if (!this.staged) throw new Error("Transcript reset part has no staging owner");
      Object.assign(this.staged.turnsByKey, event.turnsByKey);
      Object.assign(this.staged.itemsByKey, event.itemsByKey);
      Object.assign(this.staged.realtimeItems, event.realtimeItems);
      return;
    }
    if (event.type === "reset-commit") {
      if (!this.staged) throw new Error("Transcript reset commit has no staging owner");
      const value = this.staged;
      this.staged = null;
      this.installReset(value);
      return;
    }
    if (event.type === "reset") {
      this.staged = null;
      this.installReset(event.value);
      return;
    }
    if (this.staged) throw new Error("Transcript changes arrived during a staged reset");
    this.applyChanges(event.changes);
  }

  private installReset(snapshot: CodexTranscriptSnapshot | null): void {
    if (snapshot) {
      if (new Set(snapshot.turnEntityKeys).size !== snapshot.turnEntityKeys.length)
        throw new Error("Duplicate transcript Turn address");
      for (const entityKey of snapshot.turnEntityKeys) {
        const turn = snapshot.turnsByKey[entityKey];
        if (!turn) throw new Error("Transcript reset has no Turn details");
        validateSlots(turn.itemSlots);
        for (const { itemId } of turn.itemSlots.entries) {
          const item = snapshot.itemsByKey[codexTranscriptItemAddress(entityKey, itemId)];
          if (!item || item.id !== itemId)
            throw new Error("Transcript reset has no addressed item");
        }
      }
    }
    const oldTurnKeys = [...this.turnListeners.keys()];
    const oldItemKeys = [...this.itemListeners.keys()];
    const oldRealtimeKeys = [...this.realtimeListeners.keys()];
    const oldVersions = new Map(
      oldTurnKeys.map((entityKey) => [entityKey, this.readTurnVersion(entityKey)]),
    );
    this.clear();
    for (const entityKey of oldTurnKeys)
      this.turnVersions.set(entityKey, (oldVersions.get(entityKey) ?? 0) + 1);
    if (snapshot) {
      this.metadata = transcriptMetadata(snapshot);
      this.turns = new Map(Object.entries(snapshot.turnsByKey));
      this.items = new Map(Object.entries(snapshot.itemsByKey));
      this.realtimeItems = new Map(Object.entries(snapshot.realtimeItems));
      this.rebuildStructure();
    }
    this.notify(this.structureListeners);
    for (const key of oldTurnKeys) this.notify(this.turnListeners.get(key));
    for (const key of oldItemKeys) this.notify(this.itemListeners.get(key));
    for (const key of oldRealtimeKeys) this.notify(this.realtimeListeners.get(key));
  }

  private applyChanges(changes: readonly CodexTranscriptChange[]): void {
    if (!this.metadata) throw new Error("Transcript changes require an installed reset");
    const metadata = this.metadata;
    let nextMetadata = metadata;
    const previousRealtime = new Map<string, CodexTranscriptRealtimeItem | undefined>();
    const previousTurns = new Map<string, CodexTranscriptTurn | undefined>();
    const previousItems = new Map<string, CodexCanonicalItem | undefined>();
    const changedTurns = new Set<string>();
    const changedItems = new Set<string>();
    const changedRealtime = new Set<string>();
    let structureChanged = false;
    const rememberTurn = (key: string) => {
      if (!previousTurns.has(key)) previousTurns.set(key, this.turns.get(key));
    };
    const rememberItem = (key: string) => {
      if (!previousItems.has(key)) previousItems.set(key, this.items.get(key));
      changedItems.add(key);
    };
    try {
      for (const change of changes) {
        if (
          "key" in change &&
          (change.key.hostId !== this.options.hostId ||
            change.key.threadId !== this.options.threadId)
        )
          throw new Error("Transcript update belongs to a different conversation");
        if (change.type === "structure") {
          nextMetadata = {
            ...nextMetadata,
            timeline: change.timeline,
            turnEntityKeys: change.turnEntityKeys,
          };
          structureChanged = true;
          continue;
        }
        if (change.type === "history") {
          nextMetadata = {
            ...nextMetadata,
            resumeState: change.resumeState,
            historyComplete: change.historyComplete,
          };
          structureChanged = true;
          continue;
        }
        if (change.type === "item-timeline") {
          nextMetadata = { ...nextMetadata, itemTimeline: change.value };
          structureChanged = true;
          continue;
        }
        if (change.type === "item-timeline-prepend") {
          if (!nextMetadata.itemTimeline)
            throw new Error("Transcript timeline prepend has no timeline");
          nextMetadata = {
            ...nextMetadata,
            itemTimeline: {
              entries: [...change.entries, ...nextMetadata.itemTimeline.entries],
              activeRealtimeSessionAtPageStart: change.activeRealtimeSessionAtPageStart,
            },
          };
          structureChanged = true;
          continue;
        }
        if (change.type === "item-timeline-entry") {
          const timeline: CodexTranscriptMetadata["itemTimeline"] = nextMetadata.itemTimeline;
          if (!timeline || change.index < 0 || change.index > timeline.entries.length)
            throw new Error("Transcript timeline entry is out of order");
          const entries: Array<
            NonNullable<CodexTranscriptMetadata["itemTimeline"]>["entries"][number]
          > = [...timeline.entries];
          entries[change.index] = change.entry;
          nextMetadata = { ...nextMetadata, itemTimeline: { ...timeline, entries } };
          structureChanged = true;
          continue;
        }
        if (change.type === "realtime-item" || change.type === "realtime-text") {
          const previous = this.realtimeItems.get(change.itemId);
          if (!previousRealtime.has(change.itemId)) previousRealtime.set(change.itemId, previous);
          changedRealtime.add(change.itemId);
          if (change.type === "realtime-item") {
            if (change.value) this.realtimeItems.set(change.itemId, change.value);
            else this.realtimeItems.delete(change.itemId);
            continue;
          }
          if (previous?.item.type !== "transcriptSegment")
            throw new Error("Transcript realtime text has no segment");
          this.realtimeItems.set(change.itemId, {
            ...previous,
            item: { ...previous.item, text: previous.item.text + change.delta },
          });
          continue;
        }
        const entityKey = change.key.entityKey;
        rememberTurn(entityKey);
        if (change.type === "remove-turn") {
          const turn = this.turns.get(entityKey);
          for (const { itemId } of turn?.itemSlots.entries ?? []) {
            const address = codexTranscriptItemAddress(entityKey, itemId);
            rememberItem(address);
            this.items.delete(address);
          }
          this.turns.delete(entityKey);
          this.structureRows.delete(entityKey);
          changedTurns.add(entityKey);
          structureChanged = true;
          continue;
        }
        if (change.type === "turn") {
          const previous = this.turns.get(entityKey);
          this.turns.set(entityKey, {
            details: change.details,
            hasSubagentActivity: change.hasSubagentActivity,
            itemSlots: previous?.itemSlots ?? EMPTY_SLOTS,
          });
          changedTurns.add(entityKey);
          structureChanged = true;
          continue;
        }
        const turn = this.turns.get(entityKey);
        if (!turn) throw new Error("Transcript item update has no Turn");
        if (change.type === "item-slots" || change.type === "item-slots-append") {
          const slots =
            change.type === "item-slots"
              ? change.slots
              : { length: change.length, entries: [...turn.itemSlots.entries, ...change.entries] };
          if (
            change.type === "item-slots-append" &&
            (change.previousLength !== turn.itemSlots.length ||
              change.length < change.previousLength ||
              change.entries.some(({ index }) => index < change.previousLength))
          )
            throw new Error("Transcript slot append is out of order");
          validateSlots(slots);
          this.turns.set(entityKey, { ...turn, itemSlots: slots });
          changedTurns.add(entityKey);
          structureChanged = true;
          continue;
        }
        const address = codexTranscriptItemAddress(entityKey, change.key.itemId);
        const previous = this.items.get(address);
        const next =
          change.type === "item"
            ? change.value
            : previous
              ? applyCodexTranscriptTextChange(previous, change)
              : null;
        if (!next && change.type !== "item") throw new Error("Transcript text update has no item");
        rememberItem(address);
        if (next) this.items.set(address, next);
        else this.items.delete(address);
        if (
          (change.type === "item" && (!next || !isTextOnlyReplacement(previous, next))) ||
          itemShape(previous) !== itemShape(next)
        ) {
          changedTurns.add(entityKey);
          structureChanged = true;
        }
      }
    } catch (error) {
      this.metadata = metadata;
      for (const [key, value] of previousRealtime) {
        if (value) this.realtimeItems.set(key, value);
        else this.realtimeItems.delete(key);
      }
      for (const [key, value] of previousTurns) {
        if (value) this.turns.set(key, value);
        else this.turns.delete(key);
      }
      for (const [key, value] of previousItems) {
        if (value) this.items.set(key, value);
        else this.items.delete(key);
      }
      throw error;
    }
    this.metadata = nextMetadata;
    for (const entityKey of previousTurns.keys()) {
      this.canonicalTurns.delete(entityKey);
      this.materializedTurns.delete(entityKey);
    }
    for (const address of changedItems) this.projectedItems.delete(address);
    for (const entityKey of changedTurns) {
      this.turnVersions.set(entityKey, this.readTurnVersion(entityKey) + 1);
      for (const { itemId } of this.turns.get(entityKey)?.itemSlots.entries ?? []) {
        const address = codexTranscriptItemAddress(entityKey, itemId);
        this.projectedItems.delete(address);
        changedItems.add(address);
      }
    }
    if (structureChanged) {
      this.rebuildStructure();
      this.notify(this.structureListeners);
    }
    for (const entityKey of changedTurns) this.notify(this.turnListeners.get(entityKey));
    for (const address of changedItems) this.notify(this.itemListeners.get(address));
    for (const key of changedRealtime) this.notify(this.realtimeListeners.get(key));
  }

  private rebuildStructure(): void {
    if (!this.metadata) {
      this.structure = null;
      return;
    }
    const turns = this.metadata.turnEntityKeys.flatMap((entityKey) => {
      const value = this.turns.get(entityKey);
      if (!value) return [];
      const version = this.readTurnVersion(entityKey);
      const cached = this.structureRows.get(entityKey);
      if (cached?.version === version && cached.row.value === value) return [cached.row];
      const itemIds = Array<string | undefined>(value.itemSlots.length);
      let hasUserMessage = value.details.params.input.length > 0;
      let hasAssistantMessage = false;
      let hasMcpApp = false;
      let isStartupPrewarm = false;
      for (const { index, itemId } of value.itemSlots.entries) {
        itemIds[index] = itemId;
        const item = this.readItem(entityKey, itemId);
        hasUserMessage ||= item?.type === "userMessage";
        hasAssistantMessage ||= item?.type === "agentMessage";
        hasMcpApp ||=
          item?.type === "mcpToolCall" &&
          (item.mcpAppResourceUri != null || item.mcpAppUi?.resourceUri != null);
        isStartupPrewarm ||=
          item?.type === "userMessage" &&
          item.content.some(
            (content) =>
              content.type === "text" && content.text.startsWith("<startup_tool_prewarm>"),
          );
      }
      const row = {
        entityKey,
        value,
        itemIds,
        hasUserMessage,
        hasAssistantMessage,
        hasMcpApp,
        isStartupPrewarm,
      };
      this.structureRows.set(entityKey, { version, row });
      return [row];
    });
    this.structure = { ...this.metadata, turns };
  }

  private notify(listeners: Set<Listener> | undefined): void {
    for (const listener of listeners ?? []) listener();
  }

  private clear(): void {
    this.metadata = null;
    this.turns.clear();
    this.items.clear();
    this.realtimeItems.clear();
    this.staged = null;
    this.structure = null;
    this.canonicalTurns.clear();
    this.materializedTurns.clear();
    this.projectedItems.clear();
    this.structureRows.clear();
    this.turnVersions.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disconnect?.();
    this.disconnect = null;
    this.viewports.clear();
    this.clear();
    this.notify(this.structureListeners);
    for (const listeners of this.turnListeners.values()) this.notify(listeners);
    for (const listeners of this.itemListeners.values()) this.notify(listeners);
    for (const listeners of this.realtimeListeners.values()) this.notify(listeners);
    this.structureListeners.clear();
    this.turnListeners.clear();
    this.itemListeners.clear();
    this.realtimeListeners.clear();
    this.turnVersions.clear();
  }
}
