export interface CodexHistoryViewportBoundary {
  readonly oldestProtectedTurnId: string;
  readonly firstProtectedItemId: string | null;
}
export interface CodexHistoryPolicyConfiguration {
  /** Explicit configuration provenance, independent of app-server wire capabilities. */
  readonly source: string;
  readonly scope: string;
  readonly readThreadTimelineEnabled: () => boolean | null | undefined;
}

export class CodexHistoryPolicy {
  constructor(readonly configuration: CodexHistoryPolicyConfiguration) {}

  readThreadTimelineEnabled(): boolean {
    return this.configuration.readThreadTimelineEnabled() === true;
  }
}

/** null vetoes eviction for an existing viewer; undefined releases its registration. */
export class CodexHistoryViewportRegistry {
  private readonly viewports = new Map<symbol, readonly (CodexHistoryViewportBoundary | null)[]>();
  constructor(private readonly onChanged: () => void = () => {}) {}

  /** Reports whether the viewer's boundary actually changed. */
  set(
    viewer: symbol,
    value:
      | CodexHistoryViewportBoundary
      | readonly (CodexHistoryViewportBoundary | null)[]
      | null
      | undefined,
  ): boolean {
    if (value === undefined) {
      if (!this.viewports.delete(viewer)) return false;
      this.onChanged();
      return true;
    }
    const next = Array.isArray(value) ? value : [value as CodexHistoryViewportBoundary | null];
    const previous = this.viewports.get(viewer);
    if (
      previous &&
      previous.length === next.length &&
      previous.every(
        (boundary, index) =>
          boundary?.oldestProtectedTurnId === next[index]?.oldestProtectedTurnId &&
          boundary?.firstProtectedItemId === next[index]?.firstProtectedItemId,
      )
    )
      return false;
    this.viewports.set(viewer, next);
    this.onChanged();
    return true;
  }

  getBoundaries(): readonly (CodexHistoryViewportBoundary | null)[] {
    return [...this.viewports.values()].flat();
  }

  clear(): void {
    if (this.viewports.size === 0) return;
    this.viewports.clear();
    this.onChanged();
  }
}

export interface CodexHistoryViewportRow {
  readonly kind: "content" | "gap";
  readonly turnIndex: number;
  /** A gap inside the Turn below it, which the reader is not yet asking to read. */
  readonly insideTurn?: boolean;
  readonly turnId?: string | null;
  readonly status?: "inProgress" | "completed" | "interrupted" | "failed";
  readonly turnItemIds?: readonly (string | undefined)[];
}

/** Rows within this distance of the bottom count as the reader following the live tail. */
export const CODEX_HISTORY_VIEWPORT_FOLLOW_PX = 24;
/** A running Turn keeps this many of its newest items when it is the protected Turn. */
const CODEX_HISTORY_VIEWPORT_LIVE_ITEMS = 500;

/**
 * Pass what the viewport shows from the bottom plus every row a surface holds mounted. Retention
 * waits for the reader to return to the live tail. A visible gap between Turns means older history
 * is being read, so releasing beneath it would only undo that read.
 */
export function projectCodexHistoryViewportBoundary(input: {
  readonly distanceFromBottom: number;
  readonly hasPendingScrollTarget: boolean;
  readonly viewportRows: readonly CodexHistoryViewportRow[];
  readonly retainedRows?: readonly CodexHistoryViewportRow[];
}): CodexHistoryViewportBoundary | null {
  if (input.distanceFromBottom > CODEX_HISTORY_VIEWPORT_FOLLOW_PX || input.hasPendingScrollTarget)
    return null;
  let oldest: CodexHistoryViewportRow | null = null;
  for (const row of [...input.viewportRows, ...(input.retainedRows ?? [])]) {
    if (row.kind === "gap" && row.insideTurn) continue;
    if (row.kind === "gap" || !row.turnId) return null;
    if (!oldest || row.turnIndex < oldest.turnIndex) oldest = row;
  }
  if (!oldest?.turnId) return null;
  return {
    oldestProtectedTurnId: oldest.turnId,
    firstProtectedItemId:
      oldest.status === "inProgress"
        ? (oldest.turnItemIds?.at(-CODEX_HISTORY_VIEWPORT_LIVE_ITEMS) ?? null)
        : null,
  };
}
