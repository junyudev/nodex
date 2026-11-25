/**
 * Characters that set about twice as wide as a Latin letter: Han, kana, Hangul, Bopomofo, CJK
 * symbols and punctuation, and fullwidth forms. Cell classification only needs an estimate, so
 * Unicode script properties stand in for the full East Asian Width table. Halfwidth kana and
 * Hangul forms belong to those scripts but set narrow.
 */
const wideCharacter =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}\u3000-\u303F\uFF01-\uFF60\uFFE0-\uFFE6]/u;
const halfwidthForm = /[\uFF61-\uFFDC\uFFE8-\uFFEE]/u;

export type NfmTableLayout = "auto" | "mixed" | "pinned";
export type NfmTableCellFit = "short" | "long" | "blank";

const MAX_SHORT_DISPLAY_UNITS = 20;

export function measureNfmTableDisplayUnits(text: string): number {
  let units = 0;
  for (const character of text.trim()) {
    units += wideCharacter.test(character) && !halfwidthForm.test(character) ? 2 : 1;
  }
  return units;
}

export function isPinnedNfmTableWidth(width: unknown): width is number {
  return typeof width === "number" && Number.isFinite(width) && width > 0;
}

export function classifyNfmTable(
  rows: readonly (readonly string[])[],
  columnWidths: readonly (number | null | undefined)[] = [],
) {
  const columnCount = rows.reduce((count, row) => Math.max(count, row.length), 0);
  const columns = Array.from({ length: columnCount }, (_, index) =>
    isPinnedNfmTableWidth(columnWidths[index]) ? columnWidths[index] : undefined,
  );
  const pinnedCount = columns.filter(isPinnedNfmTableWidth).length;
  const layout: NfmTableLayout =
    pinnedCount === 0 ? "auto" : pinnedCount === columnCount ? "pinned" : "mixed";

  const units = rows.map((row) =>
    row.map((text, column) =>
      columns[column] === undefined ? measureNfmTableDisplayUnits(text) : 0,
    ),
  );
  const blankColumns = columns.map(
    (width, column) => width === undefined && units.every((row) => (row[column] ?? 0) === 0),
  );
  const cellFits = units.map((row) =>
    row.map((length, column): NfmTableCellFit | undefined => {
      if (blankColumns[column]) return "blank";
      if (length === 0) return undefined;
      return length <= MAX_SHORT_DISPLAY_UNITS ? "short" : "long";
    }),
  );

  return { layout, columns, cellFits };
}

/** Scale measured widths, clamping narrow columns before distributing the remaining space. */
export function fitNfmTableColumnsToWidth(
  renderedWidths: readonly number[],
  availableWidth: number,
  minWidth = 35,
): number[] {
  if (renderedWidths.length === 0) return [];
  const minimum = Math.ceil(minWidth);
  const minimumTotal = renderedWidths.length * minimum;
  // Below the combined minimum, the table needs to overflow to retain usable columns.
  const target = Math.max(Math.floor(availableWidth), minimumTotal);
  if (target === minimumTotal) return renderedWidths.map(() => minimum);

  const weights = renderedWidths.map((width) => (isPinnedNfmTableWidth(width) ? width : 0));
  const totalWeight = weights.reduce((sum, width) => sum + width, 0);
  let remainingWeight = totalWeight || weights.length;

  let remainingWidth = target;
  const byWeight = weights
    .map((weight, index) => ({ weight: totalWeight === 0 ? 1 : weight, index }))
    .sort((left, right) => left.weight - right.weight);
  const scaledWidths = weights.map(() => minimum);
  for (const { weight, index } of byWeight) {
    const scaledWidth = (weight / remainingWeight) * remainingWidth;
    if (scaledWidth < minimum) {
      remainingWidth -= minimum;
      remainingWeight -= weight;
      continue;
    }
    scaledWidths[index] = scaledWidth;
  }

  const widths = scaledWidths.map(Math.floor);
  const remainder = target - widths.reduce((sum, width) => sum + width, 0);
  const byFraction = scaledWidths
    .map((width, index) => ({ index, fraction: width - widths[index] }))
    .sort((left, right) => right.fraction - left.fraction || left.index - right.index);
  for (const { index } of byFraction.slice(0, remainder)) {
    widths[index] += 1;
  }
  return widths;
}
