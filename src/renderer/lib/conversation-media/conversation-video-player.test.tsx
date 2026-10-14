import { afterEach, expect, test, vi } from "vite-plus/test";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { attachMediaDataSource } from "./conversation-media-playback";
import {
  ConversationVideoPlayer,
  type ConversationVideoPlayerProps,
} from "./conversation-video-player";

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

test("does not admit a retired stream decoder when a pending player module settles without a parent rerender", async () => {
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
  const { createLazyConversationVideoPlayer } = await import("./conversation-video-lazy");
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
