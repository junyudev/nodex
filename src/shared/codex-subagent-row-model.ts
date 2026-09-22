import { selectOwnConversationTurns } from "./codex-inherited-history";
import { isRawCodexSubagentThreadIdLabel } from "./codex-subagent-display";
import { advanceCodexSubagentInteraction } from "./codex-subagent-interaction";
import type {
  CodexConversationChildMembership,
  CodexConversationItem,
  CodexConversationSnapshot,
  CodexConversationTurn,
  CodexThreadStatusType,
} from "./types";
import type {
  CodexMultiAgentActionName,
  CodexMultiAgentAgentState,
  CodexMultiAgentAgentStatus,
  CodexMultiAgentReceiverThread,
} from "./codex-transcript-special-items";
import { normalizeMultiAgentActionPayload } from "./codex-transcript-special-items";
/** One pure row contract shared by overview, transcript, summary and mentions. */
export interface CodexSubagentRow {
  canInteract: boolean;
  conversationId: string;
  parentConversationId: string;
  parentTurnKey: string | null;
  displayName: string;
  actorName: string;
  agentRole: string | null;
  spawnModel: string | null;
  status: "active" | "waiting" | "done";
  statusSummary: string | null;
  lastAssistantMessage: string | null;
  lastAssistantMessageAtMs: number | null;
  recencyAtMs: number;
  showInlineActivity: boolean;
  objective?: string | null;
  startedAtMs?: number | null;
  isCurrentParentTurn?: boolean;
  diffStats: { linesAdded: number; linesRemoved: number } | null;
  role: "childApproval" | "backgroundChild";
}

export type SubagentConversation = Pick<CodexConversationSnapshot, "turns"> &
  Partial<
    Pick<
      CodexConversationSnapshot,
      | "threadId"
      | "statusType"
      | "threadRuntimeStatus"
      | "archived"
      | "createdAt"
      | "updatedAt"
      | "agentNickname"
      | "agentRole"
      | "resumeState"
    >
  > & { parentThreadId?: string | null; source?: unknown };

type NormalizedAgentStatus = "active" | "waiting" | "done" | "hidden" | "unknown";
type ChildProgressStatus = "inProgress" | "notInProgress" | "unknown";

interface LatestReference {
  canInteract: boolean;
  objective: string | null;
  tool: CodexMultiAgentActionName;
  parentTurnKey: string;
  thread: CodexMultiAgentReceiverThread["thread"];
  agentState: CodexMultiAgentAgentState | null;
  spawnModel: string | null;
}

interface LastAssistantMessage {
  text: string;
  updatedAtMs: number | null;
}

export interface BuildBackgroundSubagentRowsInput {
  childMemberships: readonly CodexConversationChildMembership[];
  parentTurns: readonly CodexConversationTurn[];
  knownConversationsById: Record<string, SubagentConversation>;
  parentConversationId?: string;
  discoveryComplete?: boolean;
}

type ThreadMetadata =
  | CodexMultiAgentReceiverThread["thread"]
  | CodexConversationChildMembership["thread"];

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function normalizeOptionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function stripLeadingAt(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
}

function resolveThreadDisplayName(thread: ThreadMetadata | null | undefined): string | null {
  return (
    normalizeOptionalText(thread?.displayName) ??
    normalizeOptionalText(thread?.name) ??
    normalizeOptionalText(thread?.nickname)
  );
}

function getParentTurnKey(turn: CodexConversationTurn | null | undefined, index: number): string {
  return turn?.turnId ?? `turn-index-${index}`;
}

function getLatestParentTurnKey(parentTurns: readonly CodexConversationTurn[]): string {
  if (parentTurns.length === 0) return "0";
  return getParentTurnKey(parentTurns[parentTurns.length - 1], parentTurns.length - 1);
}

function getParentTurnKeyForCreatedAt(
  parentTurns: readonly CodexConversationTurn[],
  createdAtMs: number | null,
): string {
  if (createdAtMs === null || !Number.isFinite(createdAtMs)) {
    return getLatestParentTurnKey(parentTurns);
  }

  for (let index = parentTurns.length - 1; index >= 0; index -= 1) {
    const turn = parentTurns[index];
    if (typeof turn?.turnStartedAtMs === "number" && turn.turnStartedAtMs <= createdAtMs) {
      return getParentTurnKey(turn, index);
    }
  }

  return "0";
}

function normalizeAgentStatus(
  status: CodexMultiAgentAgentStatus | null | undefined,
): NormalizedAgentStatus {
  switch (status) {
    case "pendingInit":
      return "waiting";
    case "running":
      return "active";
    case "completed":
      return "done";
    case "interrupted":
    case "errored":
    case "shutdown":
    case "notFound":
      return "hidden";
    case null:
    case undefined:
      return "unknown";
  }
}

function mapThreadStatusToAgentStatus(
  statusType: CodexThreadStatusType,
): CodexMultiAgentAgentStatus {
  switch (statusType) {
    case "active":
      return "running";
    case "idle":
      return "completed";
    case "notLoaded":
      return "pendingInit";
    case "systemError":
      return "errored";
  }
}

function resolveChildProgress(child: SubagentConversation | null): ChildProgressStatus {
  if (child?.threadRuntimeStatus?.type === "active") return "inProgress";
  if (child?.threadRuntimeStatus && child.threadRuntimeStatus.type !== "notLoaded") {
    return "notInProgress";
  }
  if (!child || child.turns.length === 0) return "unknown";
  return child.turns[child.turns.length - 1]?.status === "inProgress"
    ? "inProgress"
    : "notInProgress";
}

function resolveRuntimeStatusType(
  child: SubagentConversation | null,
  membership: CodexConversationChildMembership,
): CodexThreadStatusType | undefined {
  const resident = child?.threadRuntimeStatus?.type ?? child?.statusType;
  if (child?.resumeState === "needs_resume" || resident === "notLoaded")
    return membership.statusType ?? resident;
  return resident ?? membership.statusType;
}

function resolveVisibleStatus(input: {
  reference: LatestReference;
  child: SubagentConversation | null;
  runtimeStatus: CodexThreadStatusType | undefined;
  discoveryComplete: boolean;
  latestTurnStatus?: CodexConversationTurn["status"];
}): CodexSubagentRow["status"] | null {
  const normalized = normalizeAgentStatus(input.reference.agentState?.status);
  const latestTurnStatus = input.latestTurnStatus ?? input.child?.turns.at(-1)?.status;
  const active = input.runtimeStatus === "active";
  if (
    input.reference.tool === "closeAgent" ||
    (normalized === "hidden" && !active) ||
    input.runtimeStatus === "systemError" ||
    ((latestTurnStatus === "failed" || latestTurnStatus === "interrupted") && !active)
  )
    return null;
  if (input.runtimeStatus !== undefined) return active ? "active" : "done";
  if (input.discoveryComplete) return "done";
  const progress = resolveChildProgress(input.child);
  if (progress === "inProgress") return "active";
  if (progress === "notInProgress") return "done";
  if (normalized === "waiting") return "waiting";
  return normalized === "done" ? "done" : "active";
}

function normalizeMultiAgentPayloadFromItem(item: CodexConversationItem) {
  const rawPayload = normalizeMultiAgentActionPayload(item.rawItem);
  if (rawPayload) return rawPayload;

  const args = asRecord(item.toolCall?.args);
  if (!args) return null;
  return normalizeMultiAgentActionPayload({
    tool: item.toolCall?.toolName,
    status: item.status,
    senderThreadId: args.sender,
    receiverThreadIds: args.receivers,
    receiverThreads: args.receiverThreads,
    agentsStates: args.agentsStates,
    prompt: args.prompt,
    model: args.model,
    reasoningEffort: args.reasoningEffort,
  });
}

function buildLatestReferenceMap(
  input: BuildBackgroundSubagentRowsInput,
): Map<string, LatestReference> {
  const knownChildIds = new Set(input.childMemberships.map((membership) => membership.threadId));
  const latest = new Map<string, LatestReference>();

  input.parentTurns.forEach((turn, turnIndex) => {
    const parentTurnKey = getParentTurnKey(turn, turnIndex);
    for (const item of turn.items) {
      const activity = item.subagentActivity;
      if (activity && knownChildIds.has(activity.agentThreadId)) {
        const previous = latest.get(activity.agentThreadId);
        latest.set(activity.agentThreadId, {
          tool: "spawnAgent",
          objective: previous?.objective ?? null,
          parentTurnKey,
          thread: previous?.thread ?? null,
          agentState: {
            status:
              activity.displayStatus === "completed" ||
              activity.displayStatus === "interrupted" ||
              (activity.isMessage &&
                (previous?.agentState?.status === "completed" ||
                  previous?.agentState?.status === "interrupted"))
                ? "completed"
                : "running",
            message: null,
          },
          spawnModel: null,
          canInteract: advanceCodexSubagentInteraction(previous, parentTurnKey, "activity"),
        });
      }

      const payload = normalizeMultiAgentPayloadFromItem(item);
      if (!payload) continue;
      const receiverThreads = new Map(
        payload.receiverThreads.map((receiver) => [receiver.threadId, receiver.thread] as const),
      );
      for (const receiverThreadId of payload.receiverThreadIds) {
        if (!knownChildIds.has(receiverThreadId)) continue;
        const previous = latest.get(receiverThreadId);
        latest.set(receiverThreadId, {
          tool:
            payload.action === "wait" ||
            payload.action === "sendInput" ||
            (payload.action === "resumeAgent" && previous?.tool !== "closeAgent")
              ? (previous?.tool ?? payload.action)
              : payload.action,
          objective: normalizeOptionalText(payload.prompt) ?? previous?.objective ?? null,
          parentTurnKey,
          thread: receiverThreads.get(receiverThreadId) ?? previous?.thread ?? null,
          agentState: payload.agentsStates[receiverThreadId] ?? previous?.agentState ?? null,
          spawnModel:
            payload.action === "spawnAgent"
              ? (payload.model ?? previous?.spawnModel ?? null)
              : (previous?.spawnModel ?? null),
          canInteract: advanceCodexSubagentInteraction(
            previous,
            parentTurnKey,
            payload.action === "spawnAgent" ? "spawn" : "collaboration",
          ),
        });
      }
    }
  });

  return latest;
}

function buildFallbackReference(
  membership: CodexConversationChildMembership,
  parentTurns: readonly CodexConversationTurn[],
  child: SubagentConversation | null,
): LatestReference {
  const statusType = child?.threadRuntimeStatus?.type ?? child?.statusType ?? membership.statusType;
  return {
    tool: "spawnAgent",
    objective: null,
    parentTurnKey: getParentTurnKeyForCreatedAt(
      parentTurns,
      child?.createdAt ?? membership.createdAtMs ?? null,
    ),
    thread: null,
    agentState:
      statusType === undefined || statusType === "notLoaded"
        ? null
        : {
            status: mapThreadStatusToAgentStatus(statusType),
            message: null,
          },
    spawnModel: null,
    canInteract: false,
  };
}

function resolveDisplayName(input: {
  membership: CodexConversationChildMembership;
  reference: LatestReference;
  child: SubagentConversation | null;
}): string {
  for (const candidate of [
    input.membership.displayName,
    resolveThreadDisplayName(input.reference.thread),
    resolveThreadDisplayName(input.membership.thread),
    input.child?.agentNickname,
  ]) {
    const name = normalizeOptionalText(candidate);
    if (!name || isRawCodexSubagentThreadIdLabel(name, input.membership.threadId)) continue;
    const displayName = stripLeadingAt(name).trim();
    if (displayName) return displayName;
  }
  return "";
}

function resolveAgentRole(input: {
  membership: CodexConversationChildMembership;
  reference: LatestReference;
  child: SubagentConversation | null;
}): string | null {
  const role =
    normalizeOptionalText(input.reference.thread?.agentRole) ??
    normalizeOptionalText(input.membership.thread?.agentRole) ??
    normalizeOptionalText(input.membership.agentRole) ??
    normalizeOptionalText(input.child?.agentRole);
  return !role || role === "default" ? null : role;
}

function unwrapMarkdownDelimiters(value: string): string {
  let current = value;
  for (;;) {
    const next = current
      .replace(/^\*\*(.+)\*\*$/u, "$1")
      .replace(/^__(.+)__$/u, "$1")
      .replace(/^\*(.+)\*$/u, "$1")
      .replace(/^_(.+)_$/u, "$1")
      .replace(/^`(.+)`$/u, "$1")
      .trim();
    if (next === current) return current;
    current = next;
  }
}

export function cleanupBackgroundSubagentStatusSummary(
  value: string | null | undefined,
): string | null {
  if (value == null) return null;
  let text = value
    .replace(/^\s*(?:>\s*|#{1,6}\s+|(?:[-*+]|\d+\.)\s+)*/u, "")
    .replace(/\*/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  text = unwrapMarkdownDelimiters(text);
  text = text.replace(/^(?:i['’]m|i am)\s+/iu, "");
  text = text.replace(/[.!?;,:]+$/u, "").trim();
  if (text.replace(/[*_`]/gu, "").trim().length === 0) return null;
  if (/^\p{Lu}\p{Ll}/u.test(text)) {
    text = `${text[0]?.toLowerCase() ?? ""}${text.slice(1)}`;
  }
  return text;
}

function getReasoningSummaryCandidates(item: CodexConversationItem): string[] {
  const candidates: string[] = [];
  const summary = asRecord(item.rawItem)?.summary;
  if (Array.isArray(summary)) {
    for (const entry of summary) {
      if (typeof entry === "string") candidates.push(entry);
      const text = asRecord(entry)?.text;
      if (typeof text === "string") candidates.push(text);
    }
  }
  if (typeof item.markdownText === "string") candidates.push(item.markdownText);
  return candidates;
}

function resolveStatusSummary(child: SubagentConversation | null): string | null {
  const latestTurn = child?.turns[child.turns.length - 1] ?? null;
  if (latestTurn?.status !== "inProgress") return null;
  for (let itemIndex = latestTurn.items.length - 1; itemIndex >= 0; itemIndex -= 1) {
    const item = latestTurn.items[itemIndex];
    if (item?.semanticKind !== "reasoning" && item?.type !== "reasoning") continue;
    const candidates = getReasoningSummaryCandidates(item);
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const summary = cleanupBackgroundSubagentStatusSummary(candidates[index]);
      if (summary) return summary;
    }
  }
  return null;
}

function isAssistantMessage(item: CodexConversationItem): boolean {
  return (
    item.role === "assistant" ||
    item.kind === "assistantMessage" ||
    item.semanticKind === "assistantMessage" ||
    item.type === "agentMessage"
  );
}

function resolveLastAssistantMessage(
  child: SubagentConversation | null,
): LastAssistantMessage | null {
  if (!child) return null;
  for (let turnIndex = child.turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const items = child.turns[turnIndex]?.items ?? [];
    for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const item = items[itemIndex];
      if (!item || !isAssistantMessage(item)) continue;
      const text = normalizeOptionalText(item.markdownText);
      if (!text) continue;
      const turn = child.turns[turnIndex];
      const startedAtMs =
        turn?.assistantMessageStartedAtMsById?.[item.itemId] ??
        (asRecord(item.rawItem)?.phase === "final_answer"
          ? turn?.finalAssistantStartedAtMs
          : null) ??
        turn?.turnStartedAtMs;
      return { text, updatedAtMs: startedAtMs ?? null };
    }
  }
  return null;
}

function summarizeTurnDiff(diff: string | null | undefined): CodexSubagentRow["diffStats"] {
  if (!diff) return null;
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const line of diff.split(/\r?\n/u)) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) linesAdded += 1;
    if (line.startsWith("-")) linesRemoved += 1;
  }
  return linesAdded === 0 && linesRemoved === 0 ? null : { linesAdded, linesRemoved };
}

export function buildBackgroundSubagentRows(
  input: BuildBackgroundSubagentRowsInput,
): CodexSubagentRow[] {
  const memberships = new Map(input.childMemberships.map((member) => [member.threadId, member]));
  const rootId =
    input.parentConversationId ??
    input.parentTurns[0]?.threadId ??
    input.childMemberships[0]?.parentThreadId;
  const parentMembershipIds = new Set<string>();
  if (rootId) {
    for (const turn of input.parentTurns) {
      for (const item of turn.items) {
        const activity = item.subagentActivity;
        if (activity && !activity.isMessage) {
          parentMembershipIds.add(activity.agentThreadId);
          const existing = memberships.get(activity.agentThreadId);
          memberships.set(activity.agentThreadId, {
            ...existing,
            threadId: activity.agentThreadId,
            parentThreadId: rootId,
            role: existing?.role ?? "backgroundChild",
            displayName: activity.displayName,
            showInlineActivity: true,
          });
        }
        const payload = normalizeMultiAgentPayloadFromItem(item);
        if (payload?.action !== "spawnAgent") continue;
        for (const threadId of payload.receiverThreadIds) {
          parentMembershipIds.add(threadId);
          if (memberships.has(threadId)) continue;
          memberships.set(threadId, { threadId, parentThreadId: rootId, role: "backgroundChild" });
        }
      }
    }
  }
  input = {
    ...input,
    childMemberships: [
      ...[...parentMembershipIds].flatMap((id) => {
        const member = memberships.get(id);
        return member ? [member] : [];
      }),
      ...[...memberships.values()].filter((member) => !parentMembershipIds.has(member.threadId)),
    ],
  };
  const references = buildLatestReferenceMap(input);
  const currentParentTurnKey = getLatestParentTurnKey(input.parentTurns);
  const hasModernActivity = input.parentTurns.some((turn) =>
    turn.items.some((item) => item.subagentActivity && !item.subagentActivity.isMessage),
  );
  const referencedTurnIndices = new Map<string, number[]>();
  input.parentTurns.forEach((turn, index) => {
    const ids = new Set<string>();
    for (const item of turn.items) {
      if (item.subagentActivity) ids.add(item.subagentActivity.agentThreadId);
      const payload = normalizeMultiAgentPayloadFromItem(item);
      for (const id of payload?.receiverThreadIds ?? []) ids.add(id);
    }
    for (const id of ids)
      referencedTurnIndices.set(id, [...(referencedTurnIndices.get(id) ?? []), index]);
  });
  const sourceParentTurnKey = (membership: CodexConversationChildMembership): string => {
    let ancestor = membership;
    const seen = new Set<string>();
    while (!seen.has(ancestor.parentThreadId)) {
      seen.add(ancestor.parentThreadId);
      const parent = memberships.get(ancestor.parentThreadId);
      if (!parent) break;
      ancestor = parent;
    }
    const createdAt =
      membership.createdAtMs ?? input.knownConversationsById[membership.threadId]?.createdAt;
    if (createdAt != null) {
      for (const index of [...(referencedTurnIndices.get(ancestor.threadId) ?? [])].reverse()) {
        const turn = input.parentTurns[index];
        if (turn && (turn.turnStartedAtMs == null || turn.turnStartedAtMs <= createdAt))
          return getParentTurnKey(turn, index);
      }
    }
    return getParentTurnKeyForCreatedAt(
      input.parentTurns,
      ancestor.createdAtMs ?? input.knownConversationsById[ancestor.threadId]?.createdAt ?? null,
    );
  };

  return input.childMemberships.flatMap((membership) => {
    const residentChild = input.knownConversationsById[membership.threadId] ?? null;
    if (residentChild?.archived) return [];
    const immediateParent = input.knownConversationsById[membership.parentThreadId];
    const parentTurns =
      membership.parentThreadId === rootId ? input.parentTurns : immediateParent?.turns;
    const child =
      residentChild && parentTurns
        ? {
            ...residentChild,
            turns: selectOwnConversationTurns(residentChild.turns, parentTurns),
          }
        : residentChild;
    const sourceOnly = !parentMembershipIds.has(membership.threadId);
    const nestedReference =
      sourceOnly && parentTurns
        ? buildLatestReferenceMap({
            ...input,
            parentTurns,
            childMemberships: [membership],
          }).get(membership.threadId)
        : undefined;
    const fallback = {
      ...buildFallbackReference(membership, input.parentTurns, child),
      parentTurnKey: sourceParentTurnKey(membership),
    };
    const reference = sourceOnly
      ? nestedReference
        ? { ...nestedReference, parentTurnKey: fallback.parentTurnKey }
        : fallback
      : (references.get(membership.threadId) ?? fallback);
    const status = resolveVisibleStatus({
      reference,
      child,
      runtimeStatus: resolveRuntimeStatusType(child, membership),
      discoveryComplete: input.discoveryComplete ?? true,
      latestTurnStatus: child?.turns.at(-1)?.status ?? residentChild?.turns.at(-1)?.status,
    });
    if (!status) return [];

    const displayName = resolveDisplayName({ membership, reference, child });
    const lastAssistantMessage = resolveLastAssistantMessage(child);
    const recencyAtMs = Math.max(
      lastAssistantMessage?.updatedAtMs ?? 0,
      child?.turns.at(-1)?.turnStartedAtMs ?? 0,
      child?.updatedAt ?? 0,
      membership.updatedAtMs ?? 0,
      child?.createdAt ?? 0,
      membership.createdAtMs ?? 0,
    );
    return [
      {
        conversationId: membership.threadId,
        parentConversationId: membership.parentThreadId,
        parentTurnKey: reference.parentTurnKey,
        displayName,
        actorName: normalizeOptionalText(membership.actorName) ?? displayName,
        agentRole: resolveAgentRole({ membership, reference, child }),
        spawnModel: reference.spawnModel,
        objective: reference.objective,
        startedAtMs:
          residentChild?.turns.at(-1)?.turnStartedAtMs ??
          child?.createdAt ??
          membership.createdAtMs ??
          null,
        isCurrentParentTurn: reference.parentTurnKey === currentParentTurnKey,
        canInteract: reference.canInteract,
        status,
        statusSummary: status === "active" ? resolveStatusSummary(child) : null,
        lastAssistantMessage: lastAssistantMessage?.text ?? null,
        lastAssistantMessageAtMs: lastAssistantMessage?.updatedAtMs ?? null,
        recencyAtMs,
        showInlineActivity:
          membership.showInlineActivity === true ||
          Boolean(membership.agentPath) ||
          (sourceOnly && hasModernActivity),
        diffStats: summarizeTurnDiff(child?.turns[child.turns.length - 1]?.diff),
        role: membership.role,
      },
    ];
  });
}
