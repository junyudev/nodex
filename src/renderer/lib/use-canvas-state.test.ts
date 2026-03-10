import { describe, expect, test } from "bun:test";
import { collectReferencedFileIds, pickReferencedFiles } from "./use-canvas-state";

describe("use-canvas-state helpers", () => {
  test("collectReferencedFileIds keeps only active image file IDs", () => {
    const elements: unknown[] = [
      { type: "rectangle", fileId: "ignore-rect" },
      { type: "image", fileId: "file-1", isDeleted: false },
      { type: "image", fileId: "file-2" },
      { type: "image", fileId: "file-3", isDeleted: true },
      { type: "image", fileId: 123 },
    ];

    const ids = [...collectReferencedFileIds(elements)].sort();
    expect(JSON.stringify(ids)).toBe(JSON.stringify(["file-1", "file-2"]));
  });

  test("pickReferencedFiles returns only files used by active image elements", () => {
    const files = {
      "file-1": { id: "file-1", mimeType: "image/png" },
      "file-2": { id: "file-2", mimeType: "image/jpeg" },
      orphan: { id: "orphan", mimeType: "image/webp" },
    };

    const selected = pickReferencedFiles(
      [
        { type: "image", fileId: "file-2" },
        { type: "text" },
      ],
      files,
    );

    expect(JSON.stringify(selected)).toBe(JSON.stringify({ "file-2": files["file-2"] }));
  });

  test("pickReferencedFiles returns empty object when files map is missing", () => {
    const selected = pickReferencedFiles([{ type: "image", fileId: "file-1" }], undefined);
    expect(JSON.stringify(selected)).toBe("{}");
  });
});
