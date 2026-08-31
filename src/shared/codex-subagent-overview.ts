import type {
  CodexSubagentOverviewStatus,
  CodexThreadActiveFlag,
  CodexThreadStatusType,
} from "./types";

export const CODEX_SUBAGENT_OVERVIEW_INITIAL_ACTIVE_LIMIT = 4;
export const CODEX_SUBAGENT_OVERVIEW_INITIAL_DONE_LIMIT = 10;
export const CODEX_SUBAGENT_DISCOVERY_PAGE_LIMIT = 200;
export const CODEX_SUBAGENT_LIFECYCLE_BATCH_LIMIT = 100;

export type CodexSubagentEvidenceKind =
  | "metadata"
  | "notification"
  | "completion"
  | "reconciliation";

export interface CodexSubagentStatusEvidence {
  readonly status: CodexSubagentOverviewStatus;
  readonly kind: CodexSubagentEvidenceKind;
  readonly sourceRevision: number;
  readonly observedAtMs: number;
}

const EVIDENCE_STRENGTH: Readonly<Record<CodexSubagentEvidenceKind, number>> = {
  metadata: 0,
  notification: 1,
  completion: 2,
  reconciliation: 3,
};

const isWaiting = (activeFlags: readonly CodexThreadActiveFlag[]): boolean =>
  activeFlags.includes("waitingOnApproval") || activeFlags.includes("waitingOnUserInput");

/**
 * Projects app-server thread residency without treating `notLoaded` as lifecycle completion.
 * A Thread can be unloaded while its Agent identity remains resumable or active elsewhere.
 */
export function projectCodexSubagentThreadStatus(input: {
  readonly statusType: CodexThreadStatusType;
  readonly activeFlags: readonly CodexThreadActiveFlag[];
}): CodexSubagentOverviewStatus {
  if (input.statusType === "active") {
    return isWaiting(input.activeFlags) ? "waiting" : "active";
  }
  if (input.statusType === "idle" || input.statusType === "systemError") return "done";
  return "unknown";
}

/**
 * Deterministic Main-side mirror of Core's evidence CAS. It is used before a write to avoid
 * publishing a weaker process-local projection while the durable apply is still in flight.
 */
export function selectCodexSubagentStatusEvidence(
  current: CodexSubagentStatusEvidence | null,
  incoming: CodexSubagentStatusEvidence,
): CodexSubagentStatusEvidence {
  if (!current) return incoming;

  const strengthDelta = EVIDENCE_STRENGTH[incoming.kind] - EVIDENCE_STRENGTH[current.kind];
  if (strengthDelta !== 0 && (incoming.kind === "metadata" || current.kind === "metadata")) {
    return strengthDelta > 0 ? incoming : current;
  }

  if (incoming.kind === current.kind) {
    if (incoming.sourceRevision !== current.sourceRevision) {
      return incoming.sourceRevision > current.sourceRevision ? incoming : current;
    }
    if (incoming.observedAtMs !== current.observedAtMs) {
      return incoming.observedAtMs > current.observedAtMs ? incoming : current;
    }
    return incoming;
  }

  if (incoming.kind === "reconciliation" || current.kind === "reconciliation") return incoming;

  if (incoming.sourceRevision !== current.sourceRevision) {
    return incoming.sourceRevision > current.sourceRevision ? incoming : current;
  }
  if (incoming.observedAtMs !== current.observedAtMs) {
    return incoming.observedAtMs > current.observedAtMs ? incoming : current;
  }
  if (strengthDelta !== 0) return strengthDelta > 0 ? incoming : current;
  return incoming;
}

export function isCodexSubagentUnresolvedStatus(status: CodexSubagentOverviewStatus): boolean {
  return status !== "done";
}
