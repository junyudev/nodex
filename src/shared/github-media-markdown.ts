import type { Nodes } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { parseFragment, type DefaultTreeAdapterMap } from "parse5";
import { parseGitHubAttachment } from "./github-media";

type HtmlNode = DefaultTreeAdapterMap["node"];

interface HtmlMedia {
  readonly tag: "img" | "video";
  readonly src: string;
  readonly start: number;
  readonly end: number;
}

/** Use actual HTML attributes and offsets, including quoted entities and single quotes. */
export function visitGitHubMediaTags(html: string, visit: (media: HtmlMedia) => void): void {
  function walk(node: HtmlNode) {
    if ("tagName" in node) {
      if (["code", "pre", "script", "style", "textarea", "template"].includes(node.tagName)) return;
      if (node.tagName === "img" || node.tagName === "video") {
        const src = node.attrs.find((attr) => attr.name === "src")?.value;
        const location = node.sourceCodeLocation;
        const start = node.tagName === "img" ? location?.attrs?.src : location;
        const end = node.tagName === "img" ? start : (location?.endTag ?? location?.startTag);
        if (src && start && end) {
          visit({ tag: node.tagName, src, start: start.startOffset, end: end.endOffset });
          return;
        }
      }
    }
    if ("childNodes" in node) node.childNodes.forEach(walk);
  }
  walk(parseFragment(html, { sourceCodeLocationInfo: true }));
}

function imageSyntax(alt: string, url: string) {
  const label = alt.replace(/[\\\[\]]/gu, "\\$&").replace(/[\r\n]/gu, " ");
  return `![${label}](<${url}>)`;
}

const githubMarkdown = { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] };

/** Normalize GitHub's attachment forms to image leaves for the opt-in media renderer. */
export function prepareGitHubAttachmentMarkdown(markdown: string): string {
  if (!/github\.com\/|githubusercontent\.com\//iu.test(markdown)) return markdown;
  const edits: Array<{ start: number; end: number; value: string }> = [];
  const tree = fromMarkdown(markdown, githubMarkdown);

  function walk(node: Nodes) {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) return;
    if (node.type === "html") {
      visitGitHubMediaTags(markdown.slice(start, end), (media) => {
        const attachment = parseGitHubAttachment(media.src);
        if (!attachment) return;
        const left = start + media.start;
        const right = start + media.end;
        const src = `src="${attachment.url}"`;
        if (media.tag === "img") {
          if (media.src !== attachment.url) edits.push({ start: left, end: right, value: src });
          return;
        }
        // Inline Markdown HTML nodes may contain only the opening tag.
        const close = right === end ? /^[ \t]*<\/video\s*>/iu.exec(markdown.slice(end))?.[0] : null;
        edits.push({
          start: left,
          end: right + (close?.length ?? 0),
          value: `<img ${src} alt="">`,
        });
      });
      return;
    }
    if (node.type === "image") {
      const attachment = parseGitHubAttachment(node.url);
      if (attachment && node.url !== attachment.url) {
        const title = node.title?.replace(/[\\"]/gu, "\\$&");
        const value = imageSyntax(node.alt ?? "", attachment.url);
        edits.push({ start, end, value: title ? `${value.slice(0, -1)} "${title}")` : value });
      }
      return;
    }
    if (node.type === "link" && node.children.length === 1) {
      const child = node.children[0];
      const attachment = parseGitHubAttachment(node.url);
      const authored = markdown.slice(start, end);
      if (
        child?.type === "image" &&
        attachment &&
        parseGitHubAttachment(child.url)?.id === attachment.id
      ) {
        edits.push({ start, end, value: imageSyntax(child.alt ?? "", attachment.url) });
        return;
      }
      if (attachment && (authored === node.url || authored === `<${node.url}>`)) {
        const lineStart = markdown.lastIndexOf("\n", start - 1) + 1;
        const lineEnd = markdown.indexOf("\n", end);
        if (
          markdown.slice(lineStart, lineEnd < 0 ? markdown.length : lineEnd).trim() === authored
        ) {
          edits.push({ start, end, value: imageSyntax("", attachment.url) });
          return;
        }
      }
    }
    if ("children" in node) node.children.forEach(walk);
  }

  walk(tree);
  let cursor = 0;
  const parts = edits
    .sort((a, b) => a.start - b.start)
    .map(({ start, end, value }) => {
      const part = markdown.slice(cursor, start) + value;
      cursor = end;
      return part;
    });
  return parts.join("") + markdown.slice(cursor);
}
