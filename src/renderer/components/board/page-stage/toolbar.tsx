import { useIntl } from "@/lib/i18n";
import { useEffect, useState, type ReactNode } from "react";
import { BackIcon } from "@/components/shared/icons";
import {
  ClockArrowRotateCounterclockwise16Glyph,
  Link16Glyph,
} from "@/components/shared/icons/outline-glyphs";
import { CheckmarkMdIcon } from "@/components/shared/icons/plugin-detail-icons";
import { ViewerButton, ViewerHeader, ViewerIconButton } from "@/components/ui/viewer-header";
import { NodexTooltip } from "@/components/ui/tooltip";
import type { NfmEditorCommands } from "../editor/nfm-editor-commands";
import { PageStageBreadcrumb, type PageStageLocationProps } from "./breadcrumb";
import { PageStageInsertTools } from "./insert-tools";
import { PageStageMenu, type PageStageMenuActions } from "./page-menu";

const COPIED_FEEDBACK_MS = 2000;

export interface PageStageHistoryToggle {
  readonly active: boolean;
  readonly onToggle: () => void;
}

interface PageStageToolbarProps {
  readonly saving: boolean;
  /** The Page is still opening: controls are inert but keep their resting appearance. */
  readonly pending?: boolean;
  /** Absent while the Page opens. */
  readonly menu: PageStageMenuActions | null;
  /** Absent while the body editor is not showing. */
  readonly editorCommands: NfmEditorCommands | null;
  /** Absent where the Page has no reachable history. */
  readonly history?: PageStageHistoryToggle | null;
  /** Copies the Page's link, resolving whether it reached the clipboard. Absent while it opens. */
  readonly onCopyLink?: (() => Promise<boolean>) | null;
  /** Where the Page lives, read from its ownership. */
  readonly location?: PageStageLocationProps;
  readonly onNavigateBack?: () => void;
  /** The Page's Comments control; absent where the Page has no Discussions. */
  readonly comments?: ReactNode;
}

/** The Page's link is how it reaches someone else, so it is the one labelled action. */
function CopyLinkButton({ onCopy }: { readonly onCopy: () => Promise<boolean> }) {
  const intl = useIntl();

  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
    return () => window.clearTimeout(timeout);
  }, [copied]);
  return (
    <NodexTooltip
      tooltipContent={intl.formatMessage({
        id: "board.toolbar.copyLink",
        defaultMessage: "Copy link",
      })}
      delayOpen
    >
      <ViewerButton
        aria-label={intl.formatMessage({
          id: "board.toolbar.copyLink",
          defaultMessage: "Copy link",
        })}
        data-tab-preview-pin-exempt="true"
        onClick={() => {
          void onCopy().then(setCopied);
        }}
      >
        {copied ? <CheckmarkMdIcon /> : <Link16Glyph />}
        <span className="overflow-hidden whitespace-nowrap" data-viewer-header-collapsible="">
          {copied
            ? intl.formatMessage({ id: "board.toolbar.copied", defaultMessage: "Copied" })
            : intl.formatMessage({ id: "board.toolbar.copyLink", defaultMessage: "Copy link" })}
        </span>
      </ViewerButton>
    </NodexTooltip>
  );
}

/**
 * The Page's floating header. The leading side holds the Page itself (where it lives and its
 * menu), then the tools that write into its body; the trailing side holds what is beside the
 * Page: its history and its link. A Page that is still opening renders the same leading controls.
 */
export function PageStageToolbar({
  saving,
  pending = false,
  menu,
  editorCommands,
  history,
  onCopyLink,
  location,
  onNavigateBack,
  comments,
}: PageStageToolbarProps) {
  const intl = useIntl();

  return (
    <ViewerHeader
      className="@container/page-toolbar w-full"
      density="compact"
      placement="overlay"
      label={intl.formatMessage({ id: "board.toolbar.page", defaultMessage: "Page" })}
      leading={[
        {
          id: "page",
          allowShrink: location !== undefined,
          content: (
            <>
              {onNavigateBack ? (
                <ViewerIconButton
                  label={intl.formatMessage({
                    id: "board.toolbar.backToLibrary",
                    defaultMessage: "Back to Library",
                  })}
                  onClick={onNavigateBack}
                >
                  <BackIcon className="icon-xs" />
                </ViewerIconButton>
              ) : null}
              {location ? <PageStageBreadcrumb {...location} /> : null}
              <PageStageMenu actions={menu} pending={pending} />
            </>
          ),
        },
        {
          id: "editing",
          collapsePriority: 0,
          content: <PageStageInsertTools commands={editorCommands} pending={pending} />,
        },
        {
          id: "saving",
          hidePriority: 0,
          content: saving ? (
            <span className="px-1 text-xs text-token-description-foreground" role="status">
              {intl.formatMessage({ id: "board.toolbar.saving", defaultMessage: "Saving…" })}
            </span>
          ) : null,
        },
      ]}
      trailing={[
        { id: "comments", content: comments ?? null },
        {
          id: "history",
          content: history ? (
            <ViewerIconButton
              label={intl.formatMessage({ id: "board.toolbar.history", defaultMessage: "History" })}
              variant={history.active ? "selected" : "default"}
              aria-pressed={history.active}
              data-tab-preview-pin-exempt="true"
              disabled={pending}
              onClick={history.onToggle}
            >
              <ClockArrowRotateCounterclockwise16Glyph />
            </ViewerIconButton>
          ) : null,
        },
        {
          id: "link",
          collapsePriority: 0,
          content: onCopyLink ? <CopyLinkButton onCopy={onCopyLink} /> : null,
        },
      ]}
    />
  );
}
