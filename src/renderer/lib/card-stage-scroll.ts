const STORAGE_KEY = "nodex-card-stage-scroll-v1";
const MAX_ENTRIES = 200;

type ScrollMap = Record<string, number>;

function makeKey(projectId: string, cardId: string): string {
  return `${projectId}:${cardId}`;
}

function readMap(): ScrollMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const result: ScrollMap = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "number" && v >= 0) result[k] = v;
    }
    return result;
  } catch {
    return {};
  }
}

function writeMap(map: ScrollMap): void {
  try {
    const keys = Object.keys(map);
    if (keys.length > MAX_ENTRIES) {
      for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete map[k];
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // localStorage may be unavailable
  }
}

export function saveScrollPosition(
  projectId: string,
  cardId: string,
  scrollTop: number,
): void {
  const map = readMap();
  map[makeKey(projectId, cardId)] = scrollTop;
  writeMap(map);
}

export function loadScrollPosition(
  projectId: string,
  cardId: string,
): number | null {
  const map = readMap();
  return map[makeKey(projectId, cardId)] ?? null;
}
