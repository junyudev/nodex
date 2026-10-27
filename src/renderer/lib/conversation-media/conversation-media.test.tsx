import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { flushSync } from "react-dom";
import { TestQueryProvider, createTestQueryClient } from "@/test/query";
import { installWindowApi } from "@/test/browser-globals";
import { settleAsyncRender } from "@/test/dom";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { registerUserAttachmentImagePreviewOpener } from "../../features/user-attachment-image-editor/adapters/image-preview-opener-registry";
import { normalizeUserAttachmentImageEditorOptions } from "../../features/user-attachment-image-editor/model/feature-policy";
import type { OpenUserAttachmentImagePreviewOptions } from "../../features/user-attachment-image-editor/model/types";
import * as resolvedImageAsset from "../../features/user-attachment-image-editor/adapters/resolved-image-asset";
import {
  ConversationMedia,
  ConversationMediaParagraph,
  ConversationMediaProvider,
  conversationMediaComponents,
} from "./conversation-media";
import type { ConversationMediaSource } from "./conversation-media-model";
import { ConversationTokenRenderer } from "../markdown/conversation-token-renderer";
import { streamdownComponents } from "../streamdown";

const reads = vi.fn();
const scope: ConversationMediaSource = {
  hostId: "remote-one",
  threadId: "thread",
  sourceIdentity: "thread:item-one",
  authority: {},
  nativeConnection: { sourceEpoch: "epoch", generation: 1 },
  isCurrent: () => true,
  isResourceCurrent: () => true,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function mediaTree(
  source: ConversationMediaSource | null,
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
    await import("./conversation-video-player");
  });
  beforeEach(() => {
    reads.mockReset().mockResolvedValue({ contentsBase64: "aW1hZ2U=", mimeType: "image/png" });
    installWindowApi({
      invoke: async (channel: string, ...args: unknown[]) => {
        if (channel === "read-file-binary") return reads(...args);
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

  test("opens the loaded image's context menu without opening its preview", async () => {
    const open = vi.fn(async () => true);
    const release = registerUserAttachmentImagePreviewOpener(open);
    try {
      const view = render(
        mediaTree(scope, <ConversationMedia src="/remote/chart.png" alt="Chart menu" />),
      );
      const image = await view.findByAltText("Chart menu");
      await loaded(image);
      await act(async () => {
        fireEvent.contextMenu(image, { clientX: 40, clientY: 40 });
        await Promise.resolve();
      });
      expect(await view.findByRole("menuitem", { name: "Open image in new tab" })).toBeTruthy();
      expect(view.getByRole("menuitem", { name: "Download a copy" })).toBeTruthy();
      expect(view.queryByRole("menuitem", { name: "Open in file manager" })).toBeNull();
      expect(open).not.toHaveBeenCalled();
      await act(async () => {
        fireEvent.click(view.getByRole("menuitem", { name: "Open image in new tab" }));
        await Promise.resolve();
      });
      await waitFor(() =>
        expect(open).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            readOnly: true,
            openInEditor: true,
            attachmentSrc: "nodex://assets/context-image",
            src: "nodex://assets/context-image",
          }),
        ),
      );
    } finally {
      release();
    }
  });

  test("uses local Range playback without binary reading and does not reclassify an HTTP extension", async () => {
    const view = render(
      mediaTree(
        { ...scope, hostId: "local" },
        <>
          <ConversationMedia src="/local/song.mp3" alt="Song" />
          <ConversationMedia src="https://example.com/song.mp3" alt="HTTP image" />
        </>,
      ),
    );
    expect(view.getByLabelText("Song").tagName).toBe("AUDIO");
    expect(view.getByLabelText("Song").getAttribute("src")).toBe("app://fs/@fs/local/song.mp3");
    expect(view.getByAltText("HTTP image").getAttribute("src")).toBe(
      "https://example.com/song.mp3",
    );
    expect(reads).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.error(view.getByLabelText("Song"));
      await Promise.resolve();
    });
    expect(view.queryByLabelText("Song")).toBeNull();
    expect(view.getByRole("status").textContent).toBe("Audio unavailable");
    view.unmount();
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
    expect(HTMLMediaElement.prototype.load).toHaveBeenCalled();
  });

  test("reads the captured host, shares the QueryClient entry, and keeps its fifteen second inactive image lifetime", async () => {
    const client = createTestQueryClient();
    const tree = (visible: boolean) =>
      mediaTree(
        scope,
        visible ? <ConversationMedia src="/remote/chart.png" alt="Chart" /> : null,
        client,
      );
    const view = render(tree(true));
    await waitFor(() =>
      expect(view.getByAltText("Chart").getAttribute("src")).toBe("data:image/png;base64,aW1hZ2U="),
    );
    expect(reads).toHaveBeenCalledExactlyOnceWith({
      hostId: "remote-one",
      path: "/remote/chart.png",
    });
    expect(client.getQueryCache().getAll()[0]?.gcTime).toBe(15_000);
    view.rerender(tree(false));
    view.rerender(tree(true));
    await waitFor(() => expect(view.getByAltText("Chart")).toBeTruthy());
    expect(reads).toHaveBeenCalledTimes(1);
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
        {
          ...scope,
          hostId: "remote-two",
          nativeConnection: { sourceEpoch: "epoch", generation: 2 },
        },
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
        { ...scope, nativeConnection: { sourceEpoch: "epoch", generation: 3 } },
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

  test("does not create unused file queries for public URLs and priority badges", () => {
    const client = createTestQueryClient();
    render(
      mediaTree(
        null,
        <>
          <ConversationMedia src="https://a/x.png" />
          <ConversationMedia src="https://img.shields.io/badge/P1-review-blue" />
        </>,
        client,
      ),
    );
    expect(client.getQueryCache().getAll()).toHaveLength(0);
    expect(reads).not.toHaveBeenCalled();
  });

  test("retires same-URL audio and video decoders when their physical source authority changes", async () => {
    const client = createTestQueryClient();
    const tree = (generation: number) =>
      mediaTree(
        { ...scope, hostId: "local", nativeConnection: { sourceEpoch: "epoch", generation } },
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

  test("the audio controls consume real native duration, play/pause and seek events", async () => {
    const view = render(
      mediaTree(
        { ...scope, hostId: "local" },
        <ConversationMedia src="/local/song.mp3" alt="Song" />,
      ),
    );
    const audio = view.getByLabelText("Song") as HTMLAudioElement;
    Object.defineProperty(audio, "duration", { configurable: true, value: 140.3 });
    await act(async () => {
      fireEvent.durationChange(audio);
      fireEvent.play(audio);
      await Promise.resolve();
    });
    expect(view.getByRole("button", { name: "Pause song.mp3" })).toBeTruthy();
    const seek = view.getByRole("slider", { name: "Seek in song.mp3" }) as HTMLInputElement;
    expect(seek.disabled).toBe(false);
    await act(async () => {
      fireEvent.change(seek, { target: { value: "61.5" } });
      await Promise.resolve();
    });
    expect(audio.currentTime).toBe(61.5);
    expect(view.getByText("1:01 / 2:20")).toBeTruthy();
    await act(async () => {
      fireEvent.pause(audio);
      await Promise.resolve();
    });
    expect(view.getByRole("button", { name: "Play song.mp3" })).toBeTruthy();
  });

  test("video controls consume native seek/volume/rate and ignore repeated activation keys", async () => {
    // Inset slider thumbs stay hidden until measured, and jsdom has no layout to measure, so
    // their range inputs are found by label rather than by accessible role.
    const slider = (name: string) => [name, { selector: "input[type=range]" }] as const;
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    const view = render(
      mediaTree(
        { ...scope, hostId: "local" },
        <ConversationMedia src="/local/clip.mp4" alt="Clip" />,
      ),
    );
    await waitFor(() => expect(view.getByLabelText("Clip").tagName).toBe("VIDEO"));
    const video = view.getByLabelText("Clip") as HTMLVideoElement;
    Object.defineProperty(video, "duration", { configurable: true, value: 125 });
    await act(async () => {
      fireEvent.durationChange(video);
      fireEvent.play(video);
      await Promise.resolve();
    });
    expect(view.getByRole("button", { name: "Pause video" })).toBeTruthy();
    await act(async () => {
      fireEvent.change(view.getByLabelText(...slider("Seek in video")), {
        target: { value: "62.5" },
      });
      await Promise.resolve();
    });
    expect(video.currentTime).toBe(62.5);
    expect(view.queryByLabelText(...slider("Video volume"))).toBeNull();
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Video volume" }));
      await Promise.resolve();
    });
    await view.findByLabelText(...slider("Video volume"));
    await act(async () => {
      fireEvent.change(view.getByLabelText(...slider("Video volume")), {
        target: { value: "0.25" },
      });
      fireEvent.volumeChange(video);
      await Promise.resolve();
    });
    expect(video.volume).toBe(0.25);
    expect(video.muted).toBe(false);
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Mute video" }));
      fireEvent.volumeChange(video);
      await Promise.resolve();
    });
    expect(video.muted).toBe(true);
    expect(view.getByRole("button", { name: "Unmute video" })).toBeTruthy();
    await act(async () => {
      fireEvent.keyDown(view.getByLabelText(...slider("Video volume")), { key: "Escape" });
      await Promise.resolve();
    });
    await waitFor(() => expect(view.queryByLabelText(...slider("Video volume"))).toBeNull());
    await act(async () => {
      fireEvent.keyDown(video, { key: " ", repeat: true });
      await Promise.resolve();
    });
    expect(play).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.keyDown(video, { key: "Enter", repeat: false });
      await Promise.resolve();
    });
    expect(play).toHaveBeenCalledTimes(1);
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Video options" }));
      await Promise.resolve();
    });
    const speed = await view.findByRole("menuitemradio", { name: "1.5×" });
    await act(async () => {
      fireEvent.click(speed);
      fireEvent.rateChange(video);
      await Promise.resolve();
    });
    expect(video.playbackRate).toBe(1.5);
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

  test("uses the actual mounted image collection for preview, excludes retired leaves, and preserves the selected image", async () => {
    const open = vi.fn(async (_options: OpenUserAttachmentImagePreviewOptions) => true);
    const release = registerUserAttachmentImagePreviewOpener(open);
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
      const one = await view.findByAltText("One");
      const two = await view.findByAltText("Two");
      await loaded(one);
      await loaded(two);
      await act(async () => {
        fireEvent.click(view.getByRole("button", { name: "Two" }));
        await Promise.resolve();
      });
      const options = normalizeUserAttachmentImageEditorOptions(open.mock.calls[0]![0]);
      expect(options.images.map((image) => image.alt)).toEqual(["One", "Two"]);
      expect(options.images.find((image) => image.id === options.initialImageId)?.alt).toBe("Two");
      expect(options.generatedImages).toBeNull();
      expect(options.threadId).toBe("thread");
      expect(options.images.every((image) => image.hostId === "remote-one")).toBe(true);
      view.rerender(tree(false));
      await act(async () => {
        fireEvent.click(view.getByRole("button", { name: "One" }));
        await Promise.resolve();
      });
      expect(open.mock.calls[1]![0].images).toHaveLength(1);
      expect(open.mock.calls[1]![0].images?.[0]?.alt).toBe("One");
    } finally {
      view.unmount();
      release();
    }
  });

  test("does not fetch or download after source retirement, including an in-flight user download", async () => {
    let current = true;
    const fetchResult = deferred<Response>();
    const fetchSource = vi.spyOn(globalThis, "fetch").mockReturnValue(fetchResult.promise);
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    const view = render(
      mediaTree(
        { ...scope, isCurrent: () => current },
        <ConversationMedia src="/remote/one.png" alt="One" />,
      ),
    );
    await loaded(await view.findByAltText("One"));
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Download image" }));
      await Promise.resolve();
    });
    expect(fetchSource).toHaveBeenCalledTimes(1);
    current = false;
    await act(async () => {
      fetchResult.resolve(new Response("image", { status: 200 }));
      await fetchResult.promise;
    });
    expect(click).not.toHaveBeenCalled();
    view.unmount();
  });

  test("does not materialize a download body whose source retired while the blob was being read", async () => {
    let current = true;
    const body = deferred<Blob>();
    const response = new Response("image", { status: 200 });
    const readBody = vi.spyOn(response, "blob").mockImplementation(() => body.promise);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
    const materialize = vi
      .spyOn(resolvedImageAsset, "blobToDataUrl")
      .mockResolvedValue("data:image/png;base64,aW1hZ2U=");
    const view = render(
      mediaTree(
        { ...scope, isCurrent: () => current },
        <ConversationMedia src="/remote/one.png" alt="One" />,
      ),
    );
    await loaded(await view.findByAltText("One"));
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Download image" }));
      await Promise.resolve();
    });
    await waitFor(() => expect(readBody).toHaveBeenCalledTimes(1));
    current = false;
    await act(async () => {
      body.resolve(new Blob(["image"], { type: "image/png" }));
      await body.promise;
    });
    expect(materialize).not.toHaveBeenCalled();
  });

  test("opens the actual dialog when the Workbench leaves preview ownership to the message, then navigates its mounted collection", async () => {
    const release = registerUserAttachmentImagePreviewOpener(async () => false);
    let current = true;
    const source = { ...scope, isCurrent: () => current };
    const client = createTestQueryClient();
    const tree = () =>
      mediaTree(
        source,
        <>
          <ConversationMedia src="/remote/one.png" alt="One" />
          <ConversationMedia src="/remote/two.png" alt="Two" />
        </>,
        client,
      );
    const view = render(tree());
    try {
      await loaded(await view.findByAltText("One"));
      await loaded(await view.findByAltText("Two"));
      const trigger = view.getByRole("button", { name: "Two" });
      await act(async () => {
        fireEvent.click(trigger);
        await Promise.resolve();
      });
      const dialog = await view.findByRole("dialog", { name: "Image preview" });
      expect(within(dialog).getByAltText("Two").getAttribute("src")).toBe(
        "data:image/png;base64,aW1hZ2U=",
      );
      await act(async () => {
        fireEvent.click(within(dialog).getByRole("button", { name: "Previous image" }));
        await Promise.resolve();
      });
      expect(within(dialog).getByAltText("One")).toBeTruthy();
      await act(async () => {
        fireEvent.click(within(dialog).getByRole("button", { name: "Next image" }));
        await Promise.resolve();
      });
      expect(within(dialog).getByAltText("Two")).toBeTruthy();
      await act(async () => {
        fireEvent.click(within(dialog).getByRole("button", { name: "Close image preview" }));
        await Promise.resolve();
      });
      await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(trigger));
      await act(async () => {
        fireEvent.click(trigger);
        await Promise.resolve();
      });
      await view.findByRole("dialog");
      current = false;
      view.rerender(tree());
      await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
      expect(reads).toHaveBeenCalledTimes(2);
    } finally {
      view.unmount();
      release();
    }
  });

  test("widens only the typed media-only paragraph and leaves single audio or mixed text narrow", () => {
    const view = render(
      mediaTree(
        null,
        <>
          <ConversationMediaParagraph
            mediaSources={["data:image/png;base64,AA==", "https://a/b.png"]}
          >
            grid
          </ConversationMediaParagraph>
          <ConversationMediaParagraph mediaSources={["data:image/png;base64,AA=="]}>
            single
          </ConversationMediaParagraph>
          <ConversationMediaParagraph mediaSources={["/a.wav"]}>audio</ConversationMediaParagraph>
          <ConversationMediaParagraph>text</ConversationMediaParagraph>
        </>,
      ),
    );
    expect(view.getByText("grid").dataset.markdownImageGrid).toBe("true");
    expect(view.getByText("single").dataset.wideMarkdownBlockKind).toBe("image");
    expect(view.getByText("audio").dataset.wideMarkdownBlock).toBeUndefined();
    expect(view.getByText("text").dataset.wideMarkdownBlock).toBeUndefined();
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
      .mockImplementation(() => undefined);
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
