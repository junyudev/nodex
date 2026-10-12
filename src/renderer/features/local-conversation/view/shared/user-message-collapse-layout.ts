/** A collapsed prompt keeps a code block whole when it crosses the text cutoff. */
export function resolveUserMessageCollapsedHeightPx(input: {
  readonly lineHeightPx: number;
  readonly visibleLineCount: number;
  readonly rootTopPx: number;
  readonly physicalScale: number;
  readonly codeBlocks: readonly { readonly top: number; readonly bottom: number }[];
}): number {
  let height = Math.ceil(input.lineHeightPx * input.visibleLineCount);
  for (const block of input.codeBlocks) {
    const top = (block.top - input.rootTopPx) / input.physicalScale;
    const bottom = (block.bottom - input.rootTopPx) / input.physicalScale;
    if (top < height && bottom > height) height = Math.ceil(bottom);
  }
  return height;
}
