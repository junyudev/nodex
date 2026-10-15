import { act, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { BlockReferenceRuntimeProvider } from "@/components/block-documents/block-reference-runtime-context";
import { BlockDisclosureStateStore } from "@/lib/block-disclosure-state";
import { ReferenceSurfaceActivationBudget } from "@/lib/reference-surface-state";
import { render } from "@/test/dom";
import { PageOutlinerBlock } from "./page-outliner-block";
import {
  handleArrowIntoEmbeddedSurface,
  type EmbeddedSurfaceHostEditor,
} from "./embedded-surface-arrow-navigation";

const targetModel = vi.hoisted(() => ({
  status: "available" as const,
  targetPageId: "nested-page",
  page: {
    pageId: "nested-page",
    libraryId: "library:a",
    lifecycle: "active" as const,
    parent: { kind: "page" as const, pageId: "host-page" },
    parentRevision: 1,
    metadataRevision: 1,
    documentId: "document:nested-page",
    documentGeneration: 1,
    documentHeadSeq: 1,
    title: "Nested Page",
    richTitle: [{ type: "text" as const, text: "Nested Page", styles: {} }],
    preview: "Body",
    plainText: "Body",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  document: {
    readiness: "ready" as const,
    schemaKey: "nodex.page",
    schemaVersion: 3,
  },
}));

const activeRuntimeProps = vi.hoisted(() => vi.fn());

vi.mock("@/lib/block-reference-queries", () => ({
  usePageTargetReadModel: () => ({
    data: targetModel,
    loading: false,
    error: null,
  }),
}));

vi.mock("./active-page-outliner-document", () => ({
  ActivePageOutlinerDocument: (props: { rowProps: { expanded: boolean } }) => {
    activeRuntimeProps(props);
    return (
      <div
        data-testid="expanded-page-runtime"
        data-expanded={props.rowProps.expanded ? "true" : "false"}
      >
        Target runtime
      </div>
    );
  },
}));

class ControlledIntersectionObserver implements IntersectionObserver {
  static latest: ControlledIntersectionObserver | null = null;

  readonly root = null;
  readonly rootMargin: string;
  readonly scrollMargin = "0px";
  readonly thresholds = [0];
  observed: Element | null = null;

  constructor(
    private readonly callback: IntersectionObserverCallback,
    options?: IntersectionObserverInit,
  ) {
    this.rootMargin = options?.rootMargin ?? "0px";
    ControlledIntersectionObserver.latest = this;
  }

  disconnect(): void {
    this.observed = null;
  }

  observe(target: Element): void {
    this.observed = target;
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  unobserve(target: Element): void {
    if (this.observed === target) this.observed = null;
  }

  emit(isIntersecting: boolean): void {
    if (!this.observed) throw new Error("No observed Page outliner anchor");
    const rect = this.observed.getBoundingClientRect();
    this.callback(
      [
        {
          boundingClientRect: rect,
          intersectionRatio: isIntersecting ? 1 : 0,
          intersectionRect: rect,
          isIntersecting,
          rootBounds: null,
          target: this.observed,
          time: performance.now(),
        },
      ],
      this,
    );
  }
}

const originalIntersectionObserver = globalThis.IntersectionObserver;

afterEach(() => {
  activeRuntimeProps.mockClear();
  ControlledIntersectionObserver.latest = null;
  Object.defineProperty(globalThis, "IntersectionObserver", {
    configurable: true,
    writable: true,
    value: originalIntersectionObserver,
  });
});

describe("PageOutlinerBlock", () => {
  test("pointer-edits through an active collapsed runtime without changing disclosure", async () => {
    const disclosureStore = new BlockDisclosureStateStore();
    const activationBudget = new ReferenceSurfaceActivationBudget(1);
    const view = render(
      <BlockReferenceRuntimeProvider
        value={{
          contentRoutingContext: { kind: "project", projectId: "project-a" },
          projectName: "Project A",
          projectWorkspacePath: null,
          hostPageId: "host-page",
          ancestorPageIds: ["host-page"],
          ancestorDocumentOwnerBlockIds: ["host-page"],
          isActiveSurface: true,
        }}
      >
        <PageOutlinerBlock
          relationship="child"
          shellBlockId="nested-page"
          targetBlockId="nested-page"
          disclosureStore={disclosureStore}
          activationBudget={activationBudget}
          visibilityOverride={false}
        />
      </BlockReferenceRuntimeProvider>,
    );
    const frame = view.container.querySelector<HTMLElement>(
      "[data-page-outliner-target='nested-page']",
    );
    if (!frame) throw new Error("Missing Page outliner frame");

    const titleTrigger = view.getByRole("button", {
      name: "Edit Nested Page title",
    });
    await act(async () => {
      fireEvent.pointerDown(titleTrigger, { clientX: 144, clientY: 32 });
      fireEvent.click(titleTrigger);
      await Promise.resolve();
    });

    await waitFor(() => expect(view.getByTestId("expanded-page-runtime")).toBeTruthy());
    expect(frame.dataset.pageOutlinerActive).toBe("true");
    expect(frame.dataset.pageOutlinerExpanded).toBe("false");
    expect(disclosureStore.isExpanded("nested-page")).toBe(false);
    expect(activeRuntimeProps.mock.lastCall?.[0]).toMatchObject({
      focusIntent: {
        kind: "pointer",
        clientX: 144,
        clientY: 32,
      },
    });
  });

  test("records a visual-boundary focus intent when the host arrows into a Page", async () => {
    const disclosureStore = new BlockDisclosureStateStore();
    const activationBudget = new ReferenceSurfaceActivationBudget(1);
    const cursorMoves: Array<{ id: string; placement?: "start" | "end" }> = [];
    const hostEditor: EmbeddedSurfaceHostEditor = {
      document: [
        { id: "before", type: "paragraph", children: [] },
        { id: "nested-page", type: "page", children: [] },
        { id: "after", type: "paragraph", children: [] },
      ],
      prosemirrorView: {
        state: { selection: { empty: true } },
        dom: document.createElement("div"),
        endOfTextblock: () => true,
      },
      getTextCursorPosition: () => ({
        block: { id: "before", type: "paragraph" },
      }),
      setTextCursorPosition: (id, placement) => {
        cursorMoves.push({ id, placement });
      },
      focus: () => undefined,
    };
    render(
      <BlockReferenceRuntimeProvider
        value={{
          contentRoutingContext: { kind: "project", projectId: "project-a" },
          projectName: "Project A",
          projectWorkspacePath: null,
          hostPageId: "host-page",
          ancestorPageIds: ["host-page"],
          ancestorDocumentOwnerBlockIds: ["host-page"],
          isActiveSurface: true,
        }}
      >
        <PageOutlinerBlock
          relationship="child"
          shellBlockId="nested-page"
          targetBlockId="nested-page"
          hostEditor={hostEditor}
          disclosureStore={disclosureStore}
          activationBudget={activationBudget}
          visibilityOverride={false}
        />
      </BlockReferenceRuntimeProvider>,
    );

    await act(async () => {
      expect(handleArrowIntoEmbeddedSurface(hostEditor, "down")).toBe(true);
      await Promise.resolve();
    });

    await waitFor(() => expect(activeRuntimeProps).toHaveBeenCalled());
    expect(activeRuntimeProps.mock.lastCall?.[0]).toMatchObject({
      focusIntent: { kind: "boundary", direction: "down" },
      rowProps: { expanded: false },
    });
    expect(cursorMoves).toEqual([{ id: "nested-page", placement: "start" }]);
    expect(disclosureStore.isExpanded("nested-page")).toBe(false);
  });

  test("keeps one observed row mounted while the target runtime activates", async () => {
    Object.defineProperty(globalThis, "IntersectionObserver", {
      configurable: true,
      writable: true,
      value: ControlledIntersectionObserver,
    });
    const disclosureStore = new BlockDisclosureStateStore();
    const activationBudget = new ReferenceSurfaceActivationBudget(1);
    const view = render(
      <BlockReferenceRuntimeProvider
        value={{
          contentRoutingContext: { kind: "project", projectId: "project-a" },
          projectName: "Project A",
          projectWorkspacePath: null,
          hostPageId: "host-page",
          ancestorPageIds: ["host-page"],
          ancestorDocumentOwnerBlockIds: ["host-page"],
          isActiveSurface: true,
        }}
      >
        <PageOutlinerBlock
          relationship="child"
          shellBlockId="nested-page"
          targetBlockId="nested-page"
          disclosureStore={disclosureStore}
          activationBudget={activationBudget}
        />
      </BlockReferenceRuntimeProvider>,
    );
    const anchor = view.container.querySelector<HTMLElement>(
      "[data-page-outliner-target='nested-page']",
    );
    expect(anchor).toBeTruthy();
    await waitFor(() => expect(ControlledIntersectionObserver.latest).toBeTruthy());

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Expand Nested Page" }));
      ControlledIntersectionObserver.latest?.emit(true);
      await Promise.resolve();
    });
    await waitFor(() => expect(view.getByTestId("expanded-page-runtime")).toBeTruthy());

    expect(view.container.querySelector("[data-page-outliner-target='nested-page']")).toBe(anchor);
    expect(ControlledIntersectionObserver.latest?.observed).toBe(anchor);
    expect(activationBudget.getActiveKeys()).toHaveLength(1);
  });

  test("persists disclosure by reference Block identity rather than target Page", async () => {
    const disclosureStore = new BlockDisclosureStateStore();
    const activationBudget = new ReferenceSurfaceActivationBudget(2);
    const view = render(
      <BlockReferenceRuntimeProvider
        value={{
          contentRoutingContext: { kind: "project", projectId: "project-a" },
          projectName: "Project A",
          projectWorkspacePath: null,
          hostPageId: "host-page",
          ancestorPageIds: ["host-page"],
          ancestorDocumentOwnerBlockIds: ["host-page"],
          isActiveSurface: true,
        }}
      >
        <PageOutlinerBlock
          relationship="reference"
          shellBlockId="page-ref-1"
          targetBlockId="nested-page"
          disclosureStore={disclosureStore}
          activationBudget={activationBudget}
          visibilityOverride
        />
        <PageOutlinerBlock
          relationship="reference"
          shellBlockId="page-ref-2"
          targetBlockId="nested-page"
          disclosureStore={disclosureStore}
          activationBudget={activationBudget}
          visibilityOverride
        />
      </BlockReferenceRuntimeProvider>,
    );
    const rows = view.container.querySelectorAll("[data-page-outliner-target='nested-page']");
    const firstDisclosure = view.getAllByRole("button", { name: "Expand Nested Page" }).at(0);
    if (!firstDisclosure) throw new Error("Missing first Page disclosure");

    await act(async () => {
      fireEvent.click(firstDisclosure);
      await Promise.resolve();
    });

    expect(rows[0]?.getAttribute("data-page-outliner-expanded")).toBe("true");
    expect(rows[1]?.getAttribute("data-page-outliner-expanded")).toBe("false");
    expect(disclosureStore.isExpanded("page-ref-1")).toBe(true);
    expect(disclosureStore.isExpanded("page-ref-2")).toBe(false);
  });
});
