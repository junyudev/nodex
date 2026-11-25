import { useCallback, useSyncExternalStore } from "react";
import { readPersistedToggledState, writePersistedToggledState } from "@blocknote/core";

type Listener = () => void;

export interface BlockDisclosurePersistence {
  read: (blockId: string) => boolean | undefined;
  write: (blockId: string, expanded: boolean) => void;
}

export class MemoryBlockDisclosurePersistence implements BlockDisclosurePersistence {
  private readonly values = new Map<string, boolean>();

  read = (blockId: string): boolean | undefined => this.values.get(blockId);

  write = (blockId: string, expanded: boolean): void => {
    this.values.set(blockId, expanded);
  };
}

/**
 * Browser-profile-scoped persistence shared with BlockNote's native toggles.
 * It is intentionally not a collaborative Document or SQLite authority.
 */
export const browserBlockDisclosurePersistence: BlockDisclosurePersistence = {
  read: readPersistedToggledState,
  write: writePersistedToggledState,
};

/**
 * Per-renderer disclosure preferences keyed by stable application Block ID.
 * Each renderer hydrates once from browser-local persistence; active windows
 * do not fan disclosure changes into one another.
 */
export class BlockDisclosureStateStore {
  private readonly hydratedKeys = new Set<string>();
  private readonly expandedByKey = new Map<string, boolean>();
  private readonly listenersByKey = new Map<string, Set<Listener>>();

  constructor(
    private readonly persistence: BlockDisclosurePersistence = new MemoryBlockDisclosurePersistence(),
  ) {}

  /** A Block nobody has toggled shows its kind's default disclosure. */
  isExpanded = (blockId: string, defaultExpanded = false): boolean => {
    this.assertBlockId(blockId);
    this.hydrate(blockId);
    return this.expandedByKey.get(blockId) ?? defaultExpanded;
  };

  subscribe = (blockId: string, listener: Listener): (() => void) => {
    this.assertBlockId(blockId);
    const listeners = this.listenersByKey.get(blockId) ?? new Set<Listener>();
    listeners.add(listener);
    this.listenersByKey.set(blockId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listenersByKey.delete(blockId);
    };
  };

  setExpanded = (blockId: string, expanded: boolean): void => {
    this.assertBlockId(blockId);
    this.hydrate(blockId);
    // An explicit choice is recorded even when it matches the default, so a
    // default-expanded Block that the reader collapses stays collapsed.
    if (this.expandedByKey.get(blockId) === expanded) return;

    this.expandedByKey.set(blockId, expanded);
    try {
      this.persistence.write(blockId, expanded);
    } catch {
      // Persistence is best-effort view state; the current renderer remains
      // authoritative for its live presentation when storage fails.
    }
    for (const listener of this.listenersByKey.get(blockId) ?? []) listener();
  };

  toggle = (blockId: string, defaultExpanded = false): void => {
    this.setExpanded(blockId, !this.isExpanded(blockId, defaultExpanded));
  };

  private hydrate(blockId: string): void {
    if (this.hydratedKeys.has(blockId)) return;
    this.hydratedKeys.add(blockId);
    try {
      const persisted = this.persistence.read(blockId);
      if (persisted !== undefined) {
        this.expandedByKey.set(blockId, persisted);
      }
    } catch {
      // Missing or unavailable browser storage has the same semantics as the
      // default collapsed preference.
    }
  }

  private assertBlockId(blockId: string): void {
    if (blockId.trim().length > 0) return;
    throw new TypeError("Block disclosure identity must be non-empty");
  }
}

export const blockDisclosureStateStore = new BlockDisclosureStateStore(
  browserBlockDisclosurePersistence,
);

export const useBlockDisclosure = (
  blockId: string,
  store: BlockDisclosureStateStore = blockDisclosureStateStore,
  defaultExpanded = false,
): readonly [boolean, (expanded: boolean) => void] => {
  const subscribe = useCallback(
    (listener: Listener) => store.subscribe(blockId, listener),
    [blockId, store],
  );
  const getSnapshot = useCallback(
    () => store.isExpanded(blockId, defaultExpanded),
    [blockId, defaultExpanded, store],
  );
  const expanded = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const setExpanded = useCallback(
    (nextExpanded: boolean) => store.setExpanded(blockId, nextExpanded),
    [blockId, store],
  );
  return [expanded, setExpanded];
};
