import type { RemappedIcon } from "@pierre/trees";
import commentSvg from "./file-tree-comment.svg?raw";

const COMMENT_BODY = commentSvg.replace(/<svg[^>]*>/, "").replace("</svg>", "");

export function fileTreeCommentIcon(count: number): Exclude<RemappedIcon, string> {
  const width = 22 + String(count).length * 7;
  return { height: 18, name: `file-tree-comment-${count}`, viewBox: `0 0 ${width} 18`, width };
}

export function fileTreeCommentSprite(counts: Iterable<number>): string {
  const symbols = [...new Set(counts)]
    .filter((count) => count > 0)
    .map((count) => {
      const icon = fileTreeCommentIcon(count);
      return `<symbol id="${icon.name}" viewBox="${icon.viewBox}"><g transform="scale(${18 / 21})">${COMMENT_BODY}</g><text x="22" y="9" fill="currentColor" font-size="12" font-family="system-ui" dominant-baseline="middle">${count}</text></symbol>`;
    });
  return `<svg data-icon-sprite aria-hidden="true" width="0" height="0" xmlns="http://www.w3.org/2000/svg">${symbols.join("")}</svg>`;
}
