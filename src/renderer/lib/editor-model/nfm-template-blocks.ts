/** A Block a template writes: plain inline text, optionally nested. */
export interface NfmTemplateBlock {
  readonly type: string;
  readonly props?: Readonly<Record<string, boolean | number | string>>;
  readonly content?: string;
  readonly children?: readonly NfmTemplateBlock[];
  /** The caret lands at the end of the first Block marked as the place to begin writing. */
  readonly caret?: true;
}

/** The BlockNote partial Block for a template Block; the caret mark is presentation only. */
export function toNfmPartialBlock(block: NfmTemplateBlock): Record<string, unknown> {
  return {
    type: block.type,
    ...(block.props ? { props: { ...block.props } } : {}),
    ...(block.content !== undefined ? { content: block.content } : {}),
    ...(block.children?.length ? { children: block.children.map(toNfmPartialBlock) } : {}),
  };
}

/** Child indexes leading to the first Block marked as the place to begin writing. */
export function findNfmTemplateCaretPath(blocks: readonly NfmTemplateBlock[]): readonly number[] {
  for (const [index, block] of blocks.entries()) {
    if (block.caret) return [index];
    const childPath = findNfmTemplateCaretPath(block.children ?? []);
    if (childPath.length > 0) return [index, ...childPath];
  }
  return [];
}
