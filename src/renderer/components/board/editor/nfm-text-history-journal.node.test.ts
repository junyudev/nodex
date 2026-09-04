import { expect, test } from "vite-plus/test";
import * as Y from "yjs";

import {
  createPageDocumentGenesis,
  materializeBlockFields,
} from "../../../../shared/block-documents/block-document-codec";
import { cloneXmlSubtree } from "../../../../shared/block-documents/xml-subtree-codec";
import { publishDocumentHistoryFence } from "../../../lib/document-history-fence";
import { NfmTextHistoryJournal } from "./nfm-text-history-journal";
import { NfmHistoryLane } from "./nfm-editor-history";

const setup = (nfm: string) => {
  const { document } = createPageDocumentGenesis({ documentId: "history-journal", nfm });
  const body = document.getXmlFragment("body");
  const group = body.get(0) as Y.XmlElement;
  const manager = new Y.UndoManager(body, {
    trackedOrigins: new Set(["local"]),
    captureTransaction: (transaction) => transaction.meta.get("addToHistory") !== false,
  });
  let materialized = 0;
  const journal = new NfmTextHistoryJournal(body, manager, (container) => {
    materialized += 1;
    return materializeBlockFields(container);
  });
  return {
    document,
    body,
    group,
    manager,
    journal,
    materialized: () => materialized,
    close: () => {
      journal.dispose();
      manager.destroy();
      document.destroy();
    },
  };
};

test("retention roots change only at first capture and last reachable reference", () => {
  const fixture = setup("One");
  const { document, group, manager, journal } = fixture;
  const changes: string[][] = [];
  const unsubscribe = journal.subscribeRetention(() => changes.push(journal.retainedBlockIds()));
  try {
    const first = group.get(0) as Y.XmlElement;
    const text = (first.get(0) as Y.XmlElement).get(0) as Y.XmlText;
    document.transact(() => text.insert(0, "A"), "local");
    document.transact(() => text.insert(0, "B"), "local");
    manager.stopCapturing();
    document.transact(() => text.insert(0, "C"), "local");
    expect(changes).toEqual([[first.getAttribute("id")]]);
    manager.discardStackItems([manager.undoStack[0]!]);
    expect(journal.retainedIdentityCount).toBe(1);
    expect(changes).toHaveLength(1);
    manager.clear();
    expect(journal.retainedBlockIds()).toEqual([]);
  } finally {
    unsubscribe();
    fixture.close();
  }
});

test("identity capacity retires an unreachable prefix without disabling later small edits", async () => {
  const fixture = setup("One\n\nTwo");
  const { document, group, manager, journal } = fixture;
  const errors: unknown[] = [];
  const lane = new NfmHistoryLane({
    undoManager: manager,
    textHistory: journal,
    limits: { maxRetainedIdentities: 1 },
    onError: (error) => errors.push(error),
  });
  try {
    const first = ((group.get(0) as Y.XmlElement).get(0) as Y.XmlElement).get(0) as Y.XmlText;
    const last = ((group.get(1) as Y.XmlElement).get(0) as Y.XmlElement).get(0) as Y.XmlText;
    document.transact(() => first.insert(0, "X"), "local");
    expect(lane.canUndo()).toBe(false);
    expect(journal.retainedIdentityCount).toBe(0);
    document.transact(() => last.insert(0, "Y"), "local");
    expect(lane.canUndo()).toBe(true);
    lane.requestUndo();
    await lane.whenIdle();
    expect(last.toString()).toBe("Two");
    expect(first.toString()).toBe("XOne");
    expect(errors).toHaveLength(1);
  } finally {
    await lane.close();
    fixture.close();
  }
});

test("net-zero capture groups still account for retained native payload", async () => {
  const fixture = setup("One");
  const { document, group, manager, journal } = fixture;
  const errors: unknown[] = [];
  const lane = new NfmHistoryLane({
    undoManager: manager,
    textHistory: journal,
    limits: { maxBytes: 4096 },
    onError: (error) => errors.push(error),
  });
  try {
    const text = ((group.get(0) as Y.XmlElement).get(0) as Y.XmlElement).get(0) as Y.XmlText;
    for (let index = 0; index < 12; index++) {
      document.transact(() => text.insert(text.length, "x".repeat(1000)), "local");
      document.transact(() => text.delete(3, 1000), "local");
    }
    expect(text.toString()).toBe("One");
    expect(errors.length).toBeGreaterThan(0);
    expect(manager.undoStack.length).toBeLessThanOrEqual(1);
  } finally {
    await lane.close();
    fixture.close();
  }
});

test("a tiny deletion update is charged for the large content its inverse retains", async () => {
  const fixture = setup("x".repeat(16 * 1024));
  const { document, group, manager, journal } = fixture;
  const errors: unknown[] = [];
  const lane = new NfmHistoryLane({
    undoManager: manager,
    textHistory: journal,
    limits: { maxBytes: 4096 },
    onError: (error) => errors.push(error),
  });
  try {
    document.transact(() => group.delete(0, 1), "local");
    lane.requestUndo();
    await lane.whenIdle();
    expect(group.length).toBe(0);
    expect(lane.canUndo()).toBe(false);
    expect(errors).toHaveLength(1);
  } finally {
    await lane.close();
    fixture.close();
  }
});

test("an entry beyond Core's semantic bridge limit cannot remain deceptively undoable", async () => {
  const initialLength = 4 * 1024 * 1024 + 512;
  const fixture = setup("x".repeat(initialLength));
  const { document, group, manager, journal } = fixture;
  const errors: unknown[] = [];
  const lane = new NfmHistoryLane({
    undoManager: manager,
    textHistory: journal,
    onError: (error) => errors.push(error),
  });
  try {
    const text = ((group.get(0) as Y.XmlElement).get(0) as Y.XmlElement).get(0) as Y.XmlText;
    document.transact(() => text.insert(text.length, "y"), "local");
    lane.requestUndo();
    await lane.whenIdle();
    expect(text.length).toBe(initialLength + 1);
    expect(lane.canUndo()).toBe(false);
    expect(errors).toHaveLength(1);
  } finally {
    await lane.close();
    fixture.close();
  }
});

test("Core fences retain moved-away history and do not invalidate later captures on replayed delivery", () => {
  const fixture = setup("One\nTwo");
  const { document, group, manager, journal } = fixture;
  try {
    const paragraph = group.get(0) as Y.XmlElement;
    const blockId = paragraph.getAttribute("id")!;
    const text = (paragraph.get(0) as Y.XmlElement).get(0) as Y.XmlText;
    document.transact(() => text.insert(text.length, " local"), "local");
    const original = manager.undoStack[0]!;
    const fence = { headSeq: 7, blockIds: [blockId], documentWide: false };
    publishDocumentHistoryFence(document, fence);
    document.transact(() => group.delete(0, 1), "core");
    expect(journal.requiresBridge(original)).toBe(true);
    expect(journal.patch(original).changes[0]?.after?.content).toEqual([
      { type: "text", text: "One local", styles: {} },
    ]);
    const second = ((group.get(0) as Y.XmlElement).get(0) as Y.XmlElement).get(0) as Y.XmlText;
    document.transact(() => second.insert(second.length, " later"), "local");
    const later = manager.undoStack.at(-1)!;
    publishDocumentHistoryFence(document, fence);
    expect(journal.requiresBridge(later)).toBe(false);
    publishDocumentHistoryFence(document, { headSeq: 8, blockIds: [], documentWide: true });
    expect(journal.requiresBridge(later)).toBe(true);
  } finally {
    fixture.close();
  }
});

test("a readdressed capture that cancels itself is consumed without a Core bridge", async () => {
  const fixture = setup("One");
  const { document, group, manager, journal } = fixture;
  const errors: unknown[] = [];
  let calls = 0;
  const lane = new NfmHistoryLane({
    undoManager: manager,
    textHistory: journal,
    onError: (error) => errors.push(error),
    prepareTextReverse: async () => {
      calls++;
      throw new Error("An empty patch cannot reach Core");
    },
  });
  try {
    const paragraph = group.get(0) as Y.XmlElement;
    const text = (paragraph.get(0) as Y.XmlElement).get(0) as Y.XmlText;
    document.transact(() => text.insert(text.length, " A"), "local");
    document.transact(() => text.delete(text.length - 2, 2), "local");
    const item = manager.undoStack[0]!;
    expect(journal.patch(item).changes).toEqual([]);
    publishDocumentHistoryFence(document, {
      headSeq: 1,
      blockIds: [paragraph.getAttribute("id")!],
      documentWide: false,
    });
    lane.requestUndo();
    await lane.whenIdle();
    expect(calls).toBe(0);
    expect(errors).toEqual([]);
    expect(lane.canUndo()).toBe(false);
    expect(lane.canRedo()).toBe(false);
    expect(text.toString()).toBe("One");
  } finally {
    await lane.close();
    fixture.close();
  }
});

test("captures only edited fields, merges the engine's exact capture group, and detects rebuilt addresses", () => {
  const fixture = setup("Paragraph\n\tChild\nUnrelated");
  const { document, group, manager, journal } = fixture;
  try {
    const paragraph = group.get(0) as Y.XmlElement;
    const content = paragraph.get(0) as Y.XmlElement;
    const text = content.get(0) as Y.XmlText;
    const initialReads = fixture.materialized();
    document.transact(() => text.insert(text.length, " A"), "local");
    document.transact(() => text.format(0, 2, { bold: {} }), "local");
    expect(manager.undoStack).toHaveLength(1);
    const item = manager.undoStack[0]!;
    const patch = journal.patch(item);
    expect(patch.changes).toHaveLength(1);
    expect(patch.changes[0]?.before?.content).toEqual([
      { type: "text", text: "Paragraph", styles: {} },
    ]);
    expect(patch.changes[0]?.after?.content).toEqual([
      { type: "text", text: "Pa", styles: { bold: true } },
      { type: "text", text: "ragraph A", styles: {} },
    ]);
    expect(fixture.materialized() - initialReads).toBe(2);
    expect(journal.requiresBridge(item)).toBe(false);
    const restored = cloneXmlSubtree(paragraph);
    document.transact(() => {
      group.delete(0, 1);
      group.insert(0, [restored]);
    }, "core");
    expect(journal.requiresBridge(item)).toBe(true);
    expect(journal.patch(item)).toEqual(patch);
  } finally {
    fixture.close();
  }
});

test("records ordinary forest deletion and insertion with exact placements, without copying descendants into fields", () => {
  const fixture = setup("Parent\n\tChild\nSibling");
  const { document, group, manager, journal } = fixture;
  try {
    const rootId = (group.get(0) as Y.XmlElement).getAttribute("id")!;
    const siblingId = (group.get(1) as Y.XmlElement).getAttribute("id")!;
    document.transact(() => group.delete(0, 1), "local");
    const patch = journal.patch(manager.undoStack[0]!);
    expect(patch.changes).toHaveLength(2);
    expect(patch.changes.find((change) => change.blockId === rootId)).toMatchObject({
      before: { parentBlockId: null, beforeBlockId: siblingId },
      after: null,
    });
    expect(patch.changes.find((change) => change.blockId !== rootId)).toMatchObject({
      before: { parentBlockId: rootId, beforeBlockId: null },
      after: null,
    });
    expect(patch.changes.every((change) => !Object.hasOwn(change.before!, "children"))).toBe(true);
  } finally {
    fixture.close();
  }
});

test("adding the first child group and deleting its new child are distinct semantic captures", () => {
  const fixture = setup("Parent");
  const { document, group, manager, journal } = fixture;
  try {
    const parent = group.get(0) as Y.XmlElement;
    const children = new Y.XmlElement("blockGroup");
    const child = cloneXmlSubtree(parent) as Y.XmlElement;
    child.setAttribute("id", "new-child");
    document.transact(() => {
      parent.insert(1, [children]);
      children.insert(0, [child]);
    }, "local");
    const created = manager.undoStack.at(-1)!;
    expect(journal.patch(created).changes).toMatchObject([
      { blockId: "new-child", before: null, after: { parentBlockId: parent.getAttribute("id") } },
    ]);
    manager.stopCapturing();
    document.transact(() => children.delete(0, 1), "local");
    const deleted = manager.undoStack.at(-1)!;
    expect(deleted).not.toBe(created);
    expect(journal.patch(deleted).changes).toMatchObject([
      { blockId: "new-child", before: { parentBlockId: parent.getAttribute("id") }, after: null },
    ]);
  } finally {
    fixture.close();
  }
});

test("an unrelated remote edit cannot become part of a local capture group", () => {
  const fixture = setup("One\nTwo");
  const { document, group, manager, journal } = fixture;
  try {
    const first = ((group.get(0) as Y.XmlElement).get(0) as Y.XmlElement).get(0) as Y.XmlText;
    const second = ((group.get(1) as Y.XmlElement).get(0) as Y.XmlElement).get(0) as Y.XmlText;
    document.transact(() => first.insert(first.length, " A"), "local");
    document.transact(() => second.insert(second.length, " remote"), "remote");
    document.transact(() => first.insert(first.length, " B"), "local");
    expect(manager.undoStack).toHaveLength(2);
    expect(journal.patch(manager.undoStack[1]!).changes).toHaveLength(1);
    expect(journal.patch(manager.undoStack[1]!).changes[0]?.before?.content).toEqual([
      { type: "text", text: "One A", styles: {} },
    ]);
  } finally {
    fixture.close();
  }
});

test("typing in a large Document materializes only its affected Block", () => {
  const fixture = setup(Array.from({ length: 2000 }, (_, i) => `Paragraph ${i}`).join("\n"));
  const { document, group, manager, journal } = fixture;
  try {
    const initialReads = fixture.materialized();
    const text = ((group.get(1000) as Y.XmlElement).get(0) as Y.XmlElement).get(0) as Y.XmlText;
    document.transact(() => text.insert(text.length, " local"), "local");
    expect(fixture.materialized() - initialReads).toBe(1);
    expect(journal.patch(manager.undoStack[0]!).changes).toHaveLength(1);
  } finally {
    fixture.close();
  }
});

test("non-history edits cannot be absorbed into a later local semantic group", () => {
  const fixture = setup("One");
  const { document, group, manager, journal } = fixture;
  try {
    const text = ((group.get(0) as Y.XmlElement).get(0) as Y.XmlElement).get(0) as Y.XmlText;
    document.transact(() => text.insert(text.length, " A"), "local");
    document.transact((transaction) => {
      transaction.meta.set("addToHistory", false);
      text.insert(text.length, " excluded");
    }, "local");
    document.transact(() => text.insert(text.length, " B"), "local");
    expect(manager.undoStack).toHaveLength(2);
    expect(journal.patch(manager.undoStack[1]!).changes[0]?.before?.content).toEqual([
      { type: "text", text: "One A excluded", styles: {} },
    ]);
  } finally {
    fixture.close();
  }
});

test("local XML recreation and native Undo keep using Yjs, including a subsequent unrelated remote edit", () => {
  const fixture = setup("One\nTwo");
  const { document, group, manager, journal } = fixture;
  try {
    const paragraph = group.get(0) as Y.XmlElement;
    const first = (paragraph.get(0) as Y.XmlElement).get(0) as Y.XmlText;
    document.transact(() => first.insert(first.length, " A"), "local");
    const item = manager.undoStack[0]!;
    manager.stopCapturing();
    const replacement = cloneXmlSubtree(paragraph);
    document.transact(() => {
      group.delete(0, 1);
      group.insert(0, [replacement]);
    }, "local");
    expect(journal.requiresBridge(item)).toBe(false);
    manager.undo();
    const second = ((group.get(1) as Y.XmlElement).get(0) as Y.XmlElement).get(0) as Y.XmlText;
    document.transact(() => second.insert(second.length, " remote"), "remote");
    expect(journal.requiresBridge(item)).toBe(false);
    manager.undo();
    const current = ((group.get(0) as Y.XmlElement).get(0) as Y.XmlElement).get(0) as Y.XmlText;
    expect(current.toString()).toBe("One");
  } finally {
    fixture.close();
  }
});

test("creation and subsequent typing in one capture preserve the absent before-state", () => {
  const fixture = setup("One");
  const { document, group, manager, journal } = fixture;
  try {
    const clone = cloneXmlSubtree(group.get(0)) as Y.XmlElement;
    clone.setAttribute("id", "created");
    document.transact(() => group.insert(1, [clone]), "local");
    const text = (clone.get(0) as Y.XmlElement).get(0) as Y.XmlText;
    document.transact(() => text.insert(text.length, " new"), "local");
    expect(
      journal.patch(manager.undoStack[0]!).changes.find((change) => change.blockId === "created"),
    ).toMatchObject({
      before: null,
      after: { content: [{ type: "text", text: "One new", styles: {} }] },
    });
  } finally {
    fixture.close();
  }
});
