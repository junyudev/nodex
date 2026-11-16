import { useIntl } from "@/lib/i18n";
import { BudgetedMarkdownRenderer } from "@/features/local-conversation/view/shared/markdown/budgeted-markdown-renderer";

export function PlanSidePanelTab({ content, cwd }: { content: string; cwd?: string | null }) {
  const intl = useIntl();
  return (
    <div className="h-full min-h-0 overflow-y-auto px-1">
      <div className="px-4 py-3">
        <BudgetedMarkdownRenderer
          content={content}
          parseIncompleteMarkdown={false}
          cwd={cwd}
          className="codex-markdown-plan text-size-chat"
          sourceAriaLabel={intl.formatMessage({
            id: "workbench.planSidePanelTab.planSource",
            defaultMessage: "Plan source",
          })}
        />
      </div>
    </div>
  );
}
