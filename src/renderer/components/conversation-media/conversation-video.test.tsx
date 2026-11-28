import { describe, afterEach, expect, test, vi } from "vite-plus/test";
import { act, cleanup, render, waitFor, fireEvent } from "@testing-library/react";
import { StrictMode, Suspense, useEffect } from "react";
import { createLazyConversationVideoPlayer } from "@/components/conversation-media/conversation-video-lazy";
import {
  type ConversationVideoPlayerProps,
  ConversationVideoPlayer,
} from "@/components/conversation-media/conversation-video-player";
import { TestQueryProvider } from "@/test/query";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import {
  ConversationMedia,
  ConversationMediaProvider,
} from "@/components/conversation-media/conversation-media";
import { THIS_COMPUTER_IMAGE_SCOPE, type ContentImageScope } from "@/lib/content-image";
import { openNodexMenu } from "@/test/dom";
import {
  attachMediaDataSource,
  claimMediaPlayback,
  releaseMediaPlayback,
} from "@/components/conversation-media/conversation-media-playback";

describe("conversation video lazy", () => {
  const source: ContentImageScope = {
    ...THIS_COMPUTER_IMAGE_SCOPE,
    hostId: "local",
    conversationId: "thread",
    sourceIdentity: "clip-item",
    authority: {},
    isCurrent: () => true,
    isResourceCurrent: () => true,
  };
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("shows the local loading fallback before a cold player module mounts the admitted video", async () => {
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
    const tree = (
      <TestQueryProvider>
        <NodexTooltipProvider>
          <ConversationMediaProvider source={source}>
            <ConversationMedia src="/media/clip.webm" alt="Clip" />
          </ConversationMediaProvider>
        </NodexTooltipProvider>
      </TestQueryProvider>
    );
    const view = render(tree);
    expect(view.container.querySelector("video")).toBeNull();
    expect(view.getByRole("button", { name: "Clip" }).hasAttribute("disabled")).toBe(true);
    // A cold module load can take longer than the default wait on a loaded machine.
    await waitFor(() => expect(view.getByLabelText("Clip").tagName).toBe("VIDEO"));
    const player = view.getByLabelText("Clip");
    expect(player.getAttribute("src")).toBe("app://fs/@fs/media/clip.webm");
    await act(async () => {
      view.unmount();
      await Promise.resolve();
    });
    expect(player.getAttribute("src")).toBeNull();
    const warm = render(tree);
    expect(warm.container.querySelector("video")?.getAttribute("src")).toBe(
      "app://fs/@fs/media/clip.webm",
    );
    // The warm player's controls measure themselves after mount.
    await act(async () => {
      await Promise.resolve();
    });
    warm.unmount();
  });

  function playerProps(alt = "Clip"): ConversationVideoPlayerProps {
    return {
      resource: {
        identity: alt,
        url: `app://fs/@fs/${alt}.webm`,
        isCurrent: () => true,
        canMount: () => true,
      },
      alt,
      onSaveCopy: async () => undefined,
      downloadPending: false,
      downloadFailed: false,
      loadErrorFallback: <button disabled>{alt} unavailable</button>,
    };
  }
  function LoadedPlayer({ alt, resource }: ConversationVideoPlayerProps) {
    return <video aria-label={alt} src={resource.url ?? undefined} />;
  }

  test("shares a cold load between consumers and retries its first failure only after two hundred milliseconds", async () => {
    vi.useFakeTimers();
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("Temporary module failure"))
      .mockResolvedValue({ ConversationVideoPlayer: LoadedPlayer });
    const LazyPlayer = createLazyConversationVideoPlayer(load);
    const view = render(
      <StrictMode>
        <Suspense fallback={<span role="status">Loading video</span>}>
          <LazyPlayer {...playerProps("One")} />
          <LazyPlayer {...playerProps("Two")} />
        </Suspense>
      </StrictMode>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(load).toHaveBeenCalledTimes(1);
    expect(view.getByRole("status").textContent).toBe("Loading video");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(199);
    });
    expect(load).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(load).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(view.getByLabelText("One").getAttribute("src")).toBe("app://fs/@fs/One.webm");
    expect(view.getByLabelText("Two").getAttribute("src")).toBe("app://fs/@fs/Two.webm");
  });

  test("contains a second module failure inside the media fallback and uses current props without another code retry", async () => {
    vi.useFakeTimers();
    const failure = new Error("Player module unavailable");
    const report = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const load = vi.fn().mockRejectedValue(failure);
    const LazyPlayer = createLazyConversationVideoPlayer(load);
    const tree = (alt: string) => (
      <div>
        <p>Resident answer</p>
        <Suspense fallback={<span>Loading video</span>}>
          <LazyPlayer {...playerProps(alt)} />
        </Suspense>
      </div>
    );
    const view = render(tree("One"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(view.getByRole("button", { name: "One unavailable" }).hasAttribute("disabled")).toBe(
      true,
    );
    expect(view.getByText("Resident answer")).toBeTruthy();
    expect(report).toHaveBeenCalledExactlyOnceWith("Unable to load video player", failure);
    view.rerender(tree("Two"));
    expect(view.getByRole("button", { name: "Two unavailable" })).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(load).toHaveBeenCalledTimes(2);
  });

  test("a late shared module mounts only the current consumer after the old one retired", async () => {
    let resolve!: (module: { ConversationVideoPlayer: typeof LoadedPlayer }) => void;
    const pending = new Promise<{ ConversationVideoPlayer: typeof LoadedPlayer }>((done) => {
      resolve = done;
    });
    const mounts = vi.fn();
    function ObservedPlayer(props: ConversationVideoPlayerProps) {
      useEffect(() => {
        mounts(props.resource.identity);
      }, [props.resource.identity]);
      return <LoadedPlayer {...props} />;
    }
    const load = vi.fn(() => pending);
    const LazyPlayer = createLazyConversationVideoPlayer(load);
    const tree = (alt: string) => (
      <Suspense fallback={null}>
        <LazyPlayer {...playerProps(alt)} />
      </Suspense>
    );
    const old = render(tree("Old"));
    old.unmount();
    const current = render(tree("Current"));
    await act(async () => {
      resolve({ ConversationVideoPlayer: ObservedPlayer });
      await pending;
    });
    expect(load).toHaveBeenCalledTimes(1);
    expect(mounts).toHaveBeenCalledExactlyOnceWith("Current");
    expect(old.container.querySelector("video")).toBeNull();
    expect(current.getByLabelText("Current").getAttribute("src")).toBe("app://fs/@fs/Current.webm");
  });
});

describe("conversation video player", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  function readBlob(blob: Blob): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener("load", () => resolve(reader.result as ArrayBuffer), { once: true });
      reader.addEventListener("error", () => reject(reader.error), { once: true });
      reader.readAsArrayBuffer(blob);
    });
  }

  test("lets one conversation player sound at a time", () => {
    const player = (tag: "audio" | "video") => {
      const element = document.createElement(tag);
      let paused = true;
      Object.defineProperty(element, "paused", { get: () => paused });
      const pause = vi.spyOn(element, "pause").mockImplementation(() => {
        paused = true;
      });
      const start = () => {
        paused = false;
        claimMediaPlayback(element);
      };
      return { element, pause, start };
    };
    const voice = player("audio");
    const clip = player("video");
    voice.start();
    clip.start();
    expect(voice.pause).toHaveBeenCalledOnce();
    expect(clip.element.paused).toBe(false);
    // Resuming the sounding player, or one that already retired, leaves the other alone.
    clip.start();
    releaseMediaPlayback(clip.element);
    voice.start();
    expect(clip.pause).not.toHaveBeenCalled();
    releaseMediaPlayback(voice.element);
  });

  test("gives a data video a decoder-owned Blob URL with exact bytes and fragment, and releases only its own src", async () => {
    const blobs: Blob[] = [];
    const create = vi.fn((blob: Blob) => {
      blobs.push(blob);
      return `blob:video-${blobs.length}`;
    });
    const revoke = vi.fn();
    vi.stubGlobal(
      "URL",
      class extends URL {
        static createObjectURL = create;
        static revokeObjectURL = revoke;
      },
    );
    const element = document.createElement("video");
    const load = vi.spyOn(element, "load").mockImplementation(() => undefined);
    const old = attachMediaDataSource(element, "data:VIDEO/WEBM;base64,AQI%3D#t=1.5");
    expect(element.getAttribute("src")).toBe("blob:video-1#t=1.5");
    expect(blobs[0]!.type).toBe("video/webm");
    expect([...new Uint8Array(await readBlob(blobs[0]!))]).toEqual([1, 2]);
    const current = attachMediaDataSource(element, "data:video/webm,A%20%E4%B8%AD#t=2");
    expect([...new Uint8Array(await readBlob(blobs[1]!))]).toEqual([
      ...new TextEncoder().encode("A 中"),
    ]);
    old();
    expect(element.getAttribute("src")).toBe("blob:video-2#t=2");
    expect(load).not.toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:video-1");
    current();
    expect(element.getAttribute("src")).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
    expect(revoke.mock.calls.map(([url]) => url)).toEqual(["blob:video-1", "blob:video-2"]);
  });

  test("retains its decoder and owned source through terminal props, then releases both on consumer retirement", async () => {
    const revoke = vi.fn();
    const create = vi.fn(() => "blob:owned-video");
    vi.stubGlobal(
      "URL",
      class extends URL {
        static createObjectURL = create;
        static revokeObjectURL = revoke;
      },
    );
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    const load = vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
    let current = true;
    const props: ConversationVideoPlayerProps = {
      resource: {
        identity: "source-one",
        url: "data:video/webm;base64,AQI=",
        isCurrent: () => current,
        canMount: () => current,
      },
      alt: "Clip",
      onSaveCopy: async () => undefined,
      downloadPending: false,
      downloadFailed: false,
      loadErrorFallback: <button disabled>Video unavailable</button>,
    };
    const tree = (title: string) => (
      <NodexTooltipProvider>
        <ConversationVideoPlayer {...props} title={title} />
      </NodexTooltipProvider>
    );
    const view = render(tree("Streaming"));
    const video = view.getByLabelText("Clip");
    await waitFor(() => expect(video.getAttribute("src")).toBe("blob:owned-video"));
    await act(async () => {
      video.focus();
    });
    view.rerender(tree("Completed"));
    expect(view.getByLabelText("Clip")).toBe(video);
    expect(document.activeElement).toBe(video);
    expect(create).toHaveBeenCalledTimes(1);
    expect(revoke).not.toHaveBeenCalled();
    current = false;
    view.unmount();
    expect(pause).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(1);
    expect(video.getAttribute("src")).toBeNull();
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:owned-video");
  });

  test("decodes the common base64 source without a second full UTF-8 encoding pass", async () => {
    const blobs: Blob[] = [];
    vi.stubGlobal(
      "URL",
      class extends URL {
        static createObjectURL(blob: Blob) {
          blobs.push(blob);
          return "blob:base64-video";
        }
        static revokeObjectURL = vi.fn();
      },
    );
    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    const video = document.createElement("video");
    vi.spyOn(video, "load").mockImplementation(() => undefined);
    const release = attachMediaDataSource(video, "data:video/webm;base64,AQI=");
    expect(encode).not.toHaveBeenCalled();
    expect([...new Uint8Array(await readBlob(blobs[0]!))]).toEqual([1, 2]);
    release();
  });

  test("contains malformed data-source setup inside the current player's unavailable fallback", async () => {
    const create = vi.fn();
    vi.stubGlobal(
      "URL",
      class extends URL {
        static createObjectURL = create;
        static revokeObjectURL = vi.fn();
      },
    );
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
    const view = render(
      <NodexTooltipProvider>
        <p>Resident answer</p>
        <ConversationVideoPlayer
          resource={{
            identity: "bad-video",
            url: "data:video/webm;base64,%%%",
            isCurrent: () => true,
            canMount: () => true,
          }}
          alt="Bad video"
          onSaveCopy={async () => undefined}
          downloadPending={false}
          downloadFailed={false}
          loadErrorFallback={<button disabled>Video unavailable</button>}
        />
      </NodexTooltipProvider>,
    );
    await view.findByRole("button", { name: "Video unavailable" });
    expect(view.queryByLabelText("Bad video")).toBeNull();
    expect(view.getByText("Resident answer")).toBeTruthy();
    expect(create).not.toHaveBeenCalled();
  });

  test.each(["Video options", "Video volume"] as const)(
    "dismisses %s before exiting fullscreen",
    async (control) => {
      vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
      vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
      const view = render(
        <NodexTooltipProvider>
          <ConversationVideoPlayer
            resource={{ identity: "clip", url: null, isCurrent: () => true, canMount: () => true }}
            alt="Clip"
            onSaveCopy={async () => undefined}
            downloadPending={false}
            downloadFailed={false}
            loadErrorFallback={null}
          />
        </NodexTooltipProvider>,
      );
      const video = view.getByLabelText("Clip");
      const player = video.parentElement;
      let fullscreenElement = player;
      const exitFullscreen = vi.fn(async () => {
        fullscreenElement = null;
        document.dispatchEvent(new Event("fullscreenchange"));
      });
      Object.defineProperties(document, {
        fullscreenElement: { configurable: true, get: () => fullscreenElement },
        exitFullscreen: { configurable: true, value: exitFullscreen },
      });
      try {
        await act(async () => {
          document.dispatchEvent(new Event("fullscreenchange"));
          await Promise.resolve();
        });

        const trigger = view.getByRole("button", { name: control });
        await openNodexMenu(trigger);
        const popupControl =
          control === "Video options"
            ? await view.findByRole("menuitem", { name: "Save a copy" })
            : await view.findByRole("button", { name: "Mute video" });
        expect(player?.contains(popupControl)).toBe(true);
        await act(async () => {
          // The volume popover is nonmodal. Its document listener also owns Escape
          // when the key originates elsewhere in the player.
          fireEvent.keyDown(control === "Video options" ? popupControl : video, { key: "Escape" });
          await Promise.resolve();
        });
        await waitFor(() => expect(trigger.getAttribute("aria-expanded")).toBe("false"));
        expect(document.fullscreenElement).toBe(player);

        await act(async () => {
          fireEvent.keyDown(video, { key: "Escape" });
          await Promise.resolve();
        });
        expect(document.fullscreenElement).toBeNull();
      } finally {
        Reflect.deleteProperty(document, "fullscreenElement");
        Reflect.deleteProperty(document, "exitFullscreen");
      }
    },
  );

  test("does not admit a retired stream decoder when a pending player module settles without a parent rerender", async () => {
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
    const { createLazyConversationVideoPlayer } =
      await import("@/components/conversation-media/conversation-video-lazy");
    const { Suspense } = await import("react");
    let finish!: (value: { ConversationVideoPlayer: typeof ConversationVideoPlayer }) => void;
    const pending = new Promise<{ ConversationVideoPlayer: typeof ConversationVideoPlayer }>(
      (resolve) => {
        finish = resolve;
      },
    );
    const LazyPlayer = createLazyConversationVideoPlayer(() => pending);
    let current = true;
    const resource = {
      identity: "retiring-stream",
      url: "app://fs/@fs/retiring.webm",
      isCurrent: () => current,
      canMount: () => current,
    };
    const view = render(
      <NodexTooltipProvider>
        <Suspense fallback={<span role="status">Loading player</span>}>
          <LazyPlayer
            resource={resource}
            alt="Retiring video"
            onSaveCopy={async () => undefined}
            downloadPending={false}
            downloadFailed={false}
            loadErrorFallback={null}
          />
        </Suspense>
      </NodexTooltipProvider>,
    );
    expect(view.getByRole("status")).toBeTruthy();
    current = false;
    await act(async () => {
      finish({ ConversationVideoPlayer });
      await pending;
    });
    await waitFor(() => expect(view.queryByRole("status")).toBeNull());
    expect(view.container.querySelector("video")).toBeNull();
  });
});
