import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  onTestFinished,
  vi,
} from "vite-plus/test";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { flushSync } from "react-dom";
import { TestQueryProvider, createTestQueryClient } from "@/test/query";
import { installWindowApi } from "@/test/browser-globals";
import { settleAsyncRender } from "@/test/dom";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import {
  registerUserAttachmentImagePreviewOpener,
  type ContentImageScope,
} from "@/lib/content-image";

import * as resolvedImageAsset from "@/lib/content-image";
import {
  ConversationMedia,
  ConversationMediaProvider,
  conversationMediaComponents,
} from "@/components/conversation-media/conversation-media";

import { ConversationTokenRenderer } from "@/lib/markdown/conversation-token-renderer";
import { streamdownComponents } from "@/lib/streamdown";
import {
  conversationImageScope,
  type ConversationMarkdownSource,
} from "@/features/local-conversation/view/conversation-markdown-source";

const reads = vi.fn();
const nativeReads = vi.fn();
const nativeMenu = vi.fn(
  async (_items: unknown, _options: unknown): Promise<string | null> => null,
);

const markdownSource: ConversationMarkdownSource = {
  projectId: null,
  cwd: null,
  workspaceRoot: null,
  sourceRoot: { hostId: "remote-one", threadId: "thread" },
  hostId: "remote-one",
  threadId: "thread",
  sourceIdentity: "thread:item-one",
  authority: {},
  nativeConnection: { sourceEpoch: "epoch", transportKind: "stdio", generation: 1 },
  isCurrent: () => true,
  isResourceCurrent: () => true,
};
const scope = conversationImageScope(markdownSource, {});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function mediaTree(
  source: ContentImageScope | null,
  children: React.ReactNode,
  client = createTestQueryClient(),
) {
  return (
    <TestQueryProvider client={client}>
      <NodexTooltipProvider>
        <ConversationMediaProvider source={source}>{children}</ConversationMediaProvider>
      </NodexTooltipProvider>
    </TestQueryProvider>
  );
}
async function loaded(image: HTMLElement) {
  await act(async () => {
    fireEvent.load(image);
    await Promise.resolve();
  });
}
describe("ordinary conversation media", () => {
  // These tests observe player behavior; cold module loading is covered by the lazy player tests.
  beforeAll(async () => {
    await import("@/components/conversation-media/conversation-video-player");
  });
  beforeEach(() => {
    nativeMenu.mockReset().mockResolvedValue(null);
    nativeReads
      .mockReset()
      .mockResolvedValue({ contentsBase64: "aW1hZ2U=", mimeType: "image/png" });
    window.electronBridge = {
      showContextMenu: nativeMenu,
    } as unknown as typeof window.electronBridge;
    reads.mockReset().mockResolvedValue({ contentsBase64: "aW1hZ2U=", mimeType: "image/png" });
    installWindowApi({
      invoke: async (channel: string, ...args: unknown[]) => {
        if (channel === "read-file-binary") return reads(...args);
        if (channel === "native-resource:read") return nativeReads(...args);
        if (channel === "asset:image:save") return { source: "nodex://assets/context-image" };
        throw new Error(`Unexpected media operation ${channel}`);
      },
    });
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
  });
  afterEach(async () => {
    cleanup();
    await settleAsyncRender();
    vi.restoreAllMocks();
  });

  test("rejects a retired host read and requires new generation bytes even when owner/native IDs are reused", async () => {
    const oldRead = deferred<{ contentsBase64: string; mimeType: string }>();
    let current = true;
    reads.mockImplementation((input: { hostId: string }) =>
      input.hostId === "remote-one"
        ? oldRead.promise
        : Promise.resolve({ contentsBase64: "bmV3", mimeType: "image/png" }),
    );
    const oldScope = { ...scope, isCurrent: () => current, isResourceCurrent: () => current };
    const client = createTestQueryClient();
    const view = render(
      mediaTree(oldScope, <ConversationMedia src="/remote/chart.png" alt="Chart" />, client),
    );
    await waitFor(() => expect(reads).toHaveBeenCalledTimes(1));
    current = false;
    view.rerender(
      mediaTree(
        conversationImageScope(
          {
            ...markdownSource,
            hostId: "remote-two",
            nativeConnection: { sourceEpoch: "epoch", transportKind: "stdio", generation: 2 },
          },
          {},
        ),
        <ConversationMedia src="/remote/chart.png" alt="Chart" />,
        client,
      ),
    );
    await waitFor(() =>
      expect(view.getByAltText("Chart").getAttribute("src")).toBe("data:image/png;base64,bmV3"),
    );
    await act(async () => {
      oldRead.resolve({ contentsBase64: "b2xk", mimeType: "image/png" });
      await oldRead.promise;
    });
    expect(view.getByAltText("Chart").getAttribute("src")).toBe("data:image/png;base64,bmV3");
    expect(reads.mock.calls.map(([input]) => input.hostId)).toEqual(["remote-one", "remote-two"]);
    reads.mockResolvedValue({ contentsBase64: "ZnJlc2g=", mimeType: "image/png" });
    view.rerender(
      mediaTree(
        conversationImageScope(
          {
            ...markdownSource,
            nativeConnection: { sourceEpoch: "epoch", transportKind: "stdio", generation: 3 },
          },
          {},
        ),
        <ConversationMedia src="/remote/chart.png" alt="Chart" />,
        client,
      ),
    );
    await waitFor(() =>
      expect(view.getByAltText("Chart").getAttribute("src")).toBe("data:image/png;base64,ZnJlc2g="),
    );
    expect(reads).toHaveBeenCalledTimes(3);
  });

  test("shares an in-flight authority read across consumer unmount without reviving old DOM callbacks", async () => {
    const read = deferred<{ contentsBase64: string; mimeType: string }>();
    reads.mockReturnValue(read.promise);
    const client = createTestQueryClient();
    const tree = (visible: boolean) =>
      mediaTree(
        scope,
        visible ? <ConversationMedia src="/remote/chart.png" alt="Chart" /> : null,
        client,
      );
    const view = render(tree(true));
    await waitFor(() => expect(reads).toHaveBeenCalledTimes(1));
    view.rerender(tree(false));
    view.rerender(tree(true));
    await act(async () => {
      read.resolve({ contentsBase64: "bmV3", mimeType: "image/png" });
      await read.promise;
    });
    await waitFor(() =>
      expect(view.getByAltText("Chart").getAttribute("src")).toBe("data:image/png;base64,bmV3"),
    );
    expect(reads).toHaveBeenCalledTimes(1);
  });

  test("removes the audio options trigger when inline audio fails and has no source to copy", async () => {
    vi.stubGlobal(
      "URL",
      class extends URL {
        static createObjectURL = vi.fn(() => "blob:voice-memo");
        static revokeObjectURL = vi.fn();
      },
    );
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });
    const view = render(
      mediaTree(null, <ConversationMedia src="data:audio/mpeg;base64,YQ==" alt="Voice memo" />),
    );
    expect(view.getByRole("button", { name: "More options for Voice memo" })).toBeTruthy();
    await act(async () => {
      fireEvent.error(view.getByLabelText("Voice memo"));
      await Promise.resolve();
    });
    expect(view.queryByRole("button", { name: "More options for Voice memo" })).toBeNull();
    expect(view.getByText("Audio unavailable")).toBeTruthy();
  });

  test("retires same-URL audio and video decoders when their physical source authority changes", async () => {
    const client = createTestQueryClient();
    const tree = (generation: number) =>
      mediaTree(
        conversationImageScope(
          {
            ...markdownSource,
            hostId: "local",
            nativeConnection: { sourceEpoch: "epoch", transportKind: "stdio", generation },
          },
          {},
        ),
        <>
          <ConversationMedia src="/local/song.mp3" alt="Song" />
          <ConversationMedia src="/local/clip.mp4" alt="Clip" />
        </>,
        client,
      );
    const view = render(tree(1));
    const audio = view.getByLabelText("Song");
    await waitFor(() => expect(view.getByLabelText("Clip").tagName).toBe("VIDEO"));
    const video = view.getByLabelText("Clip");
    const audioUrl = audio.getAttribute("src");
    const videoUrl = video.getAttribute("src");
    view.rerender(tree(2));
    expect(audio.getAttribute("src")).toBeNull();
    expect(video.getAttribute("src")).toBeNull();
    expect(view.getByLabelText("Song")).not.toBe(audio);
    expect(view.getByLabelText("Clip")).not.toBe(video);
    expect(view.getByLabelText("Song").getAttribute("src")).toBe(audioUrl);
    expect(view.getByLabelText("Clip").getAttribute("src")).toBe(videoUrl);
    expect(reads).not.toHaveBeenCalled();
    // The replacement player's controls measure themselves after mount.
    await act(async () => {
      await Promise.resolve();
    });
  });

  test("never reads authored foreign capabilities or silently substitutes a local host", async () => {
    const view = render(
      mediaTree(
        scope,
        <>
          <ConversationMedia src="file://server/share/a.png" />
          <ConversationMedia src="app://fs/@fs/a.png" />
          <ConversationMedia src="./a.png" />
        </>,
      ),
    );
    await settleAsyncRender();
    expect(view.getAllByRole("status")).toHaveLength(3);
    expect(view.container.querySelector("img")).toBeNull();
    expect(reads).not.toHaveBeenCalled();
  });

  test("does not save an HTTP image whose source retired during its native read", async () => {
    let current = true;
    const result = deferred<{ contentsBase64: string; mimeType: string }>();
    nativeReads.mockReturnValueOnce(result.promise);
    const save = vi.spyOn(resolvedImageAsset, "downloadImageDataUrl").mockResolvedValue(undefined);
    const view = render(
      mediaTree(
        { ...scope, isCurrent: () => current },
        <ConversationMedia src="https://example.test/one.png" alt="One" />,
      ),
    );
    await loaded(await view.findByAltText("One"));
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Download image" }));
      await Promise.resolve();
    });
    expect(nativeReads).toHaveBeenCalledExactlyOnceWith({ url: "https://example.test/one.png" });
    current = false;
    await act(async () => {
      result.resolve({ contentsBase64: "aW1hZ2U=", mimeType: "image/png" });
      await result.promise;
    });
    expect(save).not.toHaveBeenCalled();
    view.unmount();
  });

  test("keeps mixed media outside phrasing-only paragraphs without widening inline images", async () => {
    const errors = vi.spyOn(console, "error");
    const image = "data:image/png;base64,AA==";
    const source = [
      "Ordinary paragraph.",
      `![Wide image](${image})`,
      `![First image](${image}) ![Second image](${image})`,
      `Inline **before** ![Mixed clip](data:video/webm;base64,AA==) *after*.`,
      "**Bold before *Italic before ![Formatted clip](data:video/webm;base64,AA==) Italic after* Bold after**",
      "[Link before ![Linked clip](data:video/webm;base64,AA==) Link after](https://example.test/review)",
      "**![HTTP image](https://example.test/clip.webm)**",
      `Inline image ![Inline image](${image}) stays beside its text.`,
    ].join("\n\n");
    const view = render(
      mediaTree(
        null,
        <ConversationTokenRenderer
          source={source}
          streaming={false}
          animate={false}
          adaptive={false}
          components={{ ...streamdownComponents, ...conversationMediaComponents }}
        />,
      ),
    );
    await waitFor(() => expect(view.getByLabelText("Mixed clip").tagName).toBe("VIDEO"));
    const video = view.getByLabelText("Mixed clip");
    expect(video.closest("p")).toBeNull();
    expect(view.container.querySelector("p div, span > [data-slot='slider']")).toBeNull();
    expect(view.getByText("Ordinary paragraph.").tagName).toBe("P");
    expect(
      view.getByText("before").compareDocumentPosition(video) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      video.compareDocumentPosition(view.getByText("after")) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(view.getByAltText("Wide image").closest("[data-wide-markdown-block]")).not.toBeNull();
    const gallery = view.getByAltText("First image").closest("[data-markdown-image-grid]");
    expect(gallery).not.toBeNull();
    expect(view.getByAltText("Second image").closest("[data-markdown-image-grid]")).toBe(gallery);
    expect(view.getByAltText("Inline image").closest("[data-wide-markdown-block]")).toBeNull();
    expect(view.getByAltText("Inline image").closest("[data-markdown-image-grid]")).toBeNull();
    for (const label of ["Formatted clip", "Linked clip"]) {
      await waitFor(() => expect(view.getByLabelText(label).tagName).toBe("VIDEO"));
      expect(view.getByLabelText(label).closest("p, strong, em, del, a")).toBeNull();
    }
    expect(view.getByText("Bold before").closest("strong")).not.toBeNull();
    expect(view.getByText("Bold after").closest("strong")).not.toBeNull();
    expect(view.getByText("Italic before").closest("em")).not.toBeNull();
    expect(view.getByText("Italic after").closest("em")).not.toBeNull();
    expect(view.getByRole("link", { name: "Link before" }).getAttribute("href")).toBe(
      "https://example.test/review",
    );
    expect(view.getByRole("link", { name: "Link after" }).getAttribute("href")).toBe(
      "https://example.test/review",
    );
    expect(view.getByAltText("HTTP image").closest("strong")).not.toBeNull();
    expect(
      errors.mock.calls.filter((args) =>
        /cannot.*(?:descendant|nested|contain)|hydration error|validateDOMNesting/iu.test(
          args.map(String).join(" "),
        ),
      ),
    ).toEqual([]);
  });

  test("fences the selected image's late download after gallery navigation and removal, even while its original trigger stays resident", async () => {
    const download = vi
      .spyOn(resolvedImageAsset, "downloadImageDataUrl")
      .mockResolvedValue(undefined);
    const release = registerUserAttachmentImagePreviewOpener(async () => false);
    const client = createTestQueryClient();
    const tree = (second: boolean) =>
      mediaTree(
        scope,
        <>
          <ConversationMedia src="/remote/one.png" alt="One" />
          {second ? <ConversationMedia src="/remote/two.png" alt="Two" /> : null}
        </>,
        client,
      );
    const view = render(tree(true));
    try {
      await loaded(await view.findByAltText("One"));
      await loaded(await view.findByAltText("Two"));
      await act(async () => {
        fireEvent.click(view.getByRole("button", { name: "One" }));
        await Promise.resolve();
      });
      const dialog = await view.findByRole("dialog");
      await act(async () => {
        fireEvent.click(within(dialog).getByRole("button", { name: "Next image" }));
        await Promise.resolve();
      });
      expect(within(dialog).getByAltText("Two")).toBeTruthy();
      await act(async () => {
        fireEvent.click(within(dialog).getByRole("button", { name: "Download image" }));
        flushSync(() => view.rerender(tree(false)));
        await Promise.resolve();
      });
      await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
      expect(view.getByRole("button", { name: "One" }).isConnected).toBe(true);
      expect(download).not.toHaveBeenCalled();
    } finally {
      view.unmount();
      release();
    }
  });
});
