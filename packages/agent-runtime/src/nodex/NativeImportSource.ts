/** Frozen source boundary; copies never acquire the source's native execution identity. */
export interface NativeImportBoundary {
  readonly boundaryItemId: string | null;
  readonly boundaryTurnId: string | null;
  readonly historyMode: "legacy" | "paginated" | "claude";
  readonly sourceCwd: string;
  readonly sourceRevision: string | null;
}
