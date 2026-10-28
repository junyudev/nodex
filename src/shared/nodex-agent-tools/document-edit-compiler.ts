/** Semantic edit receipt shared with the Core adapter. */
export interface AgentDocumentEditEffects {
  readonly createdBlockIds: readonly string[];
  readonly localBlockIds: Readonly<Record<string, string>>;
  readonly copiedBlockIds: Readonly<Record<string, string>>;
  readonly updatedBlockIds: readonly string[];
  readonly movedBlockIds: readonly string[];
  readonly deletedBlockIds: readonly string[];
  readonly deletedOwnerBlockIds: readonly string[];
  readonly titleChanged: boolean;
}
