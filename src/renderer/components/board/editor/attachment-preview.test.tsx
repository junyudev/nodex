import { act, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import { render } from "@/test/dom";
import { PageFileReadCache } from "@/lib/page-file-read-cache";
import { useAttachmentPreview } from "./attachment-preview";
import { createPageFilePlacementRuntime, type PageFilePlacementRuntime } from "./page-file-runtime";

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

const deferred = <T,>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
};

const activeRuntimes: PageFilePlacementRuntime[] = [];

afterEach(() => {
  for (const runtime of activeRuntimes.splice(0)) runtime.release();
});

const createPageFileRuntime = (
  read: PageFilePlacementRuntime["read"],
): PageFilePlacementRuntime => {
  const authority = {
    contentAccessContext: { kind: "project", projectId: "project-1" },
    pageId: "page-1",
    storeEpoch: "store-1",
  } as const;
  const cache = new PageFileReadCache({
    readMetadata: async () => {
      throw new Error("not used");
    },
    readBytes: (_, fileId) => read(`nodex://files/${fileId}`),
    createObjectUrl: (file) => `blob:${file.etag}`,
    revokeObjectUrl: () => undefined,
  });
  const runtime = createPageFilePlacementRuntime(authority, cache);
  activeRuntimes.push(runtime);
  return runtime;
};

function PreviewHarness({
  source,
  runtime,
  mimeType = "application/json",
}: {
  readonly source: string;
  readonly runtime: PageFilePlacementRuntime;
  readonly mimeType?: string;
}) {
  const { state } = useAttachmentPreview(
    {
      kind: "file",
      mode: "materialized",
      source,
      mimeType,
    },
    runtime,
    true,
  );
  if (state.status !== "ready") return <div>{state.status}</div>;
  if (state.preview.type !== "text") return <div>folder</div>;
  return (
    <div>
      <pre data-testid="preview-content">{state.preview.content}</pre>
      <span>{state.preview.truncated ? "truncated" : "complete"}</span>
    </div>
  );
}

describe("attachment preview lifecycle", () => {
  test("ignores a stale File response after the attachment identity changes", async () => {
    const firstRead = deferred<Awaited<ReturnType<PageFilePlacementRuntime["read"]>>>();
    const secondRead = deferred<Awaited<ReturnType<PageFilePlacementRuntime["read"]>>>();
    const read = vi.fn((source: string) => {
      if (source === "nodex://files/file-1") return firstRead.promise;
      return secondRead.promise;
    });
    const runtime = createPageFileRuntime(read);

    const view = render(<PreviewHarness source="nodex://files/file-1" runtime={runtime} />);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    expect(view.getByText("loading")).toBeTruthy();

    view.rerender(<PreviewHarness source="nodex://files/file-2" runtime={runtime} />);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));

    await act(async () => {
      secondRead.resolve({
        bytes: new TextEncoder().encode("second"),
        mimeType: "application/json",
        etag: "etag-2",
      });
      await secondRead.promise;
    });
    await waitFor(() => expect(view.getByText("second")).toBeTruthy());

    await act(async () => {
      firstRead.resolve({
        bytes: new TextEncoder().encode("first"),
        mimeType: "application/json",
        etag: "etag-1",
      });
      await firstRead.promise;
    });
    expect(view.getByText("second")).toBeTruthy();
    expect(view.queryByText("first")).toBeNull();
  });

  test("applies the shared text preview bounds to Page Files", async () => {
    const content = Array.from({ length: 201 }, (_, index) => `line ${index + 1}`).join("\n");
    const runtime = createPageFileRuntime(async () => ({
      bytes: new TextEncoder().encode(content),
      mimeType: "application/json",
      etag: "etag-1",
    }));
    const view = render(<PreviewHarness source="nodex://files/file-1" runtime={runtime} />);

    await waitFor(() => expect(view.getByText("truncated")).toBeTruthy());
    expect(view.getByTestId("preview-content").textContent?.split("\n")).toHaveLength(200);
    expect(view.queryByText("line 201")).toBeNull();
  });

  test("does not read non-text Page Files that cannot be previewed", async () => {
    const read = vi.fn(async () => ({
      bytes: new Uint8Array([0, 1, 2]),
      mimeType: "video/webm",
      etag: "etag-1",
    }));
    const runtime = createPageFileRuntime(read);
    const view = render(
      <PreviewHarness source="nodex://files/file-1" runtime={runtime} mimeType="video/webm" />,
    );

    expect(view.getByText("unavailable")).toBeTruthy();
    await act(async () => await Promise.resolve());
    expect(read).not.toHaveBeenCalled();
  });
});
