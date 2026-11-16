import { getIntl, subscribeAppLocale, type IntlShape } from "@/lib/i18n";

export interface PageTitleSource {
  readonly getSnapshot: () => string;
  readonly getRawSnapshot: () => string;
  readonly subscribe: (listener: () => void) => () => void;
}

export interface PageTitleAuthorityVersion {
  readonly generation: number;
  readonly headSeq: number;
}

interface LivePageTitle {
  readonly title: string;
  readonly revision: number;
  readonly authorityGeneration: number;
  readonly durableVersion?: PageTitleAuthorityVersion;
}

interface CanonicalPageTitle {
  readonly title: string;
  readonly version: PageTitleAuthorityVersion;
}

interface PageTitleEntry {
  readonly liveTitlesByPublisher: Map<string, LivePageTitle>;
  readonly listeners: Set<() => void>;
  lastAccessRevision: number;
  retainedLiveTitle?: LivePageTitle;
  canonicalTitle?: CanonicalPageTitle;
}

export interface PageTitleProjectionStore {
  createSource: (resourceKey: string, fallbackTitle: string, intl?: IntlShape) => PageTitleSource;
  publishCanonical: (
    resourceKey: string,
    title: string,
    version: PageTitleAuthorityVersion,
  ) => void;
  publishLive: (
    resourceKey: string,
    publisherId: string,
    title: string,
    authorityGeneration: number,
  ) => void;
  /** Records the exact durable head only after the publisher runtime has no pending updates. */
  acknowledgeLive: (
    resourceKey: string,
    publisherId: string,
    title: string,
    version: PageTitleAuthorityVersion,
  ) => void;
  releasePublisher: (resourceKey: string, publisherId: string) => void;
}

export const makePageTitleResourceKey = (libraryId: string, pageId: string): string =>
  JSON.stringify([libraryId, pageId]);

export const presentPageTitle = (title: string, intl: IntlShape = getIntl()): string =>
  title.trim() ||
  intl.formatMessage({ id: "lib.pageTitleProjection.untitled", defaultMessage: "Untitled" });
const MAX_RETAINED_PAGE_TITLES = 1_000;

const compareAuthorityVersions = (
  left: PageTitleAuthorityVersion,
  right: PageTitleAuthorityVersion,
): number => {
  if (left.generation !== right.generation) return left.generation - right.generation;
  return left.headSeq - right.headSeq;
};

const compareLiveTitles = (left: LivePageTitle, right: LivePageTitle): number => {
  if (left.authorityGeneration !== right.authorityGeneration) {
    return left.authorityGeneration - right.authorityGeneration;
  }
  if (!left.durableVersion || !right.durableVersion) return left.revision - right.revision;
  const authorityComparison = compareAuthorityVersions(left.durableVersion, right.durableVersion);
  return authorityComparison === 0 ? left.revision - right.revision : authorityComparison;
};

const preferredLiveTitle = (entry: PageTitleEntry): LivePageTitle | undefined => {
  let preferred = entry.retainedLiveTitle;
  for (const candidate of entry.liveTitlesByPublisher.values()) {
    if (!preferred || compareLiveTitles(candidate, preferred) > 0) preferred = candidate;
  }
  return preferred;
};

const readEntryTitle = (entry: PageTitleEntry | undefined): string | undefined => {
  if (!entry) return undefined;
  const liveTitle = preferredLiveTitle(entry);
  const canonicalTitle = entry.canonicalTitle;
  if (!liveTitle) return canonicalTitle?.title;
  if (!canonicalTitle) return liveTitle.title;
  if (canonicalTitle.version.generation > liveTitle.authorityGeneration) {
    return canonicalTitle.title;
  }
  if (!liveTitle.durableVersion) return liveTitle.title;
  return compareAuthorityVersions(canonicalTitle.version, liveTitle.durableVersion) > 0
    ? canonicalTitle.title
    : liveTitle.title;
};

const canonicalMaterializesLiveTitle = (
  canonicalTitle: CanonicalPageTitle | undefined,
  liveTitle: LivePageTitle,
): boolean => {
  if (!canonicalTitle) return false;
  if (canonicalTitle.title.trim() === liveTitle.title.trim()) return true;
  if (canonicalTitle.version.generation > liveTitle.authorityGeneration) return true;
  if (!liveTitle.durableVersion) return false;
  return compareAuthorityVersions(canonicalTitle.version, liveTitle.durableVersion) > 0;
};

/**
 * Renderer-lifetime projection of Page titles into non-authoritative chrome.
 *
 * The Page resource, rather than a particular tab occurrence, is the identity.
 * Y.Text publishers remain isolated by editor surface so one unmount cannot
 * clear another still-mounted editor's live title. After the final publisher
 * retires, its last observed title remains as an overlay until canonical state
 * either presents the same title or causally follows the exact durable head
 * that acknowledged it. An unrelated head advance is never settlement proof.
 */
export function createPageTitleProjectionStore(
  options: { readonly maxRetainedTitles?: number } = {},
): PageTitleProjectionStore {
  const entries = new Map<string, PageTitleEntry>();
  const maxRetainedTitles = Math.max(
    1,
    Math.floor(options.maxRetainedTitles ?? MAX_RETAINED_PAGE_TITLES),
  );
  let revision = 0;
  let accessRevision = 0;

  const touch = (entry: PageTitleEntry): void => {
    accessRevision += 1;
    entry.lastAccessRevision = accessRevision;
  };

  const getOrCreateEntry = (resourceKey: string): PageTitleEntry => {
    const existing = entries.get(resourceKey);
    if (existing) return existing;

    const entry: PageTitleEntry = {
      liveTitlesByPublisher: new Map(),
      listeners: new Set(),
      lastAccessRevision: 0,
    };
    touch(entry);
    entries.set(resourceKey, entry);
    return entry;
  };

  const notifyIfChanged = (entry: PageTitleEntry, previousTitle: string | undefined): void => {
    if (readEntryTitle(entry) === previousTitle) return;
    entry.listeners.forEach((listener) => listener());
  };

  const pruneRetainedEntries = (): void => {
    if (entries.size <= maxRetainedTitles) return;
    const candidates = [...entries.entries()]
      .filter(
        ([, entry]) =>
          entry.listeners.size === 0 &&
          entry.liveTitlesByPublisher.size === 0 &&
          entry.retainedLiveTitle !== undefined,
      )
      .sort(([, left], [, right]) => left.lastAccessRevision - right.lastAccessRevision);
    for (const [resourceKey, entry] of candidates) {
      if (entries.size <= maxRetainedTitles) return;
      if (entries.get(resourceKey) === entry) entries.delete(resourceKey);
    }
  };

  const deleteIfUnused = (resourceKey: string, entry: PageTitleEntry): void => {
    if (entry.listeners.size > 0 || entry.liveTitlesByPublisher.size > 0) return;
    if (entry.retainedLiveTitle) {
      pruneRetainedEntries();
      return;
    }
    if (entries.get(resourceKey) !== entry) return;
    entries.delete(resourceKey);
  };

  const releasePublisher = (resourceKey: string, publisherId: string): void => {
    const entry = entries.get(resourceKey);
    const releasedTitle = entry?.liveTitlesByPublisher.get(publisherId);
    if (!entry || !releasedTitle) return;

    const previousTitle = readEntryTitle(entry);
    touch(entry);
    entry.liveTitlesByPublisher.delete(publisherId);
    if (!canonicalMaterializesLiveTitle(entry.canonicalTitle, releasedTitle)) {
      const retained = entry.retainedLiveTitle;
      if (!retained || compareLiveTitles(releasedTitle, retained) > 0) {
        entry.retainedLiveTitle = releasedTitle;
      }
    }
    notifyIfChanged(entry, previousTitle);
    deleteIfUnused(resourceKey, entry);
  };

  return {
    createSource: (resourceKey, fallbackTitle, intl) => {
      const getRawSnapshot = () => readEntryTitle(entries.get(resourceKey)) ?? fallbackTitle;
      return {
        getRawSnapshot,
        getSnapshot: () => presentPageTitle(getRawSnapshot(), intl),
        subscribe: (listener) => {
          const entry = getOrCreateEntry(resourceKey);
          touch(entry);
          entry.listeners.add(listener);
          const unsubscribeLocale = intl ? undefined : subscribeAppLocale(listener);
          return () => {
            unsubscribeLocale?.();
            entry.listeners.delete(listener);
            deleteIfUnused(resourceKey, entry);
          };
        },
      };
    },
    publishCanonical: (resourceKey, title, version) => {
      const entry = getOrCreateEntry(resourceKey);
      touch(entry);
      const current = entry.canonicalTitle;
      if (current) {
        const comparison = compareAuthorityVersions(version, current.version);
        if (comparison < 0) return;
        if (comparison === 0 && current.title === title) return;
      }

      const previousTitle = readEntryTitle(entry);
      entry.canonicalTitle = { title, version };
      if (
        entry.retainedLiveTitle &&
        canonicalMaterializesLiveTitle(entry.canonicalTitle, entry.retainedLiveTitle)
      ) {
        entry.retainedLiveTitle = undefined;
      }
      notifyIfChanged(entry, previousTitle);
    },
    publishLive: (resourceKey, publisherId, title, authorityGeneration) => {
      const entry = getOrCreateEntry(resourceKey);
      touch(entry);
      const current = entry.liveTitlesByPublisher.get(publisherId);
      if (current?.title === title && current.authorityGeneration === authorityGeneration) return;

      const previousTitle = readEntryTitle(entry);
      revision += 1;
      const liveTitle = { title, revision, authorityGeneration };
      entry.liveTitlesByPublisher.set(publisherId, liveTitle);
      notifyIfChanged(entry, previousTitle);
    },
    acknowledgeLive: (resourceKey, publisherId, title, version) => {
      const entry = entries.get(resourceKey);
      const current = entry?.liveTitlesByPublisher.get(publisherId);
      if (!entry || !current) return;
      if (current.title !== title || current.authorityGeneration !== version.generation) return;
      if (
        current.durableVersion &&
        compareAuthorityVersions(version, current.durableVersion) <= 0
      ) {
        return;
      }
      const previousTitle = readEntryTitle(entry);
      entry.liveTitlesByPublisher.set(publisherId, {
        ...current,
        durableVersion: version,
      });
      notifyIfChanged(entry, previousTitle);
    },
    releasePublisher,
  };
}
