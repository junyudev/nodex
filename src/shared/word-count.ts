const words = new Intl.Segmenter(undefined, { granularity: "word" });

/**
 * Counts words as a reader would: spaced scripts by their words, Chinese and Japanese by
 * dictionary segmentation, never punctuation or whitespace. Markdown link labels and
 * destinations count like any other text.
 */
export const countWords = (text: string): number => {
  let count = 0;
  for (const segment of words.segment(text)) if (segment.isWordLike) count += 1;
  return count;
};
