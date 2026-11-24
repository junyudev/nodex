import type { ChangelogRelease } from "../../../shared/changelog-feed";
import { defineMessage, getIntl } from "@/lib/i18n";
import { openInBrowser } from "@/lib/open-in-browser";

const OPEN_FAILED = defineMessage({
  id: "whatsNew.openFailed",
  defaultMessage: "Couldn't open the changelog",
});

/** Opens the changelog page, or a release's place on it, in the system browser. */
export function openChangelogPage(url: string): Promise<void> {
  return openInBrowser(url, getIntl().formatMessage(OPEN_FAILED));
}

/** A release's day, which the changelog states without a time of day or zone. */
export function releaseDay(release: ChangelogRelease): Date {
  return new Date(`${release.date}T00:00:00Z`);
}
