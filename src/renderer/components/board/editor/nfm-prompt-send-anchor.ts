import { useLayoutEffect, useState } from "react";
import {
  resolveNfmPromptSendAnchor,
  type NfmPromptLineBox,
  type NfmPromptSendAnchor,
} from "./nfm-prompt-block-model";

const INLINE_ORIGIN: NfmPromptSendAnchor = { placement: "inline", left: 0, top: 0 };

/** The box of the Prompt's last character, relative to the text column that holds it. */
function readLastLine(column: HTMLElement, content: HTMLElement): NfmPromptLineBox | null {
  const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
  let last: Text | null = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if ((node as Text).length > 0) last = node as Text;
  }
  if (!last) return null;
  const range = document.createRange();
  range.setStart(last, last.length - 1);
  range.setEnd(last, last.length);
  const glyph = range.getBoundingClientRect();
  const origin = column.getBoundingClientRect();
  return {
    left: glyph.left - origin.left,
    right: glyph.right - origin.left,
    top: glyph.top - origin.top,
    bottom: glyph.bottom - origin.top,
  };
}

function sameAnchor(a: NfmPromptSendAnchor, b: NfmPromptSendAnchor): boolean {
  return a.placement === b.placement && a.left === b.left && a.top === b.top;
}

/**
 * Keeps the send button beside the Prompt's last line of text. It re-measures when the text
 * changes or the column is resized, and the state only changes when the position does.
 */
export function useNfmPromptSendAnchor(
  column: HTMLElement | null,
  content: HTMLElement | null,
): NfmPromptSendAnchor {
  const [anchor, setAnchor] = useState<NfmPromptSendAnchor>(INLINE_ORIGIN);

  useLayoutEffect(() => {
    if (!column || !content) return;
    const measure = () => {
      const next = resolveNfmPromptSendAnchor({
        lastLine: readLastLine(column, content),
        width: column.clientWidth,
      });
      setAnchor((current) => (sameAnchor(current, next) ? current : next));
    };
    const mutations = new MutationObserver(measure);
    mutations.observe(content, { subtree: true, childList: true, characterData: true });
    const resizes = new ResizeObserver(measure);
    resizes.observe(column);
    measure();
    return () => {
      mutations.disconnect();
      resizes.disconnect();
    };
  }, [column, content]);

  return anchor;
}
