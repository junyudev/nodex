import { describe, expect, test } from "vite-plus/test";
import type { CodexUserAttachment, CodexUserImageAttachment } from "@/lib/types";
import type { ComposerImageAttachment } from "./composer/image-attachments/composer-image-attachment-model";
import {
  canSendUserTurnEdit,
  compileUserTurnEditImages,
  openUserTurnEditDraft,
  removeUserTurnEditImage,
  userTurnEditDraftImages,
} from "./user-turn-edit-draft";

const sent = (id: string, source = `/tmp/${id}.png`): CodexUserImageAttachment => ({
  type: "image",
  id,
  source,
  sourceKind: "local-image",
});

const added = (
  id: string,
  overrides: Partial<ComposerImageAttachment> = {},
): ComposerImageAttachment => ({
  id,
  filename: `${id}.png`,
  mimeType: "image/png",
  src: `data:image/png;base64,${id}`,
  origin: "paste",
  materialization: null,
  materializationStatus: "pending",
  uploadStatus: "idle",
  generation: 0,
  ...overrides,
});

describe("rewriting a sent message", () => {
  test("opens with the message's images and leaves its files where they are", () => {
    const file: CodexUserAttachment = {
      type: "file",
      id: "file",
      label: "notes.md",
      path: "/tmp/notes.md",
      sourceKind: "mention",
    };
    expect(openUserTurnEditDraft("Words", [file, sent("a"), sent("b")])).toEqual({
      text: "Words",
      sentImages: [sent("a"), sent("b")],
      addedImages: [],
    });
  });

  test("numbers added images after sent ones, so removing any keeps the text truthful", () => {
    const draft = {
      text: "See [Image #2] then [Image #3]",
      sentImages: [sent("a"), sent("b")],
      addedImages: [added("c")],
    };
    expect(userTurnEditDraftImages(draft).map((image) => image.id)).toEqual(["a", "b", "c"]);

    expect(removeUserTurnEditImage(draft, "a")).toEqual({
      text: "See [Image #1] then [Image #2]",
      sentImages: [sent("b")],
      addedImages: [added("c")],
    });
    expect(removeUserTurnEditImage(draft, "b").text).toBe("See then [Image #2]");
    expect(removeUserTurnEditImage(draft, "c")).toEqual({
      text: "See [Image #2] then",
      sentImages: [sent("a"), sent("b")],
      addedImages: [],
    });
  });

  test("removing an image the draft no longer holds changes nothing", () => {
    const draft = openUserTurnEditDraft("[Image #1]", [sent("a")]);
    expect(removeUserTurnEditImage(draft, "gone")).toBe(draft);
  });

  test("sends with words or an image, and refuses an empty message", () => {
    const empty = { text: "  ", sentImages: [], addedImages: [] };
    expect(canSendUserTurnEdit(empty)).toBe(false);
    expect(canSendUserTurnEdit({ ...empty, text: "Words" })).toBe(true);
    expect(canSendUserTurnEdit({ ...empty, sentImages: [sent("a")] })).toBe(true);
    expect(canSendUserTurnEdit({ ...empty, addedImages: [added("a")] })).toBe(true);
  });
});

describe("what a rewritten message attaches", () => {
  test("keeps each sent image where it was read, then each added one from this chat's host", () => {
    const local = added("picked", {
      materialization: { hostId: "local", localPath: "/tmp/picked.png", managedSource: null },
      materializationStatus: "ready",
    });
    expect(
      compileUserTurnEditImages(
        {
          text: "",
          sentImages: [sent("a", "nodex-runtime-image:t/i/a"), { ...sent("b"), caption: "b.png" }],
          addedImages: [local],
        },
        "local",
      ),
    ).toEqual([
      { source: "nodex-runtime-image:t/i/a" },
      { source: "/tmp/b.png", caption: "b.png" },
      { source: "/tmp/picked.png", caption: "picked.png" },
    ]);
  });

  test("an empty draft attaches none, which is different from keeping what was sent", () => {
    expect(
      compileUserTurnEditImages({ text: "Words", sentImages: [], addedImages: [] }, "local"),
    ).toEqual([]);
  });

  test("sends bytes to a chat on another host, where this computer's path means nothing", () => {
    const local = added("picked", {
      materialization: { hostId: "local", localPath: "/tmp/picked.png", managedSource: null },
      materializationStatus: "ready",
    });
    expect(
      compileUserTurnEditImages({ text: "", sentImages: [], addedImages: [local] }, "devbox"),
    ).toEqual([{ source: local.src, caption: "picked.png" }]);
  });

  test("rejects an added image it cannot place rather than sending without it", () => {
    const unreachable = added("lost", { src: "blob:lost" });
    expect(() =>
      compileUserTurnEditImages(
        { text: "Words", sentImages: [], addedImages: [unreachable] },
        "local",
      ),
    ).toThrow("aren’t available where this chat runs");
  });
});
