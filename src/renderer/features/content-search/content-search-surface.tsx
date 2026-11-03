import { useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  CloseIcon,
  ContentSearchDiffIcon,
  SettingsSearchIcon,
  ThreadIcon,
  GlobeIcon,
  ActivitySpinnerIcon,
  UpArrowIcon,
} from "@/components/shared/icons";
import { cn } from "@/lib/utils";
import { CONTENT_SEARCH_INPUT_ID, type ContentSearchDomain } from "./content-search-model";
import { useContentSearch } from "./content-search-context";

const DOMAIN_BUTTON_CLASS =
  "-m-0.5 flex size-6 items-center justify-center rounded-full text-token-description-foreground transition-colors hover:bg-token-foreground/5 disabled:cursor-default disabled:opacity-40";
const ACTIVE_DOMAIN_BUTTON_CLASS =
  "bg-token-foreground/8 text-token-foreground hover:bg-token-foreground/10";
const NAV_BUTTON_CLASS =
  "flex size-6 items-center justify-center rounded-full text-token-description-foreground transition-colors hover:bg-token-foreground/5 disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent";
const NAV_ROW_BASE_CLASS =
  "col-[1/4] row-[2] flex items-center justify-between overflow-hidden border-token-border px-4 text-sm text-token-description-foreground transition-[max-height,opacity,padding,transform,border-width] duration-200 ease-out";
const NAV_ROW_VISIBLE_CLASS = "max-h-9 translate-y-0 border-t py-2 opacity-100";
const NAV_ROW_HIDDEN_CLASS = "pointer-events-none max-h-0 -translate-y-2 border-t-0 py-0 opacity-0";

interface ContentSearchSurfaceViewProps {
  open: boolean;
  domain: ContentSearchDomain;
  query: string;
  hasBrowserTarget: boolean;
  loading: boolean;
  resultLabel: string;
  navigationDisabled: boolean;
  onDomainChange: (domain: ContentSearchDomain) => void;
  onQueryChange: (query: string) => void;
  onClose: () => void;
  onNext: () => void;
  onPrevious: () => void;
}

function domainButtonClass(active: boolean): string {
  return cn(DOMAIN_BUTTON_CLASS, active && ACTIVE_DOMAIN_BUTTON_CLASS);
}

function renderDomainButton(input: {
  domain: ContentSearchDomain;
  activeDomain: ContentSearchDomain;
  label: string;
  children: ReactNode;
  onDomainChange: (domain: ContentSearchDomain) => void;
}) {
  return (
    <button
      type="button"
      aria-label={input.label}
      className={domainButtonClass(input.activeDomain === input.domain)}
      onClick={() => input.onDomainChange(input.domain)}
    >
      {input.children}
    </button>
  );
}

function getPlaceholder(domain: ContentSearchDomain): string {
  if (domain === "conversation") return "Search chat…";
  if (domain === "diff") return "Search diff…";
  return "Find in page";
}

function hasDialogOverlay(): boolean {
  return (
    typeof document !== "undefined" &&
    Boolean(document.querySelector(".codex-dialog-overlay, [data-slot='codex-dialog-overlay']"))
  );
}

function subscribeDialogOverlays(onChange: () => void): () => void {
  if (typeof MutationObserver === "undefined") return () => undefined;
  const observer = new MutationObserver(onChange);
  observer.observe(document.body, { childList: true, subtree: true });
  return () => observer.disconnect();
}

function useDialogOverlaySuppressed(open: boolean): boolean {
  const suppressed = useSyncExternalStore(subscribeDialogOverlays, hasDialogOverlay, () => false);
  return open && suppressed;
}

export function ContentSearchSurfaceView({
  open,
  domain,
  query,
  hasBrowserTarget,
  loading,
  resultLabel,
  navigationDisabled,
  onDomainChange,
  onQueryChange,
  onClose,
  onNext,
  onPrevious,
}: ContentSearchSurfaceViewProps) {
  if (!open) return null;
  const navRowVisible = query.trim().length > 0 || loading || resultLabel.length > 0;

  return (
    <div
      data-content-search-surface="true"
      className="pointer-events-none fixed top-[calc(var(--app-shell-application-menu-height,0px)*var(--codex-window-zoom,1)+8px)] z-[55] flex justify-end"
      style={{ right: "calc(16px + var(--safe-area-right, 0px))" }}
    >
      <div className="no-drag pointer-events-auto grid w-[340px] max-w-[70vw] grid-cols-[minmax(0,1fr)_auto_auto] overflow-hidden rounded-[20px] border-[0.5px] border-token-border bg-token-side-bar-background shadow-[0px_8px_16px_-4px_rgba(0,0,0,0.12)]">
        <div className="col-[1/2] row-[1] flex h-[44px] min-w-0 items-center gap-2 pl-4">
          <SettingsSearchIcon className="size-4 text-token-input-placeholder-foreground" />
          <input
            id={CONTENT_SEARCH_INPUT_ID}
            value={query}
            onChange={(event) => onQueryChange(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                onClose();
                return;
              }
              if (event.key !== "Enter") return;
              event.preventDefault();
              if (navigationDisabled) return;
              if (event.shiftKey) {
                onPrevious();
              } else {
                onNext();
              }
            }}
            placeholder={getPlaceholder(domain)}
            className="h-6 min-w-0 flex-1 bg-transparent text-base leading-6 text-token-foreground outline-none placeholder:text-token-input-placeholder-foreground"
          />
        </div>

        <div className="col-[2/3] row-[1] flex h-[44px] items-center gap-1 text-token-description-foreground">
          {renderDomainButton({
            domain: "conversation",
            activeDomain: domain,
            label: "Search chat",
            onDomainChange,
            children: <ThreadIcon className="size-4" />,
          })}
          {renderDomainButton({
            domain: "diff",
            activeDomain: domain,
            label: "Search diffs",
            onDomainChange,
            children: <ContentSearchDiffIcon className="size-4" />,
          })}
          {hasBrowserTarget
            ? renderDomainButton({
                domain: "browser",
                activeDomain: domain,
                label: "Search browser page",
                onDomainChange,
                children: <GlobeIcon className="size-4" />,
              })
            : null}
        </div>

        <div className="col-[3/4] row-[1] flex h-[44px] items-center pr-4">
          <div aria-hidden="true" className="mr-2 ml-2 h-4 w-px bg-token-border" />
          <button
            type="button"
            aria-label="Close find"
            className="flex size-6 items-center justify-center rounded-full text-token-description-foreground transition-colors hover:bg-token-foreground/5 hover:text-token-foreground"
            onClick={onClose}
          >
            <CloseIcon className="size-4" />
          </button>
        </div>

        <div
          className={cn(
            NAV_ROW_BASE_CLASS,
            navRowVisible ? NAV_ROW_VISIBLE_CLASS : NAV_ROW_HIDDEN_CLASS,
          )}
        >
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label="Previous match"
              className={NAV_BUTTON_CLASS}
              disabled={navigationDisabled}
              onClick={onPrevious}
            >
              <UpArrowIcon className="size-4" />
            </button>
            <button
              type="button"
              aria-label="Next match"
              className={NAV_BUTTON_CLASS}
              disabled={navigationDisabled}
              onClick={onNext}
            >
              <UpArrowIcon className="size-4 rotate-180" />
            </button>
          </div>
          <div className="flex min-w-0 items-center gap-1.5 text-right">
            {loading ? <ActivitySpinnerIcon className="size-3" /> : null}
            <span className="truncate">{resultLabel}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export function ContentSearchSurface() {
  const controller = useContentSearch();
  const suppressed = useDialogOverlaySuppressed(controller.state.open);
  if (suppressed || typeof document === "undefined") return null;

  const domain = controller.state.domain;
  const query = controller.state.queryByDomain[domain];
  const loading = domain !== "browser" && controller.state.loadingDomain === domain;
  return createPortal(
    <ContentSearchSurfaceView
      open={controller.state.open}
      domain={domain}
      query={query}
      hasBrowserTarget={controller.hasBrowserTarget}
      loading={loading}
      resultLabel={controller.resultLabel}
      navigationDisabled={controller.navigationDisabled}
      onDomainChange={controller.setDomain}
      onQueryChange={controller.setQuery}
      onClose={controller.close}
      onNext={controller.goNext}
      onPrevious={controller.goPrevious}
    />,
    document.body,
  );
}
