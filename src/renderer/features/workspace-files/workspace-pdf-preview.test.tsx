import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { fireEvent, waitFor } from "@testing-library/react";
import { render, settleAsyncRender } from "../../test/dom";
import { WorkspacePdfPreview } from "./workspace-pdf-preview";

const runtimeMocks = vi.hoisted(() => ({
  getDocument: vi.fn(),
  textLayerRender: vi.fn(async () => undefined),
  textLayerCancel: vi.fn(),
}));

vi.mock("./workspace-pdf-runtime", () => {
  class TextLayer {
    render = runtimeMocks.textLayerRender;
    cancel = runtimeMocks.textLayerCancel;
  }

  class AnnotationLayer {
    async render() {}
  }

  return {
    loadWorkspacePdfRuntime: async () => ({
      AnnotationLayer,
      WorkspacePdfLinkService: class {},
      TextLayer,
      getDocument: runtimeMocks.getDocument,
    }),
  };
});

const originalCanvasContext = HTMLCanvasElement.prototype.getContext;
const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;

beforeAll(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: () => ({ clearRect: vi.fn() }),
  });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

afterAll(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: originalCanvasContext,
  });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: originalScrollIntoView,
  });
});

beforeEach(() => {
  runtimeMocks.getDocument.mockReset();
  runtimeMocks.textLayerRender.mockClear();
  runtimeMocks.textLayerCancel.mockClear();
});

describe("WorkspacePdfPreview", () => {
  test("decodes bytes, lays out every page, and renders visible canvases through PDF.js", async () => {
    const firstPage = makePage();
    const secondPage = makePage();
    const document = makeDocument([firstPage, secondPage]);
    const loadingTask = {
      destroyed: false,
      destroy: vi.fn(async () => undefined),
      promise: Promise.resolve(document),
    };
    runtimeMocks.getDocument.mockReturnValue(loadingTask);

    const view = render(
      <WorkspacePdfPreview
        fileDataUrl="data:application/pdf;base64,JVBERg=="
        title="spec.pdf"
        onOpenExternalLink={() => undefined}
      />,
    );
    await settleAsyncRender();
    await settleAsyncRender();

    await waitFor(() => {
      expect(view.container.querySelectorAll("[data-workspace-pdf-page]")).toHaveLength(2);
      expect(firstPage.render).toHaveBeenCalled();
      expect(secondPage.render).toHaveBeenCalled();
    });
    expect(runtimeMocks.getDocument).toHaveBeenCalledOnce();
    expect(Array.from(runtimeMocks.getDocument.mock.calls[0]?.[0].data as Uint8Array)).toEqual([
      37, 80, 68, 70,
    ]);
    expect(view.getByLabelText("PDF preview for spec.pdf")).not.toBeNull();
    expect(view.container.querySelector("iframe")).toBeNull();
    expect(view.container.querySelectorAll("canvas")).toHaveLength(2);
    expect(view.getByText("1/2")).not.toBeNull();

    fireEvent.click(view.getByRole("button", { name: "Next page" }));
    expect(view.getByText("2/2")).not.toBeNull();

    view.unmount();
    expect(loadingTask.destroy).toHaveBeenCalledOnce();
  });

  test("shows a bounded error state when the data URL cannot be decoded", async () => {
    const view = render(
      <WorkspacePdfPreview
        fileDataUrl="not-a-data-url"
        title="broken.pdf"
        onOpenExternalLink={() => undefined}
      />,
    );
    await settleAsyncRender();

    expect(await view.findByText("Unable to preview this PDF.")).not.toBeNull();
    expect(runtimeMocks.getDocument).not.toHaveBeenCalled();
  });

  test("releases the loading task when a PDF has no pages", async () => {
    const loadingTask = {
      destroyed: false,
      destroy: vi.fn(async () => {
        loadingTask.destroyed = true;
      }),
      promise: Promise.resolve(makeDocument([])),
    };
    runtimeMocks.getDocument.mockReturnValue(loadingTask);
    const view = render(
      <WorkspacePdfPreview
        fileDataUrl="data:application/pdf;base64,JVBERg=="
        title="empty.pdf"
        onOpenExternalLink={() => undefined}
      />,
    );
    try {
      expect(await view.findByText("Unable to preview this PDF.")).not.toBeNull();
      expect(loadingTask.destroy).toHaveBeenCalledOnce();
    } finally {
      view.unmount();
    }
    expect(loadingTask.destroy).toHaveBeenCalledOnce();
  });
});

function makePage() {
  return {
    userUnit: 1,
    getAnnotations: vi.fn(async () => []),
    getViewport: vi.fn(({ scale }: { scale: number }) => ({
      width: 612 * scale,
      height: 792 * scale,
    })),
    render: vi.fn(() => ({
      cancel: vi.fn(),
      promise: Promise.resolve(),
    })),
    streamTextContent: vi.fn(() => new ReadableStream()),
  };
}

function makeDocument(pages: ReturnType<typeof makePage>[]) {
  return {
    numPages: pages.length,
    cachedPageNumber: vi.fn(() => null),
    getDestination: vi.fn(async () => null),
    getPage: vi.fn(async (page: number) => pages[page - 1]),
    getPageIndex: vi.fn(async () => 0),
  };
}
