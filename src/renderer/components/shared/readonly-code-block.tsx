import { useEffect, useRef, useState, type CSSProperties } from "react";
import { CodeBlockReadOnlyHeader } from "@/components/shared/code-block-readonly-header";
import {
  CODE_TOKEN_CLASS_NAME,
  projectCodeTokenStyle,
  resolveReadonlyCodeLanguage,
} from "@/lib/code-block-presentation";
import { CODE_BLOCK_SYNTAX_THEME_NAME } from "@/lib/code-block-syntax-theme";
import { useCodeBlockWordWrap } from "@/lib/code-block-word-wrap";
import {
  requestCodeHighlight,
  supportsCodeHighlight,
} from "@/lib/markdown/markdown-code-highlight-client";
import {
  CODE_HIGHLIGHT_VIEWPORT_MARGIN,
  createCodeHighlightScheduler,
  MAX_WORKER_CODE_UNITS,
  type CodeHighlightResult,
} from "@/lib/markdown/markdown-code-highlight-queue";
import { cn } from "@/lib/utils";

function useHighlightedCode(
  code: string,
  language: string,
  incomplete: boolean,
  deferUntilVisible: boolean,
) {
  const figure = useRef<HTMLElement>(null);
  const [admitted, setAdmitted] = useState(false);
  const [highlighted, setHighlighted] = useState<CodeHighlightResult | null>(null);
  const [scheduler] = useState(() =>
    createCodeHighlightScheduler(requestCodeHighlight, setHighlighted),
  );
  const supported = code.length > 0 && supportsCodeHighlight(language);
  const inBudget = code.length <= MAX_WORKER_CODE_UNITS;
  const deferred = deferUntilVisible && !admitted && typeof IntersectionObserver !== "undefined";

  useEffect(() => {
    const target = figure.current;
    if (!deferred || !supported || !inBudget || !target) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        setAdmitted(true);
      },
      { rootMargin: `${CODE_HIGHLIGHT_VIEWPORT_MARGIN}px 0px` },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [deferred, supported, inBudget]);

  useEffect(() => () => scheduler.cancel(), [scheduler]);
  useEffect(() => {
    if (deferred || !supported || !inBudget) {
      scheduler.cancel();
      return;
    }
    scheduler.update({ code, language, incomplete, theme: CODE_BLOCK_SYNTAX_THEME_NAME }, () => {
      const element = figure.current;
      const viewport = element?.ownerDocument.defaultView;
      if (!element?.isConnected || !viewport) return false;
      if (typeof viewport.IntersectionObserver === "undefined") return true;
      if (!element.checkVisibility()) return false;
      const { bottom, top, left, right } = element.getBoundingClientRect();
      return (
        bottom > -CODE_HIGHLIGHT_VIEWPORT_MARGIN &&
        top < viewport.innerHeight + CODE_HIGHLIGHT_VIEWPORT_MARGIN &&
        right > 0 &&
        left < viewport.innerWidth
      );
    });
  }, [scheduler, deferred, supported, inBudget, code, language, incomplete]);

  const prefix =
    supported &&
    inBudget &&
    highlighted?.language === language &&
    highlighted.theme === CODE_BLOCK_SYNTAX_THEME_NAME &&
    code.startsWith(highlighted.code)
      ? highlighted
      : null;
  return { figure, prefix };
}

function HighlightedCode({
  prefix,
  suffix,
}: {
  readonly prefix: CodeHighlightResult;
  readonly suffix: string;
}) {
  // Keep the mapped tokens independent of the raw suffix while the stream advances.
  const rows = prefix.paint.tokens.map((line) =>
    line.map((token, index) => (
      <span
        key={index}
        className={CODE_TOKEN_CLASS_NAME}
        style={projectCodeTokenStyle(token) as CSSProperties}
      >
        {token.content}
      </span>
    )),
  );
  const completed = rows.slice(0, -1).map((line, index) => (
    <span key={index} className="block min-h-lh">
      {line}
      {"\n"}
    </span>
  ));
  return (
    <>
      {completed}
      <span className="block min-h-lh">
        {rows.at(-1)}
        {suffix}
      </span>
    </>
  );
}

/**
 * Fenced code outside the editor: thread messages, Markdown documents, and NFM previews share
 * one surface, language label, Copy control, and dual-theme token projection.
 */
export function ReadonlyCodeBlock({
  code,
  language,
  incomplete = false,
  deferUntilVisible = false,
  revealActions = "hover",
  className,
}: {
  readonly code: string;
  /** A catalog ID or an authored fence info token. */
  readonly language: string;
  /** A streaming fence that has not closed yet. */
  readonly incomplete?: boolean;
  /** Delay the first highlight until the block nears the viewport. */
  readonly deferUntilVisible?: boolean;
  /** Reading surfaces keep controls out of the way until the pointer or focus arrives. */
  readonly revealActions?: "hover" | "always";
  readonly className?: string;
}) {
  const { id, highlightLanguage } = resolveReadonlyCodeLanguage(language);
  const { figure, prefix } = useHighlightedCode(
    code,
    highlightLanguage,
    incomplete,
    deferUntilVisible,
  );
  const wrap = useCodeBlockWordWrap();
  return (
    <figure
      ref={figure}
      data-readonly-code-block
      data-language={id}
      data-wrapped={wrap.wrapped}
      className={cn(
        "group/code relative mx-0 my-3 overflow-hidden rounded-[10px] bg-[var(--code-block-bg)] text-[var(--foreground)]",
        className,
      )}
    >
      <div
        data-content-search-skip="true"
        className={cn(
          "absolute top-1 right-1 z-[3]",
          revealActions === "hover" &&
            "opacity-0 group-hover/code:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100",
        )}
      >
        <CodeBlockReadOnlyHeader
          language={language}
          code={code}
          disabled={incomplete}
          wrap={{ wrapped: wrap.wrapped, onToggle: wrap.toggle }}
        />
      </div>
      <pre className="m-0 overflow-x-auto px-[22px] py-6 font-mono text-size-code leading-[max(1.5em,20px)] [tab-size:2]">
        <code className={wrap.wrapped ? "wrap-break-word whitespace-pre-wrap" : "whitespace-pre"}>
          {prefix ? (
            <HighlightedCode prefix={prefix} suffix={code.slice(prefix.code.length)} />
          ) : (
            code
          )}
        </code>
      </pre>
    </figure>
  );
}
