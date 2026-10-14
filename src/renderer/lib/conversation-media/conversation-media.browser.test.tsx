import { act, fireEvent, render, waitFor, within } from "@testing-library/react";
import { expect, test, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import "../../globals.css";
import { ConversationTokenRenderer } from "../markdown/conversation-token-renderer";
import { streamdownComponents } from "../streamdown";
import { installWindowApi } from "@/test/browser-globals";
import { TestQueryProvider, createTestQueryClient } from "@/test/query";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { ConversationMediaProvider, conversationMediaComponents } from "./conversation-media";
import type { ConversationMediaSource } from "./conversation-media-model";
import { registerUserAttachmentImagePreviewOpener } from "@/features/user-attachment-image-editor/adapters/image-preview-opener-registry";
import type { OpenUserAttachmentImagePreviewOptions } from "@/features/user-attachment-image-editor/model/types";

const components = { ...streamdownComponents, ...conversationMediaComponents };
const source: ConversationMediaSource = {
  hostId: "remote-media",
  threadId: "thread",
  sourceIdentity: "item-one",
  authority: {},
  nativeConnection: { sourceEpoch: "epoch", generation: 1 },
  isCurrent: () => true,
  isResourceCurrent: () => true,
};
async function click(element: HTMLElement) {
  await act(async () => {
    await userEvent.click(element);
    await Promise.resolve();
  });
}
function base64(bytes: Uint8Array) {
  let raw = "";
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw);
}
function silentWav() {
  const bytes = new Uint8Array(44 + 8_000 * 2);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index++)
      bytes[offset + index] = value.charCodeAt(index);
  };
  text(0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8_000, true);
  view.setUint32(28, 16_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, bytes.length - 44, true);
  return base64(bytes);
}
async function canvasVideo(canvas: HTMLCanvasElement) {
  const stream = canvas.captureStream(30);
  const chunks: Blob[] = [];
  const recorder = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp8" });
  let frame = 0;
  const paint = canvas.getContext("2d")!;
  const frames = setInterval(() => {
    paint.fillStyle = frame++ % 2 ? "#334455" : "#445566";
    paint.fillRect(0, 0, canvas.width, canvas.height);
  }, 30);
  const stopped = new Promise<void>((resolve, reject) => {
    recorder.addEventListener("dataavailable", (event) => chunks.push(event.data));
    recorder.addEventListener("stop", () => resolve(), { once: true });
    recorder.addEventListener(
      "error",
      () => reject(new Error("Synthetic video recording failed")),
      { once: true },
    );
  });
  try {
    recorder.start();
    await new Promise((resolve) => setTimeout(resolve, 800));
    recorder.stop();
    await stopped;
    return base64(new Uint8Array(await new Blob(chunks).arrayBuffer()));
  } finally {
    clearInterval(frames);
    stream.getTracks().forEach((track) => track.stop());
  }
}

test("decodes captured file media, preserves grouped image identity through terminal text, and drives silent native audio/video", async () => {
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 400;
  const paint = canvas.getContext("2d");
  if (!paint) throw new Error("No synthetic canvas encoder");
  paint.fillStyle = "#334455";
  paint.fillRect(0, 0, 640, 400);
  const png = canvas.toDataURL("image/png").split(",")[1]!;
  const videoBytes = await canvasVideo(canvas);
  const reads: string[] = [];
  installWindowApi({
    invoke: async (channel: string, input: unknown) => {
      if (channel === "asset:image:save") return { source: "nodex://assets/browser-image-menu" };
      if (channel !== "read-file-binary") throw new Error(`Unexpected operation ${channel}`);
      const path = (input as { path: string }).path;
      reads.push(path);
      return path.endsWith(".wav")
        ? { contentsBase64: silentWav(), mimeType: "audio/wav" }
        : path.endsWith(".webm")
          ? { contentsBase64: videoBytes, mimeType: "video/webm" }
          : { contentsBase64: png, mimeType: "image/png" };
    },
  });
  const content =
    "![One](/media/one.png)\n\n![Two](/media/two.png)\n\n## Playback\n\n![Silent](/media/silent.wav)\n\n![Synthetic video](/media/clip.webm)";
  const revokeSource = vi.spyOn(URL, "revokeObjectURL");
  const client = createTestQueryClient();
  const tree = (streaming: boolean, value = content) => (
    <TestQueryProvider client={client}>
      <NodexTooltipProvider>
        <ConversationMediaProvider source={source}>
          <div style={{ width: 720 }}>
            <ConversationTokenRenderer
              source={value}
              sourceIdentity="item-one"
              streaming={streaming}
              animate={false}
              adaptive={false}
              components={components}
            />
          </div>
        </ConversationMediaProvider>
      </NodexTooltipProvider>
    </TestQueryProvider>
  );
  const view = render(tree(true));
  try {
    const image = (await view.findByAltText("One")) as HTMLImageElement;
    await waitFor(() => expect(image.naturalWidth).toBe(640));
    const two = (await view.findByAltText("Two")) as HTMLImageElement;
    await waitFor(() => expect(two.naturalWidth).toBe(640));
    await image.decode();
    expect(image.getBoundingClientRect().height).toBeLessThanOrEqual(160.5);
    expect(view.container.querySelectorAll('[data-markdown-image-grid="true"]')).toHaveLength(1);
    const streamingAudio = await view.findByLabelText("Silent");
    await waitFor(() => expect(view.getByLabelText("Synthetic video").tagName).toBe("VIDEO"));
    const streamingVideo = view.getByLabelText("Synthetic video");
    const button = view.getByRole("button", { name: "One" });
    await act(async () => {
      button.focus();
      await Promise.resolve();
    });
    view.rerender(tree(false, `${content}\n\nCompleted.`));
    expect(view.getByAltText("One")).toBe(image);
    const opened: OpenUserAttachmentImagePreviewOptions[] = [];
    const releaseOpener = registerUserAttachmentImagePreviewOpener(async (options) => {
      opened.push(options);
      return true;
    });
    try {
      await act(async () => {
        await userEvent.click(image, { button: "right" });
        await Promise.resolve();
      });
      const menuItem = await view.findByRole("menuitem", { name: "Open image in new tab" });
      expect(view.queryByRole("dialog")).toBeNull();
      expect(view.queryByRole("menuitem", { name: "Open in file manager" })).toBeNull();
      await click(menuItem);
      await waitFor(() => expect(opened).toHaveLength(1));
      expect(opened[0]).toMatchObject({
        readOnly: true,
        openInEditor: true,
        src: "nodex://assets/browser-image-menu",
        attachmentSrc: "nodex://assets/browser-image-menu",
      });
      expect(view.getByAltText("One")).toBe(image);
    } finally {
      releaseOpener();
    }
    expect(view.getByAltText("Two")).toBe(two);
    expect(document.activeElement).toBe(button);
    await click(button);
    const dialog = await view.findByRole("dialog", { name: "Image preview" });
    const previewImage = within(dialog).getByAltText("One") as HTMLImageElement;
    await act(async () => {
      await previewImage.decode();
      await Promise.resolve();
    });
    expect(previewImage.naturalWidth).toBe(640);
    await click(within(dialog).getByRole("button", { name: "Next image" }));
    expect(within(dialog).getByAltText("Two").getAttribute("src")).toBe(two.currentSrc);
    await click(within(dialog).getByRole("button", { name: "Close image preview" }));
    await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(button));
    expect(view.getByAltText("One")).toBe(image);
    const audio = view.getByLabelText("Silent") as HTMLAudioElement;
    expect(audio).toBe(streamingAudio);
    await waitFor(() => expect(audio.duration).toBeCloseTo(1));
    const seek = view.getByRole("slider", { name: "Seek in silent.wav" });
    await act(async () => {
      fireEvent.change(seek, { target: { value: "0.5" } });
      await Promise.resolve();
    });
    expect(audio.currentTime).toBeCloseTo(0.5);
    expect(audio.paused).toBe(true);
    const video = view.getByLabelText("Synthetic video") as HTMLVideoElement;
    expect(video).toBe(streamingVideo);
    await waitFor(() => expect(video.videoWidth).toBe(640));
    expect(video.videoHeight).toBe(400);
    expect(video.controls).toBe(false);
    const decodedVideoUrl = video.getAttribute("src");
    expect(decodedVideoUrl?.startsWith("blob:")).toBe(true);
    expect(video.currentSrc).toBe(decodedVideoUrl);
    await click(view.getByRole("button", { name: "Play video" }));
    await waitFor(() => expect(video.paused).toBe(false));
    await click(view.getByRole("button", { name: "Pause video" }));
    await waitFor(() => expect(video.paused).toBe(true));
    const player = video.parentElement;
    await click(view.getByRole("button", { name: "Fullscreen" }));
    await waitFor(() => expect(document.fullscreenElement).toBe(player));
    const bounds = player!.getBoundingClientRect();
    expect(bounds.left).toBeCloseTo(0);
    expect(bounds.top).toBeCloseTo(0);
    expect(bounds.width).toBeCloseTo(window.innerWidth);
    expect(bounds.height).toBeCloseTo(window.innerHeight);
    expect(view.getByLabelText("Synthetic video")).toBe(video);
    await click(await view.findByRole("button", { name: "Exit fullscreen" }));
    await waitFor(() => expect(document.fullscreenElement).toBeNull());
    expect(view.getByLabelText("Synthetic video")).toBe(video);
    expect(reads.sort()).toEqual([
      "/media/clip.webm",
      "/media/one.png",
      "/media/silent.wav",
      "/media/two.png",
    ]);
    view.unmount();
    expect(audio.getAttribute("src")).toBeNull();
    expect(video.getAttribute("src")).toBeNull();
    expect(video.paused).toBe(true);
    expect(revokeSource.mock.calls.filter(([url]) => url === decodedVideoUrl)).toHaveLength(1);
  } finally {
    view.unmount();
    vi.restoreAllMocks();
  }
});
