import { isEventWithinCurrentTarget } from "@/lib/react-event-ownership";
import { useIntl } from "@/lib/i18n";
import {
  useCallback,
  useId,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefCallback,
  type SyntheticEvent,
} from "react";
import { ChevronRightIcon, PageIcon } from "@/components/shared/icons";
import { LoadingResultsShimmer } from "@/components/ui/loading-results-shimmer";
import { INLINE_REFERENCE_UNDERLINE_STYLE } from "@/components/board/inline-reference-visual";
import {
  BlockDisclosureStateStore,
  blockDisclosureStateStore,
  useBlockDisclosure,
} from "@/lib/block-disclosure-state";
import {
  ReferenceSurfaceActivationPriority,
  ReferenceSurfaceActivationBudget,
  referenceSurfaceActivationBudget,
  useReferenceSurfaceActivation,
} from "@/lib/reference-surface-state";
import { embeddedEditorSelectionContextAttributes } from "@/lib/editor-selection-presentation";
import { useElementVisibility } from "@/lib/use-element-visibility";
import { cn } from "@/lib/utils";

export interface PageOutlinerStateDependencies {
  readonly disclosureStore?: BlockDisclosureStateStore;
  readonly activationBudget?: ReferenceSurfaceActivationBudget;
  /** Deterministic visibility for focused tests; production uses IntersectionObserver. */
  readonly visibilityOverride?: boolean;
}

export interface PageOutlinerActivation {
  readonly active: boolean;
  readonly expanded: boolean;
  readonly titleEngaged: boolean;
  readonly visible: boolean;
  readonly engageTitle: () => void;
  readonly releaseTitle: () => void;
  readonly sectionRef: RefCallback<HTMLElement>;
  readonly setExpanded: (expanded: boolean) => void;
  readonly touch: () => void;
}

export const usePageOutlinerActivation = ({
  disclosureKey,
  expandable,
  defaultExpanded = false,
  disclosureStore = blockDisclosureStateStore,
  activationBudget = referenceSurfaceActivationBudget,
  visibilityOverride,
}: PageOutlinerStateDependencies & {
  readonly disclosureKey: string;
  readonly expandable: boolean;
  /** How the row shows until the reader toggles it. */
  readonly defaultExpanded?: boolean;
}): PageOutlinerActivation => {
  const surfaceInstanceId = useId();
  const surfaceInstanceKey = `page-outliner:${disclosureKey}:mount:${surfaceInstanceId}`;
  const [preferredExpanded, setExpanded] = useBlockDisclosure(
    disclosureKey,
    disclosureStore,
    defaultExpanded,
  );
  const expanded = expandable && preferredExpanded;
  const { ref: visibilityRef, visible: observedVisible } = useElementVisibility();
  const visible = visibilityOverride ?? observedVisible;
  const [titleEngaged, setTitleEngaged] = useState(false);
  if (!expandable && titleEngaged) setTitleEngaged(false);
  const active = useReferenceSurfaceActivation(
    surfaceInstanceKey,
    expandable && (titleEngaged || (expanded && visible)),
    activationBudget,
    titleEngaged
      ? ReferenceSurfaceActivationPriority.editing
      : ReferenceSurfaceActivationPriority.visibility,
  );
  const engageTitle = useCallback(() => setTitleEngaged(true), []);
  const releaseTitle = useCallback(() => setTitleEngaged(false), []);
  const touch = useCallback(
    () => activationBudget.touch(surfaceInstanceKey),
    [activationBudget, surfaceInstanceKey],
  );
  return {
    active,
    expanded,
    titleEngaged,
    visible,
    engageTitle,
    releaseTitle,
    sectionRef: visibilityRef,
    setExpanded,
    touch,
  };
};

export interface PageOutlinerFrameProps {
  readonly targetBlockId: string;
  readonly accessKind?: "library" | "project";
  readonly expanded: boolean;
  readonly active: boolean;
  readonly sectionRef?: RefCallback<HTMLElement>;
  readonly onTouch?: () => void;
  readonly children?: ReactNode;
}

/** The observed DOM anchor never changes while row content loads or activates. */
export function PageOutlinerFrame({
  targetBlockId,
  accessKind,
  expanded,
  active,
  sectionRef,
  onTouch,
  children,
}: PageOutlinerFrameProps) {
  const handleTouch = (event: SyntheticEvent<HTMLElement>) => {
    if (!isEventWithinCurrentTarget(event)) return;
    onTouch?.();
  };
  return (
    <section
      ref={sectionRef}
      contentEditable={false}
      {...embeddedEditorSelectionContextAttributes}
      data-page-outliner-target={targetBlockId}
      data-page-outliner-access={accessKind}
      data-page-outliner-expanded={expanded ? "true" : "false"}
      data-page-outliner-active={active ? "true" : "false"}
      className="relative w-full min-w-0 self-stretch"
      onFocusCapture={handleTouch}
      onPointerDownCapture={handleTouch}
    >
      {children}
    </section>
  );
}

export interface PageOutlinerRowContentProps {
  readonly plainTitle: string;
  readonly title: ReactNode;
  /** The Page's identity glyph; the generic Page icon when omitted. */
  readonly icon?: ReactNode;
  readonly stateLabel?: string | null;
  readonly metadata?: ReactNode;
  readonly expanded: boolean;
  readonly expandable: boolean;
  readonly onExpandedChange: (expanded: boolean) => void;
  readonly onOpenPage?: () => void | Promise<void>;
  readonly children?: ReactNode;
}

export type PageOutlinerRowChromeProps = Omit<PageOutlinerRowContentProps, "title" | "children">;

interface PageOutlinerDisclosureProps extends PageOutlinerRowChromeProps {
  readonly children: ReactNode;
}

// While the row's own header is under the pointer, its glyph yields to the
// disclosure chevron. Child combinators keep a hovered nested row from
// reaching an outer row's glyph.
const HEADER_HOVER_REVEALS_CHEVRON =
  "[&:has(>[data-page-outliner-row]:hover)>[data-page-outliner-caret]>[data-page-outliner-glyph=icon]]:hidden [&:has(>[data-page-outliner-row]:hover)>[data-page-outliner-caret]>[data-page-outliner-glyph=chevron]]:flex";

/** Owns the permanent disclosure control; target runtimes replace only its slots. */
export function PageOutlinerDisclosure({
  plainTitle,
  icon,
  expanded,
  expandable,
  onExpandedChange,
  children,
}: PageOutlinerDisclosureProps) {
  const intl = useIntl();
  const handleKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.isDefaultPrevented() || event.nativeEvent.isComposing) return;
    if (!isEventWithinCurrentTarget(event)) return;
    if (event.key !== "Enter") return;
    if (!event.metaKey && !event.ctrlKey) return;
    if (event.altKey || event.shiftKey || !expandable) return;

    const target = event.target;
    if (target instanceof Element) {
      const body = target.closest<HTMLElement>("[data-page-outliner-body]");
      if (body && event.currentTarget.contains(body)) return;
    }

    onExpandedChange(!expanded);
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div
      className={cn(
        "bn-toggle-wrapper group/page-outliner grid! min-h-8 w-full min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-y-1 pt-1",
        expandable && HEADER_HOVER_REVEALS_CHEVRON,
      )}
      data-show-children={expanded ? "true" : "false"}
      onKeyDownCapture={handleKeyDownCapture}
    >
      {/* Like a sidebar folder, the Page's glyph becomes its disclosure under the pointer. */}
      <button
        type="button"
        data-page-outliner-caret
        aria-label={
          expanded
            ? intl.formatMessage(
                {
                  id: "components.pageOutlinerSurface.collapse",
                  defaultMessage: "Collapse {title}",
                },
                { title: plainTitle },
              )
            : intl.formatMessage(
                { id: "components.pageOutlinerSurface.expand", defaultMessage: "Expand {title}" },
                { title: plainTitle },
              )
        }
        aria-expanded={expanded}
        disabled={!expandable}
        className={cn(
          "group/page-outliner-caret ms-0.5 me-1 flex h-6 w-5 shrink-0 select-none items-center justify-center rounded-[5px] text-token-description-foreground",
          expandable
            ? "cursor-interaction hover:bg-token-foreground/5 hover:text-token-text-secondary"
            : "cursor-default",
        )}
        onClick={() => onExpandedChange(!expanded)}
      >
        <span
          data-page-outliner-glyph="icon"
          aria-hidden="true"
          className={cn(
            "flex size-4 items-center justify-center",
            expandable &&
              "group-hover/page-outliner-caret:hidden group-focus-visible/page-outliner-caret:hidden",
          )}
        >
          {icon ?? <PageIcon className="size-full" />}
        </span>
        {expandable ? (
          <span
            data-page-outliner-glyph="chevron"
            aria-hidden="true"
            className="hidden size-4 items-center justify-center group-hover/page-outliner-caret:flex group-focus-visible/page-outliner-caret:flex"
          >
            <ChevronRightIcon
              className={cn("size-4 transition-transform duration-200", expanded && "rotate-90")}
            />
          </span>
        ) : null}
      </button>
      {children}
    </div>
  );
}

export function PageOutlinerRowSlots({
  plainTitle,
  title,
  stateLabel,
  metadata,
  expanded,
  onOpenPage,
  children,
}: Omit<PageOutlinerRowContentProps, "expandable" | "onExpandedChange" | "icon">) {
  const intl = useIntl();
  return (
    <>
      <div
        data-page-outliner-row
        className="col-start-2 row-start-1 flex min-h-6 min-w-0 items-start gap-1 pe-0.5 text-[1em] leading-6 text-token-text-primary"
      >
        {/* The title reads as a link to its Page and is the row's tab stop; Enter
            opens it. Renaming in place is the arrow-key path into the title,
            and the link yields while the title editor has focus. */}
        <div
          data-page-outliner-title
          className={cn("relative min-w-0 flex-1", onOpenPage && "font-medium underline")}
          style={onOpenPage ? INLINE_REFERENCE_UNDERLINE_STYLE : undefined}
        >
          {title}
          {onOpenPage ? (
            <button
              type="button"
              data-page-outliner-open
              aria-label={intl.formatMessage(
                { id: "components.pageOutlinerSurface.openTitle", defaultMessage: "Open {title}" },
                { title: plainTitle },
              )}
              className="absolute inset-0 cursor-interaction rounded-[3px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-token-focus-border [[data-page-outliner-title]:has([data-embedded-surface-input]:focus-within)>&]:hidden"
              // A pointer opens the Page without moving focus out of the editor.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => void onOpenPage()}
            />
          ) : null}
        </div>
        {stateLabel ? (
          <span className="shrink-0 text-[11px] text-token-description-foreground">
            {stateLabel}
          </span>
        ) : null}
        {metadata}
      </div>

      {expanded ? (
        <div
          data-page-outliner-body
          className="col-span-2 col-start-1 row-start-2 w-full min-w-0 ps-6"
        >
          {children}
        </div>
      ) : null}
    </>
  );
}

export function PageOutlinerBodySkeleton() {
  const intl = useIntl();
  return (
    <div
      role="status"
      aria-label={intl.formatMessage({
        id: "components.pageOutlinerSurface.openingPage",
        defaultMessage: "Opening Page content",
      })}
      aria-live="polite"
      className="py-1.5"
    >
      <LoadingResultsShimmer
        lines={2}
        maxWidth={72}
        minWidth={48}
        seed="page-outliner-body"
        size="sm"
      />
    </div>
  );
}
