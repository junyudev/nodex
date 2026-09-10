export function buildCodexTurnOccurrenceKey(
  turnId: string | null,
  turnIndex: number,
  entityKey?: string | null,
): string {
  const stableEntityKey = entityKey?.trim();
  return stableEntityKey || turnId || `turn-index-${turnIndex}`;
}
