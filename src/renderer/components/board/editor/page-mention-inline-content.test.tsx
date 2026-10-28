import { fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { BlockReferenceRuntimeProvider } from "@/components/block-documents/block-reference-runtime-context";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { render, settleAsyncRender, textContent } from "@/test/dom";
import { projectContentRoute } from "../../../../shared/content-routing-context";
import type { PageDetail } from "../../../../shared/page-detail";
import type { PageTargetReadModel } from "../../../../shared/page-targets";
import { buildPageStageFixturePage } from "@/test/page-stage-fixture";
import { buildPageDetailFixtureResult } from "@/test/page-detail-fixture";
import {
  PageMentionInlineContentView,
  resolvePageMentionPresentation,
} from "./page-mention-inline-content";

const mocks = vi.hoisted(() => ({
  target: {
    data: null,
    loading: false,
    error: null,
  } as {
    data: PageTargetReadModel | null;
    loading: boolean;
    error: Error | null;
  },
  detail: null as PageDetail | null,
}));

vi.mock("@/lib/block-reference-queries", () => ({
  usePageTargetReadModel: () => mocks.target,
}));

vi.mock("@/lib/content-page-detail", () => ({
  useContentPageDetail: () => ({
    detail: mocks.detail,
    loading: false,
    error: null,
  }),
}));

const pageDetail = (): PageDetail => {
  const result = buildPageDetailFixtureResult("project-1", buildPageStageFixturePage(), {
    libraryId: "library-1",
  });
  if (!result.ok) throw new Error("Expected Page Detail fixture");
  return result.value;
};

const availableTarget = (
  overrides: Partial<Extract<PageTargetReadModel, { status: "available" }>> = {},
): Extract<PageTargetReadModel, { status: "available" }> => ({
  libraryId: "library-1",
  storeEpoch: "epoch-1",
  commitSeq: 7,
  status: "available",
  targetPageId: "page-1",
  page: {
    pageId: "page-1",
    libraryId: "library-1",
    parent: { kind: "data_source", dataSourceId: "data-source-1" },
    lifecycle: "active",
    parentRevision: 1,
    metadataRevision: 1,
    documentId: "document-1",
    documentGeneration: 1,
    documentHeadSeq: 3,
    title: "Keep projection updates bounded",
    richTitle: [
      {
        type: "text",
        text: "Keep projection updates bounded",
        styles: {},
      },
    ],
    preview: "Preserve   causal coverage\ninside the affected window.",
    plainText: "Preserve causal coverage inside the affected window.",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-16T00:00:00.000Z",
  },
  document: {
    readiness: "ready",
    schemaKey: "markdown",
    schemaVersion: 1,
  },
  ...overrides,
});

describe("Page mention inline content", () => {
  beforeEach(() => {
    mocks.target = {
      data: availableTarget(),
      loading: false,
      error: null,
    };
    mocks.detail = pageDetail();
  });

  test("builds compact authorized metadata and safe unavailable states", () => {
    const available = resolvePageMentionPresentation({
      targetPageId: "page-1",
      target: availableTarget({
        page: {
          ...availableTarget().page,
          parent: { kind: "page", pageId: "parent-page" },
          lifecycle: "archived",
        },
      }),
      loading: false,
      error: null,
    });
    expect(available).toEqual({
      label: "Keep projection updates bounded",
      tooltipTitle: "Keep projection updates bounded",
      tooltipDetail: "Archived",
      tooltipPreview: "Preserve causal coverage inside the affected window.",
    });

    const unavailable = resolvePageMentionPresentation({
      targetPageId: "page-private",
      target: null,
      loading: false,
      error: new Error("sensitive transport detail"),
    });
    expect(unavailable.tooltipDetail).toBe("This Page is unavailable here.");
    expect(JSON.stringify(unavailable)).not.toContain("sensitive transport detail");
    expect(
      [unavailable.tooltipTitle, unavailable.tooltipDetail, unavailable.tooltipPreview].join(" "),
    ).not.toContain("page-private");

    const longPreview = resolvePageMentionPresentation({
      targetPageId: "page-1",
      target: availableTarget({
        page: {
          ...availableTarget().page,
          preview: "a".repeat(400),
        },
      }),
      loading: false,
      error: null,
    }).tooltipPreview;
    expect(longPreview?.length).toBe(281);
    expect(longPreview?.endsWith("…")).toBe(true);
  });

  test("reveals Page metadata on hover without replacing click navigation", async () => {
    let openedPageId = "";
    const view = render(
      <NodexTooltipProvider>
        <BlockReferenceRuntimeProvider
          value={{
            contentRoutingContext: projectContentRoute("project-1"),
            projectName: "Product",
            projectWorkspacePath: "/tmp/product",
            hostPageId: "host-page",
            ancestorPageIds: ["host-page"],
            ancestorDocumentOwnerBlockIds: ["host-page"],
            isActiveSurface: true,
            openPage: ({ pageId }) => {
              openedPageId = pageId;
            },
          }}
        >
          <PageMentionInlineContentView inlineContent={{ props: { targetPageId: "page-1" } }} />
        </BlockReferenceRuntimeProvider>
      </NodexTooltipProvider>,
    );

    const mention = view.getByRole("link", {
      name: "Open Page Keep projection updates bounded",
    });
    expect(mention.tagName).toBe("A");
    expect(mention.getAttribute("href")).toBe("nodex://pages/page-1");
    expect(mention.getAttribute("tabindex")).toBe("0");
    expect(mention.getAttribute("contenteditable")).toBe("false");
    expect(view.container.querySelector('[data-mention-inline-guard="start"]')).not.toBeNull();
    expect(view.container.querySelector('[data-mention-inline-guard="end"]')).not.toBeNull();
    expect(mention.getAttribute("title")).toBe(null);
    expect(mention.querySelector("svg")?.getAttribute("style")).toContain("status-build-dot");

    fireEvent.pointerMove(mention, { pointerType: "mouse" });
    fireEvent.mouseEnter(mention);
    await settleAsyncRender();
    await waitFor(() => {
      const tooltip = document.body.querySelector('[role="tooltip"]');
      if (
        !tooltip ||
        !textContent(tooltip).includes("Preserve causal coverage") ||
        textContent(tooltip).includes("Database Page")
      ) {
        throw new Error("Page mention tooltip not open");
      }
    });

    mention.dataset.mentionTokenSelected = "true";
    await waitFor(() => {
      const affordance = document.body.querySelector(
        '[data-mention-inline-focus-affordance="true"]',
      );
      if (!affordance || textContent(affordance) !== "Open page↵") {
        throw new Error("Page mention focus affordance not open");
      }
    });
    delete mention.dataset.mentionTokenSelected;
    await waitFor(() => {
      if (document.body.querySelector('[data-mention-inline-focus-affordance="true"]')) {
        throw new Error("Page mention focus affordance did not close");
      }
    });

    fireEvent.click(mention);
    await settleAsyncRender();
    expect(openedPageId).toBe("page-1");
  });
});
