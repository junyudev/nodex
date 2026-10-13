/** Native item identities cannot return to running after confirmed completion. */
export function mergeCodexItemCompletionEvidence(
  existing: Readonly<Record<string, boolean>> | undefined,
  incoming: Readonly<Record<string, boolean>> | undefined,
): Readonly<Record<string, boolean>> | undefined {
  if (!incoming) return existing;
  let changed: Record<string, boolean> | undefined;
  for (const [id, completed] of Object.entries(incoming)) {
    if (existing?.[id] === true || existing?.[id] === completed) continue;
    changed ??= { ...existing };
    changed[id] = completed;
  }
  return changed ?? existing;
}
