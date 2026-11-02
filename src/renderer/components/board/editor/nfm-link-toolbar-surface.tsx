import {
  forwardRef,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { NodexButton } from "@/components/ui/button";
import {
  NfmLinkToolbarApplyIcon,
  NfmLinkToolbarClearIcon,
  NfmLinkToolbarCopyIcon,
  NfmLinkToolbarEditIcon,
  NfmLinkToolbarOpenIcon,
} from "@/components/shared/icons";
import { NodexTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { NFM_EDITOR_FLOATING_SURFACE_CHROME_CLASS } from "./nfm-editor-floating-surface";

const NFM_LINK_TOOLBAR_CLASS = cn(
  "m-0 flex h-9 w-fit min-w-0 shrink items-center overflow-hidden rounded-xl px-1 py-1",
  NFM_EDITOR_FLOATING_SURFACE_CHROME_CLASS,
);
const NFM_LINK_TOOLBAR_BUTTON_CLASS =
  "flex h-full items-center gap-2 rounded-lg px-2 outline-hidden hover:bg-black/5 dark:hover:bg-token-interactive-bg-secondary-hover disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent";

export interface NfmCompactLinkToolbarProps {
  href: string;
  canOpen: boolean;
  openTooltip: ReactNode;
  openLabel: string;
  clearTooltip: ReactNode;
  clearLabel: string;
  copyLabel: string;
  copyTooltip: ReactNode;
  copiedLabel: string;
  copiedTooltip: ReactNode;
  copyState?: "idle" | "copied";
  editTooltip: ReactNode;
  editLabel: string;
  disabledReason?: ReactNode;
  onOpenLink: (event: MouseEvent<HTMLButtonElement>) => void;
  onClearLink: () => void;
  onCopyLink: () => void;
  onEditLink: () => void;
}

export function NfmCompactLinkToolbar({
  href,
  canOpen,
  openTooltip,
  openLabel,
  clearTooltip,
  clearLabel,
  copyLabel,
  copyTooltip,
  copiedLabel,
  copiedTooltip,
  copyState = "idle",
  editTooltip,
  editLabel,
  disabledReason,
  onOpenLink,
  onClearLink,
  onCopyLink,
  onEditLink,
}: NfmCompactLinkToolbarProps) {
  const openActionTooltip = disabledReason ?? openTooltip;
  const isCopied = copyState === "copied";
  const copyActionTooltip = isCopied ? copiedTooltip : copyTooltip;
  const handleActionPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    // Keep the editor from treating toolbar interactions as selection changes.
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div
      role="toolbar"
      aria-orientation="horizontal"
      aria-label="Link actions"
      data-testid="nfm-compact-link-toolbar"
      contentEditable={false}
      tabIndex={0}
      className={NFM_LINK_TOOLBAR_CLASS}
    >
      <NodexTooltip tooltipContent={href} side="top" delay={0}>
        <span
          className="max-w-[220px] truncate px-2 text-xs text-token-text-secondary"
          data-testid="nfm-link-toolbar-preview"
        >
          {href}
        </span>
      </NodexTooltip>

      <NodexTooltip tooltipContent={editTooltip} side="top" delay={0}>
        <button
          type="button"
          contentEditable={false}
          aria-label={editLabel}
          onPointerDown={handleActionPointerDown}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onEditLink();
          }}
          className={NFM_LINK_TOOLBAR_BUTTON_CLASS}
        >
          <NfmLinkToolbarEditIcon className="size-4 text-token-text-primary" />
        </button>
      </NodexTooltip>

      <NodexTooltip tooltipContent={clearTooltip} side="top" delay={0}>
        <button
          type="button"
          contentEditable={false}
          aria-label={clearLabel}
          onPointerDown={handleActionPointerDown}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onClearLink();
          }}
          className={NFM_LINK_TOOLBAR_BUTTON_CLASS}
        >
          <NfmLinkToolbarClearIcon className="size-4 text-token-text-primary" />
        </button>
      </NodexTooltip>

      <div
        role="separator"
        aria-orientation="vertical"
        className="mx-1 h-3 w-px shrink-0 bg-token-border-default p-0"
      />

      <NodexTooltip tooltipContent={copyActionTooltip} side="top" delay={0}>
        <button
          type="button"
          contentEditable={false}
          aria-label={isCopied ? copiedLabel : copyLabel}
          onPointerDown={handleActionPointerDown}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onCopyLink();
          }}
          className={cn(
            NFM_LINK_TOOLBAR_BUTTON_CLASS,
            "text-token-text-primary",
            isCopied && "bg-token-foreground/10",
          )}
        >
          {isCopied ? (
            <NfmLinkToolbarApplyIcon className="size-4 text-token-text-primary" />
          ) : (
            <NfmLinkToolbarCopyIcon className="size-4 text-token-text-primary" />
          )}
        </button>
      </NodexTooltip>

      <NodexTooltip tooltipContent={openActionTooltip} side="top" delay={0}>
        <span className="inline-flex h-full" tabIndex={canOpen ? undefined : 0}>
          <button
            type="button"
            contentEditable={false}
            aria-label={openLabel}
            disabled={!canOpen}
            onPointerDown={handleActionPointerDown}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (!canOpen) return;
              onOpenLink(event);
            }}
            onAuxClick={(event) => {
              if (!canOpen || event.button !== 1) return;
              event.preventDefault();
              event.stopPropagation();
              onOpenLink(event);
            }}
            className={cn(NFM_LINK_TOOLBAR_BUTTON_CLASS, "text-token-text-primary")}
          >
            <NfmLinkToolbarOpenIcon className="size-4 text-token-text-primary" />
          </button>
        </span>
      </NodexTooltip>
    </div>
  );
}

export interface NfmLinkEditToolbarSurfaceProps {
  urlPlaceholder: string;
  urlValue: string;
  onUrlChange: (value: string) => void;
  onUrlKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  onApply: () => void;
}

export interface NfmCreateLinkDialogSurfaceProps {
  urlLabel: string;
  urlPlaceholder: string;
  urlValue: string;
  submitLabel: string;
  onUrlChange: (value: string) => void;
  onUrlKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  onSubmit: () => void;
  secondaryActionLabel?: string;
  onSecondaryAction?: () => void;
}

export const NfmLinkEditToolbarSurface = forwardRef<HTMLDivElement, NfmLinkEditToolbarSurfaceProps>(
  function NfmLinkEditToolbarSurface(
    { urlPlaceholder, urlValue, onUrlChange, onUrlKeyDown, onApply },
    ref,
  ) {
    const handleSurfacePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
      event.stopPropagation();
    };
    const handleActionPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
    };

    return (
      <div
        ref={ref}
        role="toolbar"
        aria-orientation="horizontal"
        aria-label="Edit link"
        data-testid="nfm-link-edit-toolbar"
        contentEditable={false}
        tabIndex={-1}
        onPointerDown={handleSurfacePointerDown}
        className={cn(NFM_LINK_TOOLBAR_CLASS, "max-w-[calc(100vw-24px)]")}
      >
        <div className="flex min-w-0 flex-1">
          <div className="relative min-w-0 flex-1">
            <input
              autoFocus
              autoComplete="off"
              type="text"
              aria-label={urlPlaceholder}
              value={urlValue}
              placeholder={urlPlaceholder}
              onChange={(event) => {
                onUrlChange(event.currentTarget.value);
              }}
              onKeyDown={onUrlKeyDown}
              className="relative m-[-1px] w-full min-w-[300px] rounded-[10px] border-transparent bg-token-bg-primary px-2.5 py-2 pe-9 text-sm text-token-text-primary outline-hidden placeholder:text-token-text-tertiary focus:outline-hidden focus:ring-0 dark:bg-transparent"
            />
            <div className="absolute end-1.5 top-1/2 flex -translate-y-1/2 items-center justify-center">
              <button
                type="button"
                contentEditable={false}
                aria-label="Apply link"
                onPointerDown={handleActionPointerDown}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onApply();
                }}
                className="inline-flex size-5 items-center justify-center rounded-full border-0 bg-token-foreground p-0 text-token-dropdown-background outline-hidden hover:bg-token-foreground/80 focus-visible:bg-token-foreground/80"
              >
                <NfmLinkToolbarApplyIcon className="size-3" />
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  },
);

export const NfmCreateLinkDialogSurface = forwardRef<
  HTMLDivElement,
  NfmCreateLinkDialogSurfaceProps
>(function NfmCreateLinkDialogSurface(
  {
    urlLabel,
    urlPlaceholder,
    urlValue,
    submitLabel,
    onUrlChange,
    onUrlKeyDown,
    onSubmit,
    secondaryActionLabel,
    onSecondaryAction,
  },
  ref,
) {
  const handleSurfacePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
  };

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={submitLabel}
      data-testid="nfm-create-link-dialog"
      contentEditable={false}
      onPointerDown={handleSurfacePointerDown}
      className="flex w-[16.5rem] max-w-[min(16.5rem,calc(100vw-24px))] flex-col rounded-[14px] bg-token-dropdown-background/95 text-token-foreground shadow-lg ring-[0.5px] ring-token-border backdrop-blur-sm"
    >
      <div className="flex flex-col gap-2.5 px-3 py-3">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] leading-4 font-medium text-token-text-secondary">
            {urlLabel}
          </span>
          <div className="relative flex w-full items-center rounded-md border-[0.5px] border-token-border bg-token-input-background shadow-[inset_0_0_0_0.5px_color-mix(in_srgb,var(--color-token-foreground)_2%,transparent)] focus-within:border-token-focus-border focus-within:ring-1 focus-within:ring-token-focus-border">
            <input
              autoFocus
              type="text"
              value={urlValue}
              placeholder={urlPlaceholder}
              onChange={(event) => {
                onUrlChange(event.currentTarget.value);
              }}
              onKeyDown={onUrlKeyDown}
              className="w-full appearance-none border-none bg-transparent px-2 py-1.5 text-[13px] leading-5 text-token-foreground outline-none placeholder:text-token-input-placeholder-foreground"
            />
          </div>
        </label>
      </div>
      <div className="px-3 pb-3">
        <NodexButton
          variant="secondary"
          size="xs"
          className="w-full justify-center rounded-md"
          onClick={onSubmit}
        >
          {submitLabel}
        </NodexButton>
        {secondaryActionLabel && onSecondaryAction ? (
          <button
            type="button"
            onClick={onSecondaryAction}
            className="mt-1.5 inline-flex h-7 w-full items-center justify-center rounded-md text-xs text-token-text-secondary outline-hidden hover:bg-token-foreground/5 hover:text-token-foreground focus-visible:ring-1 focus-visible:ring-token-focus-border"
          >
            {secondaryActionLabel}
          </button>
        ) : null}
      </div>
    </div>
  );
});
