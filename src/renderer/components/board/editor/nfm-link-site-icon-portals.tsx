import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { SiteIcon } from "@/components/shared/site-icon";
import { GitHubThreadGlyph } from "@/features/github-thread/github-thread-inline-link";
import { parseGitHubThreadUrl } from "../../../../shared/github-thread";
import type { LinkSiteIconSlots } from "./nfm-link-site-icons";

function LinkSiteMark({ href }: { readonly href: string }) {
  const thread = parseGitHubThreadUrl(href);
  if (thread) return <GitHubThreadGlyph thread={thread.ref} />;
  return <SiteIcon href={href} className="size-full" />;
}

/** Renders every registered link icon of one editor into its widget. */
export function LinkSiteIconPortals({ slots }: { readonly slots: LinkSiteIconSlots }) {
  const list = useSyncExternalStore(slots.subscribe, slots.getSnapshot, slots.getSnapshot);
  return list.map((slot) =>
    createPortal(<LinkSiteMark href={slot.href} />, slot.element, String(slot.id)),
  );
}
