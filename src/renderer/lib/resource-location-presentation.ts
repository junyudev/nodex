import type { IntlShape } from "@/lib/i18n";
import type { ResourceLocationSegment } from "../../shared/resource-locations";

/** The top level of Space, named where a location has no owner to show. */
export function presentSpaceTopLevel(intl: IntlShape): string {
  return intl.formatMessage({ id: "lib.resourceLocation.space", defaultMessage: "Space" });
}

/** One owner in a location: its Page title or Database name. */
export function presentLocationSegment(segment: ResourceLocationSegment, intl: IntlShape): string {
  return (
    segment.title.trim() ||
    intl.formatMessage({ id: "lib.resourceLocation.untitled", defaultMessage: "Untitled" })
  );
}

/**
 * Where a resource lives, outermost owner first. Content at the top level of Space reads as
 * Space, so every placed resource names somewhere.
 */
export function presentResourceLocation(
  segments: readonly ResourceLocationSegment[],
  intl: IntlShape,
): readonly string[] {
  return segments.length === 0
    ? [presentSpaceTopLevel(intl)]
    : segments.map((segment) => presentLocationSegment(segment, intl));
}

/** The Project whose primary Database holds the resource, however deeply it is nested there. */
export function resourceLocationProjectId(
  segments: readonly ResourceLocationSegment[],
): string | null {
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    if (segment?.kind === "database" && segment.primaryProjectId) return segment.primaryProjectId;
  }
  return null;
}
