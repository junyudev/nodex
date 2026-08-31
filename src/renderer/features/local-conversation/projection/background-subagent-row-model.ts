import type {
  CodexConversationChildMembership,
  CodexConversationItem,
  CodexConversationSnapshot,
  CodexConversationTurn,
  CodexThreadStatusType,
} from "../../../lib/types";
import type {
  CodexMultiAgentActionName,
  CodexMultiAgentAgentState,
  CodexMultiAgentAgentStatus,
  CodexMultiAgentReceiverThread,
} from "../../../../shared/codex-transcript-special-items";
import { normalizeMultiAgentActionPayload } from "../../../../shared/codex-transcript-special-items";
import type { ThreadComposerShellBackgroundAgentRowModel } from "../thread-stage-types";

type NormalizedAgentStatus = "active" | "waiting" | "done" | "hidden" | "unknown";
type ChildProgressStatus = "inProgress" | "notInProgress" | "unknown";

interface LatestReference {
  tool: CodexMultiAgentActionName;
  parentTurnKey: string;
  thread: CodexMultiAgentReceiverThread["thread"];
  agentState: CodexMultiAgentAgentState | null;
  spawnModel: string | null;
  usesThreadStatus: boolean;
  inlineDisplayName: string | null;
  showInlineActivity: boolean;
}

interface LastAssistantMessage {
  text: string;
  updatedAtMs: number;
}

export interface BuildBackgroundSubagentRowsInput {
  childMemberships: readonly CodexConversationChildMembership[];
  parentTurns: readonly CodexConversationTurn[];
  knownConversationsById: Record<string, CodexConversationSnapshot>;
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

function getInProgressParentTurnKeys(parentTurns: readonly CodexConversationTurn[]): Set<string> {
  const keys = new Set<string>();
  parentTurns.forEach((turn, index) => {
    if (turn.status === "inProgress") keys.add(getParentTurnKey(turn, index));
  });
  return keys;
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

function resolveChildProgress(child: CodexConversationSnapshot | null): ChildProgressStatus {
  if (child?.threadRuntimeStatus?.type === "active") return "inProgress";
  if (child?.threadRuntimeStatus && child.threadRuntimeStatus.type !== "notLoaded") {
    return "notInProgress";
  }
  if (!child || child.turns.length === 0) return "unknown";
  return child.turns[child.turns.length - 1]?.status === "inProgress"
    ? "inProgress"
    : "notInProgress";
}

function resolveVisibleStatus(input: {
  reference: LatestReference;
  childProgress: ChildProgressStatus;
  currentParentTurnKey: string;
  inProgressParentTurnKeys: Set<string>;
}): ThreadComposerShellBackgroundAgentRowModel["status"] | null {
  const normalized = normalizeAgentStatus(input.reference.agentState?.status);
  if (input.reference.tool === "closeAgent" || normalized === "hidden") return null;

  const parentInProgress = input.inProgressParentTurnKeys.has(input.reference.parentTurnKey);
  const isCurrentParentTurn = input.reference.parentTurnKey === input.currentParentTurnKey;
  if (
    input.childProgress === "inProgress" ||
    (input.reference.usesThreadStatus && normalized === "active") ||
    (!input.reference.usesThreadStatus && normalized === "active" && parentInProgress) ||
    (normalized === "unknown" && isCurrentParentTurn && parentInProgress)
  ) {
    return "active";
  }

  if (normalized === "waiting" && input.childProgress === "unknown") return "waiting";
  if (input.childProgress === "unknown" && parentInProgress && normalized !== "done") {
    return "waiting";
  }
  if (
    normalized === "done" ||
    input.childProgress === "notInProgress" ||
    (!input.reference.usesThreadStatus && normalized === "active" && !parentInProgress)
  ) {
    return "done";
  }

  return null;
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
          tool: previous?.tool ?? "spawnAgent",
          parentTurnKey,
          thread: previous?.thread ?? null,
          agentState: previous?.agentState ?? null,
          spawnModel: previous?.spawnModel ?? null,
          usesThreadStatus: true,
          inlineDisplayName: activity.displayName ?? previous?.inlineDisplayName ?? null,
          showInlineActivity: true,
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
          tool: payload.action === "wait" ? (previous?.tool ?? payload.action) : payload.action,
          parentTurnKey,
          thread: receiverThreads.get(receiverThreadId) ?? previous?.thread ?? null,
          agentState: payload.agentsStates[receiverThreadId] ?? previous?.agentState ?? null,
          spawnModel:
            payload.action === "spawnAgent"
              ? (payload.model ?? previous?.spawnModel ?? null)
              : (previous?.spawnModel ?? null),
          usesThreadStatus: previous?.usesThreadStatus ?? false,
          inlineDisplayName: previous?.inlineDisplayName ?? null,
          showInlineActivity: previous?.showInlineActivity ?? false,
        });
      }
    }
  });

  return latest;
}

function buildFallbackReference(
  membership: CodexConversationChildMembership,
  parentTurns: readonly CodexConversationTurn[],
  child: CodexConversationSnapshot | null,
): LatestReference {
  const statusType = child?.statusType ?? membership.statusType ?? "notLoaded";
  return {
    tool: "spawnAgent",
    parentTurnKey: getParentTurnKeyForCreatedAt(
      parentTurns,
      child?.createdAt ?? membership.createdAtMs ?? null,
    ),
    thread: null,
    agentState: {
      status: mapThreadStatusToAgentStatus(statusType),
      message: null,
    },
    spawnModel: null,
    usesThreadStatus: true,
    inlineDisplayName: null,
    showInlineActivity: membership.showInlineActivity === true || Boolean(membership.agentPath),
  };
}

function resolveDisplayName(input: {
  membership: CodexConversationChildMembership;
  reference: LatestReference;
  child: CodexConversationSnapshot | null;
}): string {
  const displayName =
    normalizeOptionalText(input.membership.displayName) ??
    normalizeOptionalText(input.reference.inlineDisplayName) ??
    resolveThreadDisplayName(input.reference.thread) ??
    resolveThreadDisplayName(input.membership.thread) ??
    normalizeOptionalText(input.child?.agentNickname) ??
    input.membership.threadId;
  return stripLeadingAt(displayName);
}

function resolveAgentRole(input: {
  membership: CodexConversationChildMembership;
  reference: LatestReference;
  child: CodexConversationSnapshot | null;
}): string | null {
  const role =
    normalizeOptionalText(input.reference.thread?.agentRole) ??
    normalizeOptionalText(input.membership.thread?.agentRole) ??
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

function resolveStatusSummary(child: CodexConversationSnapshot | null): string | null {
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
  child: CodexConversationSnapshot | null,
): LastAssistantMessage | null {
  if (!child) return null;
  for (let turnIndex = child.turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const items = child.turns[turnIndex]?.items ?? [];
    for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const item = items[itemIndex];
      if (!item || !isAssistantMessage(item)) continue;
      const text = normalizeOptionalText(item.markdownText);
      if (!text) continue;
      return { text, updatedAtMs: item.updatedAt };
    }
  }
  return null;
}

function summarizeTurnDiff(
  diff: string | null | undefined,
): ThreadComposerShellBackgroundAgentRowModel["diffStats"] {
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
): ThreadComposerShellBackgroundAgentRowModel[] {
  const references = buildLatestReferenceMap(input);
  const currentParentTurnKey = getLatestParentTurnKey(input.parentTurns);
  const inProgressParentTurnKeys = getInProgressParentTurnKeys(input.parentTurns);

  return input.childMemberships
    .flatMap((membership) => {
      const child = input.knownConversationsById[membership.threadId] ?? null;
      if (child?.archived) return [];

      const reference =
        references.get(membership.threadId) ??
        buildFallbackReference(membership, input.parentTurns, child);
      const status = resolveVisibleStatus({
        reference,
        childProgress: resolveChildProgress(child),
        currentParentTurnKey,
        inProgressParentTurnKeys,
      });
      if (!status) return [];

      const displayName = resolveDisplayName({ membership, reference, child });
      const lastAssistantMessage = resolveLastAssistantMessage(child);
      const recencyAtMs =
        lastAssistantMessage?.updatedAtMs ??
        Math.max(
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
          status,
          statusSummary: status === "active" ? resolveStatusSummary(child) : null,
          lastAssistantMessage: lastAssistantMessage?.text ?? null,
          lastAssistantMessageAtMs: lastAssistantMessage?.updatedAtMs ?? null,
          recencyAtMs,
          showInlineActivity:
            membership.showInlineActivity === true ||
            Boolean(membership.agentPath) ||
            reference.showInlineActivity,
          diffStats: summarizeTurnDiff(child?.turns[child.turns.length - 1]?.diff),
          role: membership.role,
        },
      ];
    })
    .sort((left, right) => right.recencyAtMs - left.recencyAtMs);
}
