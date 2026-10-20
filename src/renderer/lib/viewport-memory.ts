const DEFAULT_MAX_ENTRIES = 200;
const EDGE_EPSILON_PX = 2;

/**
 * Where surfaces keep their reader's place: hot for this window, and in localStorage so the
 * place survives the surface unmounting and the app relaunching. Entries are bounded, oldest
 * first out.
 */
export interface ViewportMemory<Snapshot> {
  /** Keeps the snapshot for this window only, cheap enough for every scroll. */
  readonly remember: (key: string, snapshot: Snapshot) => void;
  /** Keeps the snapshot across launches too. */
  readonly save: (key: string, snapshot: Snapshot) => void;
  readonly load: (key: string) => Snapshot | null;
  readonly forget: (key: string) => void;
}

export function createViewportMemory<Snapshot>(options: {
  readonly storageKey: string;
  /** Rejects anything an earlier or corrupted write left behind. */
  readonly decode: (value: unknown) => Snapshot | null;
  readonly maxEntries?: number;
}): ViewportMemory<Snapshot> {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const hot = new Map<string, Snapshot>();

  const readPersisted = (): Record<string, Snapshot> => {
    try {
      const raw = localStorage.getItem(options.storageKey);
      if (!raw) return {};
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return {};
      const result: Record<string, Snapshot> = {};
      for (const [key, value] of Object.entries(parsed)) {
        const snapshot = options.decode(value);
        if (snapshot !== null) result[key] = snapshot;
      }
      return result;
    } catch {
      return {};
    }
  };

  const writePersisted = (entries: Record<string, Snapshot>): void => {
    try {
      const keys = Object.keys(entries);
      for (const key of keys.slice(0, Math.max(0, keys.length - maxEntries))) delete entries[key];
      localStorage.setItem(options.storageKey, JSON.stringify(entries));
    } catch {
      // localStorage may be unavailable in restricted renderer contexts.
    }
  };

  const remember = (key: string, snapshot: Snapshot): void => {
    hot.delete(key);
    hot.set(key, snapshot);
    while (hot.size > maxEntries) {
      const oldest = hot.keys().next().value;
      if (typeof oldest !== "string") return;
      hot.delete(oldest);
    }
  };

  return {
    remember,
    save: (key, snapshot) => {
      remember(key, snapshot);
      const entries = readPersisted();
      delete entries[key];
      entries[key] = snapshot;
      writePersisted(entries);
    },
    load: (key) => {
      const current = hot.get(key);
      if (current !== undefined) return current;
      const persisted = readPersisted()[key];
      if (persisted === undefined) return null;
      remember(key, persisted);
      return persisted;
    },
    forget: (key) => {
      hot.delete(key);
      const entries = readPersisted();
      delete entries[key];
      writePersisted(entries);
    },
  };
}

/** The item a reader is looking at: the first wholly in view, else the first partly in view. */
export function findViewportAnchor<Item extends HTMLElement>(
  scrollElement: HTMLElement,
  candidates: Iterable<Item>,
): Item | null {
  const viewport = scrollElement.getBoundingClientRect();
  let partiallyVisible: Item | null = null;
  for (const candidate of candidates) {
    const rect = candidate.getBoundingClientRect();
    if (rect.height <= 0) continue;
    if (rect.bottom <= viewport.top + EDGE_EPSILON_PX) continue;
    if (rect.top >= viewport.bottom - EDGE_EPSILON_PX) continue;
    partiallyVisible ??= candidate;
    if (
      rect.top >= viewport.top - EDGE_EPSILON_PX &&
      rect.bottom <= viewport.bottom + EDGE_EPSILON_PX
    ) {
      return candidate;
    }
  }
  return partiallyVisible;
}
