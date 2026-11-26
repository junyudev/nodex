import { useIntl } from "@/lib/i18n";
import { useRef, type ReactNode } from "react";
import { PageExecutionHoldItem } from "@/components/workbench/execution-hold-controls";
import {
  AutomationsIcon,
  TerminalIcon,
  PageMenuCopyIdIcon,
  PageMenuCopyMarkdownIcon,
  PageMenuCopyTitleIcon,
} from "@/components/shared/icons";
import { ChevronDownSm16Icon, CopyLightIcon } from "@/components/shared/icons/file-viewer-icons";
import {
  ArrowDownOpenBase16Glyph,
  ArrowUpRightMd16Glyph,
  Link16Glyph,
  Pencil16Glyph,
  Trash16Glyph,
} from "@/components/shared/icons/outline-glyphs";
import { ArrowRightLightIcon, PageLightIcon } from "@/components/shared/icons/page-chrome-icons";
import {
  PageFullWidthIcon,
  PageRawContentIcon,
} from "@/components/shared/icons/page-stage-toolbar-icons";
import {
  NodexDropdownFlyoutSubmenuItem,
  NodexDropdownItem,
  NodexDropdownMenu,
  NodexDropdownSelectedIcon,
  NodexDropdownSeparator,
} from "@/components/ui/dropdown";
import { ViewerButton } from "@/components/ui/viewer-header";
import { cn } from "@/lib/utils";
import type { PageCopyAction, PageCopyActionId } from "@/lib/page-copy-model";

/** What the Page menu can do for the Page it belongs to; an absent action is not offered. */
export interface PageStageMenuActions {
  readonly pageId: string;
  /** Returns the title to move focus into, with its text selected. */
  readonly onRename?: () => HTMLElement | null;
  readonly copyActions: readonly PageCopyAction[];
  readonly onCopy: (actionId: PageCopyActionId) => void;
  readonly onDownloadMarkdown?: () => void;
  readonly onOpenOnRight?: () => void;
  readonly onOpenInNewWindow?: () => void;
  readonly fullWidth: boolean;
  readonly onToggleFullWidth: () => void;
  readonly showMarkdownSource: boolean;
  readonly onToggleMarkdownSource: () => void;
  /** Opens a new automation that follows this Page as its runbook. */
  readonly onSchedule?: () => void;
  readonly onOpenTerminal?: () => void;
  readonly onDelete?: () => void;
}

function PageCopyActionIcon({ actionId }: { readonly actionId: PageCopyActionId }) {
  switch (actionId) {
    case "copy-id":
      return <PageMenuCopyIdIcon />;
    case "copy-deeplink":
      return <Link16Glyph />;
    case "copy-title":
      return <PageMenuCopyTitleIcon />;
    case "copy-markdown":
      return <PageMenuCopyMarkdownIcon />;
  }
}

function ToggleItem({
  icon,
  checked,
  onSelect,
  children,
}: {
  readonly icon: ReactNode;
  readonly checked: boolean;
  readonly onSelect: () => void;
  readonly children: ReactNode;
}) {
  return (
    <NodexDropdownItem
      role="menuitemcheckbox"
      aria-checked={checked}
      leftSlot={icon}
      rightSlot={checked ? <NodexDropdownSelectedIcon /> : null}
      onSelect={onSelect}
    >
      {children}
    </NodexDropdownItem>
  );
}

/**
 * One menu for everything about the Page as an object: naming it, taking it elsewhere, how it
 * shows, and the work it drives. Its trigger is the Page itself; body editing lives in the
 * tools beside it.
 */
export function PageStageMenu({
  actions,
  pending = false,
}: {
  /** Absent while the Page opens: the trigger holds its place without a menu. */
  readonly actions: PageStageMenuActions | null;
  /** The Page is still opening: the trigger is inert but keeps its resting appearance. */
  readonly pending?: boolean;
}) {
  const intl = useIntl();

  // An action that moves focus elsewhere claims it as the menu closes.
  const focusTargetRef = useRef<(() => HTMLElement | null) | null>(null);
  const disabled = pending || !actions;
  const trigger = (
    <ViewerButton
      variant="dropdown"
      aria-label={intl.formatMessage({
        id: "board.pageMenu.actions",
        defaultMessage: "Page actions",
      })}
      data-tab-preview-pin-exempt="true"
      disabled={disabled}
      className={cn(pending && "disabled:text-(--color-text)")}
    >
      <PageLightIcon />
      <ChevronDownSm16Icon />
    </ViewerButton>
  );
  if (!actions || disabled) return trigger;
  return (
    <NodexDropdownMenu
      align="start"
      side="bottom"
      sideOffset={8}
      contentWidth="menu"
      triggerTooltipContent={intl.formatMessage({
        id: "board.pageMenu.actions",
        defaultMessage: "Page actions",
      })}
      onOpenChange={(open) => {
        if (open) focusTargetRef.current = null;
      }}
      finalFocus={() => {
        const target = focusTargetRef.current?.();
        focusTargetRef.current = null;
        return target ?? true;
      }}
      triggerButton={trigger}
    >
      {actions.onRename ? (
        <NodexDropdownItem
          leftSlot={<Pencil16Glyph />}
          onSelect={() => {
            focusTargetRef.current = actions.onRename ?? null;
          }}
        >
          {intl.formatMessage({ id: "board.pageMenu.rename", defaultMessage: "Rename" })}
        </NodexDropdownItem>
      ) : null}
      <NodexDropdownFlyoutSubmenuItem
        label={intl.formatMessage({ id: "board.pageMenu.copy", defaultMessage: "Copy" })}
        leftSlot={<CopyLightIcon />}
      >
        {actions.copyActions.map((action) => (
          <NodexDropdownItem
            key={action.id}
            disabled={action.disabled}
            leftSlot={<PageCopyActionIcon actionId={action.id} />}
            onSelect={() => actions.onCopy(action.id)}
          >
            {action.label}
          </NodexDropdownItem>
        ))}
      </NodexDropdownFlyoutSubmenuItem>
      {actions.onDownloadMarkdown ? (
        <NodexDropdownItem
          leftSlot={<ArrowDownOpenBase16Glyph />}
          onSelect={actions.onDownloadMarkdown}
        >
          {intl.formatMessage({
            id: "board.pageMenu.downloadMarkdown",
            defaultMessage: "Download as Markdown",
          })}
        </NodexDropdownItem>
      ) : null}
      {actions.onOpenOnRight || actions.onOpenInNewWindow ? <NodexDropdownSeparator /> : null}
      {actions.onOpenOnRight ? (
        <NodexDropdownItem leftSlot={<ArrowRightLightIcon />} onSelect={actions.onOpenOnRight}>
          {intl.formatMessage({
            id: "board.pageMenu.openOnRight",
            defaultMessage: "Open on right",
          })}
        </NodexDropdownItem>
      ) : null}
      {actions.onOpenInNewWindow ? (
        <NodexDropdownItem
          leftSlot={<ArrowUpRightMd16Glyph />}
          onSelect={actions.onOpenInNewWindow}
        >
          {intl.formatMessage({
            id: "board.pageMenu.openInNewWindow",
            defaultMessage: "Open in new window",
          })}
        </NodexDropdownItem>
      ) : null}
      <NodexDropdownSeparator />
      <ToggleItem
        icon={<PageFullWidthIcon active={actions.fullWidth} />}
        checked={actions.fullWidth}
        onSelect={actions.onToggleFullWidth}
      >
        {intl.formatMessage({ id: "board.pageMenu.fullWidth", defaultMessage: "Full width" })}
      </ToggleItem>
      <ToggleItem
        icon={<PageRawContentIcon active={actions.showMarkdownSource} />}
        checked={actions.showMarkdownSource}
        onSelect={actions.onToggleMarkdownSource}
      >
        {intl.formatMessage({
          id: "board.pageMenu.showMarkdown",
          defaultMessage: "Show Markdown source",
        })}
      </ToggleItem>
      <NodexDropdownSeparator />
      <PageExecutionHoldItem pageId={actions.pageId} />
      {actions.onSchedule ? (
        <NodexDropdownItem leftSlot={<AutomationsIcon />} onSelect={actions.onSchedule}>
          {intl.formatMessage({ id: "board.pageMenu.schedule", defaultMessage: "Schedule" })}
        </NodexDropdownItem>
      ) : null}
      {actions.onOpenTerminal ? (
        <NodexDropdownItem leftSlot={<TerminalIcon />} onSelect={actions.onOpenTerminal}>
          {intl.formatMessage({
            id: "board.pageMenu.openTerminal",
            defaultMessage: "Open Terminal",
          })}
        </NodexDropdownItem>
      ) : null}
      {actions.onDelete ? (
        <>
          <NodexDropdownSeparator />
          <NodexDropdownItem
            leftSlot={<Trash16Glyph />}
            onSelect={actions.onDelete}
            className="text-(--destructive) hover:!bg-(--destructive)/10 focus:!bg-(--destructive)/10"
          >
            {intl.formatMessage({ id: "board.pageMenu.delete", defaultMessage: "Delete" })}
          </NodexDropdownItem>
        </>
      ) : null}
    </NodexDropdownMenu>
  );
}
