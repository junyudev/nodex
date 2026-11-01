import { useLinkOpeningSettings } from "@/lib/link-opening-settings";
import { useLinkOpening } from "@/lib/web-link-navigation";
import { resolveLinkOpenTarget, type LinkOpenTarget } from "../../../../shared/browser-url-policy";
import { resolveThreadOutputOpenAction } from "../projection/thread-output-presentation";
import type { ThreadSummaryPanelOutputRow } from "../projection/thread-summary-panel-output-model";

/** Files open in Nodex's file preview; web outputs follow the link destination settings. */
export type ThreadOutputDestination = "files" | LinkOpenTarget;

/** Where activating an output goes right now, so surfaces can say so before the click. */
export function useThreadOutputDestination(
  row: ThreadSummaryPanelOutputRow,
  hostId: string,
): ThreadOutputDestination {
  const links = useLinkOpening();
  const { settings } = useLinkOpeningSettings();
  const action = resolveThreadOutputOpenAction(row, hostId);
  if (action.type === "files") return "files";
  return resolveLinkOpenTarget({
    browserAvailable: links?.browserAvailable ?? false,
    url: action.url,
    openLinkInTarget: settings.openLinkInTarget,
    openLocalUrlInTarget: settings.openLocalUrlInTarget,
  });
}

export function threadOutputHoverDetail(destination: ThreadOutputDestination): string {
  if (destination === "files") return "Open preview";
  return destination === "in-app-browser" ? "Open" : "Open in default browser";
}
