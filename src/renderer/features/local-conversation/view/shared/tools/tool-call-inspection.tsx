import { useId, useRef, useState, type ReactNode } from "react";
import { CodeIcon } from "@/components/shared/icons";
import {
  NodexDialog as Dialog,
  NodexDialogBody as DialogBody,
  NodexDialogContent as DialogContent,
  NodexDialogFrame as DialogFrame,
  NodexDialogHeader as DialogHeader,
  NodexDialogTitle as DialogTitle,
} from "../../../../../components/ui/dialog";
import { NodexTooltip } from "../../../../../components/ui/tooltip";
import { cn } from "../../../../../lib/utils";
import {
  CopyMessageActionButton,
  threadMessageActionButtonClassName,
} from "../thread-message-actions";
import { LazySourceViewer, preloadSourceViewer } from "@/components/ui/lazy-source-viewer";
import {
  buildTextPreview,
  INLINE_TEXT_PREVIEW_MAX_CHARS,
  type TextPreview,
} from "@/lib/text-preview";

const electronToolIconSizeClassName = "electron:[&>svg]:icon-sm";

export function stringifyToolCallValue(value: unknown): string {
  try {
    return (
      JSON.stringify(
        value,
        (_key, entry) => (typeof entry === "bigint" ? entry.toString() : entry),
        2,
      ) ?? String(value)
    );
  } catch {
    return String(value);
  }
}

export function ToolCallCodePanel({
  title,
  preview,
  actions,
  getCopyText,
  getFullText,
  bodyClassName,
  preClassName,
  stickyHeaderClassName,
  previewCharacterLimit = INLINE_TEXT_PREVIEW_MAX_CHARS,
}: {
  title: string;
  preview: TextPreview;
  /** Inspection controls shown before Copy in the panel toolbar. */
  actions?: ReactNode;
  getCopyText?: () => string;
  getFullText?: () => string;
  bodyClassName?: string;
  preClassName?: string;
  stickyHeaderClassName?: string;
  /** Null preserves a payload whose producing protocol already bounds its size. */
  previewCharacterLimit?: number | null;
}) {
  const [fullTextOpen, setFullTextOpen] = useState(false);
  const boundedPreview =
    previewCharacterLimit === null || preview.text.length <= previewCharacterLimit
      ? preview
      : buildTextPreview(preview.text, previewCharacterLimit);
  return (
    <div
      className="bg-token-text-code-block-background border-token-border-heavy relative overflow-clip rounded-lg border contain-inline-size dark"
      data-theme="dark"
    >
      <div
        className={cn(
          "sticky top-0 z-10 flex items-center justify-between py-1 ps-2 pe-2 font-sans text-sm text-token-description-foreground select-none",
          stickyHeaderClassName,
        )}
      >
        <div className="min-w-0 truncate">{title}</div>
        <div className="flex items-center">
          {actions}
          {boundedPreview.kind === "omitted" && getFullText ? (
            <ToolCallRawDialog
              open={fullTextOpen}
              onOpenChange={setFullTextOpen}
              title={`Full ${title}`}
              getRawText={getFullText}
              triggerLabel={`View full ${title}`}
              triggerKind="text"
              triggerText="View full"
            />
          ) : null}
          {getCopyText ? (
            <CopyMessageActionButton
              getText={getCopyText}
              label="Copy"
              copiedLabel="Copied"
              tooltipLabel="Copy"
              copiedTooltipLabel="Copied"
              className="enabled:hover:bg-token-list-hover-background data-[state=open]:bg-token-list-hover-background"
            />
          ) : null}
        </div>
      </div>
      <div className={cn("text-size-chat max-h-48 overflow-y-auto p-2", bodyClassName)} dir="ltr">
        <pre className={cn("m-0 whitespace-pre-wrap break-words", preClassName)}>
          {boundedPreview.text}
        </pre>
      </div>
    </div>
  );
}

export function ToolCallRawDialog({
  open,
  onOpenChange,
  title,
  getRawText,
  getRawValue,
  triggerLabel,
  triggerKind = "icon",
  triggerText = "Raw",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  getRawText?: () => string;
  getRawValue?: () => unknown;
  triggerLabel: string;
  /** `toolbar` sits beside a code panel's Copy; `icon` reveals itself on row hover. */
  triggerKind?: "icon" | "toolbar" | "text";
  triggerText?: string;
}) {
  const dialogId = useId();
  const contentRef = useRef<HTMLDivElement | null>(null);
  const trigger = (
    <button
      type="button"
      className={cn(
        triggerKind === "toolbar"
          ? threadMessageActionButtonClassName
          : "border-token-border user-select-none no-drag cursor-interaction flex items-center justify-center gap-1 border border-transparent text-token-description-foreground focus:outline-none disabled:cursor-not-allowed disabled:opacity-40 enabled:hover:bg-token-list-hover-background data-[state=open]:bg-token-list-hover-background",
        triggerKind === "icon" &&
          "rounded-full p-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100 electron:rounded-md electron:p-1",
        triggerKind === "icon" && electronToolIconSizeClassName,
        triggerKind === "text" && "rounded-md px-1.5 py-1 text-xs font-medium",
      )}
      aria-label={triggerLabel}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={dialogId}
      data-state={open ? "open" : "closed"}
      onClick={() => {
        onOpenChange(true);
      }}
      onPointerEnter={preloadSourceViewer}
      onFocus={preloadSourceViewer}
    >
      <CodeIcon className={triggerKind === "toolbar" ? "icon-xs electron:icon-sm" : "icon-xxs"} />
      {triggerKind === "text" ? <span>{triggerText}</span> : null}
    </button>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {triggerKind === "text" ? (
        trigger
      ) : (
        <NodexTooltip tooltipContent={triggerLabel} side="top" delay={0}>
          {trigger}
        </NodexTooltip>
      )}
      <DialogContent
        id={dialogId}
        ref={contentRef}
        tabIndex={-1}
        showCloseButton={false}
        aria-describedby={undefined}
        initialFocus={contentRef}
        size="large"
      >
        {open ? (
          <ToolCallRawFrame title={title} getRawText={getRawText} getRawValue={getRawValue} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** One copyable code surface; raw values are JSON, full previews keep their own text. */
function ToolCallRawFrame({
  title,
  getRawText,
  getRawValue,
}: {
  readonly title: string;
  readonly getRawText?: () => string;
  readonly getRawValue?: () => unknown;
}) {
  const [rawText] = useState(() =>
    getRawText ? getRawText() : stringifyToolCallValue(getRawValue?.()),
  );

  return (
    <DialogFrame>
      <DialogHeader className="flex-row items-center justify-between gap-3">
        <DialogTitle className="truncate">{title}</DialogTitle>
        <CopyMessageActionButton
          getText={() => rawText}
          label="Copy"
          copiedLabel="Copied"
          tooltipLabel="Copy"
          copiedTooltipLabel="Copied"
        />
      </DialogHeader>
      {/* Short values fit their content; longer ones scroll inside the capped surface. */}
      <DialogBody className="max-h-[min(65vh,40rem)] min-h-0">
        <div className="flex min-h-0 flex-col overflow-hidden rounded-[10px] bg-[var(--code-block-bg)] py-3 ps-1 [--codex-diffs-surface-override:transparent]">
          <LazySourceViewer
            value={rawText}
            ariaLabel={title}
            language={getRawText ? null : "json"}
            syntaxTheme="code-block"
            wrap
            className="flex h-auto flex-col"
          />
        </div>
      </DialogBody>
    </DialogFrame>
  );
}
