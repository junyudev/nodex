/** Up to two initials, from the first and last words of a display name. */
export function initialsOf(source: string): string {
  const words = source.split(/[ ._-]+/u).filter(Boolean);
  const first = Array.from(words[0] ?? "")[0] ?? "";
  const last = words.length > 1 ? (Array.from(words.at(-1) ?? "")[0] ?? "") : "";
  return `${first}${last}`.toLocaleUpperCase();
}

/** A stable hue for an identity, so the same person or Space keeps its color everywhere. */
export function hueOf(seed: string): number {
  let hue = 0;
  for (const char of seed) hue = (hue * 31 + (char.codePointAt(0) ?? 0)) % 360;
  return hue;
}

export const identityGlyphColor = (hue: number): string => `oklch(0.56 0.11 ${hue})`;
