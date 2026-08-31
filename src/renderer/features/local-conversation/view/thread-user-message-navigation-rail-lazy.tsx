import { lazy, Suspense } from "react";
import { useMarkerNavigationIdleReady } from "@/components/shared/marker-navigation-rail";
import type { ThreadUserMessageNavigationItem } from "../thread-stage-types";
import { MIN_THREAD_USER_MESSAGE_NAVIGATION_ITEMS } from "../projection/thread-user-message-navigation-items";
import type { ThreadUserMessageNavigationRailProps } from "./thread-user-message-navigation-rail";

export const CODEX_USER_MESSAGE_NAVIGATION_FEATURE_FLAG_ID = 2551582477;

const LazyThreadUserMessageNavigationRail = lazy(() =>
  import("./thread-user-message-navigation-rail").then((module) => ({
    default: module.ThreadUserMessageNavigationRail,
  })),
);

export function ThreadUserMessageNavigationRailLazy({
  items,
  onRevealItem,
  onPreviewItem,
}: {
  items: ThreadUserMessageNavigationItem[];
  onRevealItem?: ThreadUserMessageNavigationRailProps["onRevealItem"];
  onPreviewItem?: ThreadUserMessageNavigationRailProps["onPreviewItem"];
}) {
  const idleReady = useMarkerNavigationIdleReady(
    items.length,
    MIN_THREAD_USER_MESSAGE_NAVIGATION_ITEMS,
  );

  if (items.length < MIN_THREAD_USER_MESSAGE_NAVIGATION_ITEMS) return null;
  if (!idleReady) return null;

  return (
    <Suspense fallback={null}>
      <LazyThreadUserMessageNavigationRail
        items={items}
        onRevealItem={onRevealItem}
        onPreviewItem={onPreviewItem}
      />
    </Suspense>
  );
}
