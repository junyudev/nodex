import { FormattedMessage, useIntl } from "@/lib/i18n";
import { NodexButton } from "@/components/ui/button";
import {
  NodexPopover,
  NodexPopoverContent,
  NodexPopoverTitle,
  NodexPopoverTrigger,
} from "@/components/ui/popover";

export function LocalEnvironmentVariablesPopover() {
  const intl = useIntl();
  return (
    <NodexPopover>
      <NodexPopoverTrigger>
        <NodexButton size="composer" variant="secondary">
          <FormattedMessage
            id="workbench.localEnvironmentVariablesPopover.variables"
            defaultMessage={"Variables"}
          />
        </NodexButton>
      </NodexPopoverTrigger>
      <NodexPopoverContent
        align="end"
        className="w-80 max-w-[20rem] gap-1 p-1"
        role="dialog"
        aria-labelledby="local-environment-variables-title"
      >
        <NodexPopoverTitle
          id="local-environment-variables-title"
          className="px-2 py-1 text-sm font-medium text-token-text-primary"
        >
          <FormattedMessage
            id="workbench.localEnvironmentVariablesPopover.setupVariables"
            defaultMessage={"Setup script environment variables"}
          />
        </NodexPopoverTitle>
        {[
          [
            intl.formatMessage({
              id: "workbench.localEnvironmentVariablesPopover.sourceWorkspacePath",
              defaultMessage: "Source workspace path",
            }),
            "CODEX_SOURCE_TREE_PATH",
          ],
          [
            intl.formatMessage({
              id: "workbench.localEnvironmentVariablesPopover.newWorktreePath",
              defaultMessage: "New worktree path",
            }),
            "CODEX_WORKTREE_PATH",
          ],
        ].map(([description, variable]) => (
          <div key={variable} className="flex flex-col gap-0.5 rounded-lg px-2 py-1.5">
            <span className="text-sm text-token-text-primary">{description}</span>
            <code className="text-xs text-token-text-secondary">{variable}</code>
          </div>
        ))}
      </NodexPopoverContent>
    </NodexPopover>
  );
}
