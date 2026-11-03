import { useCallback, useEffect, useLayoutEffect, useMemo, useState, type RefObject } from "react";
import { useResolvedReducedMotion } from "@/lib/use-reduced-motion";
import {
  collectMarkerNavigationObservationTargets,
  MarkerNavigationRail,
  markerNavigationMutationsIncludeContainer,
  useMarkerNavigationIdleReady,
} from "@/components/shared/marker-navigation-rail";
import { findBlockElementById } from "./block-dom-selectors";
import {
  collectNfmHeadingNavigationItems,
  isNfmHeadingNavigationEligible,
  MIN_NFM_HEADING_NAVIGATION_ITEMS,
  type NfmHeadingNavigationBlockLike,
  type NfmHeadingNavigationItem,
} from "./nfm-heading-navigation-rail-model";

interface NfmHeadingNavigationEditor {
  document: NfmHeadingNavigationBlockLike[];
  domElement?: HTMLElement | null;
  onChange: (listener: () => void) => () => void;
}

interface NfmHeadingNavigationRailProps {
  editor: NfmHeadingNavigationEditor;
  scrollContainerRef: RefObject<HTMLElement | null>;
  portalElement: HTMLElement | null;
  isActivePanelTab: boolean;
}

function useCoarsePointer(): boolean {
  const [coarsePointer, setCoarsePointer] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;

    const query = window.matchMedia("(pointer: coarse)");
    const sync = () => {
      setCoarsePointer(query.matches);
    };
    sync();
    query.addEventListener?.("change", sync);
    return () => {
      query.removeEventListener?.("change", sync);
    };
  }, []);

  return coarsePointer;
}

function useHeadingNavigationItems(editor: NfmHeadingNavigationEditor): NfmHeadingNavigationItem[] {
  const [items, setItems] = useState(() => collectNfmHeadingNavigationItems(editor.document));

  useEffect(() => {
    const sync = () => {
      setItems(collectNfmHeadingNavigationItems(editor.document));
    };

    sync();
    const unsubscribeChange = editor.onChange(sync);
    return () => {
      unsubscribeChange();
    };
  }, [editor]);

  return items;
}

function HeadingTooltipContent({ item }: { item: NfmHeadingNavigationItem }) {
  return (
    <div className="w-72 max-w-[calc(100vw-1rem)] overflow-hidden rounded-xl bg-token-dropdown-background/95 p-2 text-sm leading-5 text-token-foreground shadow-xl-spread ring-[0.5px] ring-token-border backdrop-blur-sm">
      <div className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 rounded-md bg-token-foreground/5 px-1.5 py-0.5 text-xs leading-4 text-token-description-foreground">
          H{item.level}
        </span>
        <div className="min-w-0 truncate font-medium">{item.label}</div>
      </div>
      <div className="mt-1 truncate text-xs text-token-description-foreground">
        Heading {item.ordinal}
      </div>
    </div>
  );
}

export function NfmHeadingNavigationRail({
  editor,
  scrollContainerRef,
  portalElement,
  isActivePanelTab,
}: NfmHeadingNavigationRailProps) {
  const items = useHeadingNavigationItems(editor);
  const coarsePointer = useCoarsePointer();
  const reducedMotion = useResolvedReducedMotion();
  const idleReady = useMarkerNavigationIdleReady(items.length, MIN_NFM_HEADING_NAVIGATION_ITEMS);
  const itemIdsKey = useMemo(() => items.map((item) => item.id).join("\n"), [items]);

  const eligible = isNfmHeadingNavigationEligible({
    itemCount: items.length,
    isActivePanelTab,
    isRawContent: false,
    isCoarsePointer: coarsePointer,
  });

  const [elements, setElements] = useState<{
    scroll: HTMLElement | null;
    content: HTMLElement | null;
  }>({ scroll: null, content: null });
  useLayoutEffect(() => {
    const scroll = scrollContainerRef.current;
    const content = scroll?.querySelector<HTMLElement>("[data-page-stage-body='true']") ?? null;
    setElements((current) =>
      current.scroll === scroll && current.content === content ? current : { scroll, content },
    );
  }, [scrollContainerRef]);

  const findHeadingTarget = useCallback(
    (_scrollElement: HTMLElement, item: NfmHeadingNavigationItem): HTMLElement | null => {
      return findBlockElementById(editor.domElement ?? undefined, item.id);
    },
    [editor.domElement],
  );

  const collectHeadingObservationTargets = useCallback(
    (root: ParentNode, itemIds: ReadonlySet<string>) =>
      collectMarkerNavigationObservationTargets({
        root,
        itemIds,
        targetSelector: ".bn-block[data-id]",
        readItemId: (target) => target.dataset.id,
      }),
    [],
  );

  const scrollHeadingIntoView = useCallback(
    (targetElement: HTMLElement, behavior: ScrollBehavior) => {
      targetElement.scrollIntoView({
        behavior,
        block: "start",
      });
    },
    [],
  );

  const mutationsIncludeObservationTargets = useCallback(
    (records: readonly MutationRecord[]) =>
      markerNavigationMutationsIncludeContainer(records, ".bn-block[data-id]"),
    [],
  );

  const highlightHeading = useCallback(
    (targetElement: HTMLElement) => {
      if (typeof targetElement.animate !== "function") return;
      for (const animation of targetElement.getAnimations?.() ?? []) {
        animation.cancel();
      }
      targetElement.animate(
        [
          { backgroundColor: "color-mix(in srgb, var(--color-token-foreground) 12%, transparent)" },
          { backgroundColor: "color-mix(in srgb, var(--color-token-foreground) 0%, transparent)" },
        ],
        {
          duration: reducedMotion ? 0 : 900,
          easing: "ease-out",
        },
      );
    },
    [reducedMotion],
  );

  if (!eligible || !idleReady) return null;

  return (
    <MarkerNavigationRail
      key={itemIdsKey}
      ariaLabel="Headings"
      items={items}
      rowAriaLabel={(item) => `Jump to heading ${item.ordinal}: ${item.label}`}
      scrollElement={elements.scroll}
      contentElement={elements.content}
      portalTarget={portalElement}
      findTarget={findHeadingTarget}
      collectObservationTargets={collectHeadingObservationTargets}
      mutationsIncludeObservationTargets={mutationsIncludeObservationTargets}
      scrollTargetIntoView={scrollHeadingIntoView}
      renderTooltipContent={(item) => <HeadingTooltipContent item={item} />}
      highlightTarget={highlightHeading}
      side="right"
    />
  );
}
