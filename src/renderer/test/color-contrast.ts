interface RgbaColor {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
  readonly alpha: number;
}

const parseRgbColor = (value: string): RgbaColor | undefined => {
  const match = value.match(/^rgba?\(([^)]+)\)$/u);
  if (!match) return undefined;

  const channels = match[1]!.match(/[\d.]+/gu)?.map(Number);
  if (!channels || channels.length < 3) return undefined;
  return {
    red: channels[0]!,
    green: channels[1]!,
    blue: channels[2]!,
    alpha: channels[3] ?? 1,
  };
};

const parseSrgbColor = (value: string): RgbaColor | undefined => {
  const match = value.match(
    /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)$/u,
  );
  if (!match) return undefined;

  return {
    red: Number(match[1]) * 255,
    green: Number(match[2]) * 255,
    blue: Number(match[3]) * 255,
    alpha: match[4] === undefined ? 1 : Number(match[4]),
  };
};

const NUMBER = String.raw`(-?[\d.]+(?:e-?\d+)?)`;

/** Chromium keeps `color-mix(in oklab, …)` results in OKLab; convert them to sRGB. */
const parseOklabColor = (value: string): RgbaColor | undefined => {
  const match = value.match(
    new RegExp(String.raw`^oklab\(${NUMBER}\s+${NUMBER}\s+${NUMBER}(?:\s*/\s*${NUMBER})?\)$`, "u"),
  );
  if (!match) return undefined;
  const [lightness, a, b] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const encode = (linear: number) => {
    const clamped = Math.min(1, Math.max(0, linear));
    const gamma = clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;
    return gamma * 255;
  };
  return {
    red: encode(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    green: encode(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    blue: encode(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    alpha: match[4] === undefined ? 1 : Number(match[4]),
  };
};

export function parseComputedColor(value: string): RgbaColor {
  const color = parseRgbColor(value) ?? parseSrgbColor(value) ?? parseOklabColor(value);
  if (!color) throw new Error(`Unsupported computed color: ${value}`);
  return color;
}

export function compositeColor(foreground: RgbaColor, background: RgbaColor): RgbaColor {
  const alpha = foreground.alpha + background.alpha * (1 - foreground.alpha);
  if (alpha === 0) return { red: 0, green: 0, blue: 0, alpha: 0 };

  const compositeChannel = (foregroundChannel: number, backgroundChannel: number) =>
    (foregroundChannel * foreground.alpha +
      backgroundChannel * background.alpha * (1 - foreground.alpha)) /
    alpha;
  return {
    red: compositeChannel(foreground.red, background.red),
    green: compositeChannel(foreground.green, background.green),
    blue: compositeChannel(foreground.blue, background.blue),
    alpha,
  };
}

export function getPaintedBackground(element: HTMLElement): RgbaColor {
  const layers: RgbaColor[] = [];
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    layers.unshift(parseComputedColor(getComputedStyle(current).backgroundColor));
  }
  return layers.reduce((background, layer) => compositeColor(layer, background), {
    red: 255,
    green: 255,
    blue: 255,
    alpha: 1,
  });
}

export function relativeLuminance(color: RgbaColor): number {
  const linearize = (channel: number) => {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return (
    linearize(color.red) * 0.2126 + linearize(color.green) * 0.7152 + linearize(color.blue) * 0.0722
  );
}

export function contrastRatio(foreground: RgbaColor, background: RgbaColor): number {
  const paintedForeground = compositeColor(foreground, background);
  const lighter = Math.max(relativeLuminance(paintedForeground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(paintedForeground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}
