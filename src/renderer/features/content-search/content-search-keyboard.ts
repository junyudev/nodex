type FindNavigation = (direction: "next" | "previous") => boolean;
let navigate: FindNavigation | null = null;

/** One mounted Find supplies the app keyboard router's navigation capability. */
export function registerContentSearchNavigation(handler: FindNavigation): () => void {
  navigate = handler;
  return () => {
    if (navigate === handler) navigate = null;
  };
}

export function navigateContentSearch(direction: "next" | "previous"): boolean {
  return navigate?.(direction) ?? false;
}
