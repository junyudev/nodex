import { useEffect, useState } from "react";
import type { ChangelogRelease } from "../../../shared/changelog-feed";
import { persistedAtom, usePersistedAtomValue, useSetPersistedAtom } from "@/lib/maitai";
import { advanceSeenVersion, releasesNewSince } from "./whats-new-model";

/** The newest release this Profile has been shown in What's new. */
const seenReleaseAtom = persistedAtom<string | null>({
  debugLabel: "whats-new-seen",
  storageKey: "nodex:whats-new-seen:v1",
  defaultValue: null,
  hydration: "eager",
  synchronization: "cross-window",
  optimistic: true,
  writeFailure: "retain-and-error",
  decode: (value) => (typeof value === "string" && value.length > 0 ? value : null),
});

const NOTHING_NEW: ReadonlySet<string> = new Set();

/**
 * Which releases are new to the person since they last opened What's new. Showing releases counts
 * as seeing them, so they are recorded as seen right away, while the marks keep what was seen when
 * What's new opened until it closes.
 */
export function useNewReleases(
  releases: readonly ChangelogRelease[] | undefined,
): ReadonlySet<string> {
  const seen = usePersistedAtomValue(seenReleaseAtom);
  const writeSeen = useSetPersistedAtom(seenReleaseAtom);
  const [seenWhenOpened, setSeenWhenOpened] = useState<{ readonly version: string | null }>();
  if (seen.status === "ready" && seenWhenOpened === undefined) {
    setSeenWhenOpened({ version: seen.value });
  }

  const unseen =
    seen.status === "ready" && releases !== undefined
      ? advanceSeenVersion(seen.value, releases) !== seen.value
      : false;
  useEffect(() => {
    if (!unseen || releases === undefined) return;
    // A release that fails to save as seen is only marked again next time.
    void writeSeen((current) => advanceSeenVersion(current, releases)).catch(() => undefined);
  }, [unseen, releases, writeSeen]);

  return seenWhenOpened && releases
    ? releasesNewSince(releases, seenWhenOpened.version)
    : NOTHING_NEW;
}
