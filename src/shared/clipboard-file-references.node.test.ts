import { describe, expect, test } from "vite-plus/test";
import { fromMarkdown } from "mdast-util-from-markdown";
import {
  clipboardFileReferences,
  clipboardFileReferenceSources,
  replaceClipboardFileReferences,
} from "./clipboard-file-references";
import { writePortableMarkdown, type MarkdownInline } from "./nodex-markdown";

const source = "nodex://files/0199134e-cbb0-7000-8000-000000000006";

function attachmentMarkdown(attachment: Readonly<Record<string, unknown>>): string {
  return writePortableMarkdown([
    {
      type: "paragraph",
      content: [{ type: "attachment", props: attachment } satisfies MarkdownInline],
      children: [],
    },
  ]).markdown;
}

function readLink(text: string) {
  const [token] = fromMarkdown(text).children;
  if (token?.type !== "paragraph") throw new Error("Expected one paragraph");
  const [link] = token.children;
  if (link?.type !== "link") throw new Error("Expected one link");
  return link;
}

describe("clipboard File references", () => {
  test("detects saved attachment occurrences without treating linked paths as exports", () => {
    const text = `[setup.html](${source}) [same](${source}) [local](/tmp/setup.html)`;
    expect(clipboardFileReferences(text)).toEqual([
      { source, fileId: source.slice("nodex://files/".length) },
    ]);
    expect(clipboardFileReferenceSources(text)).toEqual([source]);
    expect(clipboardFileReferences("[local](/tmp/setup.html)")).toEqual([]);
    expect(clipboardFileReferences(`${text} ![old](nodex://assets/image.png)`)).toBeNull();
  });

  test.each([
    "/Users/example/setup.html",
    "/Users/example/my  files/setup (v2).html",
    "/Users/example/setup(v2).html",
    "/Users/example/<setup>.html",
    "/Users/example/&amp;.html",
    String.raw`C:\my files\setup (v2).html`,
    String.raw`C:\files\setup.html`,
  ])("links %s the same way for direct and exported attachments", (path) => {
    const attachment = {
      type: "attachment",
      kind: "file",
      mode: "link",
      source: path,
      name: "setup [v2]*`&amp;.html",
    } as const;
    const portable = attachmentMarkdown({ ...attachment, mode: "materialized", source });
    const exported = replaceClipboardFileReferences(portable, new Map([[source, path]]));
    for (const written of [attachmentMarkdown(attachment), exported]) {
      const link = readLink(written);
      expect(link.url).toBe(path);
      expect(link.children.map((token) => token.type)).toEqual(["text"]);
      expect(link.children.map((token) => ("value" in token ? token.value : "")).join("")).toBe(
        attachment.name,
      );
    }
  });

  test("rewrites repeated images, attachments and literal references in one pass", () => {
    const asset = "nodex://assets/old.png";
    const text = `[file](${source})\n![image](${source})\n${source}\n![old](${asset})`;
    expect(
      replaceClipboardFileReferences(
        text,
        new Map([
          [source, "/my files/setup.html"],
          [asset, "/my files/old.png"],
        ]),
      ),
    ).toBe(
      "[file](</my files/setup.html>)\n![image](</my files/setup.html>)\n/my files/setup.html\n![old](</my files/old.png>)",
    );
  });
});
