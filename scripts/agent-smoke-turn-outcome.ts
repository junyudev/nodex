type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export type AgentSmokeTurnOutcome =
  | { readonly kind: "pending" }
  | { readonly kind: "completed" }
  | { readonly kind: "terminalFailure"; readonly reason: "failed" | "interrupted" | "systemError" };

export const classifyAgentSmokeTurnSnapshot = (value: unknown): AgentSmokeTurnOutcome => {
  const snapshot = isRecord(value) ? value : null;
  const turns = Array.isArray(snapshot?.turns) ? snapshot.turns : [];
  const latestTurn = turns.at(-1);
  const status = isRecord(latestTurn) ? latestTurn.status : null;

  if (snapshot?.statusType === "systemError") {
    return { kind: "terminalFailure", reason: "systemError" };
  }
  if (status === "failed" || status === "interrupted") {
    return { kind: "terminalFailure", reason: status };
  }
  if (status === "completed" && snapshot?.statusType === "idle") return { kind: "completed" };
  return { kind: "pending" };
};

const summarizeItem = (value: unknown): UnknownRecord => {
  const item = isRecord(value) ? value : null;
  return {
    id: item?.itemId ?? item?.entryId ?? null,
    type: item?.type ?? item?.rawItemType ?? null,
    semanticKind: item?.semanticKind ?? null,
    normalizedKind: item?.normalizedKind ?? null,
    status: item?.status ?? null,
    text: typeof item?.markdownText === "string" ? item.markdownText.slice(0, 500) : null,
    message: typeof item?.message === "string" ? item.message.slice(0, 500) : null,
    detail: typeof item?.detail === "string" ? item.detail.slice(0, 500) : null,
    error: item?.error ?? null,
  };
};

export const summarizeAgentSmokeTurnSnapshot = (value: unknown, threadId: string): unknown => {
  const snapshot = isRecord(value) ? value : null;
  const turns = Array.isArray(snapshot?.turns) ? snapshot.turns : [];
  const latestTurn = turns.at(-1);
  const turn = isRecord(latestTurn) ? latestTurn : null;
  const items = Array.isArray(turn?.items) ? turn.items : [];
  return {
    threadId: snapshot?.threadId ?? threadId,
    threadStatus: snapshot?.statusType ?? null,
    turn: {
      id: turn?.turnId ?? turn?.id ?? null,
      status: turn?.status ?? null,
      errorMessage: turn?.errorMessage ?? null,
      items: items.slice(-20).map(summarizeItem),
    },
  };
};
