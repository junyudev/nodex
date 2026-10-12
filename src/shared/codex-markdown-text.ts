import { fromMarkdown } from "mdast-util-from-markdown";
import { toString as markdownNodeToString } from "mdast-util-to-string";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { directiveFromMarkdown } from "mdast-util-directive";
import { directive } from "micromark-extension-directive";
import { parse } from "node-html-parser";
import type { Nodes } from "mdast";
import { trimMarkdownBlankLines } from "./markdown-text-boundaries";

/** Keep literal autolinks out of an unfinished Markdown link label. */
function compactGfm() {
  const extension = gfm();
  if (!extension.text) return extension;
  const blocked = new WeakMap<object, { index: number; token: object }>();
  for (const key of Object.keys(extension.text)) {
    const code = Number(key);
    const constructs = extension.text[code];
    if (!constructs) continue;
    extension.text[code] = (Array.isArray(constructs) ? constructs : [constructs]).map(
      (construct) => {
        if (!construct.name?.endsWith("Autolink")) return construct;
        const previous = construct.previous;
        return {
          ...construct,
          previous(code) {
            if (previous && !previous.call(this, code)) return false;
            const cached = blocked.get(this.events);
            if (
              cached &&
              this.events[cached.index]?.[1] === cached.token &&
              !(cached.token as { _balanced?: boolean })._balanced
            )
              return false;
            for (let index = this.events.length - 1; index >= 0; index -= 1) {
              const token = this.events[index]![1];
              if ((token.type === "labelLink" || token.type === "labelImage") && !token._balanced) {
                blocked.set(this.events, { index, token });
                return false;
              }
              if (
                "_gfmAutolinkLiteralWalkedInto" in token &&
                token._gfmAutolinkLiteralWalkedInto === true
              )
                break;
            }
            return true;
          },
        };
      },
    );
  }
  return extension;
}

/** Normalize inline directives without changing any Markdown code node. */
function normalizeDirectives(markdown: string): string {
  if (!markdown.includes("::")) return markdown;
  const codeRanges: Array<{ start: number; end: number }> = [];
  const visit = (node: Nodes): void => {
    if (node.type === "code" || node.type === "inlineCode") {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) codeRanges.push({ start, end });
      return;
    }
    if ("children" in node) node.children.forEach(visit);
  };
  visit(fromMarkdown(markdown));
  let rangeIndex = 0;
  return markdown.replace(
    /(^|[^:])::([A-Za-z][A-Za-z0-9_-]*)(?=[[{])/g,
    (match, prefix: string, name: string, offset: number) => {
      const colonOffset = offset + prefix.length;
      while (codeRanges[rangeIndex] && codeRanges[rangeIndex]!.end <= colonOffset) rangeIndex += 1;
      const range = codeRanges[rangeIndex];
      return range && range.start <= colonOffset ? match : `${prefix}:${name}`;
    },
  );
}

function unclosedHiddenElement(value: string): string | null {
  const match = /<\s*(script|style)\b[^>]*>/i.exec(value);
  if (!match || match[0].endsWith("/>")) return null;
  const tag = match[1]!;
  if (tag !== "script" && tag !== "style") return null;
  return new RegExp(`<\\/\\s*${tag}\\s*>`, "i").test(value) ? null : tag;
}

function extractMarkdownText(node: Nodes): string {
  if (node.type === "html") {
    if (/^(?:<!--(?:(?!-->)[\s\S])*-->\s*)+$/.test(node.value.trim())) return "";
    const html = parse(node.value);
    for (const element of html.querySelectorAll("script, style")) element.remove();
    return html.structuredText;
  }
  if (!("children" in node)) return markdownNodeToString(node);
  let hidden: string | null = null;
  const text: string[] = [];
  for (const child of node.children) {
    if (hidden) {
      if (child.type === "html" && new RegExp(`<\\/\\s*${hidden}\\s*>`, "i").test(child.value))
        hidden = null;
      continue;
    }
    if (child.type === "html") {
      hidden = unclosedHiddenElement(child.value);
      if (hidden) continue;
    }
    text.push(extractMarkdownText(child));
  }
  const block = [
    "root",
    "blockquote",
    "list",
    "listItem",
    "table",
    "tableRow",
    "tableCell",
    "containerDirective",
  ].includes(node.type);
  return text.join(block ? " " : "");
}

/** Project rich assistant text into compact labels without hidden markup or attributes. */
export function projectCodexMarkdownToPlainText(markdown: string): string {
  const trimmed = trimMarkdownBlankLines(
    normalizeDirectives(markdown.replaceAll(/\uE200[^\uE201]*\uE201/g, "")),
  );
  if (!trimmed) return "";
  if (
    /^[\p{L}\p{M}\p{N} .,!?'"’()-]+$/u.test(trimmed) &&
    !trimmed.startsWith("-") &&
    !/^\d+[.)](?: |$)/.test(trimmed)
  )
    return trimmed.replace(/ +/g, " ");
  const tree = fromMarkdown(trimmed, {
    extensions: [compactGfm(), directive()],
    mdastExtensions: [gfmFromMarkdown(), directiveFromMarkdown()],
  });
  return extractMarkdownText(tree).replace(/\s+/g, " ").trim();
}

/** Project a stored label while preserving nonblank literal text that has no visible Markdown. */
export function projectCodexMarkdownLabel(markdown: string | null | undefined): string | null {
  const trimmed = markdown?.trim() ?? "";
  if (!trimmed) return null;
  return projectCodexMarkdownToPlainText(trimmed) || trimmed;
}
