import { act } from "react";
import { fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import { render } from "../../../test/dom";
import {
  DatabaseListDndProvider,
  useDatabaseListPageDnd,
  type DatabaseListDndCommit,
} from "./database-list-dnd";
import { emptyDatabaseListSelection, type DatabaseListPageRow } from "./database-list-model";

const page = (input: {
  readonly key: string;
  readonly pageId: string;
  readonly top: number;
  readonly hasChildren?: boolean;
  readonly pageKey?: string | null;
  readonly priority?: DatabaseListPageRow["row"]["priority"];
  readonly status?: DatabaseListPageRow["row"]["status"];
}): DatabaseListPageRow => ({
  kind: "page",
  key: input.key,
  pageId: input.pageId,
  row: {
    pageId: input.pageId,
    pageKey: input.pageKey ?? null,
    groupKey: "build",
    subgroupKey: null,
    title: input.pageId,
    preview: "",
    plainText: "",
    tags: [],
    priority: input.priority,
    status: input.status,
    taskParentValueRevision: 1,
    documentGeneration: 1,
    documentHeadSeq: 1,
    metadataRevision: 1,
    createdAt: new Date("2026-08-13T00:00:00.000Z"),
  },
  groupKey: "build",
  subgroupKey: null,
  ancestorPageIds: [],
  depth: 0,
  hasChildren: input.hasChildren ?? false,
  transientKind: "none",
  subtreeOccurrenceCount: 1,
  concreteSubtreePageCount: 1,
  subtreeHeight: 0,
  firstChildOccurrenceKey: null,
  firstInGroup: false,
  lastInGroup: false,
  height: 44,
});

const TestPage = ({ item }: { readonly item: DatabaseListPageRow }) => {
  const dnd = useDatabaseListPageDnd(item);
  return (
    <div
      {...dnd.attributes}
      {...dnd.listeners}
      ref={dnd.setNodeRef}
      data-test-row={item.key}
      data-active={dnd.active || undefined}
      data-target={dnd.target?.kind === "page" ? dnd.target.pointerEdge : undefined}
    >
      {item.row.title}
      <button type="button">Property</button>
    </div>
  );
};

const rect = (top: number): DOMRect =>
  ({
    x: 0,
    y: top,
    top,
    left: 0,
    right: 600,
    bottom: top + 44,
    width: 600,
    height: 44,
    toJSON: () => ({}),
  }) as DOMRect;

afterEach(() => vi.restoreAllMocks());

describe("Database List dnd-kit controller", () => {
  test("activates after four pixels, portals a compact overlay, and cancels cleanly", async () => {
    const source = page({
      key: "source",
      pageId: "page-019ff012-abcd",
      pageKey: "LAB-13",
      top: 0,
      priority: "p1-high",
      status: "build",
    });
    const target = page({ key: "target", pageId: "Target", top: 44, hasChildren: true });
    const commits: DatabaseListDndCommit[] = [];
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this instanceof HTMLElement) {
        if (this.dataset.testRow === "target") return rect(44);
        if (this.dataset.testRow === "source") return rect(0);
      }
      return rect(0);
    });
    const scroller = document.createElement("div");
    const scrollerRef = { current: scroller };
    const view = render(
      <DatabaseListDndProvider
        rows={[source, target]}
        selection={emptyDatabaseListSelection()}
        scrollerRef={scrollerRef}
        disabled={false}
        onCommit={(commit) => commits.push(commit)}
      >
        <TestPage item={source} />
        <TestPage item={target} />
      </DatabaseListDndProvider>,
    );
    const sourceElement = view.getByText("page-019ff012-abcd").closest("[data-test-row]");
    if (!(sourceElement instanceof HTMLElement)) throw new Error("missing source row");
    expect(sourceElement.getAttribute("draggable")).toBeNull();

    await act(async () => {
      fireEvent.mouseDown(sourceElement, { clientX: 20, clientY: 20, buttons: 1 });
      fireEvent.mouseMove(document, { clientX: 23, clientY: 20, buttons: 1 });
      await Promise.resolve();
    });
    expect(document.body.querySelector("[data-database-list-drag-overlay=true]")).toBeNull();

    await act(async () => {
      fireEvent.mouseMove(document, { clientX: 25, clientY: 20, buttons: 1 });
      await Promise.resolve();
    });
    await waitFor(() => {
      const overlay = document.body.querySelector("[data-database-list-drag-overlay=true]");
      expect(overlay).not.toBeNull();
      expect(overlay?.parentElement?.parentElement).toBe(document.body);
      expect(overlay?.querySelector("[data-list-drag-overlay-column=priority]")).not.toBeNull();
      expect(
        overlay?.querySelector("[data-list-drag-overlay-column=identifier]")?.textContent,
      ).toBe("LAB-13");
      expect(overlay?.querySelector("[data-list-drag-overlay-column=status]")).not.toBeNull();
      expect(sourceElement.getAttribute("data-active")).toBe("true");
      expect(document.body.textContent).toContain("Picked up page-019ff012-abcd.");
    });

    await act(async () => {
      fireEvent.keyDown(document, { key: "Escape", code: "Escape" });
      await Promise.resolve();
    });

    expect(commits).toEqual([]);
    await waitFor(() => {
      expect(document.body.querySelector("[data-database-list-drag-overlay=true]")).toBeNull();
      expect(document.body.textContent).toContain("List movement cancelled.");
    });

    await act(async () => {
      fireEvent.mouseDown(sourceElement, { clientX: 20, clientY: 20, buttons: 1 });
      fireEvent.mouseMove(document, { clientX: 25, clientY: 20, buttons: 1 });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(document.body.querySelector("[data-database-list-drag-overlay=true]")).not.toBeNull();
    });
    await act(async () => {
      fireEvent.blur(window);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(document.body.querySelector("[data-database-list-drag-overlay=true]")).toBeNull();
    });
    expect(commits).toEqual([]);

    await act(async () => {
      fireEvent.mouseDown(sourceElement, { clientX: 20, clientY: 20, buttons: 1 });
      fireEvent.mouseMove(document, { clientX: 25, clientY: 70, buttons: 1 });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(document.body.querySelector("[data-database-list-drag-overlay=true]")).not.toBeNull();
    });
    await act(async () => {
      fireEvent.mouseMove(document, { clientX: 700, clientY: 200, buttons: 1 });
      fireEvent.mouseUp(document, { clientX: 700, clientY: 200 });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(document.body.querySelector("[data-database-list-drag-overlay=true]")).toBeNull();
    });
    expect(commits).toEqual([]);
  });

  test("does not activate from an interactive property control", async () => {
    const source = page({ key: "source", pageId: "Source", top: 0 });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(rect(0));
    const commits: DatabaseListDndCommit[] = [];
    const view = render(
      <DatabaseListDndProvider
        rows={[source]}
        selection={emptyDatabaseListSelection()}
        scrollerRef={{ current: document.createElement("div") }}
        disabled={false}
        onCommit={(commit) => commits.push(commit)}
      >
        <TestPage item={source} />
      </DatabaseListDndProvider>,
    );

    await act(async () => {
      fireEvent.mouseDown(view.getByRole("button", { name: "Property" }), {
        clientX: 20,
        clientY: 20,
        buttons: 1,
      });
      fireEvent.mouseMove(document, { clientX: 40, clientY: 40, buttons: 1 });
      fireEvent.mouseUp(document, { clientX: 40, clientY: 40 });
      await Promise.resolve();
    });

    expect(document.body.querySelector("[data-database-list-drag-overlay=true]")).toBeNull();
    expect(commits).toEqual([]);
  });

  test("silently settles when a Page is returned to its original sibling slot", async () => {
    const first = page({ key: "first", pageId: "First", top: 0 });
    const source = page({ key: "source", pageId: "Source", top: 44 });
    const last = page({ key: "last", pageId: "Last", top: 88 });
    const commits: DatabaseListDndCommit[] = [];
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.dataset.testRow === "source") return rect(44);
      if (this.dataset.testRow === "last") return rect(88);
      return rect(0);
    });
    const view = render(
      <DatabaseListDndProvider
        rows={[first, source, last]}
        selection={emptyDatabaseListSelection()}
        scrollerRef={{ current: document.createElement("div") }}
        disabled={false}
        onCommit={(commit) => commits.push(commit)}
      >
        <TestPage item={first} />
        <TestPage item={source} />
        <TestPage item={last} />
      </DatabaseListDndProvider>,
    );
    const sourceElement = view.getByText("Source").closest("[data-test-row]");
    if (!(sourceElement instanceof HTMLElement)) throw new Error("missing source row");

    await act(async () => {
      fireEvent.mouseDown(sourceElement, { clientX: 20, clientY: 66, buttons: 1 });
      fireEvent.mouseMove(document, { clientX: 25, clientY: 66, buttons: 1 });
      fireEvent.mouseMove(document, { clientX: 25, clientY: 40, buttons: 1 });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(view.getByText("First").closest("[data-test-row]")?.getAttribute("data-target")).toBe(
        "after",
      );
    });
    await act(async () => {
      fireEvent.mouseUp(document, { clientX: 25, clientY: 40 });
      await Promise.resolve();
    });

    expect(commits).toEqual([]);
    await waitFor(() => {
      expect(document.body.textContent).toContain("The Page stayed in its current List position.");
    });
  });

  test("moves between Page targets with the keyboard sensor", async () => {
    const source = page({ key: "source", pageId: "Source", top: 0 });
    const target = page({ key: "target", pageId: "Target", top: 44 });
    const commits: DatabaseListDndCommit[] = [];
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.dataset.testRow === "target") return rect(44);
      return rect(0);
    });
    const scroller = document.createElement("div");
    const view = render(
      <DatabaseListDndProvider
        rows={[source, target]}
        selection={emptyDatabaseListSelection()}
        scrollerRef={{ current: scroller }}
        disabled={false}
        onCommit={(commit) => commits.push(commit)}
      >
        <TestPage item={source} />
        <TestPage item={target} />
      </DatabaseListDndProvider>,
    );
    const sourceElement = view.getByText("Source").closest("[data-test-row]");
    if (!(sourceElement instanceof HTMLElement)) throw new Error("missing source row");

    await act(async () => {
      sourceElement.focus();
      fireEvent.keyDown(sourceElement, { code: "Space", key: " " });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(document.body.querySelector("[data-database-list-drag-overlay=true]")).not.toBeNull();
    });
    await act(async () => {
      fireEvent.keyDown(document, { code: "ArrowDown", key: "ArrowDown" });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(view.getByText("Target").closest("[data-test-row]")?.getAttribute("data-target")).toBe(
        "after",
      );
    });
    await act(async () => {
      fireEvent.keyDown(document, { code: "Space", key: " " });
      await Promise.resolve();
    });

    await waitFor(() => expect(commits).toHaveLength(1));
    expect(commits[0]).toMatchObject({
      initiatorOccurrenceKey: "source",
      target: { kind: "page", occurrenceKey: "target", edge: "after" },
    });
  });
});
