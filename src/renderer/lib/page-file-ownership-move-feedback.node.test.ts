import { describe, expect, test } from "vite-plus/test";

import type { LibraryPageFileOwnershipMove } from "../../shared/library-module";
import { summarizePageFileOwnershipMoveCollisions } from "./page-file-ownership-move-feedback";

const move = (
  fileId: string,
  previousLogicalPath: string,
  logicalPath: string,
): LibraryPageFileOwnershipMove => ({
  fileId,
  previousOwnerPageId: "page:source",
  ownerPageId: "page:target",
  previousLogicalPath,
  logicalPath,
  version: 2,
});

describe("Page File ownership move feedback", () => {
  test("stays quiet when ownership moves without changing paths", () => {
    expect(
      summarizePageFileOwnershipMoveCollisions([move("file:image", "image.png", "image.png")]),
    ).toBeNull();
  });

  test("names the resolved path for one collision", () => {
    expect(
      summarizePageFileOwnershipMoveCollisions([move("file:image", "image.png", "image (2).png")]),
    ).toEqual({
      title: "Moved as image (2).png",
      description: "The destination already had image.png.",
    });
  });

  test("combines multiple collision renames into one bounded summary", () => {
    expect(
      summarizePageFileOwnershipMoveCollisions([
        move("file:image", "image.png", "image (2).png"),
        move("file:script", "scripts/build.ts", "scripts/build (2).ts"),
        move("file:data", "data.json", "data (2).json"),
        move("file:quiet", "notes.md", "notes.md"),
      ]),
    ).toEqual({
      title: "3 files renamed while moving",
      description: "image (2).png · scripts/build (2).ts · data (2).json",
    });
  });
});
