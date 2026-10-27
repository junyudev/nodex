import { QueryClient } from "@tanstack/react-query";
import { act } from "react";
import { fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { buildAgentRuntimeAttachmentSource } from "../../../shared/agent-runtime-attachments";
import type { WorkspaceFileBinaryReadResult, WorkspaceFileRequest } from "../../../shared/types";
import { queryKeys } from "@/lib/query-keys";
import { installWindowApi } from "../../test/browser-globals";
import { render } from "../../test/dom";
import { TestQueryProvider } from "../../test/query";
import {
  CONVERSATION_IMAGE_GC_TIME_MS,
  resolveConversationImageRead,
} from "./conversation-image-assets";
import {
  ConversationImageAssetProvider,
  type ConversationImageAssetContextValue,
} from "./view/conversation-image-asset-context";
import { useConversationImageAsset } from "./view/shared/use-conversation-image-asset";

const context: ConversationImageAssetContextValue = {
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
  const asset = useConversationImageAsset(
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
  readBinary.mockResolvedValue({ contentsBase64: "AQID", mimeType: "image/webp" });
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
  test("shares in-flight reads and builds data URLs from the recorded file extension", async () => {
    const client = createClient();
    const results = await Promise.all([
      resolveConversationImageRead(client, " C:\\shots\\state.PNG ", context),
      resolveConversationImageRead(client, "C:/shots/state.PNG", context),
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
    await resolveConversationImageRead(client, path, context);
    await resolveConversationImageRead(client, path, { ...context, hostId: "ssh:remote" });
    await resolveConversationImageRead(client, path, {
      ...context,
      conversationId: "conversation-two",
    });
    await resolveConversationImageRead(client, path, context);
    expect(readBinary.mock.calls.map(([input]) => input.hostId)).toEqual([
      "local",
      "ssh:remote",
      "local",
    ]);
  });

  test("defers a generated local file until its full preview requests bytes", async () => {
    const client = createClient();
    const tree = (deferLocalFile: boolean) => (
      <TestQueryProvider client={client}>
        <ConversationImageAssetProvider {...context}>
          <Probe source="/workspace/generated.png" deferLocalFile={deferLocalFile} />
        </ConversationImageAssetProvider>
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
    await resolveConversationImageRead(client, path, context);
    await vi.advanceTimersByTimeAsync(CONVERSATION_IMAGE_GC_TIME_MS - 1);
    await resolveConversationImageRead(client, path, context);
    expect(readBinary).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(
      client.getQueryData(queryKeys.conversationImages.file("local", context.conversationId, path)),
    ).toBeUndefined();
    readBinary.mockRejectedValue(new Error("ENOENT"));
    await expect(resolveConversationImageRead(client, path, context)).rejects.toThrow("ENOENT");
    expect(readBinary).toHaveBeenCalledTimes(2);
  });

  test("keeps a mounted image's bytes after its shared cache entry is removed", async () => {
    const client = createClient();
    const source = "/workspace/image.png";
    const view = render(
      <TestQueryProvider client={client}>
        <ConversationImageAssetProvider {...context}>
          <Probe source={source} />
        </ConversationImageAssetProvider>
      </TestQueryProvider>,
    );
    await waitFor(() => expect(view.getByLabelText("Image state").textContent).toBe("ready"));
    readBinary.mockRejectedValue(new Error("ENOENT"));
    await act(async () => {
      client.removeQueries({
        queryKey: queryKeys.conversationImages.file("local", context.conversationId, source),
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
        <ConversationImageAssetProvider
          {...context}
          resolveRuntimeAttachment={resolveRuntimeAttachment}
        >
          <Probe source={buildAgentRuntimeAttachmentSource(reference)} />
        </ConversationImageAssetProvider>
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
        <ConversationImageAssetProvider {...context}>
          <Probe source={source} />
        </ConversationImageAssetProvider>
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

  test("resolves an attachment when its owning resolver becomes available", async () => {
    const source = buildAgentRuntimeAttachmentSource({
      sourceThreadId: "source",
      itemId: "item",
      attachmentId: "attachment",
    });
    const client = createClient();
    const tree = (resolveRuntimeAttachment?: () => Promise<string>) => (
      <TestQueryProvider client={client}>
        <ConversationImageAssetProvider
          {...context}
          resolveRuntimeAttachment={resolveRuntimeAttachment}
        >
          <Probe source={source} />
        </ConversationImageAssetProvider>
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
