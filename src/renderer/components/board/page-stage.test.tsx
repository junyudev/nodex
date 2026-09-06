import { act, fireEvent, render as renderReact, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";

import { NodexTooltipProvider } from "@/components/ui/tooltip";
import {
  writePageStageContentWidthPreference,
  writePageStageShowRawContentPreference,
} from "@/lib/page-stage-layout";
import type { DatabasePage } from "@/lib/types";
import { projectPageDetailToStageModel, type PageStagePageModel } from "@/lib/page-stage-page";
import { readPageStageSemanticProperties } from "@/lib/page-stage-properties";
import type { PageStageDocumentAuthority, PageStageProps } from "./page-stage/types";
import { renderWithMaitai as render } from "@/test/thread-maitai";
import { MaitaiProvider } from "@/lib/maitai/maitai-scope";
import { createMaitaiStore, disposeMaitaiStore } from "@/lib/maitai/maitai-store";
import { TestThreadRouteScopePath } from "@/test/maitai-scope-harness";
import { settleAsyncRender } from "@/test/dom";
import {
  PAGE_DOCUMENT_SCHEMA_VERSION,
  createPageDocument,
} from "../../../shared/block-documents/page-document";
import { plainTextToPortableRichText } from "../../../shared/block-documents/portable-rich-text";
import { populateBlockDocumentBodyFromNfm } from "../../../shared/block-documents/block-document-codec";
import { projectContentAccess } from "../../../shared/content-access-context";
import { buildPageDetailStoryResult } from "./page-stage/page-stage-story-page-detail";
import { consumePageBlockFocus, requestPageBlockFocus } from "@/lib/page-block-focus-intents";
import type { NfmEditorBoundaryHandle } from "./editor/nfm-editor";
import {
  savePageStageViewportSnapshot,
  loadPageStageViewportSnapshot,
} from "@/lib/page-stage-viewport-storage";

let lastNfmEditorProps: Record<string, unknown> | null = null;
let simulateMountedEditor = false;
let lastRawContent: string | null = null;
let publishCollaborativeTitle: ((title: string) => void) | null = null;
let surfaceDocument = createPageDocument({
  documentId: "document:page-1",
  initialTitle: "Live title",
});

vi.mock("./editor/nfm-editor", () => ({
  NfmEditor: (props: Record<string, unknown>) => {
    lastNfmEditorProps = props;
    const root = useRef<HTMLDivElement>(null);
    const pageId = (props.sourcePageContext as { pageId: string }).pageId;
    const onMount = props.onEditorViewMount as (root: HTMLElement) => void;
    const onUnmount = props.onEditorViewUnmount as () => void;
    useLayoutEffect(() => {
      if (!simulateMountedEditor || !root.current) return;
      onMount(root.current);
      return onUnmount;
    }, [onMount, onUnmount, pageId]);
    return <div ref={root}>Mock collaborative editor</div>;
  },
}));

vi.mock("./page-stage/raw-content", () => ({
  PageStageRawContent: ({ content }: { content: string }) => {
    lastRawContent = content;
    return <div aria-label="Raw page source">{content}</div>;
  },
}));

vi.mock("@/components/block-documents/block-document-sync-status", () => ({
  BlockDocumentSyncStatus: () => null,
}));

vi.mock("@/lib/use-page-backlinks", () => ({
  usePageBacklinks: () => ({
    items: [],
    sourcePageCount: 0,
    loading: false,
    loadingMore: false,
    hasMore: false,
    error: null,
    loadMore: async () => undefined,
  }),
}));

vi.mock("@/components/block-documents/collaborative-page-title", () => ({
  CollaborativePageTitle: ({ onValueChange }: { onValueChange?: (title: string) => void }) => {
    publishCollaborativeTitle = onValueChange ?? null;
    useEffect(() => {
      onValueChange?.("Live title");
    }, [onValueChange]);
    return <div>Live title</div>;
  },
}));

vi.mock("@/components/block-documents/block-document-surface", () => ({
  BlockDocumentSurface: (props: {
    descriptor: Record<string, unknown>;
    runtimeRef?: { current: unknown };
    children: (surface: Record<string, unknown>) => ReactNode;
  }) => {
    const runtime = {
      descriptor: props.descriptor,
      clientSessionId: "surface-1",
      persist: async () => undefined,
      getStatus: () => ({ reloadRequired: false }),
    };
    if (props.runtimeRef) props.runtimeRef.current = runtime;
    return props.children({
      ...surfaceDocument,
      descriptor: props.descriptor,
      runtime,
      awareness: {},
      status: { provider: { phase: "synced" } },
    });
  },
}));

vi.mock("./page-stage/inline-property-strip", () => ({
  PageStageInlinePropertyStrip: () => <div>Inline property strip</div>,
}));

vi.mock("./page-stage/properties-section", () => ({
  PageStagePropertiesSection: () => <div>Properties section</div>,
}));

function buildPage(overrides: Partial<DatabasePage> = {}): DatabasePage {
  const title = overrides.title ?? "Stale projected title";
  return {
    id: "page-1",
    status: "build",
    archived: false,
    title,
    richTitle: plainTextToPortableRichText(title),
    description: "Stale projected body",
    tags: [],
    created: new Date("2026-01-01T00:00:00.000Z"),
    order: 1,
    ...overrides,
    pageKey: overrides.pageKey ?? null,
  };
}

function toStageModel(page: DatabasePage): PageStagePageModel {
  const detail = buildPageDetailStoryResult("default", page);
  if (!detail.ok) throw new Error(detail.error.message);
  const projected = projectPageDetailToStageModel(detail.value);
  if (projected.databaseContext.kind !== "member") return projected;
  const properties = projected.databaseContext.properties.filter(
    (item) => item.property.valueType !== "select" && item.property.valueType !== "multi_select",
  );
  return {
    ...projected,
    databaseContext: {
      ...projected.databaseContext,
      properties,
      semanticProperties: readPageStageSemanticProperties(properties),
    },
  };
}

function documentAuthority(): PageStageDocumentAuthority {
  return {
    kind: "yjs" as const,
    descriptor: {
      libraryId: "library-default",
      accessContext: { kind: "project" as const, projectId: "default" },
      ownerBlockId: "page-1",
      ownerType: "page" as const,
      ownerLifecycle: "active" as const,
      documentId: "document:page-1",
      authorization: null,
      storeEpoch: "store-1",
      generation: 1,
      headSeq: 1,
      schemaKey: "nodex.page" as const,
      schemaVersion: PAGE_DOCUMENT_SCHEMA_VERSION,
      readiness: "ready" as const,
      sync: { kind: "yjs" as const, stateVector: new Uint8Array() },
    },
    reload: async () => undefined,
  };
}

function renderStage(
  page: PageStagePageModel = toStageModel(buildPage()),
  breadcrumbProps: Pick<PageStageProps, "breadcrumb"> = {},
  renderView = render,
) {
  const { PageStage } = requirePageStage();
  return renderView(
    <NodexTooltipProvider>
      <PageStage
        contentAccessContext={projectContentAccess("default")}
        onClose={() => undefined}
        page={page}
        projectName="Default"
        documentAuthority={documentAuthority()}
        onUpdate={async () => ({ status: "updated", didMutate: true })}
        onUpdateProperty={async () => ({ status: "updated", didMutate: true })}
        {...breadcrumbProps}
        {...(page.databaseContext.kind === "member"
          ? {
              onDelete: async () => undefined,
            }
          : {})}
      />
    </NodexTooltipProvider>,
  );
}

let loadedPageStage: typeof import("./page-stage") | null = null;
function requirePageStage(): typeof import("./page-stage") {
  if (!loadedPageStage) throw new Error("Page Detail module has not loaded");
  return loadedPageStage;
}

describe("page stage", () => {
  beforeEach(async () => {
    localStorage.clear();
    lastNfmEditorProps = null;
    simulateMountedEditor = false;
    lastRawContent = null;
    publishCollaborativeTitle = null;
    surfaceDocument.document.destroy();
    surfaceDocument = createPageDocument({
      documentId: "document:page-1",
      initialTitle: "Live title",
    });
    populateBlockDocumentBodyFromNfm(surfaceDocument.body, "# Live collaborative body\n\n- item");
    loadedPageStage = await import("./page-stage");
  });

  test("keeps the new Page viewport subscribed after the previous Page cleanup", async () => {
    simulateMountedEditor = true;
    const view = renderStage();
    await settleAsyncRender();
    const scrollElement = view.getByTestId("page-stage-scroll-container");
    const editorRoot = view.getByText("Mock collaborative editor");
    Object.defineProperties(scrollElement, {
      clientHeight: { value: 400, configurable: true },
      scrollHeight: { value: 1600, configurable: true },
    });
    const rects = [new DOMRect(0, 0, 400, 400)] as unknown as DOMRectList;
    vi.spyOn(scrollElement, "getClientRects").mockReturnValue(rects);
    vi.spyOn(editorRoot, "getClientRects").mockReturnValue(rects);
    renderStage(toStageModel(buildPage({ id: "page-next" })), {}, (ui) => {
      view.rerender(ui);
      return view;
    });
    await act(async () => {
      fireEvent.wheel(scrollElement);
      scrollElement.scrollTop = 240;
      fireEvent.scroll(scrollElement);
      await Promise.resolve();
    });
    expect(loadPageStageViewportSnapshot("project:default", "page-next")).toEqual({
      version: 2,
      kind: "offset",
      scrollTop: 240,
    });
  });

  test.each(["view-first", "navigation-first"] as const)(
    "consumes delayed block focus once after both editor capabilities arrive: %s",
    async (order) => {
      savePageStageViewportSnapshot("project:default", "page-1", {
        version: 2,
        kind: "offset",
        scrollTop: 80,
      });
      const intent = requestPageBlockFocus({
        projectId: "default",
        pageId: "page-1",
        blockId: "target-block",
      });
      const view = renderStage();
      try {
        await settleAsyncRender();
        const editorRoot = view.getByText("Mock collaborative editor");
        const scrollElement = view.getByTestId("page-stage-scroll-container");
        Object.defineProperties(scrollElement, {
          clientHeight: { value: 400, configurable: true },
          scrollHeight: { value: 1600, configurable: true },
        });
        const rects = [new DOMRect(0, 0, 400, 400)] as unknown as DOMRectList;
        vi.spyOn(scrollElement, "getClientRects").mockReturnValue(rects);
        vi.spyOn(editorRoot, "getClientRects").mockReturnValue(rects);
        const focusBlock = vi.fn(() => {
          scrollElement.scrollTop = 240;
          return true;
        });
        const navigation: NfmEditorBoundaryHandle = {
          focusBlock,
          focus: () => true,
          focusBoundary: () => true,
        };
        const attachNavigation = () => {
          const ref =
            lastNfmEditorProps?.navigationRef as import("react").Ref<NfmEditorBoundaryHandle>;
          if (typeof ref === "function") ref(navigation);
          else if (ref) ref.current = navigation;
        };
        const mountView = () => {
          (lastNfmEditorProps?.onEditorViewMount as (root: HTMLElement) => void)(editorRoot);
        };
        await act(async () => {
          (order === "view-first" ? mountView : attachNavigation)();
          await Promise.resolve();
        });
        expect(focusBlock).not.toHaveBeenCalled();
        await act(async () => {
          (order === "view-first" ? attachNavigation : mountView)();
          await Promise.resolve();
        });
        expect(focusBlock).toHaveBeenCalledExactlyOnceWith("target-block");
        expect(scrollElement.scrollTop).toBe(240);
        expect(loadPageStageViewportSnapshot("project:default", "page-1")).toEqual({
          version: 2,
          kind: "offset",
          scrollTop: 240,
        });
        await act(async () => {
          attachNavigation();
          await Promise.resolve();
        });
        expect(focusBlock).toHaveBeenCalledTimes(1);
      } finally {
        view.unmount();
        consumePageBlockFocus(intent);
      }
    },
  );

  test("mounts the rich editor only from the collaborative Document source", async () => {
    writePageStageContentWidthPreference(true);
    writePageStageShowRawContentPreference(false);
    const { container, getByText } = renderStage();
    await settleAsyncRender();

    expect(getByText("Mock collaborative editor").textContent).toBe("Mock collaborative editor");
    const source = lastNfmEditorProps?.source as Record<string, unknown>;
    expect(lastNfmEditorProps?.contentAccessContext).toEqual(projectContentAccess("default"));
    expect(source.kind).toBe("collaborative-document");
    expect(source.documentId).toBe("document:page-1");
    expect(Object.hasOwn(source, "content")).toBe(false);
    expect(Object.hasOwn(source, "onChange")).toBe(false);
    expect(
      container
        .querySelector('[data-page-stage-surface="true"]')
        ?.getAttribute("data-page-stage-page-id"),
    ).toBe("page-1");
    expect(
      container.querySelector('[data-page-stage-heading-navigation-portal-target="true"]'),
    ).not.toBeNull();
  });

  test("reattaches the standalone raw viewport after StrictMode view cleanup", async () => {
    writePageStageShowRawContentPreference(false);
    const store = createMaitaiStore();
    const view = renderStage(toStageModel(buildPage()), {}, (ui) =>
      renderReact(ui, {
        reactStrictMode: true,
        wrapper: ({ children }) => (
          <MaitaiProvider store={store}>
            <TestThreadRouteScopePath>{children}</TestThreadRouteScopePath>
          </MaitaiProvider>
        ),
      }),
    );
    try {
      await settleAsyncRender();
      await act(async () => {
        fireEvent.click(view.getByRole("button", { name: "Show raw" }));
        await Promise.resolve();
      });
      await act(async () => {
        populateBlockDocumentBodyFromNfm(surfaceDocument.body, "Updated after view replay");
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(view.getByLabelText("Raw page source").textContent).toBe(
          "Updated after view replay",
        );
      });
    } finally {
      view.unmount();
      disposeMaitaiStore(store);
    }
  });

  test("renders the current breadcrumb item from the live Y.Text title", async () => {
    const view = renderStage(toStageModel(buildPage()), {
      breadcrumb: {
        ancestors: [
          {
            projectId: "default",
            pageId: "parent-page",
            title: "Parent Page",
          },
        ],
        onOpenAncestor: () => undefined,
      },
    });

    await settleAsyncRender();
    await act(async () => {
      publishCollaborativeTitle?.("Renamed live title");
      await Promise.resolve();
    });

    const breadcrumb = view.getByRole("navigation", {
      name: "Page hierarchy",
    });
    expect(breadcrumb.querySelector('[aria-current="page"]')?.textContent).toBe(
      "Renamed live title",
    );
  });

  test("opens a standalone Page without Database controls or delete", async () => {
    const member = toStageModel(buildPage());
    const standalone: PageStagePageModel = {
      page: member.page,
      databaseContext: { kind: "standalone" },
    };
    const { getByRole, queryByText, queryByRole, getByText } = renderStage(standalone);

    expect(getByText("Mock collaborative editor")).toBeTruthy();
    expect(queryByText("Inline property strip")).toBeNull();

    const trigger = getByRole("button", { name: "Page actions" });
    fireEvent.pointerDown(trigger, {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.mouseDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(trigger);
    await settleAsyncRender();

    expect(queryByRole("menuitem", { name: "Copy deeplink" })).toBeTruthy();
    expect(queryByRole("menuitem", { name: "Delete" })).toBeNull();
  });

  test("copies the current Page deeplink from the actions menu", async () => {
    const originalClipboard = navigator.clipboard;
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    try {
      const { getByRole } = renderStage();

      const trigger = getByRole("button", { name: "Page actions" });
      fireEvent.pointerDown(trigger, {
        button: 0,
        ctrlKey: false,
      });
      fireEvent.mouseDown(trigger, { button: 0, ctrlKey: false });
      fireEvent.click(trigger);
      await settleAsyncRender();

      fireEvent.click(getByRole("menuitem", { name: "Copy deeplink" }));
      await settleAsyncRender();

      expect(writeText).toHaveBeenCalledWith("nodex://pages/page-1");
    } finally {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: originalClipboard,
      });
    }
  });

  test("does not repeat a Database Page key in Page Stage", () => {
    const view = renderStage(toStageModel(buildPage({ pageKey: "LAB-13" })));
    expect(view.queryByText("LAB-13")).toBeNull();
  });

  test("raw mode reads the live Y.Doc projection, not the Page row projection", async () => {
    writePageStageShowRawContentPreference(true);
    const { getByLabelText, queryByText } = renderStage();

    expect(queryByText("Mock collaborative editor")).toBe(null);
    expect(getByLabelText("Raw page source")).not.toBeNull();
    await waitFor(() => {
      expect(lastRawContent?.includes("Live collaborative body")).toBe(true);
      expect(lastRawContent?.includes("Stale projected body")).toBe(false);
    });
  });

  test("full width changes only the Page Detail presentation lane", async () => {
    writePageStageContentWidthPreference(true);
    writePageStageShowRawContentPreference(false);
    const { container, getByRole } = renderStage();
    const body = container.querySelector('[data-page-stage-body="true"]');
    const fullWidthButton = getByRole("button", { name: "Full width" });

    expect(body?.getAttribute("data-page-stage-body-width")).toBe("constrained");
    await act(async () => {
      (fullWidthButton as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(body?.getAttribute("data-page-stage-body-width")).toBe("full");
  });
});
