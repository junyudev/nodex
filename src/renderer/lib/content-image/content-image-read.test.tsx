import { QueryClient } from "@tanstack/react-query";
import { act } from "react";
import { fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { buildAgentRuntimeAttachmentSource } from "../../../shared/agent-runtime-attachments";
import type { WorkspaceFileBinaryReadResult, WorkspaceFileRequest } from "../../../shared/types";
import { queryKeys } from "../query-keys";
import { installWindowApi } from "../../test/browser-globals";
import { render } from "../../test/dom";
import { TestQueryProvider } from "../../test/query";
import { CONTENT_IMAGE_GC_TIME_MS, readContentImage } from "./content-image-read";
import {
  ContentImageScopeProvider,
  THIS_COMPUTER_IMAGE_SCOPE,
  type ContentImageScope,
} from "./content-image-scope";
import { useContentImage } from "./use-content-image";

const context: ContentImageScope = {
  ...THIS_COMPUTER_IMAGE_SCOPE,
  hostId: "local",
  conversationId: "conversation-one",
  composerTarget: null,
};
const readBinary = vi.fn<(input: WorkspaceFileRequest) => Promise<WorkspaceFileBinaryReadResult>>();
const clients = new Set<QueryClient>();

function createClient() {
  const client = new QueryClient();
  clients.add(client);
  return client;
}

function Probe({ source, deferLocalFile }: { source: string; deferLocalFile?: boolean }) {
  const asset = useContentImage(
    source,
    deferLocalFile ? { shouldLoadFileDataUrl: false } : undefined,
  );
  return (
    <>
      <output aria-label="Image state">
        {asset.isLoading ? "loading" : asset.isError ? "failed" : "ready"}
      </output>
      <img src={asset.previewSrc ?? undefined} alt="Resolved image" />
      <button type="button" onClick={() => void asset.refetch()}>
        Retry
      </button>
    </>
  );
}

beforeEach(() => {
  readBinary.mockReset();
  readBinary.mockResolvedValue({ contentsBase64: "AQID", mimeType: "image/png" });
  installWindowApi({
    invoke: async (channel: string, input: unknown) => {
      if (channel !== "read-file-binary") throw new Error(`Unexpected query: ${channel}`);
      return readBinary(input as WorkspaceFileRequest);
    },
    on: () => () => {},
  });
});

afterEach(async () => {
  await act(async () => {
    for (const client of clients) client.clear();
  });
  clients.clear();
  vi.useRealTimers();
});

describe("conversation image reads", () => {
  test("refuses a retired source before resolving an attachment or reading its bytes", async () => {
    const resolveRuntimeAttachment = vi.fn(async () => "/managed/image.png");
    const source = buildAgentRuntimeAttachmentSource({
      sourceThreadId: "source",
      itemId: "item",
      attachmentId: "attachment",
    });
    await expect(
      readContentImage(createClient(), source, {
        ...context,
        isResourceCurrent: () => false,
        resolveRuntimeAttachment,
      }),
    ).rejects.toThrow("The image's source has moved on");
    expect(resolveRuntimeAttachment).not.toHaveBeenCalled();
    expect(readBinary).not.toHaveBeenCalled();
  });

  test("refuses cached bytes when their source has retired", async () => {
    const client = createClient();
    const path = "/workspace/image.png";
    await readContentImage(client, path, context);
    await expect(
      readContentImage(client, path, {
        ...context,
        isResourceCurrent: () => false,
      }),
    ).rejects.toThrow("The image's source has moved on");
    expect(readBinary).toHaveBeenCalledTimes(1);
  });

  test("refuses bytes when the source retires while its read is pending", async () => {
    let current = true;
    let finish!: (value: WorkspaceFileBinaryReadResult) => void;
    readBinary.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = readContentImage(createClient(), "/workspace/image.png", {
      ...context,
      isResourceCurrent: () => current,
    });
    const rejected = expect(pending).rejects.toThrow("The image's source has moved on");
    expect(readBinary).toHaveBeenCalledTimes(1);
    current = false;
    finish({ contentsBase64: "c3RhbGU=", mimeType: "image/png" });
    await rejected;
  });

  test("shares in-flight reads and infers MIME from the file extension when none is returned", async () => {
    readBinary.mockResolvedValue({ contentsBase64: "AQID" });
    const client = createClient();
    const results = await Promise.all([
      readContentImage(client, " C:\\shots\\state.PNG ", context),
      readContentImage(client, "C:/shots/state.PNG", context),
    ]);
    expect(results).toEqual(["data:image/png;base64,AQID", "data:image/png;base64,AQID"]);
    expect(readBinary).toHaveBeenCalledExactlyOnceWith({
      hostId: "local",
      path: "C:/shots/state.PNG",
    });
  });

  test("isolates the same path by its host and conversation", async () => {
    const client = createClient();
    const path = "/workspace/image.png";
    await readContentImage(client, path, context);
    await readContentImage(client, path, { ...context, hostId: "ssh:remote" });
    await readContentImage(client, path, {
      ...context,
      conversationId: "conversation-two",
    });
    await readContentImage(client, path, context);
    expect(readBinary.mock.calls.map(([input]) => input.hostId)).toEqual([
      "local",
      "ssh:remote",
      "local",
    ]);
  });

  test("reads afresh for a new source rather than reusing the previous source's bytes", async () => {
    const client = createClient();
    const path = "/workspace/image.png";
    let previousHeld = true;
    const previous = { ...context, isResourceCurrent: () => previousHeld };
    const pending = readContentImage(client, path, previous);
    previousHeld = false;
    readBinary.mockResolvedValue({ contentsBase64: "BAUG", mimeType: "image/png" });
    await expect(pending).rejects.toThrow("The image's source has moved on");
    await expect(
      readContentImage(client, path, { ...context, sourceIdentity: "reconnected" }),
    ).resolves.toBe("data:image/png;base64,BAUG");
    expect(readBinary).toHaveBeenCalledTimes(2);
  });

  test("defers a generated local file until its full preview requests bytes", async () => {
    const client = createClient();
    const tree = (deferLocalFile: boolean) => (
      <TestQueryProvider client={client}>
        <ContentImageScopeProvider scope={context}>
          <Probe source="/workspace/generated.png" deferLocalFile={deferLocalFile} />
        </ContentImageScopeProvider>
      </TestQueryProvider>
    );
    const view = render(tree(true));
    expect(view.getByRole("img", { name: "Resolved image" }).getAttribute("src")).toBe(
      "app://fs/@fs/workspace/generated.png",
    );
    expect(readBinary).not.toHaveBeenCalled();
    view.rerender(tree(false));
    await waitFor(() => expect(view.getByLabelText("Image state").textContent).toBe("ready"));
    expect(readBinary).toHaveBeenCalledTimes(1);
    expect(view.getByRole("img", { name: "Resolved image" }).getAttribute("src")).toBe(
      "data:image/png;base64,AQID",
    );
    view.unmount();
  });

  test("reclaims an unobserved read five minutes after fetching, even when reused", async () => {
    vi.useFakeTimers();
    const client = createClient();
    const path = "/workspace/image.png";
    await readContentImage(client, path, context);
    await vi.advanceTimersByTimeAsync(CONTENT_IMAGE_GC_TIME_MS - 1);
    await readContentImage(client, path, context);
    expect(readBinary).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(
      client.getQueryData(
        queryKeys.conversationImages.file(
          "local",
          context.conversationId,
          context.sourceIdentity,
          path,
        ),
      ),
    ).toBeUndefined();
    readBinary.mockRejectedValue(new Error("ENOENT"));
    await expect(readContentImage(client, path, context)).rejects.toThrow("ENOENT");
    expect(readBinary).toHaveBeenCalledTimes(2);
  });

  test("keeps a mounted image's bytes after its shared cache entry is removed", async () => {
    const client = createClient();
    const source = "/workspace/image.png";
    const view = render(
      <TestQueryProvider client={client}>
        <ContentImageScopeProvider scope={context}>
          <Probe source={source} />
        </ContentImageScopeProvider>
      </TestQueryProvider>,
    );
    await waitFor(() => expect(view.getByLabelText("Image state").textContent).toBe("ready"));
    readBinary.mockRejectedValue(new Error("ENOENT"));
    await act(async () => {
      client.removeQueries({
        queryKey: queryKeys.conversationImages.file(
          "local",
          context.conversationId,
          context.sourceIdentity,
          source,
        ),
      });
    });
    expect(view.getByRole("img", { name: "Resolved image" }).getAttribute("src")).toBe(
      "data:image/png;base64,AQID",
    );
    expect(readBinary).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  test("retries the bytes after a Runtime descriptor resolves to the same failed path", async () => {
    readBinary.mockRejectedValueOnce(new Error("temporarily unavailable"));
    const reference = { sourceThreadId: "source", itemId: "item", attachmentId: "attachment" };
    const resolveRuntimeAttachment = vi.fn(async () => "/managed/image.png");
    const view = render(
      <TestQueryProvider client={createClient()}>
        <ContentImageScopeProvider scope={{ ...context, resolveRuntimeAttachment }}>
          <Probe source={buildAgentRuntimeAttachmentSource(reference)} />
        </ContentImageScopeProvider>
      </TestQueryProvider>,
    );
    await waitFor(() => expect(view.getByLabelText("Image state").textContent).toBe("failed"));
    expect(readBinary).toHaveBeenCalledTimes(1);
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Retry" }));
      await Promise.resolve();
    });
    await waitFor(() => expect(view.getByLabelText("Image state").textContent).toBe("ready"));
    expect(readBinary).toHaveBeenCalledTimes(2);
    expect(resolveRuntimeAttachment).toHaveBeenNthCalledWith(2, reference);
    view.unmount();
  });

  test("does not publish a late image after switching to a different source", async () => {
    let finishOldRead: ((value: WorkspaceFileBinaryReadResult) => void) | undefined;
    readBinary.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOldRead = resolve;
        }),
    );
    const client = createClient();
    const tree = (source: string) => (
      <TestQueryProvider client={client}>
        <ContentImageScopeProvider scope={context}>
          <Probe source={source} />
        </ContentImageScopeProvider>
      </TestQueryProvider>
    );
    const view = render(tree("/workspace/old.png"));
    await waitFor(() => expect(readBinary).toHaveBeenCalledTimes(1));
    view.rerender(tree("/workspace/new.png"));
    await waitFor(() => expect(view.getByLabelText("Image state").textContent).toBe("ready"));
    await act(async () => {
      finishOldRead?.({ contentsBase64: "b2xk" });
      await Promise.resolve();
    });
    expect(view.getByRole("img", { name: "Resolved image" }).getAttribute("src")).toBe(
      "data:image/png;base64,AQID",
    );
    view.unmount();
  });

  test("resolves the same attachment again when its scope source identity changes", async () => {
    const reference = { sourceThreadId: "source", itemId: "item", attachmentId: "attachment" };
    const resolveRuntimeAttachment = vi
      .fn()
      .mockResolvedValueOnce("/managed/old.png")
      .mockResolvedValueOnce("/managed/new.png");
    readBinary
      .mockResolvedValueOnce({ contentsBase64: "b2xk" })
      .mockResolvedValueOnce({ contentsBase64: "bmV3" });
    const client = createClient();
    const tree = (sourceIdentity: string) => (
      <TestQueryProvider client={client}>
        <ContentImageScopeProvider scope={{ ...context, sourceIdentity, resolveRuntimeAttachment }}>
          <Probe source={buildAgentRuntimeAttachmentSource(reference)} />
        </ContentImageScopeProvider>
      </TestQueryProvider>
    );
    const view = render(tree("old"));
    await waitFor(() =>
      expect(view.getByAltText("Resolved image").getAttribute("src")).toBe(
        "data:image/png;base64,b2xk",
      ),
    );
    view.rerender(tree("new"));
    await waitFor(() =>
      expect(view.getByAltText("Resolved image").getAttribute("src")).toBe(
        "data:image/png;base64,bmV3",
      ),
    );
    expect(resolveRuntimeAttachment).toHaveBeenCalledTimes(2);
    expect(readBinary.mock.calls.map(([input]) => input.path)).toEqual([
      "/managed/old.png",
      "/managed/new.png",
    ]);
    view.unmount();
  });

  test("resolves a chat's attachment once while the chat holds it, and again on retry", async () => {
    const reference = { sourceThreadId: "source", itemId: "item", attachmentId: "photo" };
    const picture = "data:image/png;base64,iVBORw0KGgo=";
    const resolveRuntimeAttachment = vi.fn(async () => picture);
    const client = createClient();
    const scope = { ...context, resolveRuntimeAttachment };
    const source = buildAgentRuntimeAttachmentSource(reference);
    expect(await readContentImage(client, source, scope)).toBe(picture);
    expect(await readContentImage(client, source, scope)).toBe(picture);
    expect(resolveRuntimeAttachment).toHaveBeenCalledExactlyOnceWith(reference);
    await readContentImage(client, source, { ...scope, conversationId: "conversation-two" });
    await readContentImage(client, source, scope, true);
    expect(resolveRuntimeAttachment).toHaveBeenCalledTimes(3);
    expect(readBinary).not.toHaveBeenCalled();
  });

  test("resolves an attachment when its owning resolver becomes available", async () => {
    const source = buildAgentRuntimeAttachmentSource({
      sourceThreadId: "source",
      itemId: "item",
      attachmentId: "attachment",
    });
    const client = createClient();
    const tree = (resolveRuntimeAttachment?: () => Promise<string>) => (
      <TestQueryProvider client={client}>
        <ContentImageScopeProvider scope={{ ...context, resolveRuntimeAttachment }}>
          <Probe source={source} />
        </ContentImageScopeProvider>
      </TestQueryProvider>
    );
    const view = render(tree());
    await waitFor(() => expect(view.getByLabelText("Image state").textContent).toBe("failed"));
    expect(readBinary).not.toHaveBeenCalled();
    view.rerender(tree(async () => "/managed/image.png"));
    await waitFor(() => expect(view.getByLabelText("Image state").textContent).toBe("ready"));
    expect(readBinary).toHaveBeenCalledExactlyOnceWith({
      hostId: "local",
      path: "/managed/image.png",
    });
    view.unmount();
  });
});
