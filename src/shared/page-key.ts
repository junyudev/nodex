const PAGE_KEY_PREFIX_PATTERN = /^[A-Z][A-Z0-9]{1,7}$/;
const MAX_PAGE_KEY_NUMBER = 9_223_372_036_854_775_807n;

export const normalizePageKeyPrefixInput = (value: string): string => value.trim().toUpperCase();

/** Input-only hint for immediate form feedback; Core remains authoritative. */
export const isPlausiblePageKeyPrefixDraft = (value: string): boolean =>
  PAGE_KEY_PREFIX_PATTERN.test(value);

const parsePositivePageKeyNumber = (raw: string): bigint | null => {
  if (raw.length > 19 || !/^[0-9]+$/.test(raw) || (raw.length > 1 && raw.startsWith("0")))
    return null;
  const number = BigInt(raw);
  return number > 0n && number <= MAX_PAGE_KEY_NUMBER ? number : null;
};

export const parseCanonicalPageKey = (raw: string): string | null => {
  const separator = raw.indexOf("-");
  if (separator < 0 || raw.indexOf("-", separator + 1) >= 0) return null;
  const prefix = raw.slice(0, separator);
  const number = raw.slice(separator + 1);
  if (!isPlausiblePageKeyPrefixDraft(prefix)) return null;
  const parsedNumber = parsePositivePageKeyNumber(number);
  return parsedNumber === null ? null : `${prefix}-${parsedNumber}`;
};

export const isExplicitPageKeySearch = (raw: string): boolean => raw.trim().startsWith("#");

/** Canonical and compact aliases used by loaded-row search indexes. */
export const buildCurrentPageKeySearchAliases = (pageKey: string): string[] => {
  const canonical = parseCanonicalPageKey(pageKey.toUpperCase());
  return canonical ? [canonical, canonical.replace("-", "")] : [];
};
