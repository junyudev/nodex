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

  afterEach(() => {
    clearBrowserImageDragState(attachmentConversationId);
  });

  describe("browser image drag state", () => {
    test("routes one active Browser image drag to the matching composer", () => {
      const listener = vi.fn();
      const unsubscribe = subscribeBrowserImageDragState(listener);
      publishBrowserImageDragState(attachmentConversationId, {
        ...identity,
        isActive: true,
      });

      expect(getBrowserImageDragSnapshot(attachmentConversationId)).toEqual({
        ...identity,
        attachmentConversationId,
      });
      expect(getBrowserImageDragSnapshot("another-thread")).toBeNull();
      expect(listener).toHaveBeenCalledTimes(1);
      unsubscribe();
    });

    test("ignores a stale drag-end from another Browser tab", () => {
      publishBrowserImageDragState(attachmentConversationId, {
        ...identity,
        isActive: true,
      });
      publishBrowserImageDragState(attachmentConversationId, {
        ...identity,
        browserTabId: "stale-browser",
        isActive: false,
      });
      expect(getBrowserImageDragSnapshot(attachmentConversationId)).toEqual({
        ...identity,
        attachmentConversationId,
      });

      publishBrowserImageDragState(attachmentConversationId, {
        ...identity,
        isActive: false,
      });
      expect(getBrowserImageDragSnapshot(attachmentConversationId)).toBeNull();
    });
  });
});
