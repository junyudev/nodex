import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { FileLinkAnchor } from "@/components/shared/file-link-anchor";
import { queryKeys } from "@/lib/query-keys";
import { createTestQueryClient, TestQueryProvider } from "@/test/query";
import { createTestNodexReferenceRouter } from "@/test/nodex-reference-router";
import type { PageTargetReadModel } from "../../../shared/page-targets";
import type { ProjectSession } from "@/lib/types";
import { NodexReference } from "./nodex-reference";

const mocks = vi.hoisted(() => ({
  target: { data: null, loading: false, error: null } as {
    data: PageTargetReadModel | null;
    loading: boolean;
    error: Error | null;
  },
}));

vi.mock("@/lib/block-reference-queries", () => ({
  usePageTargetReadModel: () => mocks.target,
  useDatabaseViewReadModel: () => ({ data: null, loading: true, error: null }),
}));
vi.mock("@/lib/content-page-detail", () => ({
  useContentPageDetail: () => ({ detail: null, loading: false, error: null }),
}));

const authority = { libraryId: "library-1", storeEpoch: "epoch-1", commitSeq: 1 };
const available = (title: string): PageTargetReadModel =>
  ({
    ...authority,
    status: "available",
    targetPageId: "page-1",
    page: { pageId: "page-1", libraryId: "library-1", title, preview: "", lifecycle: "active" },
    document: { readiness: "ready", schemaKey: "nfm", schemaVersion: 1 },
  }) as unknown as PageTargetReadModel;

function renderInChat(ui: React.ReactElement, client = createTestQueryClient()) {
  const references = createTestNodexReferenceRouter();
  const view = render(
    <TestQueryProvider client={client}>
      <NodexTooltipProvider>
        {references.wrap(ui, { surface: "conversation", sessionId: "chat-reading" })}
      </NodexTooltipProvider>
    </TestQueryProvider>,
  );
  return { ...view, open: references.open };
}

async function click(element: Element, init?: MouseEventInit) {
  await act(async () => {
    fireEvent.click(element, init);
    await Promise.resolve();
  });
}

describe("Nodex references in a chat", () => {
  beforeEach(() => {
    mocks.target = { data: available("Launch plan"), loading: false, error: null };
  });

  test("a link keeps its words and opens its Page relative to the chat it is read in", async () => {
    const view = renderInChat(
      <FileLinkAnchor href="nodex://pages/page-1">the plan</FileLinkAnchor>,
    );
    const link = screen.getByRole("link", { name: "the plan" });
    await click(link);
    await click(link, { metaKey: true });
    expect(view.open).toHaveBeenNthCalledWith(
      1,
      { kind: "page", pageId: "page-1" },
      expect.objectContaining({
        source: { surface: "conversation", sessionId: "chat-reading" },
        gesture: { kind: "activate", activation: expect.objectContaining({ metaKey: false }) },
        titleSnapshot: "Launch plan",
      }),
    );
    expect(view.open).toHaveBeenNthCalledWith(
      2,
      { kind: "page", pageId: "page-1" },
      expect.objectContaining({
        gesture: { kind: "activate", activation: expect.objectContaining({ metaKey: true }) },
      }),
    );
  });

  test("a link written as its own URL names the Page by its current title", () => {
    renderInChat(<FileLinkAnchor href="nodex://pages/page-1">nodex://pages/page-1</FileLinkAnchor>);
    expect(screen.getByRole("link", { name: "Open Launch plan" }).textContent).toBe("Launch plan");
  });

  test("a link that only restates the Page's name shows the Page as a mention does", () => {
    renderInChat(
      <NodexReference destination={{ kind: "page", pageId: "page-1" }} variant="link">
        launch plan
      </NodexReference>,
    );
    const reference = screen.getByRole("link", { name: "Open Launch plan" });
    expect(reference.getAttribute("data-inline-reference-chip")).toBe("true");
    expect(reference.textContent).toBe("Launch plan");
  });

  test("a deleted Page explains itself instead of opening", async () => {
    mocks.target = {
      data: { ...authority, status: "deleted", targetPageId: "page-1" },
      loading: false,
      error: null,
    };
    const view = renderInChat(
      <NodexReference destination={{ kind: "page", pageId: "page-1" }} variant="mention" />,
    );
    const reference = view.container.querySelector("[data-nodex-reference]")!;
    expect(reference.getAttribute("aria-disabled")).toBe("true");
    await click(reference);
    expect(view.open).not.toHaveBeenCalled();
  });

  test("a chat mention shows the chat's current title and goes to it", async () => {
    const client = createTestQueryClient();
    client.setQueryData(queryKeys.projectSessions.detail("chat-2"), {
      id: "chat-2",
      projectId: null,
      displayTitle: "Fix flaky E2E",
      archived: false,
      activityAt: 1,
      thread: null,
    } as unknown as ProjectSession);
    const view = renderInChat(
      <NodexReference destination={{ kind: "session", sessionId: "chat-2" }} variant="mention" />,
      client,
    );
    const mention = screen.getByRole("link", { name: "Open chat Fix flaky E2E" });
    await click(mention);
    expect(view.open).toHaveBeenCalledExactlyOnceWith(
      { kind: "session", sessionId: "chat-2" },
      expect.objectContaining({ titleSnapshot: "Fix flaky E2E" }),
    );
  });

  test("outside the Workbench a reference is shown but not offered as a link to open", () => {
    render(
      <TestQueryProvider>
        <NodexTooltipProvider>
          <NodexReference destination={{ kind: "page", pageId: "page-1" }} variant="mention" />
        </NodexTooltipProvider>
      </TestQueryProvider>,
    );
    expect(
      document
        .querySelector("[data-nodex-reference]")
        ?.getAttribute("data-nodex-reference-openable"),
    ).toBe("false");
  });
});
