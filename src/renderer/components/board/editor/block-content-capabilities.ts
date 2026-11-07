export interface BlockContentSchemaLike {
  readonly blockSchema: Readonly<Record<string, { readonly content?: string }>>;
}

/** Rich inline content and unstyled source both expose a selectable text range. */
export function blockHasSelectableTextContent(
  schema: BlockContentSchemaLike,
  blockType: string,
): boolean {
  const content = schema.blockSchema[blockType]?.content;
  return content === "inline" || content === "plain";
}

/** Only rich text and Code source accept an adjacent text Block merge. */
export function blockAcceptsPlainTextMerge(
  schema: BlockContentSchemaLike,
  blockType: string,
): boolean {
  const content = schema.blockSchema[blockType]?.content;
  if (content === "inline") return true;
  return content === "plain" && blockType === "codeBlock";
}

/** Preview-first source is edited through a popup and keeps an atomic outer boundary. */
export function blockUsesPreviewFirstSource(
  schema: BlockContentSchemaLike,
  blockType: string,
): boolean {
  return schema.blockSchema[blockType]?.content === "plain" && blockType === "mathBlock";
}
