export const MARKDOWN_SYNTAX_CACHE_MAX_KEYS = 100;
export const MARKDOWN_SYNTAX_CACHE_MAX_KEY_UNITS = 6_000_000;
export const MARKDOWN_SYNTAX_CACHE_MAX_SOURCE_UNITS = 1_000_000;
export const MARKDOWN_PREFIX_CACHE_MAX_KEYS = 100;
export const MARKDOWN_SEGMENT_CACHE_MAX_KEYS = 500;
export const MARKDOWN_SEGMENT_CACHE_MAX_TEXT_UNITS = 4_096;

/** Cache budgets count JavaScript string units, independently of transport byte limits. */
export function createMarkdownCache<Value>(options: {
  readonly maxKeys: number;
  readonly maxKeyUnits?: number;
  readonly refreshOnRead: boolean;
}) {
  const entries = new Map<string, Value>();
  let keyUnits = 0;
  return {
    get(key: string): Value | undefined {
      const value = entries.get(key);
      if (value !== undefined && options.refreshOnRead) {
        entries.delete(key);
        entries.set(key, value);
      }
      return value;
    },
    set(key: string, value: Value): void {
      if (entries.has(key)) {
        entries.delete(key);
        keyUnits -= key.length;
      }
      entries.set(key, value);
      keyUnits += key.length;
      while (
        entries.size > options.maxKeys ||
        keyUnits > (options.maxKeyUnits ?? Number.POSITIVE_INFINITY)
      ) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
        keyUnits -= oldest.length;
      }
    },
    entries(): IterableIterator<[string, Value]> {
      return entries.entries();
    },
    clear(): void {
      entries.clear();
      keyUnits = 0;
    },
  };
}

export type MarkdownCache<Value> = ReturnType<typeof createMarkdownCache<Value>>;
