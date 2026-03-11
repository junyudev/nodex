import type { NfmBlock, NfmInlineContent } from "./types";
import { parseNfm } from "./parser";

export function extractPlainText(nfm: string, maxLength?: number): string {
  if (!nfm) return "";

  const blocks = parseNfm(nfm);
  const parts: string[] = [];
  collectText(blocks, parts);

  const result = parts.join(" ").replace(/\s+/g, " ").trim();
  if (maxLength && result.length > maxLength) {
    return `${result.slice(0, maxLength).trimEnd()}...`;
  }
  return result;
}

function collectText(blocks: NfmBlock[], parts: string[]): void {
  for (const block of blocks) {
    if ("content" in block && Array.isArray(block.content)) {
      collectInlineText(block.content, parts);
    }

    if (block.type === "image") {
      collectInlineText(block.caption, parts);
    }

    if (block.type === "codeBlock") {
      parts.push(block.code);
    }

    if (block.children.length === 0) continue;
    collectText(block.children, parts);
  }
}

function collectInlineText(items: NfmInlineContent[], parts: string[]): void {
  for (const item of items) {
    if (item.type === "text" || item.type === "link") {
      parts.push(item.text);
      continue;
    }

    if (item.type === "linebreak") {
      parts.push(" ");
    }
  }
}
