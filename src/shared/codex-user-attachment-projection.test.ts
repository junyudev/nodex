import { describe, expect, test } from "vite-plus/test";
import { buildCodexUserAttachmentsFromContent } from "./codex-user-attachment-projection";

describe("buildCodexUserAttachmentsFromContent", () => {
  test("preserves inline, local, and remote-pointer image source semantics", () => {
    expect(
      buildCodexUserAttachmentsFromContent(
        [
          { type: "image", url: "data:image/png;base64,aW1hZ2U=" },
          { type: "localImage", path: "/workspace/screenshot.png" },
          { type: "image_asset_pointer", asset_pointer: "file-service://asset-1" },
          { type: "image", fileId: "asset-2", detail: "original" },
        ],
        "user-1",
      ),
    ).toEqual([
      {
        type: "image",
        id: "user-1:attachment:image:0",
        source: "data:image/png;base64,aW1hZ2U=",
        sourceKind: "inline-image",
        caption: undefined,
      },
      {
        type: "image",
        id: "user-1:attachment:local-image:1",
        source: "/workspace/screenshot.png",
        sourceKind: "local-image",
        caption: undefined,
      },
      {
        type: "image",
        id: "user-1:attachment:remote-image:2",
        source: "file-service://asset-1",
        sourceKind: "remote-pointer",
        caption: undefined,
      },
      {
        type: "image",
        id: "user-1:attachment:image:3",
        source: "file-service://asset-2",
        sourceKind: "remote-pointer",
        caption: undefined,
      },
    ]);
  });
});
