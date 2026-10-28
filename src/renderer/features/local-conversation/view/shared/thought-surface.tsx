import { motion } from "motion/react";
import { useLayoutEffect, useRef, useState } from "react";
import {
  resolveThoughtExcerpt,
  resolveThoughtHeading,
} from "../../../../../shared/thought-presentation";
import type { CodexTranscriptEntry } from "../../../../lib/types";
import { cn } from "../../../../lib/utils";
import { formatThoughtLabel } from "../../thread-thought-label";
import { BudgetedMarkdownRenderer } from "./markdown/budgeted-markdown-renderer";
import { CODEX_THREAD_ACCORDION_TRANSITION } from "./thread-motion";
import { ThreadActivityDisclosure } from "./tools/tool-primitives";
import { useMeasuredElementHeight } from "./use-measured-element-height";

type ThoughtItem = Pick<CodexTranscriptEntry, "markdownText" | "status" | "thought">;

interface ThoughtMarkdownProps {
  readonly cwd?: string | null;
  readonly projectWorkspacePath?: string | null;
}

const THOUGHT_MARKDOWN_CLASS_NAME =
  "break-words text-size-chat text-token-foreground/60 [&_*]:text-size-chat [&_*]:text-token-foreground/50 [&_h1]:m-0 [&_h1]:mt-2 [&_h1]:font-semibold [&_h1+*]:mt-1 [&_h2]:m-0 [&_h2]:mt-2 [&_h2]:font-semibold [&_h2+*]:mt-1 [&_h3]:m-0 [&_h3]:mt-2 [&_h3]:font-semibold [&_h3+*]:mt-1 [&_li]:m-0 [&_ol]:my-0 [&_ol]:list-decimal [&_ol]:pl-4 [&_p]:m-0 [&_p]:has-[.inline-markdown]:py-0.5 [&_p+p]:mt-1 [&_ul]:my-0 [&_ul]:list-disc [&_ul]:pl-4";

const LIVE_THOUGHT_MAX_HEIGHT_CLASS_NAME =
  "max-h-[calc(var(--codex-chat-font-size)*var(--leading-relaxed)*5)]";

function ThoughtMarkdown({
  markdown,
  streaming,
  cwd,
  projectWorkspacePath,
}: ThoughtMarkdownProps & { readonly markdown: string; readonly streaming: boolean }) {
  return (
    <BudgetedMarkdownRenderer
      content={markdown}
      parseIncompleteMarkdown={streaming}
      cwd={cwd}
      projectWorkspacePath={projectWorkspacePath}
      sourceAriaLabel="Thought source"
      className={THOUGHT_MARKDOWN_CLASS_NAME}
    />
  );
}

/** A complete Thought: it reads in full inside a bounded scroll, pinned to its latest line while live. */
function ThoughtScroll({
  markdown,
  streaming,
  maxHeightClassName,
  ...markdownProps
}: ThoughtMarkdownProps & {
  readonly markdown: string;
  readonly streaming: boolean;
  readonly maxHeightClassName: string;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // After every render, so each streamed revision keeps the newest text in view.
  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (streaming && container) container.scrollTop = container.scrollHeight;
  });
  return (
    <div
      ref={scrollRef}
      className={cn(
        "vertical-scroll-fade-mask overflow-y-auto [--edge-fade-distance:1rem]",
        maxHeightClassName,
      )}
    >
      <ThoughtMarkdown markdown={markdown} streaming={streaming} {...markdownProps} />
    </div>
  );
}

/**
 * Prose thinking as it streams, under the Thinking status line: a few lines that follow the newest
 * text. A Thought with a heading has that heading as its status line instead. The preview folds away
 * when the Thought ends or work begins, keeping its last text while it closes.
 */
export function ThoughtLivePreview({
  item,
  active,
  ...markdownProps
}: ThoughtMarkdownProps & { readonly item: ThoughtItem; readonly active: boolean }) {
  const markdown = item.markdownText ?? "";
  const visible =
    active &&
    item.status === "inProgress" &&
    markdown.trim().length > 0 &&
    resolveThoughtHeading(markdown) === null;
  const [shownVisible, setShownVisible] = useState(visible);
  const [closing, setClosing] = useState(false);
  if (shownVisible !== visible) {
    setShownVisible(visible);
    setClosing(!visible);
  }
  const { elementHeightPx, elementRef } = useMeasuredElementHeight();
  const rendered = visible || closing;

  return (
    <motion.div
      initial={false}
      animate={{ height: visible ? elementHeightPx : 0, opacity: visible ? 1 : 0 }}
      transition={CODEX_THREAD_ACCORDION_TRANSITION}
      onAnimationComplete={() => {
        if (!visible) setClosing(false);
      }}
      className="overflow-hidden"
      data-testid="thought-live-preview"
      data-thread-find-skip
      aria-hidden={!visible}
    >
      <div ref={elementRef} className="pt-1">
        {rendered ? (
          <ThoughtScroll
            markdown={markdown}
            streaming={visible}
            maxHeightClassName={LIVE_THOUGHT_MAX_HEIGHT_CLASS_NAME}
            {...markdownProps}
          />
        ) : null}
      </div>
    </motion.div>
  );
}

/**
 * One Thought among the work it belongs to: a one-line excerpt that opens to the whole Thought,
 * whose header then names how long it took instead of repeating its opening. While it streams it
 * reads like the live preview, so an open group shows it as it is written.
 */
export function ThoughtRow({
  item,
  ...markdownProps
}: ThoughtMarkdownProps & { readonly item: ThoughtItem }) {
  const markdown = item.markdownText ?? "";
  if (item.status === "inProgress") {
    return (
      <ThoughtScroll
        markdown={markdown}
        streaming
        maxHeightClassName={LIVE_THOUGHT_MAX_HEIGHT_CLASS_NAME}
        {...markdownProps}
      />
    );
  }
  const excerpt = resolveThoughtExcerpt(markdown);
  if (excerpt === null) return null;
  return (
    <ThreadActivityDisclosure
      status="completed"
      summary={(expanded) => (expanded ? formatThoughtLabel(item.thought?.durationMs) : excerpt)}
      summaryClassName="text-token-foreground/50"
      bodyClassName="pt-1"
      indentContent={false}
      testId="thought-row"
    >
      <ThoughtScroll
        markdown={markdown}
        streaming={false}
        maxHeightClassName="max-h-[8.75rem]"
        {...markdownProps}
      />
    </ThreadActivityDisclosure>
  );
}

/** A Thought on its own between replies and work: how long it took, opening to the whole Thought. */
export function ThoughtDisclosure({
  item,
  ...markdownProps
}: ThoughtMarkdownProps & { readonly item: ThoughtItem }) {
  const markdown = item.markdownText ?? "";
  if (markdown.trim().length === 0) return null;
  return (
    <ThreadActivityDisclosure
      status="completed"
      summary={formatThoughtLabel(item.thought?.durationMs)}
      bodyClassName="pt-1"
      indentContent={false}
      testId="thought-disclosure"
    >
      <ThoughtScroll
        markdown={markdown}
        streaming={false}
        maxHeightClassName="max-h-[8.75rem]"
        {...markdownProps}
      />
    </ThreadActivityDisclosure>
  );
}
