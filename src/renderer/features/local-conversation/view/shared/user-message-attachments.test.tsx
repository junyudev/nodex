import { buildCodexUserAttachmentsFromContent } from "../../../../../shared/codex-user-attachment-projection";
import { buildAgentHistoryImageSource } from "../../../../../shared/agent-history-images";
import { buildAgentRuntimeAttachmentSource } from "../../../../../shared/agent-runtime-attachments";
import { act } from "react";
import { fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { render, settleAsyncRender } from "../../../../test/dom";
import { installWindowApi } from "../../../../test/browser-globals";
import { TestQueryProvider } from "../../../../test/query";
import { ConversationImageAssetProvider } from "../conversation-image-asset-context";
import { UserAttachmentStrip } from "./user-message-attachments";
import {
  registerUserAttachmentImagePreviewOpener,
  type OpenUserAttachmentImagePreviewOptions,
} from "@/features/user-attachment-image-editor";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("UserAttachmentStrip", () => {
  test("resolves a mounted Runtime image's exact descriptor to display bytes", async () => {
    const invoke = vi.fn(async () => ({
      contentsBase64: "aW1hZ2U=",
      mimeType: "image/png",
    }));
    installWindowApi({ invoke, on: () => () => {} });
    const reference = {
      sourceThreadId: "fork-source",
      itemId: "original-user-item",
      attachmentId: "image-asset",
    };
    const resolveRuntimeAttachment = vi.fn(async () => "/managed/runtime/attachments/image.png");
    const view = render(
      <TestQueryProvider>
        <ConversationImageAssetProvider
          conversationId="selected-child"
          hostId="local"
          resolveRuntimeAttachment={resolveRuntimeAttachment}
        >
          <UserAttachmentStrip
            attachments={buildCodexUserAttachmentsFromContent(
              [{ type: "image", url: buildAgentRuntimeAttachmentSource(reference) }],
              reference.itemId,
            )}
          />
        </ConversationImageAssetProvider>
      </TestQueryProvider>,
    );
    await view.findByRole("button", { name: "Open image preview" });
    expect(resolveRuntimeAttachment).toHaveBeenCalledExactlyOnceWith(reference);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("read-file-binary", {
      hostId: "local",
      path: "/managed/runtime/attachments/image.png",
    });
    expect(view.container.querySelector("img")?.getAttribute("src")).toBe(
      "data:image/png;base64,aW1hZ2U=",
    );
    view.unmount();
  });
  test("resolves native file-ID images through the hosted-image boundary", async () => {
    const invoke = vi.fn(async () => ({
      ok: true,
      dataBase64: "aW1hZ2U=",
      mimeType: "image/png",
    }));
    installWindowApi({ invoke, on: () => () => {} });
    const view = render(
      <TestQueryProvider>
        <ConversationImageAssetProvider conversationId="thread" hostId="local">
          <UserAttachmentStrip
            attachments={buildCodexUserAttachmentsFromContent(
              [{ type: "image", fileId: "asset-native" }],
              "native-user-message",
            )}
          />
        </ConversationImageAssetProvider>
      </TestQueryProvider>,
    );

    await view.findByRole("button", { name: "Open image preview" });
    expect(invoke).toHaveBeenCalledExactlyOnceWith("codex:conversation-image-asset:resolve", {
      hostId: "local",
      pointer: "file-service://asset-native",
    });
  });

  test("resolves native history image descriptors through their owning session without arbitrary file reads", async () => {
    const invoke = vi.fn(async () => ({
      bytes: new TextEncoder().encode("image"),
      mimeType: "image/png",
    }));
    installWindowApi({
      invoke,
      on: () => () => {},
      resolveManagedAssetPath: () => "/tmp/native-image.png",
    });
    const reference = { sessionId: "native-session", nativeMessageId: "native-message", index: 2 };
    const resolveHistoryImage = vi.fn(async () => "nodex://assets/native-image.png");
    const view = render(
      <TestQueryProvider>
        <ConversationImageAssetProvider
          conversationId="thread"
          hostId="local"
          resolveHistoryImage={resolveHistoryImage}
        >
          <UserAttachmentStrip
            attachments={[
              {
                type: "image",
                id: "native",
                source: buildAgentHistoryImageSource(reference),
                sourceKind: "remote-pointer",
              },
            ]}
          />
        </ConversationImageAssetProvider>
      </TestQueryProvider>,
    );
    await view.findByRole("button", { name: "Open image preview" });
    expect(resolveHistoryImage).toHaveBeenCalledExactlyOnceWith(reference);
    expect(invoke).toHaveBeenCalledExactlyOnceWith(
      "asset:image:read",
      "nodex://assets/native-image.png",
    );
    expect(view.container.querySelector("img")?.getAttribute("src")).toBe(
      "data:image/png;base64,aW1hZ2U=",
    );
  });
  test("rejects a native image resolver result that is not an owned asset", async () => {
    const invoke = vi.fn(async () => {
      throw new Error("Unexpected file read");
    });
    installWindowApi({ invoke, on: () => () => {} });
    const view = render(
      <TestQueryProvider>
        <ConversationImageAssetProvider
          conversationId="thread"
          hostId="local"
          resolveHistoryImage={async () => "/private/secret.png"}
        >
          <UserAttachmentStrip
            attachments={[
              {
                type: "image",
                id: "native",
                source: buildAgentHistoryImageSource({
                  sessionId: "session",
                  nativeMessageId: "message",
                  index: 0,
                }),
                sourceKind: "remote-pointer",
              },
            ]}
          />
        </ConversationImageAssetProvider>
      </TestQueryProvider>,
    );
    await view.findByRole("img", { name: "Image failed to load" });
    expect(invoke).not.toHaveBeenCalled();
    expect(view.queryByRole("button", { name: "Open image preview" })).toBeNull();
  });

  test("renders remote thumbnails with preview action", async () => {
    const view = render(
      <TestQueryProvider>
        <UserAttachmentStrip
          attachments={[
            {
              type: "image",
              id: "remote-image",
              source: "data:image/png;base64,aW1hZ2U=",
              sourceKind: "inline-image",
            },
          ]}
        />
      </TestQueryProvider>,
    );

    const image = view.container.querySelector("img");
    expect(image?.getAttribute("src")).toBe("data:image/png;base64,aW1hZ2U=");
    expect(Boolean(view.container.querySelector('[aria-label="Open image preview"]'))).toBe(true);
  });

  test("navigates all resolved message images inside one preview session", async () => {
    const firstSource = "data:image/png;base64,Zmlyc3Q=";
    const secondSource = "data:image/png;base64,c2Vjb25k";
    const view = render(
      <TestQueryProvider>
        <UserAttachmentStrip
          attachments={[
            {
              type: "image",
              id: "first-image",
              source: firstSource,
              sourceKind: "inline-image",
            },
            {
              type: "image",
              id: "second-image",
              source: secondSource,
              sourceKind: "inline-image",
            },
          ]}
        />
      </TestQueryProvider>,
    );

    const triggers = await view.findAllByRole("button", { name: "Open image preview" });
    await act(async () => {
      fireEvent.click(triggers[0]);
    });

    const dialog = await view.findByRole("dialog", { name: "Image preview" });
    expect(dialog.querySelector("img")?.getAttribute("src")).toBe(firstSource);
    expect(view.queryByRole("button", { name: "Previous image" })).toBeNull();

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Next image" }));
    });

    await waitFor(() => {
      expect(dialog.querySelector("img")?.getAttribute("src")).toBe(secondSource);
    });
    expect(view.getByRole("button", { name: "Previous image" })).not.toBeNull();
    expect(view.queryByRole("button", { name: "Next image" })).toBeNull();

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Close image preview" }));
    });
    await waitFor(() => expect(document.activeElement).toBe(triggers[0]));
  });

  test("keeps thread clicks in the lightbox and routes only Edit to its Composer", async () => {
    const opened: OpenUserAttachmentImagePreviewOptions[] = [];
    const unregister = registerUserAttachmentImagePreviewOpener(async (options) => {
      opened.push(options);
      return true;
    });
    const source = "data:image/png;base64,dGhyZWFk";
    const view = render(
      <TestQueryProvider>
        <ConversationImageAssetProvider
          composerTarget={{
            channelId: "AppScope:app/ThreadScope:session:task::root",
            placement: "root",
          }}
          conversationId="thread-1"
          hostId="local"
        >
          <UserAttachmentStrip
            attachments={[
              {
                type: "image",
                id: "thread-image",
                source,
                sourceKind: "inline-image",
              },
            ]}
          />
        </ConversationImageAssetProvider>
      </TestQueryProvider>,
    );

    try {
      const preview = await view.findByRole("button", { name: "Open image preview" });
      await act(async () => {
        fireEvent.click(preview);
      });
      expect(view.getByRole("dialog", { name: "Image preview" })).toBeTruthy();
      expect(opened).toEqual([]);

      await act(async () => {
        fireEvent.click(view.getByRole("button", { name: "Edit image" }));
        await Promise.resolve();
      });

      expect(opened).toHaveLength(1);
      expect(opened[0]).toMatchObject({
        composerTarget: {
          channelId: "AppScope:app/ThreadScope:session:task::root",
          placement: "root",
        },
        entrypoint: "lightbox_edit_button",
        openInEditor: true,
        threadId: "thread-1",
      });
    } finally {
      unregister();
      view.unmount();
      vi.restoreAllMocks();
    }
  });

  test("shows failed remote thumbnails without an automatic retry or preview action", async () => {
    const invoke = vi.fn(async () => ({
      ok: false,
      status: 404,
      message: "Image not found",
    }));
    installWindowApi({
      invoke,
      on: () => () => {},
    });
    const view = render(
      <TestQueryProvider>
        <UserAttachmentStrip
          attachments={[
            {
              type: "image",
              id: "remote-image",
              source: "file-service://missing",
              sourceKind: "remote-pointer",
            },
          ]}
        />
      </TestQueryProvider>,
    );

    expect(view.queryByLabelText("Loading user attachment")).not.toBeNull();
    await waitFor(() => {
      expect(view.queryByLabelText("Loading user attachment")).toBeNull();
    });
    expect(view.getByRole("img", { name: "Image failed to load" }).textContent).toBe("Failed");
    expect(view.queryByRole("button", { name: "Retry image" })).toBeNull();
    expect(view.queryByRole("button", { name: "Open image preview" })).toBeNull();
    await settleAsyncRender();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  test("materializes a protocol localImage on its trusted local host", async () => {
    const invokeCalls: string[] = [];
    installWindowApi({
      invoke: async (channel: string) => {
        invokeCalls.push(channel);
        return {
          contentsBase64: "aW1hZ2U=",
          mimeType: "image/png",
        };
      },
      on: () => () => {},
    });

    const view = render(
      <TestQueryProvider>
        <UserAttachmentStrip
          attachments={[
            {
              type: "image",
              id: "local-image",
              source: "/Users/example/secret.png",
              sourceKind: "local-image",
            },
          ]}
        />
      </TestQueryProvider>,
    );

    await waitFor(() => {
      expect(view.container.querySelector("img")?.getAttribute("src")).toBe(
        "data:image/png;base64,aW1hZ2U=",
      );
    });

    expect(invokeCalls).toEqual(["read-file-binary"]);
    expect(Boolean(view.container.querySelector('[aria-label="Open image preview"]'))).toBe(true);
  });

  test("keeps an unreadable local image out of preview navigation", async () => {
    const invoke = vi.fn(async (_channel: string, input: unknown) => {
      const path = (input as { path: string }).path;
      if (path === "/images/missing.png") throw new Error("ENOENT");
      return {
        contentsBase64: path === "/images/first.png" ? "Zmlyc3Q=" : "bGFzdA==",
        mimeType: "image/png",
      };
    });
    installWindowApi({ invoke, on: () => () => {} });
    const view = render(
      <TestQueryProvider>
        <UserAttachmentStrip
          attachments={["first", "missing", "last"].map((id) => ({
            type: "image",
            id,
            source: `/images/${id}.png`,
            sourceKind: "local-image",
          }))}
        />
      </TestQueryProvider>,
    );

    await view.findByRole("img", { name: "Image failed to load" });
    await waitFor(() => {
      expect(view.getAllByRole("button", { name: "Open image preview" })).toHaveLength(2);
    });
    const triggers = view.getAllByRole("button", { name: "Open image preview" });
    await act(async () => {
      fireEvent.click(triggers[0]);
      await Promise.resolve();
    });
    const dialog = await view.findByRole("dialog", { name: "Image preview" });
    expect(dialog.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,Zmlyc3Q=");
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Next image" }));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(dialog.querySelector("img")?.getAttribute("src")).toBe(
        "data:image/png;base64,bGFzdA==",
      );
    });
    expect(view.queryByRole("button", { name: "Next image" })).toBeNull();
    expect(view.queryByRole("button", { name: "Retry image" })).toBeNull();
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  test("opens a loaded local image from the same bytes after its source disappears", async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({ contentsBase64: "aW1hZ2U=", mimeType: "image/png" })
      .mockRejectedValue(new Error("ENOENT"));
    installWindowApi({ invoke, on: () => () => {} });
    const view = render(
      <TestQueryProvider>
        <UserAttachmentStrip
          attachments={[
            {
              type: "image",
              id: "loaded-local",
              source: "/images/loaded.png",
              sourceKind: "local-image",
            },
          ]}
        />
      </TestQueryProvider>,
    );

    const trigger = await view.findByRole("button", { name: "Open image preview" });
    await act(async () => {
      fireEvent.click(trigger);
      await Promise.resolve();
    });
    const dialog = await view.findByRole("dialog", { name: "Image preview" });
    expect(dialog.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,aW1hZ2U=");
    await settleAsyncRender();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  test("reads a protocol localImage on its recorded execution host", async () => {
    const invoke = vi.fn(async () => ({ contentsBase64: "aW1hZ2U=", mimeType: "image/png" }));
    installWindowApi({
      invoke,
      on: () => () => {},
    });

    const view = render(
      <TestQueryProvider>
        <ConversationImageAssetProvider conversationId="remote-conversation" hostId="ssh:remote">
          <UserAttachmentStrip
            attachments={[
              {
                type: "image",
                id: "remote-host-local-image",
                source: "/Users/example/secret.png",
                sourceKind: "local-image",
              },
            ]}
          />
        </ConversationImageAssetProvider>
      </TestQueryProvider>,
    );

    await view.findByRole("button", { name: "Open image preview" });
    expect(invoke).toHaveBeenCalledExactlyOnceWith("read-file-binary", {
      hostId: "ssh:remote",
      path: "/Users/example/secret.png",
    });
    expect(view.getByRole("img", { name: "User attachment" }).getAttribute("src")).toBe(
      "data:image/png;base64,aW1hZ2U=",
    );
  });
});
