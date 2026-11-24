/** Splits the body below a release heading into its headline area and its Markdown categories. */
export function splitChangelogReleaseBody(body: string): {
  beforeCategories: string;
  categories: string;
} {
  const normalized = body.replace(/\r\n/g, "\n");
  const firstCategory = normalized.search(/^### [ \t]*\S/mu);
  if (firstCategory === -1) return { beforeCategories: normalized, categories: "" };
  return {
    beforeCategories: normalized.slice(0, firstCategory),
    categories: normalized.slice(firstCategory),
  };
}

const MAX_HEADLINE_LENGTH = 48;
const markdownPunctuation = /[`*\[\]]/u;
const markdownLineStart = /^(?:[#>-]|\+\s|\d+[.)]\s)/u;
const markdownEmphasis = /(?:^|[^\p{L}\p{N}_])_+\S(?:.*?\S)?_+(?![\p{L}\p{N}_])/u;

/** Reads the single plain-text headline above a release's categories. */
export function readChangelogHeadline(
  beforeCategories: string,
  release: string,
  { required = release !== "Unreleased" }: { readonly required?: boolean } = {},
): string | null {
  const lines = beforeCategories.split("\n").filter((line) => line.trim());
  if (lines.length === 0 && !required) return null;
  const headline = lines[0];
  if (
    !headline ||
    lines.length !== 1 ||
    headline !== headline.trim() ||
    headline.length > MAX_HEADLINE_LENGTH ||
    headline.endsWith(".") ||
    markdownPunctuation.test(headline) ||
    markdownLineStart.test(headline) ||
    markdownEmphasis.test(headline) ||
    /<[^>]+>|~~.+~~/u.test(headline) ||
    /[\r\u2028\u2029]/u.test(headline)
  ) {
    const label = release === "Unreleased" ? "Unreleased" : `Release ${release}`;
    throw new Error(
      `${label} needs a headline: one trimmed plain-text line under its heading, at most ${MAX_HEADLINE_LENGTH} characters, without a closing period, naming the changes people will care about most.`,
    );
  }
  return headline;
}
