import type { OrchestrationV2Subagent } from "@nodex/runtime-contracts";

export type SubagentTurnCandidate = {
  readonly id: string;
  readonly status: OrchestrationV2Subagent["status"];
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly held: boolean;
};

/** Select the current turn using canonical ISO timestamps. Keep ProjectionStore's SQL ranking in sync. */
export function currentSubagentTurn<T extends SubagentTurnCandidate>(
  turns: readonly T[],
): { readonly turn: T; readonly phase: "active" | "terminal" } | undefined {
  const rank = (turn: SubagentTurnCandidate) => {
    if (turn.status === "running" || turn.status === "waiting") return 0;
    if (turn.status === "pending") return turn.held ? 3 : 1;
    return 2;
  };
  const compare = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
  // Compare Unicode code points to match SQLite's UTF-8 binary collation.
  const compareId = (left: string, right: string) => {
    const leftPoints = Array.from(left);
    const rightPoints = Array.from(right);
    const difference = leftPoints.findIndex((point, i) => point !== rightPoints[i]);
    if (difference === -1) return leftPoints.length - rightPoints.length;
    return (
      leftPoints[difference]!.codePointAt(0)! - (rightPoints[difference]?.codePointAt(0) ?? -1)
    );
  };
  const preferred = (left: T, right: T) => {
    const leftRank = rank(left);
    const rightRank = rank(right);
    if (leftRank !== rightRank) return leftRank < rightRank;
    if (leftRank === 2 && left.completedAt !== right.completedAt)
      return compare(left.completedAt ?? "", right.completedAt ?? "") > 0;
    if (leftRank !== 3 && left.startedAt !== right.startedAt) {
      const order = compare(left.startedAt ?? "", right.startedAt ?? "");
      return leftRank === 1 ? order < 0 : order > 0;
    }
    return compareId(left.id, right.id) > 0;
  };
  let turn: T | undefined;
  for (const candidate of turns) {
    if (turn === undefined || preferred(candidate, turn)) turn = candidate;
  }
  // A held pending turn can still be the only work this subagent has.
  return turn === undefined ? undefined : { turn, phase: rank(turn) !== 2 ? "active" : "terminal" };
}
