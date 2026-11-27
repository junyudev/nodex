import { AskAiIcon } from "@/components/shared/icons";
import { defineMessage, useIntl } from "@/lib/i18n";
import { useRef, useState } from "react";
import {
  CodeAndPreviewIcon,
  CodeIcon,
  DownloadIcon,
  CheckmarkIcon,
  CopyIcon,
  ExpandPanelIcon,
  MoreActionsIcon,
  PreviewOnlyIcon,
} from "@/components/shared/icons";
import { useTransientFeedback } from "@/components/shared/use-transient-feedback";
import {
  codeBlockActionButtonClassName,
  codeBlockActionDividerClassName,
  codeBlockActionSurfaceClassName,
} from "@/components/shared/code-block-action-chrome";
import {
  NodexDropdownButtonTrigger,
  NodexOptionPicker,
  type NodexOptionPickerOption,
} from "@/components/ui/dropdown";
import { NodexPopover, NodexPopoverContent, NodexPopoverTrigger } from "@/components/ui/popover";
import { NodexTooltip } from "@/components/ui/tooltip";
import {
  getCodeLanguageSearchText,
  resolveCodeLanguage,
} from "../../../../shared/code-languages/code-language-catalog";
import {
  searchCodeLanguages,
  type CodeBlockActionBarMode,
} from "@/lib/editor-model/code-block-model";
import { cn } from "@/lib/utils";
import type { MermaidCodePreviewMode } from "@/lib/editor-model/code-block-view-state";

const MERMAID_PREVIEW_OPTIONS = [
  {
    value: "code",
    ariaLabel: defineMessage({
      id: "editor.nfmCodeBlockActionBar.codeOnlyLabel",
      defaultMessage: "Show only code and hide preview",
    }),
    tooltip: defineMessage({ id: "editor.nfmCodeBlockActionBar.codeOnly", defaultMessage: "Code" }),
    icon: CodeIcon,
  },
  {
    value: "preview",
    ariaLabel: defineMessage({
      id: "editor.nfmCodeBlockActionBar.previewOnlyLabel",
      defaultMessage: "Show only preview and hide code",
    }),
    tooltip: defineMessage({
      id: "editor.nfmCodeBlockActionBar.previewOnly",
      defaultMessage: "Preview",
    }),
    icon: PreviewOnlyIcon,
  },
  {
    value: "split",
    ariaLabel: defineMessage({
      id: "editor.nfmCodeBlockActionBar.splitLabel",
      defaultMessage: "Show code and preview",
    }),
    tooltip: defineMessage({ id: "editor.nfmCodeBlockActionBar.split", defaultMessage: "Split" }),
    icon: CodeAndPreviewIcon,
  },
] as const;

export interface NfmCodeBlockMermaidActions {
  readonly previewMode: MermaidCodePreviewMode;
  readonly hasValidDiagram: boolean;
  readonly onPreviewModeChange: (mode: MermaidCodePreviewMode) => void;
  readonly onExpand: (trigger: HTMLButtonElement) => void;
  readonly onDownload: () => void;
  /** Asks Nodex to redraw the diagram as a Visual; absent where the Page has no Asks. */
  readonly onRedrawAsVisual?: () => void;
}

export interface NfmCodeBlockActionBarProps {
  readonly languageId: string;
  readonly mode: CodeBlockActionBarMode;
  readonly onLanguageChange: (languageId: string) => void;
  readonly onCopy: () => Promise<boolean>;
  readonly onMore: (anchor: HTMLButtonElement) => void;
  readonly onInteractionOpenChange?: (open: boolean) => void;
  readonly tooltipsDisabled?: boolean;
  readonly mermaid?: NfmCodeBlockMermaidActions;
}

function MermaidPreviewModePicker({
  value,
  open,
  tooltipsDisabled,
  onOpenChange,
  onValueChange,
}: {
  readonly value: MermaidCodePreviewMode;
  readonly open: boolean;
  readonly tooltipsDisabled: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onValueChange: (value: MermaidCodePreviewMode) => void;
}) {
  const intl = useIntl();
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const CurrentIcon =
    MERMAID_PREVIEW_OPTIONS.find((option) => option.value === value)?.icon ?? CodeAndPreviewIcon;
  const choose = (nextValue: MermaidCodePreviewMode) => {
    if (nextValue === "preview") triggerRef.current?.focus();
    onValueChange(nextValue);
    onOpenChange(false);
  };
  const moveSelection = (currentIndex: number, direction: -1 | 1) => {
    const nextIndex =
      (currentIndex + direction + MERMAID_PREVIEW_OPTIONS.length) % MERMAID_PREVIEW_OPTIONS.length;
    const next = MERMAID_PREVIEW_OPTIONS[nextIndex]!;
    onValueChange(next.value);
    optionRefs.current[nextIndex]?.focus();
  };

  const trigger = (
    <NodexPopoverTrigger>
      <button
        ref={triggerRef}
        type="button"
        aria-label={intl.formatMessage({
          id: "editor.nfmCodeBlockActionBar.openPreviewFormat",
          defaultMessage: "Open language preview format dropdown",
        })}
        className={codeBlockActionButtonClassName}
      >
        <CurrentIcon className="size-4 shrink-0" />
      </button>
    </NodexPopoverTrigger>
  );

  return (
    <NodexPopover open={open} onOpenChange={onOpenChange}>
      <NodexTooltip
        tooltipContent={intl.formatMessage({
          id: "editor.nfmCodeBlockActionBar.display",
          defaultMessage: "Display",
        })}
        disabled={tooltipsDisabled || open}
      >
        {trigger}
      </NodexTooltip>
      <NodexPopoverContent
        side="bottom"
        align="end"
        sideOffset={8}
        initialFocus={false}
        finalFocus={false}
        role="radiogroup"
        aria-label={intl.formatMessage({
          id: "editor.nfmCodeBlockActionBar.diagramDisplay",
          defaultMessage: "Diagram display",
        })}
        className="w-auto flex-row overflow-visible rounded-md p-0.5"
      >
        {MERMAID_PREVIEW_OPTIONS.map((option, index) => {
          const OptionIcon = option.icon;
          const selected = option.value === value;
          return (
            <div key={option.value} className="flex items-center">
              {index > 0 ? (
                <span
                  aria-hidden="true"
                  className={cn("mx-1 h-4 w-px", codeBlockActionDividerClassName)}
                />
              ) : null}
              <NodexTooltip
                tooltipContent={intl.formatMessage(option.tooltip)}
                disabled={tooltipsDisabled}
              >
                <button
                  ref={(node) => {
                    optionRefs.current[index] = node;
                  }}
                  type="button"
                  role="radio"
                  aria-label={intl.formatMessage(option.ariaLabel)}
                  aria-checked={selected}
                  tabIndex={selected ? 0 : -1}
                  data-mermaid-preview-mode-option={option.value}
                  className={cn(
                    codeBlockActionButtonClassName,
                    selected &&
                      "bg-[color-mix(in_srgb,var(--foreground)_6%,transparent)] text-[var(--foreground)]",
                  )}
                  onClick={() => choose(option.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                    event.preventDefault();
                    moveSelection(index, event.key === "ArrowLeft" ? -1 : 1);
                  }}
                >
                  <OptionIcon className="size-4 shrink-0" />
                </button>
              </NodexTooltip>
            </div>
          );
        })}
      </NodexPopoverContent>
    </NodexPopover>
  );
}

export function NfmCodeBlockActionBar({
  languageId,
  mode,
  onLanguageChange,
  onCopy,
  onMore,
  onInteractionOpenChange,
  tooltipsDisabled = false,
  mermaid,
}: NfmCodeBlockActionBarProps) {
  const intl = useIntl();
  const [languageOpen, setLanguageOpen] = useState(false);
  const [previewModeOpen, setPreviewModeOpen] = useState(false);
  const copyFeedback = useTransientFeedback();
  const language = resolveCodeLanguage(languageId);
  const locale = globalThis.navigator?.language || "en";
  const languages = searchCodeLanguages("", locale);
  const options: readonly NodexOptionPickerOption[] = languages.map((item) => ({
    value: item.id,
    label: item.label,
    searchText: getCodeLanguageSearchText(item),
  }));

  const changeLanguageOpen = (open: boolean) => {
    setLanguageOpen(open);
    onInteractionOpenChange?.(open);
  };

  const changePreviewModeOpen = (open: boolean) => {
    setPreviewModeOpen(open);
    onInteractionOpenChange?.(open);
  };

  const copyCode = async () => {
    if (!(await onCopy())) return;
    copyFeedback.show();
  };

  return (
    <div
      role="toolbar"
      aria-label={intl.formatMessage({
        id: "editor.nfmCodeBlockActionBar.toolbar",
        defaultMessage: "Code block action bar",
      })}
      data-nfm-code-block-action-bar
      className={cn(
        "pointer-events-auto flex h-7 items-center rounded-md p-0.5 text-xs",
        codeBlockActionSurfaceClassName,
      )}
    >
      {mode !== "more_only" && (!mermaid || mode === "all") ? (
        <>
          <NodexOptionPicker
            value={language.id}
            options={options}
            search="filter"
            searchPlaceholder={intl.formatMessage({
              id: "editor.nfmCodeBlockActionBar.searchLanguagesPlaceholder",
              defaultMessage: "Search languages…",
            })}
            searchAriaLabel={intl.formatMessage({
              id: "editor.nfmCodeBlockActionBar.searchLanguages",
              defaultMessage: "Search code languages",
            })}
            title={intl.formatMessage({
              id: "editor.nfmCodeBlockActionBar.language",
              defaultMessage: "Code language",
            })}
            contentWidth="menuWide"
            contentMaxHeight="halfViewport"
            sideOffset={8}
            align="end"
            open={languageOpen}
            onOpenChange={changeLanguageOpen}
            onValueChange={onLanguageChange}
            triggerButton={
              <NodexDropdownButtonTrigger
                aria-label={intl.formatMessage({
                  id: "editor.nfmCodeBlockActionBar.openLanguage",
                  defaultMessage: "Open language dropdown",
                })}
                size="xs"
                chrome="transparent"
                className="pointer-events-auto max-w-[112px] rounded-[4px] px-1.5 text-[var(--foreground-secondary)]"
              >
                <span className="truncate">{language.label}</span>
              </NodexDropdownButtonTrigger>
            }
          />
          <span
            aria-hidden="true"
            className={cn("mx-0.5 h-4 w-px shrink-0", codeBlockActionDividerClassName)}
          />
        </>
      ) : null}
      {mermaid ? (
        <>
          <MermaidPreviewModePicker
            value={mermaid.previewMode}
            open={previewModeOpen}
            tooltipsDisabled={tooltipsDisabled}
            onOpenChange={changePreviewModeOpen}
            onValueChange={mermaid.onPreviewModeChange}
          />
          {mode === "all" ? (
            <>
              <NodexTooltip
                tooltipContent={intl.formatMessage({
                  id: "editor.nfmCodeBlockActionBar.expandDiagram",
                  defaultMessage: "Expand diagram",
                })}
                disabled={tooltipsDisabled}
              >
                <button
                  type="button"
                  aria-label={intl.formatMessage({
                    id: "editor.nfmCodeBlockActionBar.expandDiagram",
                    defaultMessage: "Expand diagram",
                  })}
                  disabled={!mermaid.hasValidDiagram}
                  className={codeBlockActionButtonClassName}
                  onClick={(event) => mermaid.onExpand(event.currentTarget)}
                >
                  <ExpandPanelIcon />
                </button>
              </NodexTooltip>
              <NodexTooltip
                tooltipContent={intl.formatMessage({
                  id: "editor.nfmCodeBlockActionBar.downloadDiagram",
                  defaultMessage: "Download diagram as JPEG",
                })}
                disabled={tooltipsDisabled}
              >
                <button
                  type="button"
                  aria-label={intl.formatMessage({
                    id: "editor.nfmCodeBlockActionBar.downloadDiagram",
                    defaultMessage: "Download diagram as JPEG",
                  })}
                  disabled={!mermaid.hasValidDiagram}
                  className={codeBlockActionButtonClassName}
                  onClick={mermaid.onDownload}
                >
                  <DownloadIcon />
                </button>
              </NodexTooltip>
              {mermaid.onRedrawAsVisual ? (
                <NodexTooltip
                  tooltipContent={intl.formatMessage({
                    id: "editor.nfmCodeBlockActionBar.redrawAsVisualTooltip",
                    defaultMessage: "Ask Nodex to redraw this diagram as a Visual",
                  })}
                  disabled={tooltipsDisabled}
                >
                  <button
                    type="button"
                    aria-label={intl.formatMessage({
                      id: "editor.nfmCodeBlockActionBar.redrawAsVisual",
                      defaultMessage: "Redraw as Visual",
                    })}
                    className={codeBlockActionButtonClassName}
                    onClick={mermaid.onRedrawAsVisual}
                  >
                    <AskAiIcon className="size-3.5" />
                  </button>
                </NodexTooltip>
              ) : null}
            </>
          ) : null}
        </>
      ) : null}
      {mode === "more_only" ? null : (
        <NodexTooltip
          tooltipContent={
            copyFeedback.visible
              ? intl.formatMessage({
                  id: "editor.nfmCodeBlockActionBar.copied",
                  defaultMessage: "Copied",
                })
              : intl.formatMessage({
                  id: "editor.nfmCodeBlockActionBar.copy",
                  defaultMessage: "Copy code",
                })
          }
          disabled={tooltipsDisabled}
        >
          <button
            type="button"
            aria-label={intl.formatMessage({
              id: "editor.nfmCodeBlockActionBar.copyToClipboard",
              defaultMessage: "Copy code to clipboard",
            })}
            className={codeBlockActionButtonClassName}
            onClick={() => void copyCode()}
          >
            {copyFeedback.visible ? <CheckmarkIcon /> : <CopyIcon />}
          </button>
        </NodexTooltip>
      )}
      <NodexTooltip
        tooltipContent={intl.formatMessage({
          id: "editor.nfmCodeBlockActionBar.blockActions",
          defaultMessage: "Block actions",
        })}
        disabled={tooltipsDisabled}
      >
        <button
          type="button"
          aria-label={intl.formatMessage({
            id: "editor.nfmCodeBlockActionBar.openBlockActions",
            defaultMessage: "Open block actions menu",
          })}
          className={cn(codeBlockActionButtonClassName, mode === "more_only" && "size-6")}
          onClick={(event) => onMore(event.currentTarget)}
        >
          <MoreActionsIcon />
        </button>
      </NodexTooltip>
    </div>
  );
}
