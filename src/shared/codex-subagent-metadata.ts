import type { CodexCanonicalTurnState } from "./types";

/** Resident references help locate children; they do not control Thread interaction. */
export function collectCodexSubagentThreadIds(
  turns: readonly Pick<CodexCanonicalTurnState, "items">[],
): ReadonlySet<string> {
  const threadIds = new Set<string>();
  for (const turn of turns) {
    for (const item of turn.items) {
      if (item.type === "subAgentActivity") threadIds.add(item.agentThreadId);
      if (item.type !== "collabAgentToolCall") continue;
      for (const threadId of item.receiverThreadIds) threadIds.add(threadId);
    }
  }
  return threadIds;
}

export interface CodexThreadSpawnMetadata {
  parentThreadId: string | null;
  depth: number | null;
  agentPath: string | null;
  agentNickname: string | null;
  agentRole: string | null;
  hasParentThreadId: boolean;
  hasAgentNickname: boolean;
  hasAgentRole: boolean;
  hasAgentPath: boolean;
}

export interface CodexThreadSubagentMetadata extends CodexThreadSpawnMetadata {
  hasAnySubagentSource: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function normalizeOptionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeOptionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getOptionalTextField(record: Record<string, unknown>, key: string): string | null {
  return normalizeOptionalText(record[key]);
}

function getOptionalTextFieldPair(
  record: Record<string, unknown>,
  camelKey: string,
  snakeKey: string,
): { value: string | null; present: boolean } {
  if (hasOwn(record, camelKey)) {
    return {
      value: getOptionalTextField(record, camelKey),
      present: true,
    };
  }

  if (hasOwn(record, snakeKey)) {
    return {
      value: getOptionalTextField(record, snakeKey),
      present: true,
    };
  }

  return {
    value: null,
    present: false,
  };
}

function getSubagentSourceRecord(source: unknown): {
  record: Record<string, unknown> | null;
  found: boolean;
} {
  const sourceRecord = asRecord(source);
  if (!sourceRecord) return { record: null, found: false };

  if (hasOwn(sourceRecord, "subAgent")) {
    return {
      record: asRecord(sourceRecord.subAgent),
      found: true,
    };
  }

  if (hasOwn(sourceRecord, "subagent")) {
    return {
      record: asRecord(sourceRecord.subagent),
      found: true,
    };
  }

  return {
    record: sourceRecord,
    found: false,
  };
}

export function hasCodexSubagentSource(source: unknown): boolean {
  return getSubagentSourceRecord(source).found;
}

export function getCodexSubagentOtherSource(source: unknown): string | null {
  const subagentSource = getSubagentSourceRecord(source);
  if (!subagentSource.found) return null;
  return normalizeOptionalText(subagentSource.record?.other);
}

export function extractCodexThreadSpawnMetadata(source: unknown): CodexThreadSpawnMetadata {
  const subagentSource = getSubagentSourceRecord(source);
  const threadSpawn = asRecord(subagentSource.record?.thread_spawn);
  if (!threadSpawn) {
    return {
      parentThreadId: null,
      depth: null,
      agentPath: null,
      agentNickname: null,
      agentRole: null,
      hasParentThreadId: false,
      hasAgentNickname: false,
      hasAgentRole: false,
      hasAgentPath: false,
    };
  }

  const parentThreadId = getOptionalTextField(threadSpawn, "parent_thread_id");
  const nickname = getOptionalTextFieldPair(threadSpawn, "agentNickname", "agent_nickname");
  const role = getOptionalTextFieldPair(threadSpawn, "agentRole", "agent_role");
  const path = getOptionalTextFieldPair(threadSpawn, "agentPath", "agent_path");

  return {
    parentThreadId,
    depth: normalizeOptionalNumber(threadSpawn.depth),
    agentPath: path.value,
    agentNickname: nickname.value,
    agentRole: role.value,
    hasParentThreadId: hasOwn(threadSpawn, "parent_thread_id"),
    hasAgentNickname: nickname.present,
    hasAgentRole: role.present,
    hasAgentPath: path.present,
  };
}

export function extractCodexThreadSubagentMetadata(thread: unknown): CodexThreadSubagentMetadata {
  const threadRecord = asRecord(thread);
  if (!threadRecord) {
    return {
      ...extractCodexThreadSpawnMetadata(null),
      hasAnySubagentSource: false,
    };
  }

  const source = extractCodexThreadSpawnMetadata(threadRecord.source);
  const parent = getOptionalTextFieldPair(threadRecord, "parentThreadId", "parent_thread_id");
  const nickname = getOptionalTextFieldPair(threadRecord, "agentNickname", "agent_nickname");
  const role = getOptionalTextFieldPair(threadRecord, "agentRole", "agent_role");

  return {
    parentThreadId: parent.value ?? source.parentThreadId,
    depth: source.depth,
    agentPath: source.agentPath,
    agentNickname: nickname.value ?? source.agentNickname,
    agentRole: role.value ?? source.agentRole,
    hasParentThreadId: parent.present || source.hasParentThreadId,
    hasAgentNickname: nickname.present || source.hasAgentNickname,
    hasAgentRole: role.present || source.hasAgentRole,
    hasAgentPath: source.hasAgentPath,
    hasAnySubagentSource:
      source.hasParentThreadId || source.hasAgentNickname || source.hasAgentRole,
  };
}
