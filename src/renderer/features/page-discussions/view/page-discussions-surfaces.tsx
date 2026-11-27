import type { RefObject } from "react";
import { usePageDiscussionsControllerContext } from "../page-discussions-context";
import { BlockAttributionHint } from "./block-attribution-hint";
import { PageDiscussionsMarginHost } from "./page-discussions-margin-host";

export { NewDiscussionComposer } from "./new-discussion-composer";

/** The margin beside a Page body, reading the Page's Discussions owner from context. */
export function PageDiscussionsMargin({
  origin,
  scrollContainerRef,
}: {
  readonly origin: HTMLElement | null;
  readonly scrollContainerRef: RefObject<HTMLElement | null>;
}) {
  const controller = usePageDiscussionsControllerContext();
  if (!controller) return null;
  return (
    <>
      <PageDiscussionsMarginHost
        controller={controller}
        origin={origin}
        scrollContainerRef={scrollContainerRef}
      />
      <BlockAttributionHint controller={controller} origin={origin} />
    </>
  );
}
