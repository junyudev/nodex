export interface CommandPaletteHighlightSegment {
  text: string;
  highlight: boolean;
}

export type CommandPaletteCharacterHighlightMode = "substring" | "fuzzy";

export function normalizeCommandPalettePreviewText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function findCodePointSubstring(text: readonly string[], query: readonly string[]): number {
  if (query.length === 0 || query.length > text.length) return -1;

  for (let start = 0; start <= text.length - query.length; start += 1) {
    let matches = true;
    for (let offset = 0; offset < query.length; offset += 1) {
      if (text[start + offset]?.toLocaleLowerCase() === query[offset]?.toLocaleLowerCase())
        continue;
      matches = false;
      break;
    }
    if (matches) return start;
  }

  return -1;
}

function buildSegmentsFromMatchedIndexes(
  characters: readonly string[],
  matchedIndexes: ReadonlySet<number>,
): CommandPaletteHighlightSegment[] {
  const segments: CommandPaletteHighlightSegment[] = [];
  characters.forEach((character, index) => {
    const highlight = matchedIndexes.has(index);
    const previous = segments.at(-1);
    if (previous?.highlight === highlight) {
      previous.text += character;
      return;
    }
    segments.push({ text: character, highlight });
  });
  return segments;
}

export function buildCommandPaletteCharacterHighlightSegments(
  text: string,
  query: string,
  mode: CommandPaletteCharacterHighlightMode = "substring",
): CommandPaletteHighlightSegment[] {
  const characters = Array.from(text);
  const queryCharacters = Array.from(query.trim());
  if (queryCharacters.length === 0) {
    return [{ text, highlight: false }];
  }

  const substringStart = findCodePointSubstring(characters, queryCharacters);
  if (substringStart >= 0) {
    const matchedIndexes = new Set(
      queryCharacters.flatMap((character, offset) =>
        /\s/u.test(character) ? [] : [substringStart + offset],
      ),
    );
    return buildSegmentsFromMatchedIndexes(characters, matchedIndexes);
  }
  if (mode === "substring") {
    return [{ text, highlight: false }];
  }

  const matchedIndexes = new Set<number>();
  let queryIndex = 0;
  characters.forEach((character, index) => {
    if (
      queryIndex < queryCharacters.length &&
      character.toLocaleLowerCase() === queryCharacters[queryIndex]?.toLocaleLowerCase()
    ) {
      matchedIndexes.add(index);
      queryIndex += 1;
    }
  });

  if (queryIndex !== queryCharacters.length) {
    return [{ text, highlight: false }];
  }
  return buildSegmentsFromMatchedIndexes(characters, matchedIndexes);
}

export function buildCommandPaletteTokenHighlightSegments(
  text: string,
  query: string,
): CommandPaletteHighlightSegment[] {
  const characters = Array.from(text);
  const phrase = buildCommandPaletteCharacterHighlightSegments(text, query, "substring");
  if (phrase.some((segment) => segment.highlight)) return phrase;

  const matchedIndexes = new Set<number>();
  const tokens = Array.from(new Set(query.trim().split(/\s+/).filter(Boolean)));
  tokens.forEach((token) => {
    const tokenCharacters = Array.from(token);
    let searchFrom = 0;
    while (searchFrom <= characters.length - tokenCharacters.length) {
      const start = findCodePointSubstring(characters.slice(searchFrom), tokenCharacters);
      if (start < 0) break;
      const absoluteStart = searchFrom + start;
      tokenCharacters.forEach((_, offset) => matchedIndexes.add(absoluteStart + offset));
      searchFrom = absoluteStart + tokenCharacters.length;
    }
  });

  if (matchedIndexes.size === 0) return [{ text, highlight: false }];
  return buildSegmentsFromMatchedIndexes(characters, matchedIndexes);
}

export interface SearchHighlightPreviewOptions {
  readonly maxCharacters?: number;
  readonly leadingContextCharacters?: number;
}

function cropSearchHighlightPreview(
  text: string,
  firstMatch: { readonly index: number; readonly length: number } | null,
  options: SearchHighlightPreviewOptions,
): string {
  const maxCharacters =
    options.maxCharacters === undefined ? null : Math.max(16, Math.floor(options.maxCharacters));
  if (!maxCharacters) return text;

  const characters = Array.from(text);
  const leadingContext = Math.max(
    0,
    Math.min(options.leadingContextCharacters ?? Math.floor(maxCharacters / 3), maxCharacters - 1),
  );
  const matchIndex = firstMatch?.index ?? 0;
  // Reposition even a short source when its match would land beyond the
  // rendered row's ellipsis. The character budget is an upper bound, not a
  // promise that CSS can display every character in a proportional font.
  const rawStart = matchIndex > leadingContext ? matchIndex - leadingContext : 0;
  const nextBoundary =
    rawStart > 0
      ? characters.findIndex(
          (character, index) => index >= rawStart && index < matchIndex && /\s/u.test(character),
        )
      : -1;
  const start = nextBoundary >= rawStart ? nextBoundary + 1 : rawStart;
  const minimumEnd = firstMatch ? matchIndex + Math.max(firstMatch.length, 1) : 0;
  const end = Math.min(characters.length, Math.max(start + maxCharacters, minimumEnd));
  if (start === 0 && end === characters.length) return text;
  return `${start > 0 ? "…" : ""}${characters.slice(start, end).join("")}${end < characters.length ? "…" : ""}`;
}

export function buildCommandPaletteQueryHighlightPreview(
  excerpt: string,
  query: string,
  options: SearchHighlightPreviewOptions = {},
): { excerpt: string; segments: CommandPaletteHighlightSegment[] } | null {
  const normalizedText = normalizeCommandPalettePreviewText(excerpt);
  if (!normalizedText) {
    return null;
  }

  const characters = Array.from(normalizedText);
  const queryCharacters = Array.from(query.trim());
  const queryTokens = query.trim().split(/\s+/).filter(Boolean);
  const phraseStart = findCodePointSubstring(characters, queryCharacters);
  const tokenMatches = queryTokens
    .map((token) => ({
      index: findCodePointSubstring(characters, Array.from(token)),
      length: Array.from(token).length,
    }))
    .filter(({ index }) => index >= 0);
  const firstMatch =
    phraseStart >= 0
      ? { index: phraseStart, length: queryCharacters.length }
      : tokenMatches.length > 0
        ? tokenMatches.reduce((earliest, current) =>
            current.index < earliest.index ? current : earliest,
          )
        : null;
  const normalizedExcerpt = cropSearchHighlightPreview(normalizedText, firstMatch, options);

  if (!query.trim()) {
    return {
      excerpt: normalizedExcerpt,
      segments: [{ text: normalizedExcerpt, highlight: false }],
    };
  }

  return {
    excerpt: normalizedExcerpt,
    segments: buildCommandPaletteTokenHighlightSegments(normalizedExcerpt, query),
  };
}
