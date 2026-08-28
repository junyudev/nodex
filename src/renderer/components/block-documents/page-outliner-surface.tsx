import {
  useCallback,
  useEffect,
  useId,
  useState,
  type FocusEventHandler,
  type KeyboardEvent,
  type PointerEventHandler,
  type ReactNode,
  type RefCallback,
} from "react";
import { OpenInIcon } from "@/components/shared/icons";
import { LoadingResultsShimmer } from "@/components/ui/loading-results-shimmer";
import { NodexTooltip } from "@/components/ui/tooltip";
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
  /** Deterministic test/story seam; production always uses IntersectionObserver. */
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
  disclosureStore = blockDisclosureStateStore,
  activationBudget = referenceSurfaceActivationBudget,
  visibilityOverride,
}: PageOutlinerStateDependencies & {
  readonly disclosureKey: string;
  readonly expandable: boolean;
}): PageOutlinerActivation => {
  const surfaceInstanceId = useId();
  const surfaceInstanceKey = `page-outliner:${disclosureKey}:mount:${surfaceInstanceId}`;
  const [preferredExpanded, setExpanded] = useBlockDisclosure(disclosureKey, disclosureStore);
  const expanded = expandable && preferredExpanded;
  const visibility = useElementVisibility();
  const visible = visibilityOverride ?? visibility.visible;
  const [titleEngaged, setTitleEngaged] = useState(false);
  useEffect(() => {
    if (!expandable) setTitleEngaged(false);
  }, [expandable]);
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
    sectionRef: visibility.ref,
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
  const handleFocus: FocusEventHandler<HTMLElement> = () => onTouch?.();
  const handlePointerDown: PointerEventHandler<HTMLElement> = () => onTouch?.();
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
      onFocusCapture={handleFocus}
      onPointerDownCapture={handlePointerDown}
    >
      {children}
    </section>
  );
}

export interface PageOutlinerRowContentProps {
  readonly plainTitle: string;
  readonly title: ReactNode;
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

/** Owns the permanent disclosure control; target runtimes replace only its slots. */
export function PageOutlinerDisclosure({
  plainTitle,
  expanded,
  expandable,
  onExpandedChange,
  children,
}: PageOutlinerDisclosureProps) {
  const handleKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.isDefaultPrevented() || event.nativeEvent.isComposing) return;
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
      className="bn-toggle-wrapper group/page-outliner grid! min-h-8 w-full min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-y-1 pt-1"
      data-show-children={expanded ? "true" : "false"}
      onKeyDownCapture={handleKeyDownCapture}
    >
      <button
        type="button"
        data-page-outliner-caret
        aria-label={expanded ? `Collapse ${plainTitle}` : `Expand ${plainTitle}`}
        aria-expanded={expanded}
        disabled={!expandable}
        className={cn(
          "bn-toggle-button ms-0.5 shrink-0",
          expandable ? "cursor-pointer" : "cursor-default opacity-35",
        )}
        onClick={() => onExpandedChange(!expanded)}
      />
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
}: Omit<PageOutlinerRowContentProps, "expandable" | "onExpandedChange">) {
  return (
    <>
      <div className="col-start-2 row-start-1 flex min-h-6 min-w-0 items-start gap-1 pe-0.5 text-[1em] leading-6 text-token-text-primary">
        <div className="min-w-0 flex-1">{title}</div>
        {stateLabel ? (
          <span className="shrink-0 text-[11px] text-token-description-foreground">
            {stateLabel}
          </span>
        ) : null}
        {metadata}
        {onOpenPage ? (
          <NodexTooltip tooltipContent="Open Page" side="top">
            <button
              type="button"
              aria-label={`Open ${plainTitle}`}
              className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-sm text-token-description-foreground opacity-0 group-hover/page-outliner:opacity-100 hover:bg-token-foreground/8 hover:text-token-text-primary focus-visible:opacity-100"
              onClick={() => void onOpenPage()}
            >
              <OpenInIcon aria-hidden="true" className="size-3.5" />
            </button>
          </NodexTooltip>
        ) : null}
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

export function PageOutlinerRowContent(props: PageOutlinerRowContentProps) {
  return (
    <PageOutlinerDisclosure {...props}>
      <PageOutlinerRowSlots {...props} />
    </PageOutlinerDisclosure>
  );
}

export interface PageOutlinerRowProps extends PageOutlinerFrameProps, PageOutlinerRowContentProps {}

/** Convenience composite for stories and simple consumers. */
export function PageOutlinerRow({
  targetBlockId,
  accessKind,
  active,
  sectionRef,
  onTouch,
  ...content
}: PageOutlinerRowProps) {
  return (
    <PageOutlinerFrame
      targetBlockId={targetBlockId}
      accessKind={accessKind}
      expanded={content.expanded}
      active={active}
      sectionRef={sectionRef}
      onTouch={onTouch}
    >
      <PageOutlinerRowContent {...content} />
    </PageOutlinerFrame>
  );
}

export function PageOutlinerBodySkeleton() {
  return (
    <div role="status" aria-label="Opening Page content" aria-live="polite" className="py-1.5">
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
