import { useIntl } from "@/lib/i18n";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { NodexButton } from "@/components/ui/button";
import { NodexTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export interface GitHubEditorAction {
  readonly id: string;
  readonly label: string;
  /** Resolves true once GitHub has the text, which then leaves the editor. */
  readonly submit: (body: string) => Promise<boolean>;
  /** Off for actions GitHub takes without words, such as an approval. */
  readonly requiresText?: boolean;
  readonly disabled?: boolean;
  readonly tooltip?: string;
}

/**
 * Markdown written back to GitHub: a reply, a line comment, an edit. The last action is the
 * primary one and takes `Cmd/Ctrl+Enter`; Escape cancels. Text stays until an action succeeds.
 */
export function GitHubMarkdownEditor({
  initialValue = "",
  placeholder,
  ariaLabel,
  actions,
  onCancel,
  hint,
  autoFocus = true,
  className,
}: {
  readonly initialValue?: string;
  readonly placeholder: string;
  readonly ariaLabel: string;
  readonly actions: readonly GitHubEditorAction[];
  readonly onCancel?: () => void;
  /** A quiet line on the left of the buttons, such as who will see the comment. */
  readonly hint?: ReactNode;
  readonly autoFocus?: boolean;
  readonly className?: string;
}) {
  const intl = useIntl();
  const [value, setValue] = useState(initialValue);
  const [busy, setBusy] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    if (!autoFocus) return;
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }, [autoFocus]);

  const hasText = value.trim().length > 0;
  const enabled = (action: GitHubEditorAction) =>
    busy === null && !action.disabled && (action.requiresText === false || hasText);
  const submit = async (action: GitHubEditorAction) => {
    if (!enabled(action)) return;
    setBusy(action.id);
    const done = await action.submit(value.trim()).finally(() => setBusy(null));
    if (done) setValue("");
  };
  const primary = actions.at(-1);

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape" && onCancel && busy === null) {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
      return;
    }
    if (event.key !== "Enter" || event.repeat || event.shiftKey) return;
    if (!(event.metaKey || event.ctrlKey) || !primary) return;
    event.preventDefault();
    void submit(primary);
  };

  return (
    <div
      data-github-editor=""
      className={cn(
        "flex flex-col rounded-lg bg-token-input-background ring-[0.5px] ring-token-border ring-inset focus-within:ring-token-focus-border",
        className,
      )}
    >
      <textarea
        ref={textareaRef}
        aria-label={ariaLabel}
        rows={3}
        value={value}
        readOnly={busy !== null}
        placeholder={placeholder}
        onChange={(event) => setValue(event.currentTarget.value)}
        onKeyDown={handleKeyDown}
        className="block max-h-96 min-h-16 w-full resize-none bg-transparent px-3 pt-2.5 pb-1 text-sm leading-5 text-token-text-primary outline-none [field-sizing:content] placeholder:text-token-input-placeholder-foreground placeholder:opacity-60"
      />
      <div className="flex min-h-9 items-center gap-1.5 px-2 pb-2">
        <div className="min-w-0 flex-1 truncate pl-1 text-xs text-token-description-foreground">
          {hint}
        </div>
        {onCancel ? (
          <NodexButton size="toolbar" variant="ghost" disabled={busy !== null} onClick={onCancel}>
            {intl.formatMessage({ id: "githubThread.editor.cancel", defaultMessage: "Cancel" })}
          </NodexButton>
        ) : null}
        {actions.map((action) => {
          const button = (
            <NodexButton
              key={action.id}
              size="toolbar"
              variant={action === primary ? "primary" : "secondary"}
              disabled={!enabled(action)}
              aria-busy={busy === action.id}
              onClick={() => void submit(action)}
            >
              {action.label}
            </NodexButton>
          );
          const tooltip = action.tooltip ?? (action === primary ? action.label : null);
          return tooltip ? (
            <NodexTooltip
              key={action.id}
              tooltipContent={tooltip}
              shortcutLabel={action === primary ? "⌘↵" : undefined}
              side="top"
            >
              <span className="inline-flex">{button}</span>
            </NodexTooltip>
          ) : (
            button
          );
        })}
      </div>
    </div>
  );
}
