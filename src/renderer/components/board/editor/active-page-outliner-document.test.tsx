import { act, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import * as Y from "yjs";
import type { PageOutlinerRowChromeProps } from "@/components/block-documents/page-outliner-surface";
import type { AvailablePageOutlinerTarget } from "@/lib/page-outliner-target";
import {
  readRichTitleDomSelection,
  restoreRichTitleDomSelection,
} from "@/lib/rich-title-editor-dom";
import { render } from "@/test/dom";
import { projectContentAccess } from "../../../../shared/content-access-context";
import type { OwnedDocumentDescriptor } from "../../../../shared/block-documents/contracts";
import { ActivePageOutlinerDocument } from "./active-page-outliner-document";

const surfaceState = vi.hoisted(() => ({ value: null as unknown }));
const bodyBoundaryFocus = vi.hoisted(() => vi.fn(() => true));

vi.mock("@/components/block-documents/owned-block-document-boundary", () => ({
  OwnedBlockDocumentBoundary: ({
    children,
  }: {
    children: (
      model: { status: "ready"; descriptor: Record<string, unknown> },
      controls: { reload: () => Promise<void> },
    ) => React.ReactNode;
  }) =>
    children(
      { status: "ready", descriptor: { documentId: "document:nested" } },
      { reload: () => Promise.resolve() },
    ),
}));

vi.mock("@/components/block-documents/block-document-surface", () => ({
  BlockDocumentSurface: ({ children }: { children: (surface: unknown) => React.ReactNode }) =>
    children(surfaceState.value),
}));

vi.mock("@/components/block-documents/block-document-sync-status", () => ({
  BlockDocumentSyncStatus: () => null,
}));

vi.mock("@/lib/use-projects", () => ({
  useProjects: () => ({
    projects: [{ id: "project-a", name: "Project A", path: null }],
  }),
}));

vi.mock("./nfm-editor", async () => {
  const React = await import("react");
  return {
    NfmEditor: ({
      embeddedBoundary,
    }: {
      embeddedBoundary: {
        navigationRef: React.Ref<{ focusBoundary: (direction: "up" | "down") => boolean }>;
        onBoundaryArrow: (direction: "up" | "down") => boolean;
      };
    }) => {
      React.useImperativeHandle(embeddedBoundary.navigationRef, () => ({
        focusBoundary: bodyBoundaryFocus,
      }));
      return (
        <div data-testid="body-editor">
          <button type="button" onClick={() => embeddedBoundary.onBoundaryArrow("up")}>
            Leave body up
          </button>
          <button type="button" onClick={() => embeddedBoundary.onBoundaryArrow("down")}>
            Leave body down
          </button>
        </div>
      );
    },
  };
});

const target: AvailablePageOutlinerTarget = {
  status: "available",
  relationship: "child",
  targetBlockId: "nested-page",
  contentAccessContext: projectContentAccess("project-a"),
  lifecycle: "active",
  inlineMode: "editable",
  fallbackTitle: "Nested Page",
  page: {
    pageId: "nested-page",
    libraryId: "library:a",
    lifecycle: "active",
    parent: { kind: "page", pageId: "host-page" },
    parentRevision: 1,
    metadataRevision: 1,
    documentId: "document:nested",
    documentGeneration: 1,
    documentHeadSeq: 1,
    title: "Nested Page",
    richTitle: [{ type: "text", text: "Nested Page", styles: {} }],
    preview: "Body",
    plainText: "Body",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
};

const rowProps = (expanded: boolean): PageOutlinerRowChromeProps => ({
  plainTitle: "Nested Page",
  expanded,
  expandable: true,
  onExpandedChange: () => undefined,
});

const hostRuntime = {
  contentAccessContext: { kind: "project", projectId: "project-a" } as const,
  projectName: "Project A",
  projectWorkspacePath: null,
  hostPageId: "host-page",
  ancestorPageIds: ["host-page"],
  ancestorDocumentOwnerBlockIds: ["host-page"],
  isActiveSurface: true,
};

function createSurface() {
  const document = new Y.Doc({ guid: "active-page-outliner-test" });
  const title = document.getText("title");
  title.insert(0, "Nested Page");
  return {
    document,
    surface: {
      title,
      body: document.getXmlFragment("body"),
      documentId: "document:nested",
      descriptor: {
        libraryId: "library:a",
        accessContext: projectContentAccess("project-a"),
        documentId: "document:nested",
        ownerBlockId: "nested-page",
        ownerType: "page",
        ownerLifecycle: "active",
        storeEpoch: "epoch",
        generation: 1,
        headSeq: 0,
        schemaKey: "nfm",
        schemaVersion: 1,
        authorization: null,
        readiness: "ready",
        sync: { kind: "yjs", stateVector: Y.encodeStateVector(document) },
      } satisfies OwnedDocumentDescriptor,
      clientSessionId: "client",
      awareness: {},
      runtime: {
        subscribe: () => () => undefined,
        flushAndFence: async () => ({
          documentId: "document:nested",
          storeEpoch: "epoch",
          generation: 1,
          expectedHeadSeq: 0,
        }),
      },
      status: { provider: "synced" },
    },
  };
}

describe("ActivePageOutlinerDocument", () => {
  beforeEach(() => {
    bodyBoundaryFocus.mockClear();
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis.document, "caretPositionFromPoint");
    Reflect.deleteProperty(globalThis.document, "caretRangeFromPoint");
  });

  test("preserves first-mount pointer placement after title subscription setup", () => {
    const { document, surface } = createSurface();
    surfaceState.value = surface;
    const consumed = vi.fn();
    const caretRangeFromPoint = vi.fn((clientX: number, clientY: number) => {
      expect({ clientX, clientY }).toEqual({ clientX: 240, clientY: 80 });
      const editor = globalThis.document.querySelector<HTMLElement>(
        '[aria-label="Edit Nested Page title"]',
      );
      const text = editor?.querySelector<HTMLElement>("[data-rich-title-kind='text']")?.firstChild;
      if (!(text instanceof Text)) return null;
      const range = globalThis.document.createRange();
      range.setStart(text, 6);
      range.collapse(true);
      return range;
    });
    Object.defineProperties(globalThis.document, {
      caretPositionFromPoint: {
        configurable: true,
        value: undefined,
      },
      caretRangeFromPoint: {
        configurable: true,
        value: caretRangeFromPoint,
      },
    });

    const view = render(
      <ActivePageOutlinerDocument
        target={target}
        rowProps={rowProps(false)}
        hostRuntime={hostRuntime}
        focusIntent={{
          id: 1,
          kind: "pointer",
          clientX: 240,
          clientY: 80,
        }}
        onFocusIntentConsumed={consumed}
        onTitleFocus={() => undefined}
        onTitleBlur={() => undefined}
        onMoveToHostBoundary={() => true}
        onEscapeToHostShell={() => true}
      />,
    );
    const title = view.getByRole("textbox", {
      name: "Edit Nested Page title",
    }) as HTMLDivElement;

    expect(caretRangeFromPoint).toHaveBeenCalledTimes(1);
    expect(readRichTitleDomSelection(title)).toMatchObject({
      start: 6,
      end: 6,
    });
    expect(consumed).toHaveBeenCalledWith(1);
    document.destroy();
  });

  test("consumes collapsed entry in the authoritative title without mounting a body", async () => {
    const { document, surface } = createSurface();
    surfaceState.value = surface;
    const consumed = vi.fn();
    const titleFocus = vi.fn();
    const moveToHost = vi.fn(() => true);
    const escapeToHost = vi.fn(() => true);
    const view = render(
      <ActivePageOutlinerDocument
        target={target}
        rowProps={rowProps(false)}
        hostRuntime={hostRuntime}
        focusIntent={{ id: 1, kind: "boundary", direction: "down" }}
        onFocusIntentConsumed={consumed}
        onTitleFocus={titleFocus}
        onTitleBlur={() => undefined}
        onMoveToHostBoundary={moveToHost}
        onEscapeToHostShell={escapeToHost}
      />,
    );
    const title = view.getByRole("textbox", {
      name: "Edit Nested Page title",
    }) as HTMLDivElement;

    expect(view.queryByTestId("body-editor")).toBeNull();
    expect(document.getText("title")).toBe(surface.title);
    expect(document.getXmlFragment("body")).toBe(surface.body);
    expect(document.getText("title").toString()).toBe("Nested Page");
    expect(title.ownerDocument.activeElement).toBe(title);
    expect(readRichTitleDomSelection(title)).toMatchObject({ start: 0, end: 0 });
    expect(consumed).toHaveBeenCalledWith(1);
    expect(titleFocus).toHaveBeenCalled();

    await act(async () => {
      restoreRichTitleDomSelection(title, surface.title.length, surface.title.length);
      fireEvent.keyDown(title, { key: "ArrowDown" });
      await Promise.resolve();
    });
    expect(moveToHost).toHaveBeenCalledWith("down");

    await act(async () => {
      fireEvent.keyDown(title, { key: "Escape" });
      await Promise.resolve();
    });
    expect(escapeToHost).toHaveBeenCalled();
    document.destroy();
  });

  test("enters an expanded body from below and bridges body edges through the title", async () => {
    const { document, surface } = createSurface();
    surfaceState.value = surface;
    const consumed = vi.fn();
    const moveToHost = vi.fn(() => true);
    const view = render(
      <ActivePageOutlinerDocument
        target={target}
        rowProps={rowProps(true)}
        hostRuntime={hostRuntime}
        focusIntent={{ id: 2, kind: "boundary", direction: "up" }}
        onFocusIntentConsumed={consumed}
        onTitleFocus={() => undefined}
        onTitleBlur={() => undefined}
        onMoveToHostBoundary={moveToHost}
        onEscapeToHostShell={() => true}
      />,
    );
    const title = view.getByRole("textbox", {
      name: "Edit Nested Page title",
    }) as HTMLDivElement;

    expect(view.getByTestId("body-editor")).toBeTruthy();
    expect(bodyBoundaryFocus).toHaveBeenCalledWith("up");
    expect(consumed).toHaveBeenCalledWith(2);

    await act(async () => {
      restoreRichTitleDomSelection(title, surface.title.length, surface.title.length);
      fireEvent.keyDown(title, { key: "ArrowDown" });
      await Promise.resolve();
    });
    expect(bodyBoundaryFocus).toHaveBeenCalledWith("down");

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Leave body up" }));
      await Promise.resolve();
    });
    expect(title.ownerDocument.activeElement).toBe(title);
    expect(readRichTitleDomSelection(title)).toMatchObject({
      start: surface.title.length,
      end: surface.title.length,
    });

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Leave body down" }));
      await Promise.resolve();
    });
    expect(moveToHost).toHaveBeenCalledWith("down");
    document.destroy();
  });
});
