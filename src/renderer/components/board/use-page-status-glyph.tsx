import type { ReactNode } from "react";

import { useContentPageDetail } from "@/lib/content-page-detail";
import { readPageDetailWorkflowStatus } from "@/lib/page-stage-properties";
import { StatusIcon } from "@/lib/status-presentation";
import type { ContentRoutingContext } from "../../../shared/content-routing-context";

/**
 * A Database Page with a current workflow Status is shown by that Status;
 * every other Page falls back to the caller's generic Page icon. Pass `null`
 * for a Page that cannot carry a Status, which reads nothing.
 */
export function usePageStatusGlyph(
  routingContext: ContentRoutingContext,
  page: { readonly libraryId: string; readonly pageId: string } | null,
): ReactNode | undefined {
  const detail = useContentPageDetail(
    page?.libraryId ?? null,
    routingContext,
    page?.pageId ?? null,
  );
  const workflowStatus = readPageDetailWorkflowStatus(detail.detail);
  return workflowStatus ? (
    <StatusIcon statusId={workflowStatus} className="size-full" />
  ) : undefined;
}
