const utf8 = new TextEncoder();
const reservedWindowsName = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu;

/**
 * A canonical File name, usable verbatim as one path segment. Mirrors Core's
 * `normalize_file_name`, which owns the rule: a name Core accepts always passes.
 */
export const isPortableFileName = (name: string): boolean =>
  name.length > 0 &&
  name === name.normalize("NFC") &&
  utf8.encode(name).length <= 255 &&
  !/[\/\\<>:"|?*\p{Cc}\p{Cs}]/u.test(name) &&
  !/[. ]$/u.test(name) &&
  !reservedWindowsName.test(name);
