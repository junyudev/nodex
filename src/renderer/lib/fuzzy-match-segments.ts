import { matchFuzzyQueryFragments } from "./settings-search-score";

interface FuzzyMatchSegment {
  text: string;
  isMatch: boolean;
}

/** Mark each code point in the label for the current query. */
export function segmentFuzzyMatch(
  text: string,
  query: string,
  mode: "fuzzy" | "substring" = "fuzzy",
): FuzzyMatchSegment[] {
  const codePoints = Array.from(text);
  const trimmedQuery = query.trim();
  if (trimmedQuery.length === 0) {
    return codePoints.map((text) => ({ text, isMatch: true }));
  }

  const lowerText = text.toLowerCase();
  const lowerQuery = trimmedQuery.toLowerCase();
  const substringIndex = lowerText.indexOf(lowerQuery);
  if (substringIndex >= 0) {
    const start = Array.from(lowerText.slice(0, substringIndex)).length;
    const end = start + Array.from(lowerQuery).length;
    return codePoints.map((text, index) => ({ text, isMatch: index >= start && index < end }));
  }

  if (mode === "substring") {
    return codePoints.map((text) => ({ text, isMatch: false }));
  }

  const fragments = matchFuzzyQueryFragments(text, trimmedQuery) ?? [];
  let offset = 0;
  return codePoints.map((text) => {
    const isMatch = fragments.some(
      ({ startOffset, endOffset }) => offset >= startOffset && offset < endOffset,
    );
    offset += text.length;
    return { text, isMatch };
  });
}

export function mergeFuzzyMatchSegments(
  segments: readonly FuzzyMatchSegment[],
): FuzzyMatchSegment[] {
  const runs: FuzzyMatchSegment[] = [];
  for (const segment of segments) {
    const previous = runs.at(-1);
    if (previous?.isMatch === segment.isMatch) {
      previous.text += segment.text;
      continue;
    }

    runs.push({ ...segment });
  }
  return runs;
}
