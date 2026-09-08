import { cn } from "../../../../../lib/utils";
import type { NodexMarkdownChangePreview } from "../../../projection/tool-metadata/nodex-dynamic-tool-call-presentation";

export function NodexDynamicToolChangePreview({ change }: { change: NodexMarkdownChangePreview }) {
  const compactRemovedLines = change.lines.filter((line) => line.kind === "removed").slice(0, 2);
  const compactAddedLines = change.lines.filter((line) => line.kind === "added").slice(0, 2);
  const compactLines =
    compactRemovedLines.length > 0 && compactAddedLines.length > 0
      ? [...compactRemovedLines, ...compactAddedLines]
      : change.lines.filter((line) => line.kind !== "separator").slice(0, 4);
  const visibleLines = compactLines;
  const renderedChangeLineCount = change.lines.filter((line) => line.kind !== "separator").length;
  const visibleChangeLineCount = visibleLines.filter((line) => line.kind !== "separator").length;
  const omittedLineCount =
    change.omittedLineCount + Math.max(0, renderedChangeLineCount - visibleChangeLineCount);
  const stats = [
    change.additions > 0 ? `+${change.additions}` : null,
    change.deletions > 0 ? `−${change.deletions}` : null,
  ]
    .filter((value): value is string => value !== null)
    .join(" ");

  return (
    <div
      className={cn(
        "overflow-hidden rounded-md bg-token-bg-secondary/40 ring-[0.5px] ring-token-border-light",
        "mt-1.5",
      )}
    >
      <div className="flex items-center justify-between gap-2 border-b-[0.5px] border-token-border-light px-2 py-1 text-xs text-token-description-foreground">
        <span className="truncate font-medium">{change.label}</span>
        {stats ? <span className="shrink-0 font-vscode-editor">{stats}</span> : null}
      </div>
      <div className="max-h-64 overflow-auto py-0.5 font-vscode-editor text-xs" dir="ltr">
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
