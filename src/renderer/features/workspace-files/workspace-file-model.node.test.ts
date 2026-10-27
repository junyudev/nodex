import { describe, expect, test } from "vite-plus/test";
import {
  getWorkspaceFileDomTabId,
  getWorkspaceRelativePath,
  isWorkspacePathInsideRoot,
  formatWorkspaceFileSize,
  isWorkspaceFileTooLargeToPreview,
  resolveWorkspaceFilePreviewKind,
  resolveWorkspaceFileRichViewMode,
  resolveWorkspaceFileUnsupportedType,
  resolveWorkspaceSourceLanguage,
  resolveWorkspaceTreeFilePath,
  WORKSPACE_FILE_PREVIEW_MAX_BYTES,
} from "./workspace-file-model";
describe("workspace-file-model", () => {
  test("builds Codex-style file DOM tab ids", () => {
    expect(getWorkspaceFileDomTabId("local", "/Users/asc/repo/nodex/README.md")).toBe(
      "file:local:/Users/asc/repo/nodex/README.md",
    );
  });

  test("opens sniffed images, PDFs, and playable media in their rich previews", () => {
    expect(resolveWorkspaceFilePreviewKind({ path: "/repo/asset", contentKind: "image" })).toBe(
      "image",
    );
    expect(resolveWorkspaceFilePreviewKind({ path: "/repo/report", contentKind: "pdf" })).toBe(
      "pdf",
    );
    expect(
      resolveWorkspaceFilePreviewKind({ path: "/repo/review.webm", contentKind: "video" }),
    ).toBe("video");
    expect(
      resolveWorkspaceFilePreviewKind({ path: "/repo/demo.MP4", contentKind: undefined }),
    ).toBe("video");
    expect(resolveWorkspaceFilePreviewKind({ path: "/repo/tone.mp3", contentKind: "audio" })).toBe(
      "audio",
    );
    expect(
      resolveWorkspaceFileRichViewMode({ path: "/repo/review.webm", contentKind: "video" }),
    ).toBe("always");
  });

  test("keeps containers the player cannot decode out of the media preview", () => {
    const mkv = { path: "/repo/clip.mkv", contentKind: "video" } as const;
    expect(resolveWorkspaceFilePreviewKind(mkv)).toBeNull();
    expect(resolveWorkspaceFileUnsupportedType(mkv)).toBe("video");
    expect(
      resolveWorkspaceFileUnsupportedType({ path: "/repo/scan.tiff", contentKind: "image" }),
    ).toBe("image");
    expect(
      resolveWorkspaceFileUnsupportedType({ path: "/repo/scan.tiff (2)", contentKind: undefined }),
    ).toBe("image");
  });

  test("lets Markdown and SVG toggle between their source and rich views", () => {
    const markdown = { path: "/repo/README.md", contentKind: "text" } as const;
    expect(resolveWorkspaceFilePreviewKind(markdown)).toBe("markdown");
    expect(resolveWorkspaceFileRichViewMode(markdown)).toBe("toggle");
    const svg = { path: "/repo/logo.svg", contentKind: undefined } as const;
    expect(resolveWorkspaceFilePreviewKind(svg)).toBe("image");
    expect(resolveWorkspaceFileRichViewMode(svg)).toBe("toggle");
    expect(resolveWorkspaceFileRichViewMode({ path: "/repo/main.ts", contentKind: "text" })).toBe(
      "none",
    );
  });

  test("names office documents and archives that have no preview", () => {
    expect(
      resolveWorkspaceFileUnsupportedType({ path: "/repo/deck.pptx", contentKind: "archive" }),
    ).toBe("powerpoint-deck");
    expect(
      resolveWorkspaceFileUnsupportedType({ path: "/repo/notes.rtf", contentKind: "text" }),
    ).toBe("rich-text-document");
    expect(
      resolveWorkspaceFileUnsupportedType({ path: "/repo/bundle.zip", contentKind: "archive" }),
    ).toBe("archive");
    expect(
      resolveWorkspaceFileUnsupportedType({ path: "/repo/data.bin", contentKind: "binary" }),
    ).toBe("binary");
    expect(
      resolveWorkspaceFileUnsupportedType({ path: "/repo/LICENSE", contentKind: "text" }),
    ).toBeNull();
  });

  test("blocks previews above the preview limit and formats sizes for the limit message", () => {
    expect(isWorkspaceFileTooLargeToPreview(WORKSPACE_FILE_PREVIEW_MAX_BYTES)).toBe(false);
    expect(isWorkspaceFileTooLargeToPreview(WORKSPACE_FILE_PREVIEW_MAX_BYTES + 1)).toBe(true);
    expect(isWorkspaceFileTooLargeToPreview(null)).toBe(false);
    expect(formatWorkspaceFileSize(512)).toBe("512 B");
    expect(formatWorkspaceFileSize(3_482)).toBe("3.4 KB");
    expect(formatWorkspaceFileSize(WORKSPACE_FILE_PREVIEW_MAX_BYTES)).toBe("256.0 MB");
  });

  test("uses the public source-language registry without treating unknown text as code", () => {
    expect(resolveWorkspaceSourceLanguage("/repo/main.ts")).toBe("typescript");
    expect(resolveWorkspaceSourceLanguage("/repo/Dockerfile")).toBe("dockerfile");
    expect(resolveWorkspaceSourceLanguage("/repo/LICENSE")).toBeNull();
  });

  test("resolves tree coordinates without treating prefix collisions as descendants", () => {
    expect(resolveWorkspaceTreeFilePath("/repo/project", "src/file.ts")).toBe(
      "/repo/project/src/file.ts",
    );
    expect(isWorkspacePathInsideRoot("/repo/project", "/repo/project/src/file.ts")).toBe(true);
    expect(isWorkspacePathInsideRoot("/repo/project", "/repo/project-other/file.ts")).toBe(false);
    expect(getWorkspaceRelativePath("/repo/project", "/repo/project/src/file.ts")).toBe(
      "src/file.ts",
    );
    expect(getWorkspaceRelativePath("/repo/project", "/repo/project-other/file.ts")).toBe(null);
  });

  test("handles Windows workspace roots case-insensitively", () => {
    expect(resolveWorkspaceTreeFilePath("C:\\repo", "src/file.ts")).toBe("C:\\repo\\src\\file.ts");
    expect(isWorkspacePathInsideRoot("C:\\Repo", "c:\\repo\\src\\file.ts")).toBe(true);
  });
});
