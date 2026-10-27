import { afterEach, expect, test, vi } from "vite-plus/test";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { StrictMode, Suspense, useEffect } from "react";
import { createLazyConversationVideoPlayer } from "./conversation-video-lazy";
import type { ConversationVideoPlayerProps } from "./conversation-video-player";
import { TestQueryProvider } from "@/test/query";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { ConversationMedia, ConversationMediaProvider } from "./conversation-media";
import type { ConversationMediaSource } from "./conversation-media-model";

const source: ConversationMediaSource = {
  hostId: "local",
  threadId: "thread",
  sourceIdentity: "clip-item",
  authority: {},
  nativeConnection: { sourceEpoch: "epoch", generation: 1 },
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
  await waitFor(() => expect(view.getByLabelText("Clip").tagName).toBe("VIDEO"), {
    timeout: 5000,
  });
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
  expect(view.getByRole("button", { name: "One unavailable" }).hasAttribute("disabled")).toBe(true);
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
