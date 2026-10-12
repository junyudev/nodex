export interface CodexHistoryViewportBoundary {
  readonly oldestRenderedTurnId: string;
  readonly firstProtectedItemId: string | null;
}
export interface CodexHistoryPolicyConfiguration {
  /** Explicit configuration provenance, independent of app-server wire capabilities. */
  readonly source: string;
  readonly scope: string;
  readonly readThreadTimelineEnabled: () => boolean | null | undefined;
  readonly readActiveHistoryEvictionEnabled: () => boolean | null | undefined;
}

/** One manager lifetime captures the first assigned eviction result, including false. */
export class CodexHistoryPolicy {
  private evictionEnabled: boolean | undefined;
  constructor(readonly configuration: CodexHistoryPolicyConfiguration) {}

  readThreadTimelineEnabled(): boolean {
    return this.configuration.readThreadTimelineEnabled() === true;
  }

  readActiveHistoryEvictionEnabled(): boolean | undefined {
    if (this.evictionEnabled !== undefined) return this.evictionEnabled;
    const value = this.configuration.readActiveHistoryEvictionEnabled();
    if (value !== null && value !== undefined) this.evictionEnabled = value;
    return this.evictionEnabled;
  }
}

/** null vetoes eviction for an existing viewer; undefined releases its registration. */
export class CodexHistoryViewportRegistry {
  private readonly viewports = new Map<symbol, readonly (CodexHistoryViewportBoundary | null)[]>();
  constructor(private readonly onChanged: () => void = () => {}) {}

  set(
    viewer: symbol,
    value:
      | CodexHistoryViewportBoundary
      | readonly (CodexHistoryViewportBoundary | null)[]
      | null
      | undefined,
  ): void {
    if (value === undefined) {
      if (this.viewports.delete(viewer)) this.onChanged();
      return;
    }
    const next = Array.isArray(value) ? value : [value as CodexHistoryViewportBoundary | null];
    const previous = this.viewports.get(viewer);
    if (
      previous &&
      previous.length === next.length &&
      previous.every(
        (boundary, index) =>
          boundary?.oldestRenderedTurnId === next[index]?.oldestRenderedTurnId &&
          boundary?.firstProtectedItemId === next[index]?.firstProtectedItemId,
      )
    )
      return;
    this.viewports.set(viewer, next);
    this.onChanged();
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
  readonly turnId?: string | null;
  readonly status?: "inProgress" | "completed" | "interrupted" | "failed";
  readonly turnItemIds?: readonly (string | undefined)[];
  readonly turnIndex?: number;
}

/** The caller supplies the actual viewport without overscan, plus any explicitly retained row. */
export function projectCodexHistoryViewportBoundary(input: {
  readonly distanceFromBottom: number;
  readonly hasPendingScrollTarget: boolean;
  readonly viewportRows: readonly CodexHistoryViewportRow[];
  readonly retainedRow?: CodexHistoryViewportRow | null;
}): CodexHistoryViewportBoundary | null {
  if (input.distanceFromBottom > 24 || input.hasPendingScrollTarget) return null;
  const rows = input.viewportRows.filter((row) => row.kind !== "gap");
  if (input.retainedRow && input.retainedRow.kind !== "gap") {
    if (
      input.retainedRow.turnIndex === undefined ||
      rows.some((row) => row.turnIndex === undefined)
    )
      return null;
    rows.push(input.retainedRow);
    rows.sort((left, right) => left.turnIndex! - right.turnIndex!);
  }
  if (rows.some((row) => !row.turnId)) return null;
  const row = rows[0];
  if (!row?.turnId) return null;
  return {
    oldestRenderedTurnId: row.turnId,
    firstProtectedItemId: row.status === "inProgress" ? (row.turnItemIds?.at(-500) ?? null) : null,
  };
}
