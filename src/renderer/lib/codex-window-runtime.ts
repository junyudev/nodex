import { resolveRuntimePlatform, type RuntimePlatform } from "../../shared/command-keybindings";

export type CodexRendererOs = "darwin" | "linux" | "unknown" | "win32";
export type CodexRendererWindowType = "browser" | "electron";
export type CodexRendererWindowChrome = "application-menu" | "native";

const COMPACT_ROUTE_PREFIXES = ["/global-dictation", "/hotkey-window"] as const;

export function resolveCodexRendererOsFromText(platformText: string): CodexRendererOs {
  const normalized = platformText.trim().toLowerCase();
  if (!normalized) return "unknown";
  if (normalized.includes("win")) return "win32";
  if (normalized.includes("mac") || normalized.includes("darwin")) return "darwin";
  if (normalized.includes("linux")) return "linux";
  return "unknown";
}

export function resolveCodexRendererOs(
  navigatorLike: Pick<Navigator, "platform" | "userAgent"> = navigator,
): CodexRendererOs {
  const platform = navigatorLike.platform || navigatorLike.userAgent || "";
  return resolveCodexRendererOsFromText(platform);
}

/** Pending keymap reads use browser platform data; Node defaults remain Main-owned. */
export function resolveCodexRendererCommandPlatform(
  navigatorLike: Pick<Navigator, "platform" | "userAgent"> = navigator,
): RuntimePlatform {
  const os = resolveCodexRendererOs(navigatorLike);
  return resolveRuntimePlatform(os === "unknown" ? "linux" : os);
}

export function resolveCodexRendererWindowChrome(
  windowType: CodexRendererWindowType,
  os: CodexRendererOs,
): CodexRendererWindowChrome {
  if (windowType !== "electron") return "native";
  if (os === "linux" || os === "win32") return "application-menu";
  return "native";
}

function isCompactRoute(route: string): boolean {
  if (route === "/avatar-overlay") return true;
  return COMPACT_ROUTE_PREFIXES.some(
    (prefix) => route === prefix || route.startsWith(`${prefix}/`),
  );
}

function normalizeInitialRoute(route: string | null): string | null {
  if (!route) return null;
  const withoutQuery = route.split("?")[0] ?? "";
  if (!withoutQuery.startsWith("/")) return `/${withoutQuery}`;
  return withoutQuery;
}

export function isCodexCompactWindowUrl(href: string): boolean {
  try {
    const url = new URL(href);
    const pathname = normalizeInitialRoute(url.pathname);
    if (pathname && isCompactRoute(pathname)) return true;

    const initialRoute = normalizeInitialRoute(url.searchParams.get("initialRoute"));
    return initialRoute ? isCompactRoute(initialRoute) : false;
  } catch {
    return false;
  }
}
