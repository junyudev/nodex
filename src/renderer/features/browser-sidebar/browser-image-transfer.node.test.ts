import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import {
  consumeBrowserImageAttachments,
  getBrowserImageAttachmentsSnapshot,
  publishBrowserImageAttachment,
  subscribeBrowserImageAttachments,
} from "./browser-image-attachments";
import {
  clearBrowserImageDragState,
  getBrowserImageDragSnapshot,
  publishBrowserImageDragState,
  subscribeBrowserImageDragState,
} from "./browser-image-drag-state";

describe("browser image attachments", () => {
  const conversationId = "browser-image-test";

  afterEach(() => {
    consumeBrowserImageAttachments(
      conversationId,
      getBrowserImageAttachmentsSnapshot(conversationId).map((attachment) => attachment.id),
    );
  });

  describe("browser image attachments", () => {
    test("queues opaque managed images until the matching composer consumes them", () => {
      const listener = vi.fn();
      const unsubscribe = subscribeBrowserImageAttachments(listener);
      publishBrowserImageAttachment(conversationId, {
        id: "image-1",
        filename: "preview.png",
        source: "nodex://assets/image-1.png",
      });

      expect(getBrowserImageAttachmentsSnapshot(conversationId)).toEqual([
        {
          id: "image-1",
          filename: "preview.png",
          source: "nodex://assets/image-1.png",
        },
      ]);
      consumeBrowserImageAttachments(conversationId, ["image-1"]);
      expect(getBrowserImageAttachmentsSnapshot(conversationId)).toEqual([]);
      expect(listener).toHaveBeenCalledTimes(2);
      unsubscribe();
    });

    test("deduplicates retries by managed attachment id", () => {
      const base = {
        id: "image-1",
        filename: "first.png",
        source: "nodex://assets/image-1.png",
      };
      publishBrowserImageAttachment(conversationId, base);
      publishBrowserImageAttachment(conversationId, {
        ...base,
        filename: "renamed.png",
      });

      expect(getBrowserImageAttachmentsSnapshot(conversationId)).toHaveLength(1);
      expect(getBrowserImageAttachmentsSnapshot(conversationId)[0]?.filename).toBe("renamed.png");
    });

    test("rejects display URLs that cannot cross the app-server attachment boundary", () => {
      expect(() =>
        publishBrowserImageAttachment(conversationId, {
          id: "image-1",
          filename: "preview.png",
          source: "app://fs/@fs/profile/assets/image-1.png",
        }),
      ).toThrow("Browser image attachment is incomplete");
    });
  });
});

describe("browser image drag state", () => {
  const attachmentConversationId = "thread-1";
  const identity = {
    browserConversationId: "session-1",
    browserViewScopeId: "window-1",
    browserTabId: "browser-1",
  } as const;
  const firstDrag = { ...identity, dragToken: "1".repeat(32), isActive: true };
  const secondDrag = { ...identity, dragToken: "2".repeat(32), isActive: true };

  afterEach(() => {
    clearBrowserImageDragState(firstDrag.dragToken);
    clearBrowserImageDragState(secondDrag.dragToken);
  });

  test("routes one active Browser image drag to the matching composer", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeBrowserImageDragState(listener);
    publishBrowserImageDragState(attachmentConversationId, firstDrag);

    expect(getBrowserImageDragSnapshot(attachmentConversationId)).toEqual({
      ...identity,
      dragToken: firstDrag.dragToken,
      attachmentConversationId,
    });
    expect(getBrowserImageDragSnapshot("another-thread")).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  test("replaces a prior chat's drag and only clears the matching token", () => {
    publishBrowserImageDragState(attachmentConversationId, firstDrag);
    publishBrowserImageDragState("another-thread", secondDrag);
    expect(getBrowserImageDragSnapshot(attachmentConversationId)).toBeNull();

    clearBrowserImageDragState(firstDrag.dragToken);
    expect(getBrowserImageDragSnapshot("another-thread")?.dragToken).toBe(secondDrag.dragToken);

    clearBrowserImageDragState(secondDrag.dragToken);
    expect(getBrowserImageDragSnapshot("another-thread")).toBeNull();
  });
});
