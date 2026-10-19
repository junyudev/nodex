import { formatKeyboardShortcut, isTableCellSelection } from "@blocknote/core";
import { FormattingToolbarExtension, LinkToolbarExtension } from "@blocknote/core/extensions";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { FormattingToolbarLinkIcon } from "@/components/shared/icons";
import { NodexPopover, NodexPopoverContent, NodexPopoverTrigger } from "@/components/ui/popover";
import { NodexTooltip } from "@/components/ui/tooltip";
import { useCopyFeedback } from "@/lib/use-copy-feedback";
import { cn } from "@/lib/utils";
import {
  NfmCompactLinkToolbar,
  NfmCreateLinkDialogSurface,
  NfmLinkEditToolbarSurface,
  openNfmResolvedLinkAction,
  resolveNfmLinkAction,
  resolveNfmLinkTooltipLabel,
  useBlockNoteEditor,
  useDictionary,
  useEditorState,
  useExtension,
  useFileLinkOpener,
  writeTextToClipboard,
  type LinkToolbarProps,
  type NfmResolvedLinkAction,
} from "./nfm-link-toolbar-deps";
import { useFileReferenceRouter } from "@/lib/file-reference-router";
import { useNfmLinkEditorState } from "./nfm-edit-link-menu-items";
import { applyNfmLinkEditAtRange } from "./nfm-link-editing";
import { normalizeNfmEditorLinkUrl } from "./nfm-link-url";
import { useNfmRetainedSelectionPresentation } from "./nfm-retained-selection-presentation";
import { useBlockReferenceHostRuntime } from "@/components/block-documents/block-reference-runtime-context";
import { pageSearchResultsToReferenceCandidates } from "@/lib/page-reference-picker/search-controller";
import type { PageReferenceCandidate } from "@/lib/page-reference-picker/types";
import {
  configuredPageSearchProjectIds,
  useInteractivePageSearch,
} from "@/lib/interactive-page-search";
import { buildPageDeepLink } from "../../../../shared/nodex-deeplink";
import { PageIcon } from "@/components/shared/icons";

function hasLinkInSchema(editor: {
  schema: { inlineContentSchema: Record<string, unknown> };
}): boolean {
  return (
    "link" in editor.schema.inlineContentSchema &&
    editor.schema.inlineContentSchema["link"] === "link"
  );
}

interface NfmCreateLinkSelectionState {
  url?: string;
  text: string;
  range: {
    from: number;
    to: number;
  };
}

function NfmPageLinkPicker({
  onBack,
  onSelect,
}: {
  readonly onBack: () => void;
  readonly onSelect: (candidate: PageReferenceCandidate) => void;
}) {
  const hostRuntime = useBlockReferenceHostRuntime();
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const projectIds =
    hostRuntime?.contentRoutingContext.kind === "project"
      ? [hostRuntime.contentRoutingContext.projectId]
      : configuredPageSearchProjectIds();
  const search = useInteractivePageSearch({
    projectIds,
    query,
    limit: 24,
    complete: Boolean(hostRuntime),
  });
  const request = hostRuntime
    ? {
        routingContext: hostRuntime.contentRoutingContext,
        hostPageId: hostRuntime.hostPageId,
        ancestorPageIds: hostRuntime.ancestorPageIds,
        intent: "link" as const,
        query,
        limit: 24,
      }
    : null;
  const rows = hostRuntime?.hostPageId
    ? search.rows.flatMap((row) => {
        if (row.pageId !== hostRuntime.hostPageId || row.matches.length === 0) {
          return [row];
        }
        const matches = row.matches.filter((match) => match.source !== "body");
        if (matches.length === 0) return [];
        return [
          {
            ...row,
            matches,
            excerpt: null,
            excerptParts: [],
          },
        ];
      })
    : search.rows;
  const items = request ? pageSearchResultsToReferenceCandidates(request, rows) : [];
  useEffect(() => {
    setSelectedIndex((current) => Math.min(current, Math.max(items.length - 1, 0)));
  }, [items.length]);
  const status =
    !hostRuntime || search.enrichment === "unavailable"
      ? ("error" as const)
      : search.enrichment === "loading"
        ? ("loading" as const)
        : ("ready" as const);

  return (
    <div
      role="dialog"
      aria-label="Choose a Page link"
      className="flex w-[17.5rem] max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-[14px] bg-token-dropdown-background/95 text-token-foreground shadow-lg ring-[0.5px] ring-token-border backdrop-blur-sm"
    >
      <div className="flex items-center gap-1.5 px-2 py-2">
        <button
          type="button"
          aria-label="Back to URL"
          onClick={onBack}
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg text-token-text-secondary hover:bg-token-foreground/5 hover:text-token-foreground"
        >
          ←
        </button>
        <input
          autoFocus
          type="text"
          value={query}
          placeholder="Search Pages"
          onChange={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onBack();
              return;
            }
            if (items.length === 0) return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const delta = event.key === "ArrowDown" ? 1 : -1;
              setSelectedIndex((current) => (current + delta + items.length) % items.length);
              return;
            }
            if (event.key === "Enter") {
              event.preventDefault();
              const selected = items[selectedIndex];
              if (selected) onSelect(selected);
            }
          }}
          className="h-7 min-w-0 flex-1 rounded-md border-[0.5px] border-token-border bg-token-input-background px-2 text-[13px] outline-none focus:border-token-focus-border focus:ring-1 focus:ring-token-focus-border"
        />
      </div>
      <div
        role="listbox"
        aria-label="Page link results"
        className="scrollbar-token max-h-64 overflow-y-auto px-1 pb-1"
      >
        {items.map((item, index) => (
          <button
            key={item.pageId}
            type="button"
            role="option"
            aria-selected={selectedIndex === index}
            data-selected={selectedIndex === index || undefined}
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => setSelectedIndex(index)}
            onClick={() => onSelect(item)}
            className="flex min-h-8 w-full items-center gap-2 rounded-lg px-2 py-1 text-left hover:bg-token-list-hover-background focus-visible:bg-token-list-hover-background data-[selected=true]:bg-token-list-hover-background"
          >
            <PageIcon className="icon-xs shrink-0 text-token-description-foreground" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-token-foreground">
                {item.title || "Untitled"}
              </span>
              <span className="block truncate text-xs text-token-description-foreground">
                {[item.pageKey, item.locationLabel].filter(Boolean).join(" · ")}
              </span>
            </span>
          </button>
        ))}
        {status !== "ready" || items.length === 0 ? (
          <div className="px-2 py-3 text-center text-xs text-token-description-foreground">
            {status === "loading"
              ? "Loading more Pages…"
              : status === "error"
                ? "Full Page search is unavailable"
                : "No matching Pages"}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export interface NfmCreateLinkTriggerProps {
  ariaLabel: string;
  title: string;
  open: boolean;
  onMouseDown: (event: ReactMouseEvent<HTMLElement>) => void;
  onClick: () => void;
}

export interface NfmCreateLinkButtonProps {
  renderTrigger?: (props: NfmCreateLinkTriggerProps) => ReactNode;
}

function NfmCreateLinkPopover({
  dict,
  formattingToolbar,
  showPopover,
  setShowPopover,
  state,
  renderTrigger,
}: {
  dict: ReturnType<typeof useDictionary>;
  formattingToolbar: ReturnType<typeof useExtension<typeof FormattingToolbarExtension>>;
  showPopover: boolean;
  setShowPopover: (open: boolean | ((current: boolean) => boolean)) => void;
  state: NfmCreateLinkSelectionState;
  renderTrigger?: (props: NfmCreateLinkTriggerProps) => ReactNode;
}) {
  const [showPagePicker, setShowPagePicker] = useState(false);
  const { currentUrl, setCurrentUrl, submit } = useNfmLinkEditorState({
    ...state,
    url: state.url || "",
    setToolbarOpen: (open: boolean) => {
      formattingToolbar.store.setState(open);
      if (!open) {
        setShowPopover(false);
      }
    },
  });

  const handleSubmit = () => {
    submit();
    setShowPopover(false);
  };

  const handleUrlKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setShowPopover(false);
      return;
    }

    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    handleSubmit();
  };

  const triggerProps: NfmCreateLinkTriggerProps = {
    ariaLabel: dict.formatting_toolbar.link.tooltip,
    title: dict.formatting_toolbar.link.tooltip,
    open: showPopover,
    onMouseDown: (event) => {
      if ("button" in event && event.button !== 0) return;
      event.preventDefault();
    },
    onClick: () => setShowPopover((open) => !open),
  };

  return (
    <NodexPopover open={showPopover} onOpenChange={setShowPopover}>
      <NodexTooltip
        tooltipContent={dict.formatting_toolbar.link.tooltip}
        shortcutLabel={formatKeyboardShortcut(
          dict.formatting_toolbar.link.secondary_tooltip,
          dict.generic.ctrl_shortcut,
        )}
        side="top"
        delay={0}
      >
        <NodexPopoverTrigger nativeButton={!renderTrigger}>
          {renderTrigger ? (
            renderTrigger(triggerProps)
          ) : (
            <button
              type="button"
              data-test="createLink"
              aria-label={triggerProps.ariaLabel}
              className={cn(
                "inline-flex h-7 min-w-7 shrink-0 items-center justify-center gap-1 rounded-[9px] px-2 text-xs leading-4 text-token-text-secondary outline-hidden transition-colors",
                "hover:bg-token-foreground/6 hover:text-token-foreground focus-visible:ring-1 focus-visible:ring-token-focus-border",
              )}
              onMouseDown={triggerProps.onMouseDown}
              onClick={triggerProps.onClick}
            >
              <span className="shrink-0 [&_svg]:size-4">
                <FormattingToolbarLinkIcon />
              </span>
            </button>
          )}
        </NodexPopoverTrigger>
      </NodexTooltip>
      <NodexPopoverContent
        sideOffset={6}
        collisionPadding={8}
        className="w-[16.5rem] gap-0 p-0 overflow-hidden"
      >
        {showPagePicker ? (
          <NfmPageLinkPicker
            onBack={() => setShowPagePicker(false)}
            onSelect={(candidate) => {
              submit(
                buildPageDeepLink({ pageId: candidate.pageId }),
                state.text || candidate.title,
              );
              setShowPopover(false);
            }}
          />
        ) : (
          <NfmCreateLinkDialogSurface
            urlLabel={"Page or URL"}
            urlPlaceholder={dict.link_toolbar.form.url_placeholder}
            urlValue={currentUrl}
            submitLabel={dict.formatting_toolbar.link.tooltip}
            onUrlChange={setCurrentUrl}
            onUrlKeyDown={handleUrlKeyDown}
            onSubmit={handleSubmit}
            secondaryActionLabel="Page…"
            onSecondaryAction={() => setShowPagePicker(true)}
          />
        )}
      </NodexPopoverContent>
    </NodexPopover>
  );
}

function NfmCreateLinkButton({ renderTrigger }: NfmCreateLinkButtonProps) {
  const editor = useBlockNoteEditor();
  const dict = useDictionary();
  const formattingToolbar = useExtension(FormattingToolbarExtension);
  const [showPopover, setShowPopover] = useState(false);

  useNfmRetainedSelectionPresentation(showPopover ? "inline" : "none", "createLinkButton", []);

  const state = useEditorState<NfmCreateLinkSelectionState | undefined>({
    editor,
    selector: ({ editor: currentEditor }) => {
      if (
        !currentEditor.isEditable ||
        !hasLinkInSchema(currentEditor) ||
        isTableCellSelection(currentEditor.prosemirrorState.selection) ||
        !(
          currentEditor.getSelection()?.blocks || [currentEditor.getTextCursorPosition().block]
        ).find((block) => block.content !== undefined)
      ) {
        return undefined;
      }

      return {
        url: currentEditor.getSelectedLinkUrl(),
        text: currentEditor.getSelectedText(),
        range: {
          from: currentEditor.prosemirrorState.selection.from,
          to: currentEditor.prosemirrorState.selection.to,
        },
      };
    },
  });

  useEffect(() => {
    setShowPopover(false);
  }, [state]);

  useEffect(() => {
    const callback = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "k") {
        setShowPopover(true);
        event.preventDefault();
      }
    };

    const domElement = editor.domElement;
    domElement?.addEventListener("keydown", callback);

    return () => {
      domElement?.removeEventListener("keydown", callback);
    };
  }, [editor.domElement]);

  if (state === undefined) {
    return null;
  }

  return (
    <NfmCreateLinkPopover
      dict={dict}
      formattingToolbar={formattingToolbar}
      showPopover={showPopover}
      setShowPopover={setShowPopover}
      state={state}
      renderTrigger={renderTrigger}
    />
  );
}

export interface NfmLinkToolbarProps extends LinkToolbarProps {
  projectWorkspacePath?: string | null;
}

const COPY_FEEDBACK_MS = 1600;
const NFM_LINK_EDIT_URL_PLACEHOLDER = "Type or paste a link";

function isOpenableLinkAction(
  action: NfmResolvedLinkAction | null,
): action is Exclude<NfmResolvedLinkAction, { kind: "blocked" | "unresolved-file-like" }> {
  return action !== null && action.kind !== "blocked" && action.kind !== "unresolved-file-like";
}

export function NfmLinkToolbar(props: NfmLinkToolbarProps) {
  const editor = useBlockNoteEditor();
  const dict = useDictionary();
  const { opener } = useFileLinkOpener();
  const fileReferenceRouter = useFileReferenceRouter();
  const hostRuntime = useBlockReferenceHostRuntime();
  const { deleteLink } = useExtension(LinkToolbarExtension);
  const [isEditing, setIsEditing] = useState(false);
  const { copied, copy } = useCopyFeedback(COPY_FEEDBACK_MS);
  const editToolbarRef = useRef<HTMLDivElement | null>(null);
  const liveRangeRef = useRef(props.range);
  const action = resolveNfmLinkAction(props.url, props.projectWorkspacePath);
  const tooltip = resolveNfmLinkTooltipLabel(action, false) ?? dict.link_toolbar.open.tooltip;
  const canOpen =
    isOpenableLinkAction(action) && (action.kind !== "page" || Boolean(hostRuntime?.openPage));
  const { currentUrl, setCurrentUrl } = useNfmLinkEditorState(props);

  useEffect(() => {
    if (isEditing) return;
    liveRangeRef.current = props.range;
  }, [isEditing, props.range]);

  const applyLiveLinkEdit = useCallback(
    (nextUrl: string) => {
      const normalizedUrl = normalizeNfmEditorLinkUrl(nextUrl);
      if (!normalizedUrl) return false;

      liveRangeRef.current = applyNfmLinkEditAtRange(
        editor,
        liveRangeRef.current,
        normalizedUrl,
        props.text,
      );
      return true;
    },
    [editor, props.text],
  );

  const closeEditDialog = useCallback(
    (closeToolbar: boolean) => {
      setIsEditing(false);
      props.setToolbarPositionFrozen?.(false);
      if (closeToolbar) props.setToolbarOpen?.(false);
    },
    [props],
  );

  useEffect(() => {
    if (!isEditing) return undefined;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (editToolbarRef.current?.contains(target)) return;
      closeEditDialog(true);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeEditDialog(true);
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [closeEditDialog, isEditing]);

  const handleFieldKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeEditDialog(true);
        return;
      }

      if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
      event.preventDefault();
      if (!applyLiveLinkEdit(currentUrl)) return;
      closeEditDialog(true);
    },
    [applyLiveLinkEdit, closeEditDialog, currentUrl],
  );

  const handleCopyLink = () => copy(() => writeTextToClipboard(props.url));

  if (isEditing) {
    return (
      <NfmLinkEditToolbarSurface
        ref={editToolbarRef}
        urlPlaceholder={NFM_LINK_EDIT_URL_PLACEHOLDER}
        urlValue={currentUrl}
        onUrlChange={(value) => {
          setCurrentUrl(value);
          applyLiveLinkEdit(value);
        }}
        onUrlKeyDown={handleFieldKeyDown}
        onApply={() => {
          if (!applyLiveLinkEdit(currentUrl)) return;
          closeEditDialog(true);
        }}
      />
    );
  }

  return (
    <NfmCompactLinkToolbar
      href={props.url}
      canOpen={canOpen}
      openTooltip={tooltip}
      openLabel={"Open"}
      clearTooltip={"Clear"}
      clearLabel={"Clear"}
      copyLabel={"Copy"}
      copyTooltip={"Copy link"}
      copiedLabel={"Copied"}
      copiedTooltip={"Copied"}
      copyState={copied ? "copied" : "idle"}
      editTooltip={dict.link_toolbar.edit.tooltip}
      editLabel={dict.link_toolbar.edit.tooltip}
      disabledReason={!canOpen ? tooltip : undefined}
      onOpenLink={() => {
        if (!canOpen) return;
        if (action?.kind === "local-file" || action?.kind === "workspace-file") {
          void fileReferenceRouter.open(action.target, {
            cwd: props.projectWorkspacePath,
            workspaceRoot: props.projectWorkspacePath,
          });
          return;
        }
        void openNfmResolvedLinkAction(
          action,
          opener,
          undefined,
          undefined,
          hostRuntime?.openPage
            ? {
                openPage: (pageId) =>
                  hostRuntime.openPage?.({
                    routingContext: hostRuntime.contentRoutingContext,
                    pageId,
                  }),
              }
            : undefined,
        );
      }}
      onClearLink={() => {
        deleteLink(liveRangeRef.current.from);
        closeEditDialog(true);
      }}
      onCopyLink={() => {
        void handleCopyLink();
      }}
      onEditLink={() => {
        setIsEditing(true);
        props.setToolbarPositionFrozen?.(true);
      }}
    />
  );
}

export { NfmCreateLinkButton };
