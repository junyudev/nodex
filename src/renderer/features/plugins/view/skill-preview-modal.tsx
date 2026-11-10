import type { CSSProperties, ReactNode } from "react";
import { ActivitySpinnerIcon } from "@/components/shared/icons";
import { MarkdownRenderer } from "@/features/local-conversation/view/shared/markdown/markdown-renderer";
import { skillMarkdownBody } from "../model/plugin-detail-model";
import {
  useSkillContents,
  type PluginContext,
  type SkillContentsSelector,
} from "../plugin-management";

const MARKDOWN_STYLE = { "--markdown-font-size": "var(--text-sm)" } as CSSProperties;

/**
 * A skill's SKILL.md inside a bordered, scrolling card. It loads when mounted, which is when its
 * dialog opens.
 */
export function SkillInstructions({
  context,
  selector,
}: {
  readonly context: PluginContext;
  readonly selector: SkillContentsSelector | null;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col pt-4">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-(--color-border)/70 bg-(--color-surface-secondary)/40">
        <div className="h-full min-h-0 overflow-y-auto p-4">
          {selector == null ? (
            <SkillInstructionsMessage>Unable to load skill contents.</SkillInstructionsMessage>
          ) : (
            <LoadedSkillInstructions context={context} selector={selector} />
          )}
        </div>
      </div>
    </div>
  );
}

function SkillInstructionsMessage({ children }: { readonly children: ReactNode }) {
  return <div className="text-sm text-(--color-text-secondary)">{children}</div>;
}

function LoadedSkillInstructions({
  context,
  selector,
}: {
  readonly context: PluginContext;
  readonly selector: SkillContentsSelector;
}) {
  const query = useSkillContents(context, selector);
  if (query.isPending) {
    return (
      <div className="flex items-center gap-2 text-sm text-(--color-text-secondary)">
        <ActivitySpinnerIcon className="icon-xs" />
        Loading skill contents...
      </div>
    );
  }
  if (query.isError || query.data.status === "failed") {
    return <SkillInstructionsMessage>Unable to load skill contents.</SkillInstructionsMessage>;
  }
  const markdown = skillMarkdownBody(query.data.contents ?? "");
  if (markdown.trim().length === 0) {
    return <SkillInstructionsMessage>No instructions available yet</SkillInstructionsMessage>;
  }
  return (
    <MarkdownRenderer
      content={markdown}
      style={MARKDOWN_STYLE}
      className="text-sm [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
    />
  );
}
