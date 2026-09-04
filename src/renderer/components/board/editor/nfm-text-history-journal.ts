import * as Y from "yjs";
import { subscribeDocumentHistoryFences } from "../../../lib/document-history-fence";

import {
  materializeBlockFields,
  type BlockTreeNode,
} from "../../../../shared/block-documents/block-document-codec";
import type {
  BlockHistoryChange,
  BlockHistoryPatch,
  BlockHistoryState,
} from "../../../../shared/block-documents/block-history-patch";

type StackItem = Y.UndoManager["undoStack"][number];
interface CachedBlock {
  readonly container: Y.XmlElement;
  readonly content: Y.XmlElement;
  readonly state: BlockHistoryState;
}
interface Capture {
  readonly changes: Map<string, BlockHistoryChange>;
  readonly addresses: Set<string>;
  readonly root: Y.XmlElement | undefined;
  bytes: number;
  invalidated: boolean;
}
interface StackEvent {
  readonly stackItem: StackItem;
  readonly changedParentTypes: Y.Transaction["changedParentTypes"];
}

const encodedBytes = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

const equal = (left: unknown, right: unknown): boolean => {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const a = Object.entries(left);
  const b = Object.entries(right);
  return (
    a.length === b.length &&
    a.every(
      ([key, value]) =>
        Object.hasOwn(right, key) && equal(value, (right as Record<string, unknown>)[key]),
    )
  );
};

const nearestBlock = (target: Y.AbstractType<unknown>): Y.XmlElement | undefined => {
  let node: Y.AbstractType<unknown> | null = target;
  while (node) {
    if (node instanceof Y.XmlElement && node.nodeName === "blockContainer") return node;
    node = node.parent;
  }
  return undefined;
};

/**
 * One flat cache per surface, not one Document snapshot per keystroke. Text
 * transactions read only affected fields. Structural transactions also scan
 * identities/placements, reusing unchanged fields and never traversing an
 * owning shell's separate Document.
 */
export class NfmTextHistoryJournal {
  private blocks = new Map<string, CachedBlock>();
  private readonly transactions = new WeakMap<Y.Transaction["changedParentTypes"], Capture>();
  private readonly entries = new Map<StackItem, Capture>();
  private readonly retentionRoots = new Map<string, number>();
  private readonly retentionListeners = new Set<() => void>();
  private readonly unsubscribeFences: () => void;

  constructor(
    private readonly body: Y.XmlFragment,
    private readonly manager: Y.UndoManager,
    private readonly materialize: (
      container: Y.XmlElement,
    ) => BlockTreeNode = materializeBlockFields,
  ) {
    this.blocks = this.scan(new Set());
    this.unsubscribeFences = subscribeDocumentHistoryFences(manager.doc, (fence) => {
      manager.stopCapturing();
      for (const capture of this.entries.values())
        if (fence.documentWide || fence.blockIds.some((id) => capture.addresses.has(id)))
          capture.invalidated = true;
    });
    body.observeDeep(this.observe);
    manager.on("stack-item-added", this.capture);
    manager.on("stack-item-updated", this.capture);
    manager.on("stack-cleared", this.prune);
    manager.on("stack-item-popped", this.prune);
  }

  private read(
    container: Y.XmlElement,
    parentBlockId: string | null,
    beforeBlockId: string | null,
  ): CachedBlock {
    const fields = this.materialize(container);
    const content = container.get(0);
    if (!(content instanceof Y.XmlElement)) throw new Error("History Block content is missing.");
    return {
      container,
      content,
      state: {
        type: fields.type,
        props: fields.props,
        content: fields.content ?? null,
        parentBlockId,
        beforeBlockId,
      },
    };
  }

  private scan(dirty: ReadonlySet<Y.XmlElement>): Map<string, CachedBlock> {
    const next = new Map<string, CachedBlock>();
    const visit = (group: Y.XmlElement, parentBlockId: string | null): void => {
      const children = group
        .toArray()
        .filter(
          (node): node is Y.XmlElement =>
            node instanceof Y.XmlElement && node.nodeName === "blockContainer",
        );
      children.forEach((container, index) => {
        const id = container.getAttribute("id");
        if (!id) throw new Error("History Block identity is missing.");
        if (next.has(id)) throw new Error("History Block identity is duplicated.");
        const beforeBlockId = children[index + 1]?.getAttribute("id") ?? null;
        const previous = this.blocks.get(id);
        const unchanged = previous?.container === container && !dirty.has(container);
        const current = unchanged
          ? { ...previous, state: { ...previous.state, parentBlockId, beforeBlockId } }
          : this.read(container, parentBlockId, beforeBlockId);
        next.set(id, current);
        const nested = container.get(1);
        if (nested instanceof Y.XmlElement && nested.nodeName === "blockGroup") visit(nested, id);
      });
    };
    const root = this.body.get(0);
    if (root instanceof Y.XmlElement) visit(root, null);
    return next;
  }

  private readonly observe = (
    events: Y.YEvent<Y.AbstractType<unknown>>[],
    transaction: Y.Transaction,
  ): void => {
    const dirty = new Set<Y.XmlElement>();
    let structural = false;
    for (const event of events) {
      if (
        event.target === this.body ||
        (event.target instanceof Y.XmlElement && event.target.nodeName === "blockGroup")
      ) {
        structural = true;
        continue;
      }
      if (
        event.target instanceof Y.XmlElement &&
        event.target.nodeName === "blockContainer" &&
        (event.changes.added.size > 0 || event.changes.deleted.size > 0)
      )
        structural = true;
      const container = nearestBlock(event.target);
      if (container) dirty.add(container);
    }
    // A text edit must not even clone the whole identity index.
    const previous = structural
      ? this.blocks
      : new Map(
          [...dirty].flatMap((container) => {
            const id = container.getAttribute("id");
            const cached = id ? this.blocks.get(id) : undefined;
            return id && cached ? [[id, cached] as const] : [];
          }),
        );
    const next = structural ? this.scan(dirty) : this.blocks;
    if (!structural)
      for (const container of dirty) {
        const id = container.getAttribute("id");
        const cached = id ? previous.get(id) : undefined;
        if (id && cached)
          next.set(
            id,
            this.read(container, cached.state.parentBlockId, cached.state.beforeBlockId),
          );
      }
    this.blocks = next;
    const candidates = structural
      ? new Set([...previous.keys(), ...next.keys()])
      : new Set([...dirty].map((container) => container.getAttribute("id")!));
    const changes = new Map<string, BlockHistoryChange>();
    const addresses = new Set<string>();
    const remote =
      !this.manager.captureTransaction(transaction) ||
      (!this.manager.trackedOrigins.has(transaction.origin) &&
        !this.manager.trackedOrigins.has(transaction.origin?.constructor));
    const readdressed = new Set<string>();
    for (const blockId of candidates) {
      const before = previous.get(blockId);
      const after = next.get(blockId);
      if (
        remote &&
        after &&
        (before?.container !== after.container || before?.content !== after.content)
      )
        readdressed.add(blockId);
      if (equal(before?.state ?? null, after?.state ?? null)) continue;
      changes.set(blockId, { blockId, before: before?.state ?? null, after: after?.state ?? null });
      for (const [initial, index] of [
        [before, previous],
        [after, next],
      ] as const) {
        let address = initial;
        let addressId: string | null = blockId;
        while (address && addressId) {
          addresses.add(addressId);
          if (address.state.beforeBlockId) addresses.add(address.state.beforeBlockId);
          addressId = address.state.parentBlockId;
          address = addressId ? index.get(addressId) : undefined;
        }
      }
    }
    if (remote)
      for (const capture of this.entries.values()) {
        if (
          capture.root !== this.body.get(0) ||
          [...readdressed].some((id) => capture.addresses.has(id))
        )
          capture.invalidated = true;
      }
    if (changes.size === 0) return;
    // Remote changes must not be absorbed into a subsequent local capture group.
    if (remote) this.manager.stopCapturing();
    const root = this.body.get(0);
    this.transactions.set(transaction.changedParentTypes, {
      changes,
      addresses,
      root: root instanceof Y.XmlElement ? root : undefined,
      bytes:
        [...changes.values()].reduce((bytes, change) => bytes + encodedBytes(change), 0) +
        [...addresses].reduce((bytes, id) => bytes + encodedBytes(id), 0),
      invalidated: false,
    });
  };

  private readonly capture = ({ stackItem, changedParentTypes }: StackEvent): void => {
    const change = this.transactions.get(changedParentTypes);
    if (!change) return;
    const previous = this.entries.get(stackItem);
    if (!previous) {
      this.entries.set(stackItem, change);
      this.addRetentionRoots(change.addresses);
      return;
    }
    for (const [id, next] of change.changes) {
      const prior = previous.changes.get(id);
      const before = prior ? prior.before : next.before;
      if (prior) previous.bytes -= encodedBytes(prior);
      if (equal(before, next.after)) previous.changes.delete(id);
      else {
        const merged = { blockId: id, before, after: next.after };
        previous.changes.set(id, merged);
        previous.bytes += encodedBytes(merged);
      }
    }
    const added = new Set<string>();
    for (const id of change.addresses) {
      if (!previous.addresses.has(id)) added.add(id);
      if (!previous.addresses.has(id)) previous.bytes += encodedBytes(id);
      previous.addresses.add(id);
    }
    this.addRetentionRoots(added);
  };

  private addRetentionRoots(ids: ReadonlySet<string>): void {
    let changed = false;
    for (const id of ids) {
      const count = this.retentionRoots.get(id) ?? 0;
      this.retentionRoots.set(id, count + 1);
      changed ||= count === 0;
    }
    if (changed) for (const listener of this.retentionListeners) listener();
  }

  /** Only first/last identity references notify; ordinary typing is O(changed fields). */
  subscribeRetention(listener: () => void): () => void {
    this.retentionListeners.add(listener);
    return () => {
      this.retentionListeners.delete(listener);
    };
  }

  retainedBlockIds(): string[] {
    return [...this.retentionRoots.keys()];
  }

  get retainedIdentityCount(): number {
    return this.retentionRoots.size;
  }

  /** Encoded affected-field evidence; no whole-Document sizing on each key. */
  retainedBytes(item: StackItem): number {
    return this.entries.get(item)?.bytes ?? 0;
  }

  exceedsBridgeBounds(item: StackItem): boolean {
    const capture = this.entries.get(item);
    if (!capture) return false;
    // Match Core's 10,000-identity / 8 MiB compiler contract conservatively.
    // Reserve wire field-name/array overhead without reserializing the group.
    return (
      capture.changes.size > 10_000 ||
      capture.bytes + capture.changes.size * 128 + 64 > 8 * 1024 * 1024
    );
  }

  patch(item: StackItem): BlockHistoryPatch {
    const capture = this.entries.get(item);
    if (!capture) throw new Error("Local history has no semantic capture evidence.");
    return { changes: [...capture.changes.values()] };
  }

  requiresBridge(item: StackItem): boolean {
    return this.entries.get(item)?.invalidated ?? false;
  }

  private readonly prune = (): void => {
    const reachable = new Set([...this.manager.undoStack, ...this.manager.redoStack]);
    let changed = false;
    for (const [item, capture] of this.entries) {
      if (reachable.has(item)) continue;
      this.entries.delete(item);
      for (const id of capture.addresses) {
        const count = this.retentionRoots.get(id)!;
        if (count > 1) this.retentionRoots.set(id, count - 1);
        else {
          this.retentionRoots.delete(id);
          changed = true;
        }
      }
    }
    if (changed) for (const listener of this.retentionListeners) listener();
  };

  dispose(): void {
    this.unsubscribeFences();
    this.body.unobserveDeep(this.observe);
    this.manager.off("stack-item-added", this.capture);
    this.manager.off("stack-item-updated", this.capture);
    this.manager.off("stack-cleared", this.prune);
    this.manager.off("stack-item-popped", this.prune);
    this.blocks.clear();
    this.entries.clear();
    this.retentionRoots.clear();
    this.retentionListeners.clear();
  }
}
