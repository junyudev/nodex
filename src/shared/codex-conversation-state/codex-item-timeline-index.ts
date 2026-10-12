import type { Patch } from "immer";
import type { CodexCanonicalItemTimeline } from "./codex-conversation-state";
import { codexTimelineEntryIdentity } from "./codex-live-item-timeline";

/** Sparse live receipts reuse the resident identity index; history replacement rebuilds lazily. */
export class CodexItemTimelineIndex {
  private readonly positions = new WeakMap<CodexCanonicalItemTimeline, Map<string, number>>();

  position(timeline: CodexCanonicalItemTimeline | undefined, identity: string): number | undefined {
    if (!timeline) return undefined;
    let positions = this.positions.get(timeline);
    if (!positions) {
      positions = new Map(
        timeline.entries.map((entry, index) => [codexTimelineEntryIdentity(entry), index]),
      );
      this.positions.set(timeline, positions);
    }
    return positions.get(identity);
  }

  update(
    before: CodexCanonicalItemTimeline | undefined,
    after: CodexCanonicalItemTimeline | undefined,
    patches?: readonly Patch[],
  ): void {
    if (!before || !after || before === after) return;
    const positions = this.positions.get(before);
    if (!positions) return;
    const changed = patches?.filter(({ path }) => path[0] === "itemTimeline");
    if (
      !changed?.length ||
      changed.some(
        ({ op, path }) => op === "remove" || path[1] !== "entries" || typeof path[2] !== "number",
      )
    )
      return;
    const indexes = new Set(changed.map(({ path }) => path[2] as number));
    if ([...indexes].some((index) => !after.entries[index])) return;
    this.positions.delete(before);
    for (const index of indexes) {
      const previous = before.entries[index];
      if (previous) positions.delete(codexTimelineEntryIdentity(previous));
      positions.set(codexTimelineEntryIdentity(after.entries[index]!), index);
    }
    this.positions.set(after, positions);
  }
}
