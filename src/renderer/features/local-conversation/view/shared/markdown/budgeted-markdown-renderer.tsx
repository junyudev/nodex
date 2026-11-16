import { useIntl } from "@/lib/i18n";
import { LazySourceViewer } from "@/components/ui/lazy-source-viewer";
import { classifyContentBudget } from "@/lib/content-budget";
import { MarkdownRenderer, type MarkdownRendererProps } from "./markdown-renderer";

export const RICH_MARKDOWN_MAX_BYTES = 256 * 1024;
export const RICH_MARKDOWN_MAX_LINES = 5_000;

interface BudgetedMarkdownRendererProps extends MarkdownRendererProps {
  readonly sourceAriaLabel: string;
  readonly sourceIdentity?: string;
  readonly fallbackMessage?: string;
}

export function BudgetedMarkdownRenderer({
  sourceAriaLabel,
  sourceIdentity,
  fallbackMessage,
  ...rendererProps
}: BudgetedMarkdownRendererProps) {
  const intl = useIntl();
  const budget = classifyContentBudget({
    value: rendererProps.content,
    maxBytes: RICH_MARKDOWN_MAX_BYTES,
    maxLines: RICH_MARKDOWN_MAX_LINES,
  });

  if (budget.kind === "withinBudget") {
    return <MarkdownRenderer {...rendererProps} />;
  }

  return (
    <div className="flex max-h-80 min-h-32 min-w-0 flex-col overflow-hidden rounded-lg border border-token-border-light bg-token-editor-background">
      <div className="shrink-0 px-3 py-2 text-xs text-token-description-foreground">
        {fallbackMessage ??
          intl.formatMessage({
            id: "conversation.budgetedMarkdownRenderer.tooLarge",
            defaultMessage: "Rich preview is unavailable for large content.",
          })}
      </div>
      <LazySourceViewer
        value={rendererProps.content}
        ariaLabel={sourceAriaLabel}
        sourceIdentity={sourceIdentity}
        lineNumbers
        className="min-h-0 flex-1"
      />
    </div>
  );
}
