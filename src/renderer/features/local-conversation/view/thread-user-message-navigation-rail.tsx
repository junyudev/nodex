import { useCallback, type ComponentType } from "react";
import { useResolvedReducedMotion } from "@/lib/use-reduced-motion";
import {
  SidePanelReviewIcon,
  ReviewCommitOrPushIcon,
  ReviewCreatePrIcon,
  FileIcon,
} from "@/components/shared/icons";
import {
  collectMarkerNavigationObservationTargets,
  ensureMarkerNavigationRowVisible,
  escapeMarkerNavigationAttributeSelectorValue,
  hasEnoughMarkerNavigationSideSpace,
  markerNavigationMutationsIncludeContainer,
  MarkerNavigationRail,
  type MarkerNavigationObservationTarget,
  type MarkerNavigationRevealMode,
  resolveMarkerNavigationCurrentRangeIds,
} from "@/components/shared/marker-navigation-rail";
import { MARKER_NAVIGATION_VIRTUALIZE_AFTER } from "@/components/shared/marker-navigation-window";
import { logTelemetryEvent } from "@/lib/statsig-telemetry";
import type {
  ThreadUserMessageNavigationItem,
  ThreadUserMessageNavigationOutput,
  ThreadUserMessageNavigationOutputType,
} from "../thread-stage-types";
import { getThreadUserMessageNavigationVisibleOutputs } from "../projection/thread-user-message-navigation-items";
import { useLocalConversationThreadScrollController } from "./local-conversation-thread-scroll-controller";
import {
  ConnectorFallbackIcon,
  EditFilesIcon,
  ConnectorGlobeIcon,
  PluginCubeIcon,
} from "@/components/shared/icons";

export type ThreadUserMessageNavigationRevealMode = MarkerNavigationRevealMode;

export const THREAD_USER_MESSAGE_NAVIGATION_TURN_CONTAINER_SELECTOR =
  "[data-turn-key], [data-content-search-turn-key]";

const THREAD_USER_MESSAGE_NAVIGATION_SEARCH_UNIT_SELECTOR = "[data-content-search-unit-key]";

export interface ThreadUserMessageNavigationRailProps {
  items: ThreadUserMessageNavigationItem[];
  onRevealItem?: (
    item: ThreadUserMessageNavigationItem,
    mode: ThreadUserMessageNavigationRevealMode,
  ) => HTMLElement | null | Promise<HTMLElement | null>;
  onPreviewItem?: (item: ThreadUserMessageNavigationItem) => void;
}

function findUserMessageTarget(
  scrollElement: HTMLElement,
  item: ThreadUserMessageNavigationItem,
): HTMLElement | null {
  return scrollElement.querySelector<HTMLElement>(
    `[data-content-search-unit-key="${escapeMarkerNavigationAttributeSelectorValue(item.id)}"]`,
  );
}

export function resolveThreadUserMessageNavigationCurrentRangeIds(
  items: readonly ThreadUserMessageNavigationItem[],
  visibleIds: ReadonlySet<string>,
): Set<string> | null {
  return resolveMarkerNavigationCurrentRangeIds(items, visibleIds);
}

export type ThreadUserMessageNavigationObservationTarget = MarkerNavigationObservationTarget;

export function collectThreadUserMessageNavigationObservationTargets(
  root: ParentNode,
  itemIds: ReadonlySet<string>,
): ThreadUserMessageNavigationObservationTarget[] {
  return collectMarkerNavigationObservationTargets({
    root,
    itemIds,
    targetSelector: THREAD_USER_MESSAGE_NAVIGATION_SEARCH_UNIT_SELECTOR,
    containerSelector: THREAD_USER_MESSAGE_NAVIGATION_TURN_CONTAINER_SELECTOR,
    readItemId: (target) => target.dataset.contentSearchUnitKey,
  });
}

export function threadUserMessageNavigationMutationsIncludeTurnContainer(
  records: readonly MutationRecord[],
): boolean {
  return markerNavigationMutationsIncludeContainer(
    records,
    THREAD_USER_MESSAGE_NAVIGATION_TURN_CONTAINER_SELECTOR,
  );
}

export function ensureThreadUserMessageNavigationRowVisible(
  listElement: HTMLElement | null,
  activeItemId: string | null,
) {
  ensureMarkerNavigationRowVisible(listElement, activeItemId);
  if (!listElement || !activeItemId) return;

  const row = listElement.querySelector<HTMLElement>(
    `[data-thread-user-message-navigation-item-id="${escapeMarkerNavigationAttributeSelectorValue(activeItemId)}"]`,
  );
  if (!row) return;

  if (row.offsetTop < listElement.scrollTop) {
    listElement.scrollTop = row.offsetTop;
    return;
  }

  if (row.offsetTop + row.offsetHeight > listElement.scrollTop + listElement.clientHeight) {
    listElement.scrollTop = row.offsetTop + row.offsetHeight - listElement.clientHeight + 1;
  }
}

export function hasEnoughThreadUserMessageNavigationLeftSpace({
  scrollElement,
  contentElement,
}: {
  scrollElement: HTMLElement;
  contentElement: HTMLElement;
}): boolean {
  return hasEnoughMarkerNavigationSideSpace({
    scrollElement,
    contentElement,
    side: "left",
  });
}

function resolveOutputIcon(
  type: ThreadUserMessageNavigationOutputType,
): ComponentType<{ className?: string; "aria-hidden"?: boolean }> {
  if (type === "app") return PluginCubeIcon;
  if (type === "website") return ConnectorGlobeIcon;
  if (type === "google-drive") return ConnectorFallbackIcon;
  if (type === "image") return EditFilesIcon;
  if (type === "commit") return ReviewCommitOrPushIcon;
  if (type === "pull-request") return ReviewCreatePrIcon;
  if (type === "review") return SidePanelReviewIcon;
  return FileIcon;
}

function NavigationOutputPill({ output }: { output: ThreadUserMessageNavigationOutput }) {
  const Icon = resolveOutputIcon(output.type);
  return (
    <span className="inline-flex min-w-0 items-center gap-1 rounded-md bg-token-foreground/5 px-1.5 py-0.5 text-xs leading-4 text-token-description-foreground">
      <Icon className="icon-3xs shrink-0" aria-hidden={true} />
      <span className="truncate">{output.label}</span>
    </span>
  );
}

function NavigationTooltipContent({ item }: { item: ThreadUserMessageNavigationItem }) {
  const outputs = getThreadUserMessageNavigationVisibleOutputs(item.outputs);

  return (
    <div className="w-80 max-w-[calc(100vw-1rem)] overflow-hidden rounded-xl bg-token-dropdown-background/95 p-2 text-sm leading-5 text-token-foreground shadow-xl-spread ring-[0.5px] ring-token-border backdrop-blur-sm">
      <div className="truncate font-medium">{item.label}</div>
      {item.responsePreview ? (
        <div className="mt-1 line-clamp-3 text-token-description-foreground">
          {item.responsePreview}
        </div>
      ) : null}
      {outputs.length > 0 ? (
        <div className="mt-2 flex min-w-0 flex-wrap gap-1">
          {outputs.map((output) => (
            <NavigationOutputPill key={output.id} output={output} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function ThreadUserMessageNavigationRail({
  items,
  onRevealItem,
  onPreviewItem,
}: ThreadUserMessageNavigationRailProps) {
  const { scrollElement, scrollElementIntoView, setScrollMode } =
    useLocalConversationThreadScrollController();
  const reducedMotion = useResolvedReducedMotion();
  const contentElement =
    scrollElement?.querySelector<HTMLElement>("[data-mcp-app-portal-target='true']") ?? null;

  const highlightTarget = useCallback(
    (targetElement: HTMLElement) => {
      const pulseElement =
        targetElement.querySelector<HTMLElement>(
          "[data-user-message-bubble='true'],[data-composer-attachment-pill='true']",
        ) ?? targetElement;

      if (typeof pulseElement.animate !== "function") return;
      for (const animation of pulseElement.getAnimations?.() ?? []) {
        animation.cancel();
      }
      pulseElement.animate(
        [
          { backgroundColor: "color-mix(in srgb, var(--color-token-foreground) 14%, transparent)" },
          { backgroundColor: "color-mix(in srgb, var(--color-token-foreground) 5%, transparent)" },
        ],
        {
          duration: reducedMotion ? 0 : 1400,
          easing: "ease-out",
        },
      );
    },
    [reducedMotion],
  );

  const handleScrollTargetIntoView = useCallback(
    (targetElement: HTMLElement, behavior: ScrollBehavior) => {
      setScrollMode("programmaticFind");
      scrollElementIntoView(targetElement, behavior, "start");
    },
    [scrollElementIntoView, setScrollMode],
  );

  return (
    <MarkerNavigationRail
      ariaLabel="User messages"
      items={items}
      rowAriaLabel={(item) => `Jump to user message ${item.ordinal}`}
      scrollElement={scrollElement}
      contentElement={contentElement}
      portalTarget={scrollElement?.parentElement ?? null}
      findTarget={findUserMessageTarget}
      collectObservationTargets={collectThreadUserMessageNavigationObservationTargets}
      mutationsIncludeObservationTargets={threadUserMessageNavigationMutationsIncludeTurnContainer}
      scrollTargetIntoView={handleScrollTargetIntoView}
      renderTooltipContent={(item) => <NavigationTooltipContent item={item} />}
      highlightTarget={highlightTarget}
      onRevealMissingItem={onRevealItem}
      onItemPreviewIntent={onPreviewItem}
      onClickItem={(item) => {
        logTelemetryEvent("thread_user_message_navigation", undefined, {
          ordinal: item.ordinal,
          itemCount: items.length,
          navigationMode: "smooth",
        });
      }}
      listDataAttributes={{
        "data-thread-user-message-navigation-rail-list": "true",
      }}
      getRowDataAttributes={(item) => ({
        "data-thread-user-message-navigation-item-id": item.id,
      })}
      markerClassName="thread-user-message-navigation-marker"
      virtualizeAfter={MARKER_NAVIGATION_VIRTUALIZE_AFTER}
    />
  );
}
