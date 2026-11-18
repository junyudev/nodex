/**
 * Directory and branch names Nodex generates are lowercase ASCII words joined by hyphens,
 * with no spaces. Shells, Git, build tools and the paths an Agent types all handle such a
 * name the same way on every platform, while spaces need quoting and other scripts depend on
 * locale and on the filesystem's Unicode normalization. A name the person chose themselves,
 * such as a folder they picked, is kept as it is.
 */

/** Latin letters that Unicode does not decompose into an ASCII letter plus a mark. */
const UNDECOMPOSED_LATIN: Readonly<Record<string, string>> = {
  ß: "ss",
  æ: "ae",
  œ: "oe",
  ø: "o",
  đ: "d",
  ð: "d",
  ł: "l",
  þ: "th",
  ı: "i",
};

const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/u;

export interface AsciiSlugLimits {
  readonly maxWords?: number;
  readonly maxLength?: number;
}

/**
 * The words of `text` in lowercase ASCII, joined by hyphens. Accents are dropped,
 * compatibility forms such as full-width letters become their plain letter, and a script
 * with no ASCII form is left out. Returns an empty string when nothing remains, so each
 * caller names its own fallback.
 */
export function asciiSlug(text: string, limits: AsciiSlugLimits = {}): string {
  const words =
    text
      .replace(/['’]/gu, "")
      .normalize("NFKD")
      .toLowerCase()
      .replace(/\p{M}+/gu, "")
      .replace(/[ßæœøđðłþı]/gu, (letter) => UNDECOMPOSED_LATIN[letter]!)
      .match(/[a-z0-9]+/gu) ?? [];
  return words.slice(0, limits.maxWords).join("-").slice(0, limits.maxLength).replace(/-+$/u, "");
}

/**
 * The name of a directory Nodex creates for `text`: its slug, or `fallback` when the text has
 * no ASCII words. A Windows device name such as `con` follows the fallback instead of standing
 * alone, because Windows refuses it as a directory.
 */
export function asciiDirectoryName(
  text: string,
  fallback: string,
  limits: AsciiSlugLimits = {},
): string {
  const slug = asciiSlug(text, limits);
  if (!slug) return fallback;
  return WINDOWS_DEVICE_NAME.test(slug) ? `${fallback}-${slug}` : slug;
}
