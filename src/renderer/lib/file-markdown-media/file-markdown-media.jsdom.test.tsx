import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { MarkdownRenderer } from "@/features/local-conversation/view/shared/markdown/markdown-renderer";
import { installWindowApi } from "@/test/browser-globals";
import { TestQueryProvider, createTestQueryClient } from "@/test/query";
import { settleAsyncRender } from "@/test/dom";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { useLayoutEffect, type ReactNode } from "react";
import {
  FILE_MARKDOWN_IMAGE_MAX_BYTES,
  type FileMarkdownMediaScope,
} from "./file-markdown-media-model";

const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;
const createUrl = vi.fn((_blob: Blob) => `blob:owned-${createUrl.mock.calls.length}`);
const revokeUrl = vi.fn((_url: string) => undefined);
const calls: unknown[][] = [];
const scope: FileMarkdownMediaScope = {
  hostId: "remote-one",
  sourceFilePath: "/remote/docs/README.md",
};
let lateRead: Promise<{ contentsBase64: string; mimeType: string }> | null = null;
let size: number | null = null;

function renderDocument(content: string, value: FileMarkdownMediaScope = scope) {
  const client = createTestQueryClient();
  const body = (next: FileMarkdownMediaScope, after?: ReactNode) => (
    <TestQueryProvider client={client}>
      <NodexTooltipProvider>
        <MarkdownRenderer content={content} fileMediaScope={next} />
        {after}
      </NodexTooltipProvider>
    </TestQueryProvider>
  );
  return { ...render(body(value)), body, client };
}

function DuringLayout({ run }: { run: () => void }) {
  useLayoutEffect(run, [run]);
  return null;
}

describe("file Markdown media owner", () => {
  beforeEach(() => {
    calls.length = 0;
    lateRead = null;
    size = null;
    createUrl.mockClear();
    revokeUrl.mockClear();
    Object.defineProperties(URL, {
      createObjectURL: { configurable: true, value: createUrl },
      revokeObjectURL: { configurable: true, value: revokeUrl },
    });
    installWindowApi({
      invoke: async (channel: string, ...args: unknown[]) => {
        calls.push([channel, ...args]);
        const input = args[0] as { hostId: string };
        if (channel === "read-file-metadata")
          return { isFile: true, sizeBytes: size, mtimeMs: null, createdAtMs: null };
        if (channel === "read-file-binary") {
          if (input.hostId === "remote-one" && lateRead) return lateRead;
          return { contentsBase64: "aW1hZ2U=", mimeType: "image/png" };
        }
        return null;
      },
    });
  });
  afterEach(async () => {
    await settleAsyncRender();
    Object.defineProperties(URL, {
      createObjectURL: { configurable: true, value: originalCreateObjectURL },
      revokeObjectURL: { configurable: true, value: originalRevokeObjectURL },
    });
    vi.restoreAllMocks();
  });

  test("reads relative and absolute images from the source host with unknown metadata", async () => {
    const view = renderDocument(
      "![Relative](./images/chart.png)\n\n![Absolute](/remote/chart.png)",
    );
    await waitFor(() =>
      expect(view.getByAltText("Relative").getAttribute("src")).toMatch(/^blob:owned-/),
    );
    await waitFor(() =>
      expect(view.getByAltText("Absolute").getAttribute("src")).toMatch(/^blob:owned-/),
    );
    expect(calls.filter(([channel]) => channel === "read-file-binary")).toEqual([
      ["read-file-binary", { hostId: "remote-one", path: "/remote/docs/images/chart.png" }],
      ["read-file-binary", { hostId: "remote-one", path: "/remote/chart.png" }],
    ]);
    expect(createUrl.mock.calls.map(([blob]) => blob.type)).toEqual(["image/png", "image/png"]);
    view.unmount();
    await settleAsyncRender();
    expect(revokeUrl.mock.calls).toHaveLength(2);
  });

  test("rewrites nested source/srcSet candidates without retaining local browser transports", async () => {
    const view = renderDocument(
      `<picture><source srcset="app://fs/@fs/tmp/sentinel.png 1x, /@fs/tmp/sentinel.png 2x, ./wide.png 3x" media="(min-width: 600px)" sizes="50vw"><img src="./base.png" srcset="./retina.png 2x" alt="Responsive"></picture>`,
    );
    await waitFor(() =>
      expect(view.container.querySelector("source")?.getAttribute("srcset")).toMatch(
        /^blob:owned-\d+ 3x$/,
      ),
    );
    await waitFor(() =>
      expect(view.getByAltText("Responsive").getAttribute("srcset")).toMatch(/^blob:owned-\d+ 2x$/),
    );
    expect(view.container.querySelector("source")?.getAttribute("media")).toBe(
      "(min-width: 600px)",
    );
    expect(view.container.querySelector("source")?.getAttribute("sizes")).toBe("50vw");
    expect(
      calls.filter(([channel]) => channel === "read-file-binary").map(([, input]) => input),
    ).toEqual(
      expect.arrayContaining([
        { hostId: "remote-one", path: "/remote/docs/wide.png" },
        { hostId: "remote-one", path: "/remote/docs/base.png" },
        { hostId: "remote-one", path: "/remote/docs/retina.png" },
      ]),
    );
    for (const media of view.container.querySelectorAll("img, source")) {
      expect(media.getAttribute("src") ?? "").not.toMatch(/app:|\/@fs|sentinel/u);
      expect(media.getAttribute("srcset") ?? "").not.toMatch(/app:|\/@fs|sentinel/u);
    }
    view.unmount();
    await settleAsyncRender();
    expect(revokeUrl.mock.calls).toHaveLength(3);
  });

  test("keeps explicit HTTPS and data images without filesystem reads", async () => {
    const data = "data:image/png;base64,aW1hZ2U=";
    const view = renderDocument(
      `![Network](https://example.com/chart.png "A network chart")\n\n![Inline](${data})`,
    );
    await waitFor(() =>
      expect(view.getByAltText("Network").getAttribute("src")).toBe(
        "https://example.com/chart.png",
      ),
    );
    await waitFor(() => expect(view.getByAltText("Inline").getAttribute("src")).toBe(data));
    expect(calls).toEqual([]);
    view.unmount();
  });

  test("fences late host results and releases replaced/unmounted object URLs", async () => {
    let release: (result: { contentsBase64: string; mimeType: string }) => void = () => undefined;
    lateRead = new Promise((resolve) => {
      release = resolve;
    });
    const view = renderDocument("![Chart](./chart.png)");
    try {
      await waitFor(() =>
        expect(calls).toContainEqual([
          "read-file-binary",
          { hostId: "remote-one", path: "/remote/docs/chart.png" },
        ]),
      );
      await act(async () => {
        view.rerender(view.body({ ...scope, hostId: "remote-two" }));
      });
      await waitFor(() =>
        expect(view.getByAltText("Chart").getAttribute("src")).toBe("blob:owned-1"),
      );
      await act(async () => {
        release({ contentsBase64: "bGF0ZQ==", mimeType: "image/png" });
        await Promise.resolve();
      });
      expect(createUrl.mock.calls).toHaveLength(1);
      expect(view.getByAltText("Chart").getAttribute("src")).toBe("blob:owned-1");
      await act(async () => {
        view.rerender(view.body({ ...scope, hostId: "remote-three" }));
      });
      await waitFor(() =>
        expect(view.getByAltText("Chart").getAttribute("src")).toBe("blob:owned-2"),
      );
      expect(revokeUrl).toHaveBeenCalledWith("blob:owned-1");
    } finally {
      release({ contentsBase64: "bGF0ZQ==", mimeType: "image/png" });
      view.unmount();
      await settleAsyncRender();
    }
    expect(revokeUrl).toHaveBeenCalledWith("blob:owned-2");
  });

  test("rejects oversized metadata before binary IO and blocks opaque capabilities", async () => {
    size = FILE_MARKDOWN_IMAGE_MAX_BYTES + 1;
    const view = renderDocument(
      "![Large](./large.png)\n\n![Opaque](app://fs/@fs/tmp/sentinel.png)",
    );
    await view.findByText("Large");
    await view.findByText("Opaque");
    expect(calls).toEqual([
      ["read-file-metadata", { hostId: "remote-one", path: "/remote/docs/large.png" }],
    ]);
    expect(createUrl).not.toHaveBeenCalled();
    view.unmount();
  });

  test("restores load/error and dimensioned-image presentation without losing native picture children", async () => {
    const view = renderDocument(
      `<img src="./chart.png" alt="Chart"><img src="./dimensioned.png" width="40" alt="Dimensioned">`,
    );
    try {
      const image = view.getByAltText("Chart") as HTMLImageElement;
      await waitFor(() => expect(image.getAttribute("src")).toMatch(/^blob:owned-/));
      expect(view.getAllByRole("button", { name: "Download image" })).toHaveLength(1);
      await act(async () => {
        fireEvent.load(image);
      });
      expect(view.getAllByRole("button", { name: "Download image" })).toHaveLength(2);
      await act(async () => {
        fireEvent.error(image);
      });
      expect(image.hidden).toBe(true);
      expect(view.getByRole("status").textContent).toBe("Chart");
      const dimensioned = view.getByAltText("Dimensioned") as HTMLImageElement;
      await act(async () => {
        fireEvent.error(dimensioned);
      });
      expect(dimensioned.hidden).toBe(false);
      expect(view.queryByRole("button", { name: "Download image" })).toBeNull();
    } finally {
      view.unmount();
    }
  });

  test("downloads the selected picture source bytes and releases its download URL", async () => {
    const clicked: { href: string; name: string }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push({ href: this.href, name: this.download });
    });
    const fetchImage = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "image/png" } }),
      );
    const view = renderDocument(
      `<picture><source srcset="./wide.png 2x"><img src="app://fs/@fs/tmp/blocked.png" alt="Picture"></picture>`,
    );
    try {
      await waitFor(() =>
        expect(view.container.querySelector("source")?.getAttribute("srcset")).toMatch(
          /^blob:owned-/,
        ),
      );
      const image = view.getByAltText("Picture") as HTMLImageElement;
      const selected = view.container.querySelector("source")!.getAttribute("srcset")!.slice(0, -3);
      expect(image.parentElement?.tagName).toBe("PICTURE");
      expect(image.getAttribute("src")).toBeNull();
      Object.defineProperty(image, "currentSrc", { configurable: true, value: selected });
      await act(async () => {
        fireEvent.load(image);
      });
      await act(async () => {
        fireEvent.click(view.getByRole("button", { name: "Download image" }));
        await Promise.resolve();
      });
      await waitFor(() => expect(clicked).toHaveLength(1));
      expect(fetchImage).toHaveBeenCalledWith(
        selected,
        expect.objectContaining({ credentials: "omit", signal: expect.any(AbortSignal) }),
      );
      expect(clicked[0]?.name).toBe("wide.png");
      expect(revokeUrl).toHaveBeenCalledWith(clicked[0]?.href);
      expect(calls.filter(([channel]) => channel === "read-file-binary")).toEqual([
        ["read-file-binary", { hostId: "remote-one", path: "/remote/docs/wide.png" }],
      ]);
    } finally {
      view.unmount();
    }
  });

  test("settles all-blocked picture candidates as an image error rather than an empty pending frame", async () => {
    const view = renderDocument(
      `<picture><source srcset="app://fs/@fs/tmp/local.png 1x"><img src="blob:app://-/unknown" alt="Unavailable"></picture>`,
    );
    try {
      expect((await view.findByRole("status")).textContent).toBe("Unavailable");
      expect((view.getByAltText("Unavailable") as HTMLImageElement).hidden).toBe(true);
      expect(view.queryByRole("button", { name: "Download image" })).toBeNull();
      expect(calls).toEqual([]);
    } finally {
      view.unmount();
    }
  });

  test("preserves a valid network image even when its download filename cannot be URI-decoded", async () => {
    const view = renderDocument(`![Network](https://example.com/chart%ZZ.png)`);
    try {
      await waitFor(() =>
        expect(view.getByAltText("Network").getAttribute("src")).toBe(
          "https://example.com/chart%ZZ.png",
        ),
      );
      expect(calls).toEqual([]);
    } finally {
      view.unmount();
    }
  });

  test("retires a pending download in layout before its old fetch can save bytes", async () => {
    let release: (response: Response) => void = () => undefined;
    const fetchImage = vi.spyOn(globalThis, "fetch").mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    const view = renderDocument("![Chart](./chart.png)");
    try {
      const image = view.getByAltText("Chart") as HTMLImageElement;
      await waitFor(() => expect(image.getAttribute("src")).toBe("blob:owned-1"));
      await act(async () => {
        fireEvent.load(image);
      });
      await act(async () => {
        fireEvent.click(view.getByRole("button", { name: "Download image" }));
      });
      await waitFor(() => expect(fetchImage).toHaveBeenCalledOnce());
      const signal = fetchImage.mock.calls[0]?.[1]?.signal;
      await act(async () => {
        view.rerender(
          view.body(
            { ...scope, hostId: "remote-two" },
            <DuringLayout
              run={() => {
                expect(signal?.aborted).toBe(true);
                release(new Response(new Uint8Array([1, 2, 3])));
              }}
            />,
          ),
        );
        await Promise.resolve();
      });
      await waitFor(() =>
        expect(view.getByAltText("Chart").getAttribute("src")).toBe("blob:owned-2"),
      );
      expect(click).not.toHaveBeenCalled();
      expect(createUrl).toHaveBeenCalledTimes(2);
    } finally {
      release(new Response(new Uint8Array([1])));
      view.unmount();
      await settleAsyncRender();
    }
  });
});
