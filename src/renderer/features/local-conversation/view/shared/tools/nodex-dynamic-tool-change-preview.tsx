import { cn } from "../../../../../lib/utils";
import type { NodexMarkdownChangePreview } from "../../../projection/tool-metadata/nodex-tool-activity";

/** The Markdown an Agent wrote to a Page, as the bounded diff behind its row. */
export function NodexDynamicToolChangePreview({ change }: { change: NodexMarkdownChangePreview }) {
  const { lines: visibleLines, omittedLineCount } = change;

  return (
    <div className="overflow-hidden rounded-md bg-token-bg-secondary/40 ring-[0.5px] ring-token-border-light">
      <div className="truncate border-b-[0.5px] border-token-border-light px-2 py-1 font-sans text-xs font-medium text-token-description-foreground">
        {change.label}
      </div>
      <div
        className="codex-tool-code max-h-64 overflow-auto py-0.5 font-code text-size-code"
        dir="ltr"
      >
        {visibleLines.map((line, index) => {
          if (line.kind === "separator") {
            return (
              <div
                key={`${line.kind}-${index}`}
                className="px-2 py-0.5 text-token-description-foreground"
              >
                ··· {line.text} ···
              </div>
            );
          }

          const isAdded = line.kind === "added";
          return (
            <div
              key={`${line.kind}-${index}`}
              className={cn(
                "grid min-w-max grid-cols-[1.5rem_1fr] px-1.5 py-px",
                isAdded
                  ? "bg-[var(--diff-add-line-bg)] text-[color:var(--diff-add)]"
                  : "bg-[var(--diff-remove-line-bg)] text-[color:var(--diff-remove)]",
              )}
            >
              <span className="select-none">{isAdded ? "+" : "−"}</span>
              <span className="whitespace-pre-wrap break-words text-token-foreground/80">
                {line.text || " "}
              </span>
            </div>
          );
        })}
        {visibleLines.length === 0 ? (
          <div className="px-2 py-1 text-token-description-foreground">Empty change content</div>
        ) : null}
        {omittedLineCount > 0 ? (
          <div className="px-2 py-1 text-token-description-foreground">
            {omittedLineCount} more changed {omittedLineCount === 1 ? "line" : "lines"}
          </div>
        ) : null}
      </div>
    </div>
  );
}
