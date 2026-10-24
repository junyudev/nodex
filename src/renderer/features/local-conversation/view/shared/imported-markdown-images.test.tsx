import { act, type ReactNode } from "react";
import { cleanup, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { buildAgentRuntimeAttachmentSource } from "../../../../../shared/agent-runtime-attachments";
import { ConversationMediaProvider } from "@/lib/conversation-media/conversation-media";
import { installWindowApi } from "../../../../test/browser-globals";
import { render, settleAsyncRender } from "../../../../test/dom";
import { TestQueryProvider } from "../../../../test/query";
import { ConversationImageAssetProvider } from "../conversation-image-asset-context";
import { ImageViewSurface } from "./image-view-surface";
import { ImportedMarkdownImagesProvider } from "./imported-markdown-images";
import { MarkdownRenderer } from "./markdown/markdown-renderer";
import { UserAttachmentStrip } from "./user-message-attachments";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const reference = {
  sourceThreadId: "imported-thread",
  itemId: "imported-assistant",
  attachmentId: "retained-image",
};
const ownedPath = "/runtime/attachments/retained-image.png";
const availablePath = "/gone/available&image.png";
const missingPath = "/gone/missing&image.png";
const spyOnConsole = () => [vi.spyOn(console, "error"), vi.spyOn(console, "warn")];
let consoleSpies: ReturnType<typeof spyOnConsole> = [];

beforeEach(() => {
  consoleSpies = spyOnConsole();
});
afterEach(() => {
  try {
    cleanup();
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  } finally {
    for (const spy of consoleSpies) spy.mockRestore();
  }
});

const withImages = (
  children: ReactNode,
  resolveRuntimeAttachment: (reference: unknown) => Promise<string>,
) => (
  <TestQueryProvider>
    <NodexTooltipProvider>
      <ConversationImageAssetProvider
        conversationId="imported-thread"
        hostId="local"
        resolveRuntimeAttachment={resolveRuntimeAttachment}
      >
        {children}
      </ConversationImageAssetProvider>
    </NodexTooltipProvider>
  </TestQueryProvider>
);

describe("imported conversation images", () => {
  test.each([
    {
      syntax: "inline",
      content:
        "![Retained](/gone/available&amp;image.png)\n\n![Missing](/gone/missing&amp;image.png)",
    },
    {
      syntax: "reference",
      content:
        "![Retained][copy]\n\n![Missing][gone]\n\n[copy]: /gone/available&amp;image.png\n[gone]: /gone/missing&amp;image.png",
    },
  ])(
    "maps real conversation $syntax Markdown to owned bytes and missing records",
    async ({ content }) => {
      const invoke = vi.fn(async () => ({ contentsBase64: png, mimeType: "image/png" }));
      const resolveRuntimeAttachment = vi.fn(async () => ownedPath);
      installWindowApi({ invoke, on: () => () => {} });
      const view = render(
        withImages(
          <ConversationMediaProvider
            source={{
              hostId: "local",
              threadId: "imported-thread",
              sourceIdentity: "imported-thread",
              authority: {},
              nativeConnection: { sourceEpoch: "fixture", generation: 1 },
              isCurrent: () => true,
              isResourceCurrent: () => true,
            }}
          >
            <ImportedMarkdownImagesProvider
              images={[
                {
                  sourcePath: availablePath,
                  name: "available&image.png",
                  source: buildAgentRuntimeAttachmentSource(reference),
                },
                { sourcePath: missingPath, name: "missing&image.png", source: null },
              ]}
            >
              <MarkdownRenderer dialect="conversation" content={content} />
            </ImportedMarkdownImagesProvider>
          </ConversationMediaProvider>,
          resolveRuntimeAttachment,
        ),
      );

      const retained = await view.findByRole("img", { name: "Retained" });
      expect(retained.getAttribute("src")).toBe(`data:image/png;base64,${png}`);
      const missing = await view.findByRole("img", {
        name: "missing&image.png, file missing",
      });
      expect(missing.hasAttribute("src")).toBe(false);
      expect(view.container.querySelectorAll("img")).toHaveLength(1);
      expect(resolveRuntimeAttachment).toHaveBeenCalledExactlyOnceWith(reference);
      expect(invoke).toHaveBeenCalledExactlyOnceWith("read-file-binary", {
        hostId: "local",
        path: ownedPath,
      });
    },
  );

  test("keeps a missing user picture visible without resolving its old path", async () => {
    const invoke = vi.fn();
    const resolveRuntimeAttachment = vi.fn();
    installWindowApi({ invoke, on: () => () => {} });
    const view = render(
      withImages(
        <UserAttachmentStrip
          attachments={[]}
          unavailableImages={[{ name: "user-image.png", sourcePath: "/gone/user-image.png" }]}
        />,
        resolveRuntimeAttachment,
      ),
    );
    await view.findByRole("img", { name: "user-image.png, file missing" });
    await settleAsyncRender();
    expect(view.container.querySelector("img")).toBeNull();
    expect(view.queryByRole("button", { name: "Open image preview" })).toBeNull();
    expect(resolveRuntimeAttachment).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  test("expands a missing inspected picture without requesting source bytes", async () => {
    const invoke = vi.fn();
    const resolveRuntimeAttachment = vi.fn();
    installWindowApi({ invoke, on: () => () => {} });
    const view = render(
      withImages(
        <ImageViewSurface
          imagePaths={[]}
          unavailableImages={[{ name: "viewed-image.png", sourcePath: "/gone/viewed-image.png" }]}
        />,
        resolveRuntimeAttachment,
      ),
    );
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Viewed an image · file missing" }));
      await Promise.resolve();
    });
    await view.findByRole("img", { name: "viewed-image.png, file missing" });
    await settleAsyncRender();
    expect(view.container.querySelector("img")).toBeNull();
    expect(resolveRuntimeAttachment).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });
});
