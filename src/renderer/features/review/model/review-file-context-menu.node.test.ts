import { describe, expect, test } from "vite-plus/test";
import {
  buildReviewFileContextMenu,
  reviewFileTargetPreferredOpener,
  type ReviewFileContextMenuInput,
} from "./review-file-context-menu";

const fileContext: ReviewFileContextMenuInput = {
  canOpenFile: true,
  canOpenInNewTab: true,
  selectedText: "const value = 1;",
  relativePath: "src/example.ts",
  githubUrl: "https://github.com/example/project/blob/main/src/example.ts",
  primary: { id: "cursor", label: "Cursor", opener: "cursor" },
  alternatives: [
    { id: "cursor", label: "Cursor", opener: "cursor" },
    { id: "vscode", label: "VS Code", opener: "vscode" },
  ],
};

describe("Review file context menu", () => {
  test("keeps selection and path actions beside file opening and line comments", () => {
    const items = buildReviewFileContextMenu(fileContext);
    expect(items.map((item) => (item.type === "separator" ? "separator" : item.label))).toEqual([
      "Request changes",
      "Open in Cursor",
      "Open with",
      "Open in GitHub",
      "separator",
      "Copy selection",
      "Copy path",
      "Copy relative path",
      "Toggle line wrap",
    ]);
    expect(items.find((item) => item.id === "open-with")).toMatchObject({
      type: "submenu",
      submenu: [
        { id: "open-in-new-tab", label: "New tab" },
        { id: "open-target:cursor", label: "Cursor" },
        { id: "open-target:vscode", label: "VS Code" },
      ],
    });
  });

  test("retains Request changes while an empty selection disables only its copy action", () => {
    const items = buildReviewFileContextMenu({
      ...fileContext,
      selectedText: "",
    });
    expect(items.find((item) => item.id === "copy-selection")).toMatchObject({ enabled: false });
    expect(items.find((item) => item.id === "request-changes")).toEqual({
      id: "request-changes",
      label: "Request changes",
    });
    expect(items.find((item) => item.id === "copy-path")).toMatchObject({ enabled: true });
  });

  test("remembers editor choices without promoting native viewers or terminals", () => {
    expect(reviewFileTargetPreferredOpener(fileContext.alternatives[1]!)).toBe("vscode");
    for (const opener of ["fileManager", "terminal", "iterm2", "ghostty", "warp"] as const) {
      expect(reviewFileTargetPreferredOpener({ id: opener, label: opener, opener })).toBeNull();
    }
    expect(reviewFileTargetPreferredOpener({ id: "default", label: "Default app" })).toBeNull();
    expect(
      reviewFileTargetPreferredOpener({
        id: "native",
        label: "Native app",
        appPath: "/Applications/Preview.app",
      }),
    ).toBeNull();
  });

  test("does not offer a new editable tab for a deleted file", () => {
    const items = buildReviewFileContextMenu({
      ...fileContext,
      canOpenInNewTab: false,
      githubUrl: null,
    });
    const submenu = items.find((item) => item.id === "open-with");
    if (submenu?.type !== "submenu")
      throw new Error("The deleted file has available external targets");
    expect(submenu.submenu.map((item) => item.id)).toEqual([
      "open-target:cursor",
      "open-target:vscode",
    ]);
    expect(items.some((item) => item.id === "open-in-github")).toBe(false);
  });

  test("omits unsupported file targets without inserting empty menu sections", () => {
    const items = buildReviewFileContextMenu({
      ...fileContext,
      canOpenFile: false,
      relativePath: null,
      githubUrl: null,
      primary: null,
      alternatives: [],
    });
    expect(items.map((item) => item.id)).toEqual([
      "request-changes",
      "copy-selection",
      "copy-path",
      "toggle-wrap",
    ]);
    expect(items.find((item) => item.id === "copy-path")).toMatchObject({ enabled: false });
  });
});
