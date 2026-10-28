import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import {
  createConversationImageActions,
  conversationImageWebAddress,
} from "./conversation-image-actions";
import {
  captureComposerImageAttachmentTarget,
  registerComposerImageAttachmentTarget,
} from "../composer-image-attachment-channel";
import type { ResolvedComposerImageInput } from "@/features/local-conversation/view/composer/image-attachments/composer-image-attachment-model";

const ports = vi.hoisted(() => ({
  open: vi.fn(async (_options: unknown) => true),
  upload: vi.fn(async () => "nodex://assets/menu-image"),
  copyImage: vi.fn(async () => ({ ok: true })),
  copyText: vi.fn(async () => undefined),
  reveal: vi.fn(async () => true),
}));
vi.mock("../assets", () => ({ uploadImageAsset: ports.upload }));
vi.mock("../clipboard", () => ({
  writeImageToClipboard: ports.copyImage,
  writeTextToClipboardStrict: ports.copyText,
}));
vi.mock("../file-system-operations", () => ({ openFileLink: ports.reveal }));
vi.mock("@/features/user-attachment-image-editor/adapters/image-preview-opener-registry", () => ({
  openUserAttachmentImagePreview: ports.open,
}));
const data = "data:image/png;base64,aW1hZ2U=";
const target = { channelId: "scope::side", placement: "side" as const };
function input(overrides: Partial<Parameters<typeof createConversationImageActions>[0]> = {}) {
  return {
    url: data,
    raw: "/source/chart.png",
    alt: "Chart",
    hostId: "remote-one",
    threadId: "thread",
    path: "/source/chart.png",
    isCurrent: () => true,
    signal: new AbortController().signal,
    download: vi.fn(async () => undefined),
    ...overrides,
  };
}
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("conversation image actions", () => {
  test.each([
    { url: "data:image/gif;base64,aW1hZ2U=" },
    { isAnimated: true },
    { mimeType: "image/gif; charset=binary" },
    {
      url: "https://example.test/animation.gif?key=1",
      raw: "https://example.test/animation.gif?key=1",
    },
  ])("keeps animated images out of static clipboard and Composer actions: %j", (overrides) => {
    vi.stubGlobal("ClipboardItem", class {});
    vi.stubGlobal("navigator", { clipboard: { write: vi.fn() } });
    const release = registerComposerImageAttachmentTarget(target, {
      hostId: "destination",
      threadId: "thread",
      scopeKey: "scope",
      append: () => true,
    });
    try {
      const actions = createConversationImageActions(
        input({ composerTarget: target, ...overrides }),
      );
      expect(actions.map(({ id }) => id)).not.toContain("add");
      expect(actions.map(({ id }) => id)).not.toContain("copy");
      expect(actions.map(({ id }) => id)).toContain("download");
    } finally {
      release();
    }
  });

  test.each([
    ["darwin", "Reveal in Finder"],
    ["win32", "Open in Explorer"],
    ["linux", "Open in File Manager"],
  ])("uses the platform reveal action on %s", (platform, label) => {
    expect(
      createConversationImageActions(input({ hostId: "local", platform })).find(
        ({ id }) => id === "reveal",
      )?.label,
    ).toBe(label);
  });
  test("new tabs own a durable read-only image and never persist the body's raw path", async () => {
    const action = createConversationImageActions(input()).find((entry) => entry.id === "open")!;
    await action.run();
    expect(ports.upload).toHaveBeenCalledTimes(1);
    expect(ports.open).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        src: "nodex://assets/menu-image",
        attachmentSrc: "nodex://assets/menu-image",
        readOnly: true,
        openInEditor: true,
        hostId: "remote-one",
        threadId: "thread",
      }),
    );
    expect(ports.open.mock.calls[0]?.[0]).not.toHaveProperty("localPath");
  });

  test("only public addresses are copied and HTTP tabs need no duplicate binary read", async () => {
    expect(conversationImageWebAddress("/secret/image.png", "blob:private", data)).toBeNull();
    const actions = createConversationImageActions(
      input({ raw: "https://original.test/chart.png", url: "https://display.test/image.png" }),
    );
    await actions.find((entry) => entry.id === "address")!.run();
    expect(ports.copyText).toHaveBeenCalledExactlyOnceWith("https://original.test/chart.png");
    await actions.find((entry) => entry.id === "open")!.run();
    expect(ports.upload).not.toHaveBeenCalled();
  });

  test("copies resolved bytes and only reveals the explicit local host", async () => {
    vi.stubGlobal("ClipboardItem", class {});
    vi.stubGlobal("navigator", { clipboard: { write: vi.fn() } });
    const remote = createConversationImageActions(input());
    expect(remote.some((entry) => entry.id === "reveal")).toBe(false);
    await remote.find((entry) => entry.id === "copy")!.run();
    expect(ports.copyImage).toHaveBeenCalledExactlyOnceWith(data);
    const local = createConversationImageActions(
      input({ hostId: "local", raw: "/source/chart.png ", path: "/source/chart.png " }),
    );
    await local.find((entry) => entry.id === "reveal")!.run();
    expect(ports.reveal).toHaveBeenCalledExactlyOnceWith(
      { path: "/source/chart.png " },
      "fileManager",
    );
  });

  test("adds only to the captured mounted Composer and transports cross-host bytes instead of paths", async () => {
    const appended: ResolvedComposerImageInput[][] = [];
    const release = registerComposerImageAttachmentTarget(target, {
      hostId: "destination",
      threadId: "thread",
      scopeKey: "scope",
      append: (images) => {
        appended.push([...images]);
        return true;
      },
    });
    try {
      const actions = createConversationImageActions(input({ composerTarget: target }));
      await actions.find((entry) => entry.id === "add")!.run();
      expect(appended).toEqual([
        [expect.objectContaining({ src: data, origin: "conversation", filename: "chart.png" })],
      ]);
      expect(appended[0]?.[0]).not.toHaveProperty("localPath");
      expect(ports.open).not.toHaveBeenCalled();
      const captured = captureComposerImageAttachmentTarget(target)!;
      release();
      const replacement = vi.fn(() => true);
      const remove = registerComposerImageAttachmentTarget(target, {
        hostId: "destination",
        threadId: "thread",
        scopeKey: "scope",
        append: replacement,
      });
      try {
        expect(captured.append(appended[0]!, () => true)).toBe(false);
        expect(replacement).not.toHaveBeenCalled();
      } finally {
        remove();
      }
    } finally {
      release();
    }
  });

  test("retirement during a binary fetch cannot copy, append, upload or open late", async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      ),
    );
    let current = true;
    const actions = createConversationImageActions(
      input({ url: "blob:owned", isCurrent: () => current }),
    );
    const pending = actions.find((entry) => entry.id === "open")!.run();
    current = false;
    finish(new Response(new Blob(["image"], { type: "image/png" })));
    await pending;
    expect(ports.upload).not.toHaveBeenCalled();
    expect(ports.open).not.toHaveBeenCalled();
  });
});
