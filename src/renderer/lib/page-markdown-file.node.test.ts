import { describe, expect, test } from "vite-plus/test";
import {
  encodeUtf8Base64,
  pageMarkdownFileContents,
  pageMarkdownFileName,
} from "./page-markdown-file";

describe("page Markdown file", () => {
  test("names the file after the title, safe for the file system", () => {
    expect(pageMarkdownFileName("Release plan")).toBe("Release plan.md");
    expect(pageMarkdownFileName("  Q3: plan / review?  ")).toBe("Q3_ plan _ review_.md");
    expect(pageMarkdownFileName("   ")).toBe("Untitled.md");
    expect(pageMarkdownFileName("line\nbreak")).toBe("line break.md");
  });

  test("leads with the title as the one top-level heading", () => {
    expect(pageMarkdownFileContents("Release plan", "## Goal\n\nShip it.\n\n")).toBe(
      "# Release plan\n\n## Goal\n\nShip it.\n",
    );
    expect(pageMarkdownFileContents("", "")).toBe("# Untitled\n");
  });

  test("encodes Unicode text as UTF-8", () => {
    expect(encodeUtf8Base64("é ✓")).toBe(Buffer.from("é ✓", "utf8").toString("base64"));
  });
});
