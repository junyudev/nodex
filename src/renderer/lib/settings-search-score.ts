const MAX_PATTERN_LENGTH = 100;
const NO_MATCH = -2147483648;
const PATH_SEPARATOR_MARKER = "\0";
const PATH_SEPARATORS = ["/", "\\"];
const START_MATCH_BONUS = 10_000;

interface MatchRange {
  startOffset: number;
  endOffset: number;
}

class CombinedMatcher {
  constructor(
    private readonly mainMatcher: PatternMatcher,
    private readonly fallbackMatcher: PatternMatcher | null,
  ) {}

  matchingDegree(candidate: string): number {
    const mainMatch = this.mainMatcher.match(candidate);
    if (mainMatch !== null) {
      return addStartMatchBonus(
        this.mainMatcher.matchingDegree(candidate, false, mainMatch),
        mainMatch,
      );
    }

    if (this.fallbackMatcher === null) return NO_MATCH;

    const fallbackMatch = this.fallbackMatcher.match(candidate);
    if (fallbackMatch === null) return NO_MATCH;

    return addStartMatchBonus(
      this.fallbackMatcher.matchingDegree(candidate, false, fallbackMatch),
      fallbackMatch,
    );
  }
}

class PatternMatcher {
  private readonly myPattern: string[];
  private readonly isLowerCase: boolean[];
  private readonly isUpperCase: boolean[];
  private readonly isWordSeparator: boolean[];
  private readonly toUpperCase: string[];
  private readonly toLowerCase: string[];
  private readonly hardSeparators: string[];
  private readonly mixedCase: boolean;
  private readonly hasSeparators: boolean;
  private readonly hasDots: boolean;
  private readonly meaningfulCharacters: string[];
  private readonly minNameLength: number;
  private failedMatchStates: Set<number> | undefined;

  constructor(
    pattern: string,
    private readonly matchingMode: "IGNORE_CASE" | "MATCH_CASE" | "FIRST_LETTER",
    hardSeparators: string,
  ) {
    const normalizedPattern = pattern.endsWith("* ") ? pattern.slice(0, -2) : pattern;

    // Match candidate offsets and pattern offsets in the same UTF-16 units.
    this.myPattern = normalizedPattern.split("");
    this.isLowerCase = Array.from({ length: this.myPattern.length }, () => false);
    this.isUpperCase = Array.from({ length: this.myPattern.length }, () => false);
    this.isWordSeparator = Array.from({ length: this.myPattern.length }, () => false);
    this.toUpperCase = Array.from({ length: this.myPattern.length }, () => "");
    this.toLowerCase = Array.from({ length: this.myPattern.length }, () => "");
    this.hardSeparators = Array.from(hardSeparators);

    const meaningfulCharacters: string[] = [];
    let hasMeaningfulCharacter = false;
    let hasLowerCase = false;
    let hasUpperAfterLower = false;
    let hasDot = false;
    let hasSeparatorAfterMeaningful = false;

    for (let index = 0; index < this.myPattern.length; index += 1) {
      const char = this.myPattern[index];
      const isSeparator = isPatternWordSeparator(char);
      const isUpper = isUpperCase(char);
      const isLower = isLowerCase(char);
      const upper = char.toUpperCase();
      const lower = char.toLowerCase();

      if (isLower) hasLowerCase = true;
      if (char === ".") hasDot = true;
      if (hasMeaningfulCharacter && isUpper) hasUpperAfterLower = true;

      if (!isWildcard(char)) {
        hasMeaningfulCharacter = true;
        meaningfulCharacters.push(lower, upper);
      }

      if (hasMeaningfulCharacter && isSeparator) hasSeparatorAfterMeaningful = true;

      this.isWordSeparator[index] = isSeparator;
      this.isUpperCase[index] = isUpper;
      this.isLowerCase[index] = isLower;
      this.toUpperCase[index] = upper;
      this.toLowerCase[index] = lower;
    }

    this.hasDots = hasDot;
    this.mixedCase = hasLowerCase && hasUpperAfterLower;
    this.hasSeparators = hasSeparatorAfterMeaningful;
    this.meaningfulCharacters = meaningfulCharacters;
    this.minNameLength = meaningfulCharacters.length / 2;
  }

  matchingDegree(candidate: string, preferStart = false, match = this.match(candidate)): number {
    if (match === null) return NO_MATCH;
    if (match.length === 0) return 0;

    const firstMatch = match[0];
    const startsAtBeginning = firstMatch.startOffset === 0;
    const preferBeginning = startsAtBeginning && preferStart;
    let score = 0;
    let lastPatternIndex = -1;
    let skippedWordStarts = 0;
    let nextWordStart = 0;
    let previousWasUpperPattern = false;

    for (const range of match) {
      for (let offset = range.startOffset; offset < range.endOffset; offset += 1) {
        const startsNewRange = offset === range.startOffset && range !== firstMatch;
        let isWordStart = false;

        while (nextWordStart <= offset) {
          if (nextWordStart === offset) {
            isWordStart = true;
          } else if (startsNewRange) {
            skippedWordStarts += 1;
          }
          nextWordStart = nextWord(candidate, nextWordStart);
        }

        const candidateChar = candidate[offset];
        lastPatternIndex = indexOfPatternChar(
          this.myPattern,
          candidateChar,
          lastPatternIndex + 1,
          this.myPattern.length,
          true,
        );

        if (lastPatternIndex < 0) break;

        if (isWordStart) {
          previousWasUpperPattern =
            candidateChar === this.myPattern[lastPatternIndex] &&
            this.isUpperCase[lastPatternIndex];
        }

        score += this.evaluateCaseMatching(
          preferBeginning,
          lastPatternIndex,
          previousWasUpperPattern,
          offset,
          startsNewRange,
          isWordStart,
          candidateChar,
        );
      }
    }

    const firstOffset = firstMatch.startOffset;
    const hasPreviousHardSeparator =
      indexOfAny(candidate, this.hardSeparators, 0, firstOffset) >= 0;
    const beginsAtWordStart =
      firstOffset === 0 ||
      (isWordStart(candidate, firstOffset) && !isWordStart(candidate, firstOffset - 1));
    const endsAtCandidateEnd = match[match.length - 1].endOffset === candidate.length;

    return (
      (beginsAtWordStart ? 1000 : 0) +
      score -
      match.length +
      -skippedWordStarts * 10 +
      (hasPreviousHardSeparator ? 0 : 2) +
      (startsAtBeginning ? 1 : 0) +
      (endsAtCandidateEnd ? 1 : 0)
    );
  }

  match(candidate: string): MatchRange[] | null {
    if (candidate.length < this.minNameLength) return null;
    if (this.myPattern.length > MAX_PATTERN_LENGTH) return this.matchBySubstring(candidate);

    let matchedCharacters = 0;
    for (
      let index = 0;
      index < candidate.length && matchedCharacters < this.meaningfulCharacters.length;
      index += 1
    ) {
      const char = candidate[index];
      if (
        char === this.meaningfulCharacters[matchedCharacters] ||
        char === this.meaningfulCharacters[matchedCharacters + 1]
      ) {
        const previousPatternIndex = this.myPattern.length - 2;
        // An alphanumeric suffix must continue a fragment or begin a word.
        // Reject impossible suffixes before exploring alternative fragments.
        if (
          matchedCharacters === this.meaningfulCharacters.length - 2 &&
          previousPatternIndex >= 0 &&
          isAlphaNumeric(this.myPattern[previousPatternIndex + 1]) &&
          !this.isWildcard(previousPatternIndex) &&
          (index === 0 ||
            !this.charEquals(
              this.myPattern[previousPatternIndex],
              previousPatternIndex,
              candidate[index - 1],
              this.matchingMode !== "MATCH_CASE",
            )) &&
          !isWordStart(candidate, index)
        )
          continue;
        matchedCharacters += 2;
      }
    }

    if (matchedCharacters < this.minNameLength * 2) return null;

    this.failedMatchStates?.clear();
    const match = this.matchWildcards(candidate, 0, 0);
    return match === null ? null : match.reverse();
  }

  private evaluateCaseMatching(
    preferStart: boolean,
    patternIndex: number,
    previousWasUpperPattern: boolean,
    candidateOffset: number,
    startsNewRange: boolean,
    isWordStartCandidate: boolean,
    candidateChar: string,
  ): number {
    if (startsNewRange && isWordStartCandidate && this.isLowerCase[patternIndex]) return -10;

    if (candidateChar === this.myPattern[patternIndex]) {
      if (this.isUpperCase[patternIndex]) return 50;
      if (candidateOffset === 0 && preferStart) return 150;
      if (isWordStartCandidate) return 1;
      return 0;
    }

    if (isWordStartCandidate || (this.isLowerCase[patternIndex] && previousWasUpperPattern))
      return -1;
    return 0;
  }

  private matchBySubstring(candidate: string): MatchRange[] | null {
    const startsWithWildcard = this.isPatternChar(0, "*");
    const literalPattern = withoutWildcards(this.myPattern);

    if (candidate.length < literalPattern.length) return null;

    if (startsWithWildcard) {
      const index = indexOfSubstring(candidate, literalPattern, 0, candidate.length);
      return index >= 0
        ? [
            {
              startOffset: index,
              endOffset: index + literalPattern.length,
            },
          ]
        : null;
    }

    return equalsIgnoreCase(candidate, 0, literalPattern.length, literalPattern)
      ? [
          {
            startOffset: 0,
            endOffset: literalPattern.length,
          },
        ]
      : null;
  }

  private matchWildcards(
    candidate: string,
    patternIndex: number,
    candidateIndex: number,
  ): MatchRange[] | null {
    let index = patternIndex;

    if (candidateIndex < 0) return null;

    if (!this.isWildcard(index)) {
      return index === this.myPattern.length
        ? []
        : this.matchFragment(candidate, index, candidateIndex);
    }

    do {
      index += 1;
    } while (this.isWildcard(index));

    if (index === this.myPattern.length) {
      if (
        this.isTrailingSpacePattern() &&
        candidateIndex !== candidate.length &&
        (index < 2 || !this.isUpperCaseOrDigit(index - 2))
      ) {
        const spaceIndex = candidate.indexOf(" ", candidateIndex);
        return spaceIndex >= 0
          ? [
              {
                startOffset: spaceIndex,
                endOffset: spaceIndex + 1,
              },
            ]
          : null;
      }

      return [];
    }

    return this.matchSkippingWords(
      candidate,
      index,
      this.findNextPatternCharOccurrence(candidate, candidateIndex, index),
      true,
    );
  }

  private isTrailingSpacePattern(): boolean {
    return this.isPatternChar(this.myPattern.length - 1, " ");
  }

  private isUpperCaseOrDigit(index: number): boolean {
    return this.isUpperCase[index] || isDigit(this.myPattern[index]);
  }

  private matchSkippingWords(
    candidate: string,
    patternIndex: number,
    candidateIndex: number,
    allowSpecialCharSkipping: boolean,
  ): MatchRange[] | null {
    if (candidateIndex < 0) return null;
    const stateKey =
      (patternIndex * (candidate.length + 1) + candidateIndex) * 2 +
      Number(allowSpecialCharSkipping);
    if (this.failedMatchStates?.has(stateKey)) return null;

    let index = candidateIndex;
    let longestFragment = 0;

    while (index >= 0) {
      const fragmentLength = this.seemsLikeFragmentStart(candidate, patternIndex, index)
        ? this.maxMatchingFragment(candidate, patternIndex, index)
        : 0;

      if (
        fragmentLength > longestFragment ||
        (index + fragmentLength === candidate.length && this.isTrailingSpacePattern())
      ) {
        if (!this.isMiddleMatch(candidate, patternIndex, index)) {
          longestFragment = fragmentLength;
        }

        const insideMatch = this.matchInsideFragment(
          candidate,
          patternIndex,
          index,
          fragmentLength,
        );
        if (insideMatch !== null) return insideMatch;
      }

      const nextIndex = this.findNextPatternCharOccurrence(candidate, index + 1, patternIndex);
      index = allowSpecialCharSkipping
        ? nextIndex
        : this.checkForSpecialChars(candidate, index + 1, nextIndex, patternIndex);
    }

    // Successful ranges are joined in place. Cache only failures, per candidate,
    // including the separator mode so independent search branches stay distinct.
    (this.failedMatchStates ??= new Set()).add(stateKey);
    return null;
  }

  private findNextPatternCharOccurrence(
    candidate: string,
    candidateIndex: number,
    patternIndex: number,
  ): number {
    return !this.isPatternChar(patternIndex - 1, "*") && !this.isWordSeparator[patternIndex]
      ? this.indexOfWordStart(candidate, patternIndex, candidateIndex)
      : this.indexOfIgnoreCase(candidate, candidateIndex, patternIndex);
  }

  private checkForSpecialChars(
    candidate: string,
    startIndex: number,
    candidateIndex: number,
    patternIndex: number,
  ): number {
    if (
      candidateIndex < 0 ||
      (!this.hasSeparators &&
        !this.mixedCase &&
        indexOfAny(candidate, this.hardSeparators, startIndex, candidateIndex) !== -1) ||
      (this.hasDots &&
        !this.isPatternChar(patternIndex - 1, ".") &&
        indexOfChar(candidate, ".", startIndex, candidateIndex) !== -1)
    ) {
      return -1;
    }

    return candidateIndex;
  }

  private seemsLikeFragmentStart(
    candidate: string,
    patternIndex: number,
    candidateIndex: number,
  ): boolean {
    if (
      !this.isUpperCase[patternIndex] ||
      isUpperCase(candidate[candidateIndex]) ||
      isWordStart(candidate, candidateIndex)
    ) {
      return true;
    }

    return !this.mixedCase && this.matchingMode !== "MATCH_CASE";
  }

  private charEquals(
    patternChar: string,
    patternIndex: number,
    candidateChar: string,
    ignoreCase: boolean,
  ): boolean {
    if (patternChar === candidateChar) return true;
    if (!ignoreCase) return false;
    return (
      this.toLowerCase[patternIndex] === candidateChar ||
      this.toUpperCase[patternIndex] === candidateChar
    );
  }

  private matchFragment(
    candidate: string,
    patternIndex: number,
    candidateIndex: number,
  ): MatchRange[] | null {
    const fragmentLength = this.maxMatchingFragment(candidate, patternIndex, candidateIndex);
    return fragmentLength === 0
      ? null
      : this.matchInsideFragment(candidate, patternIndex, candidateIndex, fragmentLength);
  }

  private maxMatchingFragment(
    candidate: string,
    patternIndex: number,
    candidateIndex: number,
  ): number {
    if (!this.isFirstCharMatching(candidate, candidateIndex, patternIndex)) return 0;

    let length = 1;
    const ignoreCase = this.matchingMode !== "MATCH_CASE";

    while (
      candidateIndex + length < candidate.length &&
      patternIndex + length < this.myPattern.length
    ) {
      const candidateChar = candidate[candidateIndex + length];
      if (
        !this.charEquals(
          this.myPattern[patternIndex + length],
          patternIndex + length,
          candidateChar,
          ignoreCase,
        )
      ) {
        if (this.isSkippingDigitBetweenPatternDigits(patternIndex + length, candidateChar))
          return 0;
        break;
      }

      length += 1;
    }

    return length;
  }

  private isSkippingDigitBetweenPatternDigits(
    patternIndex: number,
    candidateChar: string,
  ): boolean {
    return (
      isDigit(this.myPattern[patternIndex]) &&
      isDigit(this.myPattern[patternIndex - 1]) &&
      isDigit(candidateChar)
    );
  }

  private matchInsideFragment(
    candidate: string,
    patternIndex: number,
    candidateIndex: number,
    fragmentLength: number,
  ): MatchRange[] | null {
    const minimumPrefix = this.isMiddleMatch(candidate, patternIndex, candidateIndex) ? 3 : 1;
    return (
      this.improveCamelHumps(
        candidate,
        patternIndex,
        candidateIndex,
        fragmentLength,
        minimumPrefix,
      ) ??
      this.findLongestMatchingPrefix(
        candidate,
        patternIndex,
        candidateIndex,
        fragmentLength,
        minimumPrefix,
      )
    );
  }

  private isMiddleMatch(candidate: string, patternIndex: number, candidateIndex: number): boolean {
    if (
      !this.isPatternChar(patternIndex - 1, "*") ||
      this.isWildcard(patternIndex + 1) ||
      !isAlphaNumeric(candidate[candidateIndex])
    ) {
      return false;
    }

    return !isWordStart(candidate, candidateIndex);
  }

  private findLongestMatchingPrefix(
    candidate: string,
    patternIndex: number,
    candidateIndex: number,
    fragmentLength: number,
    minimumPrefix: number,
  ): MatchRange[] | null {
    if (patternIndex + fragmentLength >= this.myPattern.length) {
      return [
        {
          startOffset: candidateIndex,
          endOffset: candidateIndex + fragmentLength,
        },
      ];
    }

    let length = fragmentLength;
    while (length >= minimumPrefix || (length > 0 && this.isWildcard(patternIndex + length))) {
      let rest: MatchRange[] | null = null;
      if (this.isWildcard(patternIndex + length)) {
        rest = this.matchWildcards(candidate, patternIndex + length, candidateIndex + length);
      } else {
        let nextIndex = this.findNextPatternCharOccurrence(
          candidate,
          candidateIndex + length + 1,
          patternIndex + length,
        );
        nextIndex = this.checkForSpecialChars(
          candidate,
          candidateIndex + length,
          nextIndex,
          patternIndex + length,
        );
        if (nextIndex >= 0) {
          rest = this.matchSkippingWords(candidate, patternIndex + length, nextIndex, false);
        }
      }

      if (rest !== null) return joinMatchRanges(rest, candidateIndex, length);
      length -= 1;
    }

    return null;
  }

  private improveCamelHumps(
    candidate: string,
    patternIndex: number,
    candidateIndex: number,
    fragmentLength: number,
    minimumPrefix: number,
  ): MatchRange[] | null {
    for (let index = minimumPrefix; index < fragmentLength; index += 1) {
      if (
        this.isUppercasePatternVsLowercaseNameChar(
          candidate,
          patternIndex + index,
          candidateIndex + index,
        )
      ) {
        const upperMatch = this.findUppercaseMatchFurther(
          candidate,
          patternIndex + index,
          candidateIndex + index,
        );
        if (upperMatch !== null) return joinMatchRanges(upperMatch, candidateIndex, index);
      }
    }

    return null;
  }

  private isUppercasePatternVsLowercaseNameChar(
    candidate: string,
    patternIndex: number,
    candidateIndex: number,
  ): boolean {
    return (
      this.isUpperCase[patternIndex] && this.myPattern[patternIndex] !== candidate[candidateIndex]
    );
  }

  private findUppercaseMatchFurther(
    candidate: string,
    patternIndex: number,
    candidateIndex: number,
  ): MatchRange[] | null {
    const wordStartIndex = this.indexOfWordStart(candidate, patternIndex, candidateIndex);
    return this.matchWildcards(candidate, patternIndex, wordStartIndex);
  }

  private isFirstCharMatching(
    candidate: string,
    candidateIndex: number,
    patternIndex: number,
  ): boolean {
    if (candidateIndex >= candidate.length) return false;

    const ignoreCase = this.matchingMode !== "MATCH_CASE";
    const patternChar = this.myPattern[patternIndex];

    if (!this.charEquals(patternChar, patternIndex, candidate[candidateIndex], ignoreCase))
      return false;

    if (
      this.matchingMode === "FIRST_LETTER" &&
      (patternIndex === 0 || (patternIndex === 1 && this.isWildcard(0))) &&
      this.hasCase(patternIndex)
    ) {
      return this.isUpperCase[patternIndex] === isUpperCase(candidate[0]);
    }

    return true;
  }

  private hasCase(index: number): boolean {
    return this.isUpperCase[index] || this.isLowerCase[index];
  }

  private isWildcard(index: number): boolean {
    return index >= 0 && index < this.myPattern.length && isWildcard(this.myPattern[index]);
  }

  private isPatternChar(index: number, char: string): boolean {
    return index >= 0 && index < this.myPattern.length && this.myPattern[index] === char;
  }

  private indexOfWordStart(
    candidate: string,
    patternIndex: number,
    candidateIndex: number,
  ): number {
    const patternChar = this.myPattern[patternIndex];

    if (
      candidateIndex >= candidate.length ||
      (this.mixedCase &&
        this.isLowerCase[patternIndex] &&
        !(patternIndex > 0 && this.isWordSeparator[patternIndex - 1]))
    ) {
      return -1;
    }

    let index = candidateIndex;
    const patternIsNotAlphaNumeric = !isAlphaNumeric(patternChar);

    for (;;) {
      index = this.indexOfIgnoreCase(candidate, index, patternIndex);
      if (index < 0) return -1;
      if (patternIsNotAlphaNumeric || isWordStart(candidate, index)) return index;
      index += 1;
    }
  }

  private indexOfIgnoreCase(
    candidate: string,
    candidateIndex: number,
    patternIndex: number,
  ): number {
    const upper = this.toUpperCase[patternIndex];
    const lower = this.toLowerCase[patternIndex];
    for (let index = candidateIndex; index < candidate.length; index += 1) {
      const candidateChar = candidate[index];
      if (candidateChar === upper || candidateChar === lower) return index;
    }
    return -1;
  }
}

/** Compile once per query; candidate-local failure state is reset before reuse. */
export function createFuzzyQueryScorer(query: string): (candidate: string) => number {
  const trimmedQuery = query.trim();
  if (trimmedQuery.length === 0) return () => 0;

  const matcher = createMatcher(trimmedQuery);
  const normalizePaths = containsPathSeparator(trimmedQuery);
  return (candidate) => {
    const candidateForMatching = normalizePaths ? replacePathSeparators(candidate) : candidate;
    const degree = matcher.matchingDegree(candidateForMatching);

    if (degree === NO_MATCH) return 0;

    const score = degree * 10 - candidate.length;
    return score <= 0 ? 1 : score;
  };
}

export function scoreFuzzyQueryMatch(candidate: string, query: string): number {
  return createFuzzyQueryScorer(query)(candidate);
}

export const scoreSettingsQueryMatch = scoreFuzzyQueryMatch;

function createMatcher(query: string): CombinedMatcher {
  const normalizedQuery = Array.from(query, (char) => {
    const lower = char.toLowerCase();
    return lower.length === char.length ? lower : char;
  }).join("");
  const hasPathSeparators = containsPathSeparator(normalizedQuery);
  const mainPattern = hasPathSeparators ? buildPathPattern(normalizedQuery) : `*${normalizedQuery}`;
  const fallbackPattern = basenamePattern(normalizedQuery);

  return new CombinedMatcher(
    new PatternMatcher(mainPattern, "IGNORE_CASE", PATH_SEPARATORS.join("")),
    hasPathSeparators && normalizedQuery !== fallbackPattern
      ? new PatternMatcher(fallbackPattern, "IGNORE_CASE", PATH_SEPARATORS.join(""))
      : null,
  );
}

function buildPathPattern(query: string): string {
  let pattern = `*${query}`;
  for (const separator of PATH_SEPARATORS) {
    pattern = pattern.split(separator).join(`*${PATH_SEPARATOR_MARKER}*`);
  }
  return pattern;
}

function basenamePattern(query: string): string {
  let lastSeparatorIndex = -1;
  for (const separator of PATH_SEPARATORS) {
    const index = query.lastIndexOf(separator);
    if (index >= 0 && index < query.length - 1) {
      lastSeparatorIndex = Math.max(lastSeparatorIndex, index);
    }
  }
  return query.slice(lastSeparatorIndex + 1);
}

function replacePathSeparators(candidate: string): string {
  let normalized = candidate;
  for (const separator of PATH_SEPARATORS) {
    normalized = normalized.split(separator).join(PATH_SEPARATOR_MARKER);
  }
  return normalized;
}

function containsPathSeparator(query: string): boolean {
  for (const separator of PATH_SEPARATORS) {
    if (query.includes(separator)) return true;
  }
  return false;
}

function addStartMatchBonus(score: number, match: MatchRange[]): number {
  if (match.length === 0) return score;
  return match[0].startOffset === 0 ? score + START_MATCH_BONUS : score;
}

function isPatternWordSeparator(char: string): boolean {
  return (
    char.trim().length === 0 ||
    char === "_" ||
    char === "-" ||
    char === ":" ||
    char === "+" ||
    char === "." ||
    char === "/" ||
    char === "\\"
  );
}

function nextWord(candidate: string, index: number): number {
  return index < candidate.length && isDigit(candidate[index])
    ? index + 1
    : nextWordStart(candidate, index);
}

function nextWordStart(candidate: string, index: number): number {
  for (let nextIndex = index + 1; nextIndex <= candidate.length; nextIndex += 1) {
    if (nextIndex >= candidate.length) return candidate.length + 1;
    if (isWordStart(candidate, nextIndex)) return nextIndex;
  }
  return candidate.length + 1;
}

function isWordStart(candidate: string, index: number): boolean {
  if (index < 0 || index >= candidate.length) return false;
  const char = candidate[index];
  if (!isAlphaNumeric(char)) return false;
  if (index === 0) return true;

  const previous = candidate[index - 1];
  return Boolean(
    !isAlphaNumeric(previous) ||
    (isUpperCase(char) && isLowerCase(previous)) ||
    (isDigit(char) && !isDigit(previous)),
  );
}

function indexOfPatternChar(
  pattern: string[],
  char: string,
  startIndex: number,
  endIndex: number,
  ignoreCase: boolean,
): number {
  if (!ignoreCase) {
    for (let index = startIndex; index < endIndex; index += 1) {
      if (pattern[index] === char) return index;
    }
    return -1;
  }

  const lower = char.toLowerCase();
  const upper = char.toUpperCase();
  for (let index = startIndex; index < endIndex; index += 1) {
    const patternChar = pattern[index];
    if (patternChar === lower || patternChar === upper) return index;
  }
  return -1;
}

function isWildcard(char: string): boolean {
  return char === " " || char === "*";
}

function indexOfAny(
  candidate: string,
  chars: string[],
  startIndex: number,
  endIndex: number,
): number {
  for (let index = startIndex; index < endIndex; index += 1) {
    if (chars.includes(candidate[index])) return index;
  }
  return -1;
}

function indexOfChar(
  candidate: string,
  char: string,
  startIndex: number,
  endIndex: number,
): number {
  for (let index = startIndex; index < endIndex; index += 1) {
    if (candidate[index] === char) return index;
  }
  return -1;
}

function indexOfSubstring(
  candidate: string,
  pattern: string,
  startIndex: number,
  endIndex: number,
): number {
  const candidateLower = candidate.toLowerCase();
  const patternLower = pattern.toLowerCase();
  const index = candidateLower.indexOf(patternLower, startIndex);
  return index < 0 || index + pattern.length > endIndex ? -1 : index;
}

function equalsIgnoreCase(
  candidate: string,
  startIndex: number,
  length: number,
  pattern: string,
): boolean {
  return startIndex + length <= candidate.length
    ? candidate.slice(startIndex, startIndex + length).toLowerCase() === pattern.toLowerCase()
    : false;
}

function withoutWildcards(pattern: string[]): string {
  let result = "";
  for (const char of pattern) {
    if (char !== "*") result += char;
  }
  return result;
}

function joinMatchRanges(rest: MatchRange[], startOffset: number, length: number): MatchRange[] {
  if (rest.length === 0) {
    return [
      {
        startOffset,
        endOffset: startOffset + length,
      },
    ];
  }

  const lastRange = rest[rest.length - 1];
  if (lastRange.startOffset === startOffset + length) {
    rest[rest.length - 1] = {
      startOffset,
      endOffset: lastRange.endOffset,
    };
  } else {
    rest.push({
      startOffset,
      endOffset: startOffset + length,
    });
  }

  return rest;
}

function isUpperCase(char: string): boolean {
  return char.toUpperCase() === char && char.toLowerCase() !== char;
}

function isLowerCase(char: string): boolean {
  return char.toLowerCase() === char && char.toUpperCase() !== char;
}

function isDigit(char: string): boolean {
  return char >= "0" && char <= "9";
}

function isAlphaNumeric(char: string): boolean {
  return /[a-z0-9]/i.test(char);
}
