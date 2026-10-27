import { readDocumentTheme } from "../use-document-theme";
import {
  DEFAULT_UI_FONT_WEIGHT,
  FONT_SIZE_LIMITS,
  MONO_FONT_FAMILY,
  SYSTEM_FONT_FAMILY,
} from "../typography-preferences";

const chartCandidates = {
  light: ["#e879b0", "#4f8df7", "#62c87a", "#f08a42", "#f2c94c", "#43b8b0", "#9a7be8", "#4fbad9"],
  dark: ["#f08fc0", "#6aa3ff", "#74d58b", "#f59a55", "#f5d45f", "#59cbc2", "#aa91ef", "#63c7e5"],
};
const chartFallback = {
  light: ["#f3883b", "#5dc977", "#eb77b1", "#9b79ec", "#3ab9b1"],
  dark: ["#f59a56", "#74d58b", "#f08fc0", "#aa91ef", "#5acbc2"],
};
type PolarColor = { readonly lightness: number; readonly chroma: number; readonly hue: number };
const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value));
const hueDistance = (left: number, right: number) =>
  Math.min(Math.abs(left - right), 360 - Math.abs(left - right));

function colorHex(value: string): string | null {
  const hex = value.trim().match(/^#([\da-f]{6})(?:[\da-f]{2})?$/i)?.[1];
  if (hex) return `#${hex.toLowerCase()}`;
  const rgb = value.trim().match(/^rgba?\((.*)\)$/i)?.[1];
  const srgb = value.trim().match(/^color\(\s*srgb\s+(.*)\)$/i)?.[1];
  const channels = (rgb ?? srgb)
    ?.split("/")[0]
    ?.trim()
    .split(/[,\s]+/)
    .filter(Boolean)
    .slice(0, 3)
    .map(Number);
  if (channels?.length !== 3 || channels.some(Number.isNaN)) return null;
  const scale = srgb === undefined ? 1 : 255;
  return `#${channels
    .map((channel) =>
      Math.round(clamp(channel * scale, 0, 255))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

function polarColor(hex: string): PolarColor {
  const linear = (channel: number) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  const red = linear(Number.parseInt(hex.slice(1, 3), 16) / 255);
  const green = linear(Number.parseInt(hex.slice(3, 5), 16) / 255);
  const blue = linear(Number.parseInt(hex.slice(5, 7), 16) / 255);
  const long = Math.cbrt(0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue);
  const medium = Math.cbrt(0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue);
  const short = Math.cbrt(0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue);
  const a = 1.9779984951 * long - 2.428592205 * medium + 0.4505937099 * short;
  const b = 0.0259040371 * long + 0.7827717662 * medium - 0.808675766 * short;
  return {
    lightness: 0.2104542553 * long + 0.793617785 * medium - 0.0040720468 * short,
    chroma: Math.hypot(a, b),
    hue: ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360,
  };
}

function rgbChannels({ lightness, chroma, hue }: PolarColor): number[] {
  const radians = (hue * Math.PI) / 180;
  const a = chroma * Math.cos(radians);
  const b = chroma * Math.sin(radians);
  const long = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const medium = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const short = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const gamma = (channel: number) =>
    channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055;
  return [
    gamma(4.0767416621 * long - 3.3077115913 * medium + 0.2309699292 * short),
    gamma(-1.2684380046 * long + 2.6097574011 * medium - 0.3413193965 * short),
    gamma(-0.0041960863 * long - 0.7034186147 * medium + 1.707614701 * short),
  ];
}

function gamutHex(color: PolarColor): string {
  let current = color;
  while (
    !rgbChannels(current).every((channel) => channel >= -0.0001 && channel <= 1.0001) &&
    current.chroma > 0.005
  )
    current = { ...current, chroma: current.chroma * 0.96 };
  return `#${rgbChannels(current)
    .map((channel) =>
      Math.round(clamp(channel) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/** Keep secondary chart hues distinct from the actual host accent and each other. */
function chartSeries(accent: string, theme: "light" | "dark"): readonly string[] {
  const primary = polarColor(colorHex(accent) ?? (theme === "dark" ? "#83c3ff" : "#339cff"));
  const scale = 0.96 + clamp((primary.chroma - 0.06) / 0.16) * 0.12;
  const colors = chartCandidates[theme]
    .map(polarColor)
    .map((color) => ({ ...color, chroma: color.chroma * scale }));
  const remaining = [
    ...colors.filter((color) => hueDistance(color.hue, primary.hue) >= 30),
    ...colors.filter((color) => hueDistance(color.hue, primary.hue) < 30),
  ];
  const selected: PolarColor[] = [];
  while (selected.length < 5 && remaining.length > 0) {
    let bestIndex = 0;
    let bestDistance = -1;
    remaining.forEach((color, index) => {
      const distance = Math.min(
        hueDistance(color.hue, primary.hue),
        ...selected.map((chosen) => hueDistance(color.hue, chosen.hue)),
      );
      if (distance <= bestDistance) return;
      bestDistance = distance;
      bestIndex = index;
    });
    const chosen = remaining.splice(bestIndex, 1)[0];
    if (chosen) selected.push(chosen);
  }
  return selected.map(gamutHex);
}

/** Resolves current host preferences once; guest documents never depend on host CSS variables. */
export function readInlineVisualizationStyleVariables(): Record<string, string> {
  const theme = readDocumentTheme();
  const dark = theme === "dark";
  const rootStyle = getComputedStyle(document.documentElement);
  const probe = document.createElement("div");
  probe.style.display = "none";
  probe.setAttribute("aria-hidden", "true");
  document.body.append(probe);
  const resolve = (
    properties: readonly string[],
    cssProperty: string,
    fallback: string,
  ): string => {
    for (const property of properties) {
      const raw = rootStyle.getPropertyValue(property).trim();
      if (!raw) continue;
      probe.style.setProperty(cssProperty, `var(${property})`);
      const resolved = getComputedStyle(probe).getPropertyValue(cssProperty).trim();
      if (resolved && !resolved.includes("var(")) return resolved;
      if (!raw.includes("var(")) return raw;
    }
    return fallback;
  };
  const color = (properties: readonly string[], fallback: string) =>
    resolve(properties, "color", fallback);
  const background = (properties: readonly string[], fallback: string) =>
    resolve(properties, "background-color", fallback);
  try {
    const foreground = color(
      ["--app-color-text-foreground", "--color-text", "--foreground"],
      dark ? "#ffffff" : "#1a1c1f",
    );
    const accent = color(
      ["--app-color-text-accent", "--color-text-info"],
      dark ? "#83c3ff" : "#339cff",
    );
    const radius = resolve(["--radius-lg"], "border-radius", "10px");
    const series = chartSeries(accent, theme);
    return {
      "--accent": background(
        ["--app-color-background-accent", "--color-background-info-surface"],
        dark ? "#0d273f" : "#e5f2ff",
      ),
      "--accent-foreground": accent,
      "--background": background(
        ["--app-color-background-surface", "--color-surface", "--background"],
        dark ? "#181818" : "#ffffff",
      ),
      "--border": color(
        ["--app-color-border", "--color-border", "--border"],
        dark ? "rgb(255 255 255 / 8.2%)" : "rgb(26 28 31 / 8%)",
      ),
      "--border-strong": color(
        ["--app-color-border-heavy", "--color-border-strong"],
        dark ? "rgb(255 255 255 / 12%)" : "rgb(26 28 31 / 12%)",
      ),
      "--card": `color-mix(in oklab, ${foreground} 5%, transparent)`,
      "--card-foreground": foreground,
      "--corner-shape": rootStyle.getPropertyValue("--codex-corner-shape").trim() || "round",
      "--control-spacing": resolve(
        ["--spacing-button-toolbar-inline", "--control-spacing"],
        "padding-inline-start",
        "12px",
      ),
      "--cursor-interaction":
        getComputedStyle(document.body).getPropertyValue("--cursor-interaction").trim() ||
        rootStyle.getPropertyValue("--cursor-interaction").trim() ||
        "default",
      "--destructive": color(
        ["--color-text-warning", "--destructive"],
        dark ? "#ff8549" : "#e25507",
      ),
      "--font-mono": resolve(["--font-mono"], "font-family", MONO_FONT_FAMILY),
      "--font-smoothing": rootStyle.getPropertyValue("--font-smoothing").trim() || "antialiased",
      "--font-sans": resolve(
        ["--font-sans", "--font-sans-default"],
        "font-family",
        SYSTEM_FONT_FAMILY,
      ),
      "--font-size-base": resolve(
        ["--codex-chat-font-size", "--sans-font-size", "--text-base"],
        "font-size",
        `${FONT_SIZE_LIMITS.ui.default}px`,
      ),
      "--font-weight-normal": resolve(
        ["--font-ui-weight", "--font-weight-normal"],
        "font-weight",
        String(DEFAULT_UI_FONT_WEIGHT),
      ),
      "--foreground": foreground,
      "--input": color(
        ["--color-border-primary-outline", "--input"],
        dark ? "rgb(255 255 255 / 11.8%)" : "rgb(26 28 31 / 11.8%)",
      ),
      "--muted": `color-mix(in srgb, ${foreground} 10%, transparent)`,
      "--muted-foreground": color(
        ["--app-color-text-foreground-secondary", "--foreground-secondary"],
        dark ? "rgb(255 255 255 / 49.8%)" : "rgb(26 28 31 / 49.4%)",
      ),
      "--popover": background(
        [
          "--app-color-background-elevated-secondary",
          "--color-surface-elevated-secondary",
          "--popover",
        ],
        dark ? "#2d2d2d" : "#ffffff",
      ),
      "--popover-foreground": foreground,
      "--primary": accent,
      "--primary-foreground": color(
        ["--app-color-text-on-accent", "--primary-foreground"],
        dark ? "#0d0d0d" : "#ffffff",
      ),
      "--radius": radius,
      "--radius-2xl": resolve(["--radius-2xl"], "border-radius", "16px"),
      "--radius-lg": radius,
      "--radius-md": resolve(["--radius-md"], "border-radius", "8px"),
      "--radius-sm": resolve(["--radius-sm"], "border-radius", "6px"),
      "--ring": color(
        ["--app-color-border-focus", "--color-token-focus-border", "--ring"],
        dark ? "rgb(131 195 255 / 76%)" : "#339cff",
      ),
      "--secondary": background(
        [
          "--app-color-background-button-secondary",
          "--color-background-primary-soft-active",
          "--secondary",
        ],
        dark ? "#303030" : "#f3f3f3",
      ),
      "--secondary-foreground": foreground,
      "--blue": color(["--app-color-accent-blue", "--color-chart-blue"], "#339cff"),
      "--orange": color(
        ["--app-color-accent-orange", "--color-chart-orange"],
        dark ? "#fb6a22" : "#e25507",
      ),
      "--green": color(
        ["--app-color-accent-green", "--color-chart-green"],
        dark ? "#40c977" : "#00a240",
      ),
      "--red": color(["--app-color-accent-red", "--color-chart-red"], dark ? "#ff6764" : "#e02e2a"),
      "--purple": color(
        ["--app-color-accent-purple", "--color-chart-purple"],
        dark ? "#ad7bf9" : "#924ff7",
      ),
      "--yellow": color(
        ["--app-color-accent-yellow", "--color-chart-yellow"],
        dark ? "#ffd240" : "#ffc300",
      ),
      "--visualize-paint-gutter": "5px",
      "--viz-series-1": accent,
      ...Object.fromEntries(
        chartFallback[theme].map((fallback, index) => [
          `--viz-series-${index + 2}`,
          series[index] ?? fallback,
        ]),
      ),
    };
  } finally {
    probe.remove();
  }
}
