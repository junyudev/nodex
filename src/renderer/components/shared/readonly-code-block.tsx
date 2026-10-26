import { useEffect, useState, type CSSProperties } from "react";
import type { HighlightOptions, HighlightResult } from "@streamdown/code";
import { CodeBlockReadOnlyHeader } from "@/components/shared/code-block-readonly-header";
import {
  CODE_TOKEN_CLASS_NAME,
  projectCodeTokenStyle,
  resolveReadonlyCodeLanguage,
} from "@/lib/code-block-presentation";
import { streamdownCodePlugin } from "@/lib/markdown/markdown-code-highlighter";
import { CODE_BLOCK_THEME_PAIR } from "@/lib/syntax-highlighting";
import { cn } from "@/lib/utils";

const themes: HighlightOptions["themes"] = [...CODE_BLOCK_THEME_PAIR];

function useHighlightedCode(code: string, language: string): HighlightResult | null {
  const [highlighted, setHighlighted] = useState<{
    code: string;
    language: string;
    result: HighlightResult;
  } | null>(null);
  useEffect(() => {
    let active = true;
    const accept = (result: HighlightResult) => {
      if (active) setHighlighted({ code, language, result });
    };
    const result = streamdownCodePlugin.highlight(
      { code, language: language as HighlightOptions["language"], themes },
      accept,
    );
    if (result) accept(result);
    return () => {
      active = false;
    };
  }, [code, language]);
  return highlighted?.code === code && highlighted.language === language
    ? highlighted.result
    : null;
}

/**
 * Fenced code outside the editor: thread messages, Markdown documents, and NFM previews share
 * one surface, language label, Copy control, and dual-theme token projection.
 */
export function ReadonlyCodeBlock({
  code,
  language,
  incomplete = false,
  revealActions = "hover",
  className,
}: {
  readonly code: string;
  /** A catalog ID or an authored fence info token. */
  readonly language: string;
  /** A streaming fence that has not closed yet. */
  readonly incomplete?: boolean;
  /** Reading surfaces keep controls out of the way until the pointer or focus arrives. */
  readonly revealActions?: "hover" | "always";
  readonly className?: string;
}) {
  const { id, highlightLanguage } = resolveReadonlyCodeLanguage(language);
  const result = useHighlightedCode(code, highlightLanguage);
  return (
    <figure
      data-readonly-code-block
      data-language={id}
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
        <CodeBlockReadOnlyHeader language={language} code={code} disabled={incomplete} />
      </div>
      <pre className="m-0 overflow-x-auto px-[22px] py-6 font-mono text-size-code leading-[max(1.5em,20px)] [tab-size:2]">
        <code className="whitespace-pre">
          {result
            ? result.tokens.map((line, lineIndex) => (
                <span key={lineIndex} className="block min-h-lh">
                  {line.map((token, index) => (
                    <span
                      key={index}
                      className={CODE_TOKEN_CLASS_NAME}
                      style={projectCodeTokenStyle(token) as CSSProperties}
                    >
                      {token.content}
                    </span>
                  ))}
                  {lineIndex < result.tokens.length - 1 ? "\n" : ""}
                </span>
              ))
            : code}
        </code>
      </pre>
    </figure>
  );
}
