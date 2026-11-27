import { useIntl } from "@/lib/i18n";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { NfmDocument } from "@/components/board/nfm-renderer";
import { ChevronDownIcon } from "@/components/shared/icons";
import { useClippedFocusSafety } from "@/features/local-conversation/view/shared/use-clipped-focus-safety";
import { cn } from "@/lib/utils";
import { markdownPlainText, type MarkdownBlock } from "../../../shared/nodex-markdown";

/**
 * Blocks whose lines flow in one column, so a line clamp counts them and ends the last line it
 * shows with an ellipsis. A code block, table, checklist or image keeps its own layout, which a
 * clamp cannot count, so a brief stops before it.
 */
const FLOWING_BLOCKS = new Set([
  "paragraph",
  "heading",
  "bulletListItem",
  "numberedListItem",
  "quote",
]);

const flows = (block: MarkdownBlock): boolean =>
  FLOWING_BLOCKS.has(block.type) &&
  !block.props?.isToggleable &&
  (block.children ?? []).every(flows);

/**
 * What a brief shows before it opens: the text's leading run of flowing Blocks, or, when the
 * text opens with something else, its words as one paragraph. `complete` says nothing was left
 * out, so only clipping would hide the rest.
 */
export function briefExcerpt(blocks: readonly MarkdownBlock[]): {
  readonly blocks: readonly MarkdownBlock[];
  readonly complete: boolean;
} {
  const run = blocks.findIndex((block) => !flows(block));
  const leading = run === -1 ? blocks : blocks.slice(0, run);
  if (leading.length > 0) return { blocks: leading, complete: leading.length === blocks.length };
  const words = markdownPlainText(blocks).replace(/\s+/g, " ").trim();
  return {
    blocks: words
      ? [{ type: "paragraph", content: [{ type: "text", text: words, styles: {} }] }]
      : [],
    complete: false,
  };
}

const BRIEF_LINES = 3;
/** The Blocks a line of text can end: a paragraph, list item, heading or quote. */
const TEXT_BLOCKS = "p, li, h1, h2, h3, h4, blockquote";

/** The visual lines of a text, from the boxes its words take up. */
function textLines(root: HTMLElement): readonly { top: number; bottom: number }[] {
  // Only the words' own boxes: a range over an element also reports the element's box.
  const range = root.ownerDocument.createRange();
  const words = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const found: DOMRect[] = [];
  for (let text = words.nextNode(); text; text = words.nextNode()) {
    range.selectNodeContents(text);
    found.push(...range.getClientRects());
  }
  const boxes = found
    .filter((box) => box.width > 0 && box.height > 0)
    .toSorted((a, b) => a.top - b.top);
  const lines: { top: number; bottom: number }[] = [];
  for (const box of boxes) {
    const line = lines.at(-1);
    if (line && box.top + box.height / 2 <= line.bottom)
      line.bottom = Math.max(line.bottom, box.bottom);
    else lines.push({ top: box.top, bottom: box.bottom });
  }
  return lines;
}

/**
 * Where a brief ends. Past three lines the clamp ends the third with an ellipsis, unless that
 * line finishes a paragraph, list item or heading: an ellipsis after a finished sentence reads as
 * a typo, so the brief stops at that Block's edge instead. `cut` is that edge, from the top.
 */
function measureBrief(root: HTMLElement): {
  readonly clipped: boolean;
  readonly cut: number | null;
} {
  // A clamp lays out no lines past its last, so the text is read unclamped for this one
  // synchronous measurement, which no frame ever paints.
  const { style } = root;
  const held = { display: style.display, clamp: style.webkitLineClamp, height: style.maxHeight };
  style.display = "block";
  style.webkitLineClamp = "none";
  style.maxHeight = "none";
  try {
    const lines = textLines(root);
    const last = lines[BRIEF_LINES - 1];
    const next = lines[BRIEF_LINES];
    if (!last || !next) return { clipped: false, cut: null };
    const ends = [...root.querySelectorAll(TEXT_BLOCKS)]
      .map((block) => block.getBoundingClientRect().bottom)
      .filter((bottom) => bottom >= last.bottom - 1 && bottom <= next.top + 1);
    return {
      clipped: true,
      cut: ends.length > 0 ? Math.ceil(Math.min(...ends) - root.getBoundingClientRect().top) : null,
    };
  } finally {
    style.display = held.display;
    style.webkitLineClamp = held.clamp;
    style.maxHeight = held.height;
  }
}

/**
 * Text written for the reader by someone else, read as a brief: its opening three lines, ending
 * in an ellipsis when a sentence runs on, and `Show more` to read the whole text in place. Beneath a
 * headline the opening recedes, so the headline leads; opened, the whole text reads at full
 * strength. `contentKey` identifies the text, so an opened brief closes again when it changes.
 * `lead` opens the first line. Typography comes from `className` and the surrounding text.
 */
export function BriefText({
  blocks,
  contentKey,
  lead,
  recede = false,
  className,
}: {
  readonly blocks: readonly MarkdownBlock[];
  readonly contentKey: string;
  readonly lead?: ReactNode;
  readonly recede?: boolean;
  readonly className?: string;
}) {
  const intl = useIntl();
  const clampRef = useRef<HTMLDivElement>(null);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [{ clipped, cut }, setEnd] = useState<ReturnType<typeof measureBrief>>({
    clipped: false,
    cut: null,
  });
  const expanded = expandedKey === contentKey;
  const excerpt = briefExcerpt(blocks);
  useLayoutEffect(() => {
    const clamp = clampRef.current;
    if (expanded || !clamp) return;
    const measure = () => {
      const end = measureBrief(clamp);
      setEnd((current) =>
        current.clipped === end.clipped && current.cut === end.cut ? current : end,
      );
    };
    measure();
    const resize = new ResizeObserver(measure);
    resize.observe(clamp);
    return () => resize.disconnect();
  }, [expanded]);
  useClippedFocusSafety(clampRef, !expanded && clipped);
  const opens = expanded || clipped || !excerpt.complete;
  const document = (shown: readonly MarkdownBlock[]) => (
    <NfmDocument
      blocks={shown}
      lead={lead}
      density="message"
      className={cn("codex-markdown min-w-0", className)}
    />
  );
  return (
    <div className="flex min-w-0 flex-col items-start gap-1">
      {expanded ? (
        document(blocks)
      ) : (
        <div
          ref={clampRef}
          data-brief-excerpt=""
          style={cut == null ? undefined : { maxHeight: cut }}
          className={cn(
            "w-full min-w-0",
            cut == null ? "line-clamp-3" : "overflow-hidden",
            // Markdown reads `--foreground` directly, so the opening recedes through it.
            recede &&
              "text-token-description-foreground [--foreground:var(--color-token-description-foreground)]",
          )}
        >
          {document(excerpt.blocks)}
        </div>
      )}
      {opens ? (
        <button
          type="button"
          aria-expanded={expanded}
          data-markdown-copy="exclude"
          className="cursor-interaction inline-flex items-center gap-1 text-xs text-token-description-foreground hover:text-token-foreground"
          onClick={() => setExpandedKey(expanded ? null : contentKey)}
        >
          {expanded
            ? intl.formatMessage({
                id: "components.briefText.showLess",
                defaultMessage: "Show less",
              })
            : intl.formatMessage({
                id: "components.briefText.showMore",
                defaultMessage: "Show more",
              })}
          <ChevronDownIcon
            className={cn("icon-2xs transition-transform duration-150", expanded && "rotate-180")}
          />
        </button>
      ) : null}
    </div>
  );
}
