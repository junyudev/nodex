export type DevStoryId = "threads-panel" | "card-stage" | "ui-components";

const DEV_STORY_QUERY_KEY = "dev-story";

function parseDevStoryId(value: string | null): DevStoryId | null {
  if (!value) return null;
  if (value === "threads-panel" || value === "threads" || value === "thread-panel") {
    return "threads-panel";
  }
  if (value === "card-stage" || value === "card" || value === "cardstage") {
    return "card-stage";
  }
  if (value === "ui-components" || value === "ui" || value === "components") {
    return "ui-components";
  }
  return null;
}

export function readActiveDevStoryFromSearch(search: string): DevStoryId | null {
  const params = new URLSearchParams(search);
  return parseDevStoryId(params.get(DEV_STORY_QUERY_KEY));
}

export function resolveActiveDevStory(
  options?: {
    search?: string;
    isDevelopment?: boolean;
  },
): DevStoryId | null {
  const isDevelopment = options?.isDevelopment ?? process.env.NODE_ENV === "development";
  if (!isDevelopment) return null;

  const search = options?.search ?? window.location.search;
  return readActiveDevStoryFromSearch(search);
}

export function removeActiveDevStoryFromSearch(search: string): string {
  const params = new URLSearchParams(search);
  if (!params.has(DEV_STORY_QUERY_KEY)) return search;

  params.delete(DEV_STORY_QUERY_KEY);
  const next = params.toString();
  return next ? `?${next}` : "";
}

export function clearActiveDevStoryFromLocation(): void {
  const { location, history } = window;
  const nextSearch = removeActiveDevStoryFromSearch(location.search);
  if (nextSearch === location.search) return;
  const nextUrl = `${location.pathname}${nextSearch}${location.hash}`;
  history.replaceState(null, "", nextUrl);
}
