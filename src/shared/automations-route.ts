/** Admit saved Scheduled links into the single canonical Automations destination. */
export function normalizeAutomationsPath(path: string): string {
  if (!URL.canParse(path, "https://nodex.local")) return path;
  const url = new URL(path, "https://nodex.local");
  const route = url.pathname.match(
    /^\/(?:automations|scheduled)(?:\/(new|create|edit)(?:\/([^/]+))?)?\/?$/u,
  );
  if (!route) return path;
  const query = new URLSearchParams(url.search);
  const automationId = query.get("automationId") ?? route[2];
  const automationMode = query.get("automationMode") ?? (route[1] === "new" ? "create" : route[1]);
  if (automationId) query.set("automationId", automationId);
  if (automationMode) query.set("automationMode", automationMode);
  const search = query.toString();
  return search ? `/automations?${search}` : "/automations";
}

function normalizeLocation(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const location = value as Record<string, unknown>;
  const returnTo =
    location.returnTo === undefined ? {} : { returnTo: normalizeLocation(location.returnTo) };
  if (location.kind !== "automations" && location.kind !== "scheduled") {
    return { ...location, ...returnTo };
  }
  return {
    ...location,
    kind: "automations",
    path:
      typeof location.path === "string" ? normalizeAutomationsPath(location.path) : location.path,
    ...returnTo,
  };
}

/** Legacy route names are accepted only while decoding persisted Window Session state. */
export function normalizeAutomationsLayout(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const layout = value as Record<string, unknown>;
  return {
    ...layout,
    ...(layout.location === undefined ? {} : { location: normalizeLocation(layout.location) }),
    ...(layout.homeLocation === undefined
      ? {}
      : { homeLocation: normalizeLocation(layout.homeLocation) }),
  };
}
