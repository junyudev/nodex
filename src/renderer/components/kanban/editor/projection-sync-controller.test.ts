import { describe, expect, test } from "bun:test";
import { EDITOR_SYNC_DEBOUNCE_MS } from "../../../lib/timing";
import type { CardInput } from "../../../lib/types";
import type { ToggleListCard } from "../../../lib/toggle-list/types";
import {
  buildProjectedCardToggleBlock,
} from "./projection-card-toggle";
import {
  removeProjectionSyncOwner,
  resetProjectionSyncControllersForTest,
  upsertProjectionSyncOwner,
} from "./projection-sync-controller";

interface FakeEditorBlock {
  id: string;
  type?: string;
  props?: Record<string, unknown>;
  children?: unknown[];
}

interface FakeEditorRuntime {
  editor: {
    domElement: HTMLElement;
    getBlock: (id: string) => FakeEditorBlock | undefined;
    getParentBlock: (id: string) => FakeEditorBlock | undefined;
    getTextCursorPosition: () => { block: { id: string } };
    updateBlock: (id: string, update: { children: unknown[] }) => void;
    onChange: (listener: () => void) => () => void;
    onSelectionChange: (listener: () => void) => () => void;
  };
  setCursorBlock: (blockId: string) => void;
  triggerChange: () => void;
  triggerSelectionChange: () => void;
  triggerFocusOut: () => void;
  updateCalls: Array<{ id: string; children: unknown[] }>;
  onChangeSubscribeCount: number;
  onSelectionSubscribeCount: number;
  onChangeUnsubscribeCount: number;
  onSelectionUnsubscribeCount: number;
}

interface FakeFocusOutEvent {
  type: "focusout";
  relatedTarget: unknown;
}

class FakeHTMLElement {
  className = "";

  private parent: FakeHTMLElement | null = null;

  private readonly children: FakeHTMLElement[] = [];

  private readonly listeners = new Map<string, Set<(event: FakeFocusOutEvent) => void>>();

  appendChild(child: FakeHTMLElement): void {
    child.parent = this;
    this.children.push(child);
  }

  closest(selector: string): FakeHTMLElement | null {
    if (selector !== ".nfm-editor") return null;

    if (this.className.split(" ").includes("nfm-editor")) {
      return this;
    }

    return this.parent?.closest(selector) ?? null;
  }

  contains(target: unknown): boolean {
    if (!(target instanceof FakeHTMLElement)) return false;

    let current: FakeHTMLElement | null = target;
    while (current) {
      if (current === this) return true;
      current = current.parent;
    }

    return false;
  }

  addEventListener(type: string, listener: (event: FakeFocusOutEvent) => void): void {
    const listeners = this.listeners.get(type) ?? new Set<(event: FakeFocusOutEvent) => void>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: FakeFocusOutEvent) => void): void {
    const listeners = this.listeners.get(type);
    if (!listeners) return;
    listeners.delete(listener);
    if (listeners.size === 0) {
      this.listeners.delete(type);
    }
  }

  dispatchEvent(event: FakeFocusOutEvent): void {
    const listeners = this.listeners.get(event.type);
    if (!listeners) return;

    for (const listener of listeners) {
      listener(event);
    }
  }
}

function installDomShims(): void {
  const domGlobal = globalThis as unknown as {
    Element?: typeof FakeHTMLElement;
    HTMLElement?: typeof FakeHTMLElement;
  };

  if (typeof domGlobal.Element === "undefined") {
    domGlobal.Element = FakeHTMLElement;
  }

  if (typeof domGlobal.HTMLElement === "undefined") {
    domGlobal.HTMLElement = FakeHTMLElement;
  }
}

installDomShims();

function makeCard(overrides: Partial<ToggleListCard> = {}): ToggleListCard {
  return {
    id: "card-1",
    status: "backlog",
    archived: false,
    title: "Saved title",
    description: "Saved description",
    priority: "p1-high",
    estimate: "m",
    tags: [],
    agentBlocked: false,
    created: new Date("2026-02-16T00:00:00.000Z"),
    order: 0,
    columnId: "backlog",
    columnName: "Backlog",
    boardIndex: 0,
    ...overrides,
  };
}

function waitForTimers(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(), ms);
  });
}

function waitForMicrotasks(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(), 0);
  });
}

function createFakeEditorRuntime(): FakeEditorRuntime {
  const container = new FakeHTMLElement();
  container.className = "nfm-editor";
  const host = new FakeHTMLElement();
  container.appendChild(host);

  const blocks = new Map<string, FakeEditorBlock>([
    ["owner-1", { id: "owner-1", type: "cardRef", children: [] }],
    ["owner-2", { id: "owner-2", type: "cardRef", children: [] }],
    ["leaf-1", { id: "leaf-1", type: "paragraph", children: [] }],
    ["leaf-2", { id: "leaf-2", type: "paragraph", children: [] }],
    ["outside", { id: "outside", type: "paragraph", children: [] }],
  ]);

  const parentById = new Map<string, string | undefined>([
    ["owner-1", undefined],
    ["owner-2", undefined],
    ["leaf-1", "owner-1"],
    ["leaf-2", "owner-2"],
    ["outside", undefined],
  ]);

  let cursorBlockId = "outside";
  const onChangeListeners = new Set<() => void>();
  const onSelectionListeners = new Set<() => void>();
  const updateCalls: Array<{ id: string; children: unknown[] }> = [];

  let onChangeSubscribeCount = 0;
  let onSelectionSubscribeCount = 0;
  let onChangeUnsubscribeCount = 0;
  let onSelectionUnsubscribeCount = 0;

  const editor = {
    domElement: host as unknown as HTMLElement,
    getBlock: (id: string) => blocks.get(id),
    getParentBlock: (id: string) => {
      const parentId = parentById.get(id);
      return typeof parentId === "string" ? blocks.get(parentId) : undefined;
    },
    getTextCursorPosition: () => ({
      block: {
        id: cursorBlockId,
      },
    }),
    updateBlock: (id: string, update: { children: unknown[] }) => {
      const block = blocks.get(id);
      if (!block) return;

      block.children = update.children;
      updateCalls.push({
        id,
        children: update.children,
      });
    },
    onChange: (listener: () => void) => {
      onChangeSubscribeCount += 1;
      onChangeListeners.add(listener);
      return () => {
        onChangeUnsubscribeCount += 1;
        onChangeListeners.delete(listener);
      };
    },
    onSelectionChange: (listener: () => void) => {
      onSelectionSubscribeCount += 1;
      onSelectionListeners.add(listener);
      return () => {
        onSelectionUnsubscribeCount += 1;
        onSelectionListeners.delete(listener);
      };
    },
  };

  return {
    editor,
    setCursorBlock: (blockId: string) => {
      cursorBlockId = blockId;
    },
    triggerChange: () => {
      for (const listener of onChangeListeners) {
        listener();
      }
    },
    triggerSelectionChange: () => {
      for (const listener of onSelectionListeners) {
        listener();
      }
    },
    triggerFocusOut: () => {
      container.dispatchEvent({
        type: "focusout",
        relatedTarget: null,
      });
    },
    updateCalls,
    get onChangeSubscribeCount() {
      return onChangeSubscribeCount;
    },
    get onSelectionSubscribeCount() {
      return onSelectionSubscribeCount;
    },
    get onChangeUnsubscribeCount() {
      return onChangeUnsubscribeCount;
    },
    get onSelectionUnsubscribeCount() {
      return onSelectionUnsubscribeCount;
    },
  };
}

function buildOwnerInput(
  ownerBlockId: string,
  card: ToggleListCard,
  updateCard: (columnId: string, cardId: string, updates: Partial<CardInput>) => Promise<void>,
  patchCard: (columnId: string, cardId: string, updates: Partial<CardInput>) => void = () => {},
  moveCard: (input: { cardId: string; fromStatus?: string; toStatus: string }) => Promise<boolean> = async () => true,
  savedColumnId = card.columnId,
) {
  const savedCard = makeCard({
    id: card.id,
    title: "Saved title",
    description: "",
    columnId: savedColumnId,
  });

  const projectedRows = [
    buildProjectedCardToggleBlock({
      ownerBlockId,
      projectionKind: "cardRef",
      sourceProjectId: "default",
      card,
      propertyOrder: ["priority", "estimate", "status", "tags"],
      hiddenProperties: [],
      showEmptyEstimate: false,
    }),
  ];

  return {
    ownerBlockId,
    enabled: true,
    projectedRows,
    projectedRowsSignature: JSON.stringify(projectedRows),
    cardById: new Map([[card.id, savedCard]]),
    updateCard,
    patchCard,
    moveCard,
  };
}

describe("projection sync controller", () => {
  test("attaches one listener set per editor for multiple owners", async () => {
    resetProjectionSyncControllersForTest();
    const runtime = createFakeEditorRuntime();
    const noOpUpdate = async () => {};

    upsertProjectionSyncOwner(
      runtime.editor,
      buildOwnerInput("owner-1", makeCard({ id: "card-1", title: "Edited one" }), noOpUpdate),
    );
    upsertProjectionSyncOwner(
      runtime.editor,
      buildOwnerInput("owner-2", makeCard({ id: "card-2", title: "Edited two" }), noOpUpdate),
    );
    await waitForMicrotasks();

    expect(runtime.onChangeSubscribeCount).toBe(1);
    expect(runtime.onSelectionSubscribeCount).toBe(1);

    removeProjectionSyncOwner(runtime.editor, "owner-1");
    removeProjectionSyncOwner(runtime.editor, "owner-2");

    expect(runtime.onChangeUnsubscribeCount).toBe(1);
    expect(runtime.onSelectionUnsubscribeCount).toBe(1);
  });

  test("targets focused owner on outbound flush scheduling", async () => {
    resetProjectionSyncControllersForTest();
    const runtime = createFakeEditorRuntime();
    let ownerOneUpdates = 0;
    let ownerTwoUpdates = 0;

    upsertProjectionSyncOwner(
      runtime.editor,
      buildOwnerInput(
        "owner-1",
        makeCard({ id: "card-1", title: "Edited one", description: "" }),
        async () => {
          ownerOneUpdates += 1;
        },
      ),
    );
    upsertProjectionSyncOwner(
      runtime.editor,
      buildOwnerInput(
        "owner-2",
        makeCard({ id: "card-2", title: "Edited two", description: "" }),
        async () => {
          ownerTwoUpdates += 1;
        },
      ),
    );
    await waitForMicrotasks();

    runtime.setCursorBlock("leaf-1");
    runtime.triggerSelectionChange();
    runtime.triggerChange();

    await waitForTimers(EDITOR_SYNC_DEBOUNCE_MS + 50);

    expect(ownerOneUpdates).toBe(1);
    expect(ownerTwoUpdates).toBe(0);
  });

  test("applies optimistic patch before remote update", async () => {
    resetProjectionSyncControllersForTest();
    const runtime = createFakeEditorRuntime();
    const callOrder: string[] = [];

    upsertProjectionSyncOwner(
      runtime.editor,
      buildOwnerInput(
        "owner-1",
        makeCard({ id: "card-1", title: "Optimistic edit", description: "" }),
        async () => {
          callOrder.push("update");
        },
        () => {
          callOrder.push("patch");
        },
      ),
    );
    await waitForMicrotasks();

    runtime.setCursorBlock("leaf-1");
    runtime.triggerSelectionChange();
    runtime.triggerChange();

    await waitForTimers(EDITOR_SYNC_DEBOUNCE_MS + 50);

    expect(callOrder[0]).toBe("patch");
    expect(callOrder[1]).toBe("update");
  });

  test("defers inbound reconcile while focused and applies on blur", async () => {
    resetProjectionSyncControllersForTest();
    const runtime = createFakeEditorRuntime();
    const noOpUpdate = async () => {};

    upsertProjectionSyncOwner(
      runtime.editor,
      buildOwnerInput(
        "owner-1",
        makeCard({
          id: "card-1",
          title: "Saved title",
          description: "",
          columnName: "Inbound A",
        }),
        noOpUpdate,
      ),
    );
    await waitForMicrotasks();
    expect(runtime.updateCalls.length).toBe(1);

    runtime.setCursorBlock("leaf-1");
    runtime.triggerSelectionChange();

    upsertProjectionSyncOwner(
      runtime.editor,
      buildOwnerInput(
        "owner-1",
        makeCard({
          id: "card-1",
          title: "Saved title",
          description: "",
          columnName: "Inbound B",
        }),
        noOpUpdate,
      ),
    );
    await waitForMicrotasks();
    expect(runtime.updateCalls.length).toBe(1);

    runtime.setCursorBlock("outside");
    runtime.triggerSelectionChange();
    await waitForMicrotasks();

    expect(runtime.updateCalls.length).toBe(2);
  });

  test("does not overwrite local projected edits with stale inbound rows while unfocused", async () => {
    resetProjectionSyncControllersForTest();
    const runtime = createFakeEditorRuntime();
    let remoteUpdates = 0;

    const applyStaleInbound = () =>
      upsertProjectionSyncOwner(
        runtime.editor,
        buildOwnerInput(
          "owner-1",
          makeCard({ id: "card-1", title: "Saved title", description: "" }),
          async () => {
            remoteUpdates += 1;
          },
        ),
      );

    applyStaleInbound();
    await waitForMicrotasks();
    expect(runtime.updateCalls.length).toBe(1);

    const ownerBlock = runtime.editor.getBlock("owner-1");
    const projectedRow = Array.isArray(ownerBlock?.children)
      ? ownerBlock.children[0]
      : undefined;
    expect(projectedRow).not.toBeNull();
    if (!projectedRow || typeof projectedRow !== "object" || !("content" in projectedRow)) {
      throw new Error("expected projected row to exist");
    }

    // Simulate a local edit (same shape as an unsynced projected-row mutation).
    (projectedRow as { content: unknown }).content = "Locally dropped";
    runtime.triggerChange();

    // Re-upsert with stale projected rows before outbound sync resolves.
    applyStaleInbound();
    await waitForMicrotasks();

    // Regression check: no stale inbound overwrite of owner children.
    expect(runtime.updateCalls.length).toBe(1);

    await waitForTimers(EDITOR_SYNC_DEBOUNCE_MS + 50);

    expect(remoteUpdates).toBe(1);
    const latestProjectedRow = runtime.editor.getBlock("owner-1")?.children?.[0] as
      | { content?: unknown }
      | undefined;
    expect(latestProjectedRow?.content).toBe("Locally dropped");
  });

  test("flushes pending outbound sync on container blur", async () => {
    resetProjectionSyncControllersForTest();
    const runtime = createFakeEditorRuntime();
    let updateCalls = 0;

    upsertProjectionSyncOwner(
      runtime.editor,
      buildOwnerInput(
        "owner-1",
        makeCard({ id: "card-1", title: "Blur edit", description: "" }),
        async () => {
          updateCalls += 1;
        },
      ),
    );
    await waitForMicrotasks();

    runtime.setCursorBlock("leaf-1");
    runtime.triggerSelectionChange();
    runtime.triggerFocusOut();
    await waitForMicrotasks();

    expect(updateCalls).toBe(1);
  });

  test("persists projected status chip edits with moveCard only", async () => {
    resetProjectionSyncControllersForTest();
    const runtime = createFakeEditorRuntime();
    let updateCalls = 0;
    let patchCalls = 0;
    let moveCalls = 0;

    upsertProjectionSyncOwner(
      runtime.editor,
      buildOwnerInput(
        "owner-1",
        makeCard({
          id: "card-1",
          title: "Saved title",
          description: "",
          columnId: "done",
          columnName: "Done",
        }),
        async () => {
          updateCalls += 1;
        },
        () => {
          patchCalls += 1;
        },
        async (input) => {
          moveCalls += 1;
          expect(input.fromStatus).toBe("backlog");
          expect(input.toStatus).toBe("done");
          return true;
        },
        "backlog",
      ),
    );
    await waitForMicrotasks();

    runtime.setCursorBlock("leaf-1");
    runtime.triggerSelectionChange();
    runtime.triggerChange();

    await waitForTimers(EDITOR_SYNC_DEBOUNCE_MS + 50);

    expect(patchCalls).toBe(0);
    expect(updateCalls).toBe(0);
    expect(moveCalls).toBe(1);
  });
});
