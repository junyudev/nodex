const listeners = new Set<() => void>();

/** An Agent became usable outside the Composer, so open Composers read the catalog again. */
export function publishAgentCatalogRefresh(): void {
  for (const listener of listeners) listener();
}

export function subscribeAgentCatalogRefresh(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
