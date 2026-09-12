import { projectAssistantText } from "./codex-canonical-item-projector";
import { projectCodexMarkdownToPlainText } from "./codex-markdown-text";
import type { ThreadStatus, Turn, ThreadItem } from "@nodex/codex-app-server-protocol/v2";
import { parseCodexHeartbeatAssistantMessage } from "./codex-turn-notification";

export interface ThreadPollTarget { readonly threadId: string; readonly hostId: string; readonly afterCursor?: string }
interface AssistantMessage { readonly id: string; readonly turnId: string; readonly phase: Extract<ThreadItem, { type: "agentMessage" }>["phase"]; readonly text: string; readonly truncated?: true; readonly originalChars?: number }
interface ToolMarker { readonly id: string; readonly turnId: string; readonly type: string; readonly name: string; readonly status: string | null }
interface Projection {
  readonly thread: { readonly id: string; readonly hostId: string; readonly status: ThreadStatus };
  readonly latestTurn: Pick<Turn, "id" | "status" | "startedAt" | "completedAt" | "durationMs"> & { readonly error: { readonly message: string } | null } | null;
  readonly latestAssistantMessage: AssistantMessage | null;
  readonly latestToolMarker: ToolMarker | null;
}
export interface ThreadPoll extends Projection {
  readonly schemaVersion: 1; readonly cursor: string; readonly revision: number; readonly changed: boolean; readonly cursorReset?: true;
  readonly latestAssistantMessageId: string | null; readonly latestToolMarkerId: string | null;
}
export type ThreadPollWake = { readonly reason: "turnCompleted"; readonly turnId: string } | { readonly reason: "inactiveStatus" | "actionableStatus" };
interface CacheEntry { readonly generation: string; readonly revision: number; readonly fingerprint: string; readonly ordinal: number; readonly projection: Projection }
const uuid7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
export function isNewerPollTurn(a: NonNullable<Projection["latestTurn"]>, b: NonNullable<Projection["latestTurn"]>): boolean {
  if (a.id === b.id) return false;
  if (a.startedAt !== null && b.startedAt !== null && a.startedAt !== b.startedAt) return a.startedAt > b.startedAt;
  return uuid7.test(a.id) && uuid7.test(b.id) && a.id.toLowerCase() > b.id.toLowerCase();
}
function assistant(turn: Turn | null): AssistantMessage | null {
  if (!turn) return null;
  const lastWork = turn.status === "inProgress" ? turn.items.findLastIndex((item) => item.type !== "userMessage" && item.type !== "hookPrompt") : -1;
  for (let index = turn.items.length - 1; index >= 0; index -= 1) {
    const item = turn.items[index];
    if (item?.type !== "agentMessage") continue;
    const content = projectAssistantText(item.text, index === lastWork);
    if (content === null || (index === lastWork && content.trimStart().startsWith("{"))) continue;
    const heartbeat = parseCodexHeartbeatAssistantMessage(content);
    const text = projectCodexMarkdownToPlainText(heartbeat ? heartbeat.visibleText || heartbeat.notificationMessage || "" : content);
    if (!text) continue;
    return { id: item.id, turnId: turn.id, phase: item.phase, text: text.slice(0, 2000), ...(text.length > 2000 ? { truncated: true, originalChars: text.length } : {}) };
  }
  return null;
}
function tool(turn: Turn | null): ToolMarker | null {
  if (!turn) return null;
  for (let index = turn.items.length - 1; index >= 0; index -= 1) {
    const item = turn.items[index]!;
    switch (item.type) {
      case "commandExecution": case "fileChange": case "imageGeneration": return { id: item.id, turnId: turn.id, type: item.type, name: item.type, status: item.status };
      case "collabAgentToolCall": case "dynamicToolCall": case "mcpToolCall": return { id: item.id, turnId: turn.id, type: item.type, name: item.tool, status: item.status };
      case "sleep": case "webSearch": return { id: item.id, turnId: turn.id, type: item.type, name: item.type, status: null };
    }
  }
  return null;
}
function cursorRevision(cursor: string | undefined, generation: string): number | null {
  const prefix = `${generation}:`;
  if (!cursor?.startsWith(prefix)) return null;
  const suffix = cursor.slice(prefix.length);
  if (!/^\d+$/u.test(suffix)) return null;
  const revision = Number(suffix);
  return Number.isSafeInteger(revision) && revision > 0 ? revision : null;
}

/** Compact polling has its own cursor lifetime; commentary updates do not wake waiting callers. */
export class ThreadPollCache {
  private readonly entries = new Map<string, CacheEntry>();
  private ordinal = 0;
  constructor(private readonly generation: () => string = () => crypto.randomUUID()) {}
  beginRead(): number { return ++this.ordinal; }
  read(target: ThreadPollTarget): Projection | undefined { return this.entries.get(JSON.stringify([target.hostId, target.threadId]))?.projection; }
  unchangedStatus(target: ThreadPollTarget): ThreadStatus | null {
    const entry = this.entries.get(JSON.stringify([target.hostId, target.threadId]));
    return entry && cursorRevision(target.afterCursor, entry.generation) === entry.revision ? entry.projection.thread.status : null;
  }
  commit(target: ThreadPollTarget, status: ThreadStatus, turn: Turn | null, ordinal: number, preserveMissingItems = false): ThreadPoll {
    const prior = this.read(target);
    return this.commitProjection(target, { thread: { id: target.threadId, hostId: target.hostId, status }, latestTurn: turn ? { id: turn.id, status: turn.status, error: turn.error ? { message: turn.error.message.slice(0, 2000) } : null, startedAt: turn.startedAt, completedAt: turn.completedAt, durationMs: turn.durationMs } : null, latestAssistantMessage: assistant(turn) ?? (preserveMissingItems && turn && prior?.latestTurn?.id === turn.id ? prior.latestAssistantMessage : null), latestToolMarker: tool(turn) ?? (preserveMissingItems && turn && prior?.latestTurn?.id === turn.id ? prior.latestToolMarker : null) }, ordinal);
  }
  fallback(target: ThreadPollTarget, completed: Turn | null, status: ThreadStatus | null): ThreadPoll | null {
    const prior = this.read(target);
    if (!prior && !completed) return null;
    if (completed) return this.commit(target, status?.type === "active" && status.activeFlags.length > 0 ? status : { type: "idle" }, completed, this.beginRead(), true);
    return this.commitProjection(target, { ...prior!, thread: { id: target.threadId, hostId: target.hostId, status: status ?? prior!.thread.status } }, this.beginRead());
  }
  withProgress(poll: ThreadPoll): ThreadPoll {
    const current = this.read({ hostId: poll.thread.hostId, threadId: poll.thread.id });
    return { ...poll, latestAssistantMessage: current?.latestAssistantMessage ?? poll.latestAssistantMessage, latestToolMarker: current?.latestToolMarker ?? poll.latestToolMarker };
  }
  private commitProjection(target: ThreadPollTarget, candidate: Projection, ordinal: number): ThreadPoll {
    const key = JSON.stringify([target.hostId, target.threadId]);
    const previous = this.entries.get(key);
    if (previous && ordinal < previous.ordinal) return this.project(previous, target.afterCursor);
    let projection = candidate;
    const priorTurn = previous?.projection.latestTurn;
    const turn = candidate.latestTurn;
    const oldMessage = previous?.projection.latestAssistantMessage;
    const message = candidate.latestAssistantMessage;
    if (previous && priorTurn && (!turn || isNewerPollTurn(priorTurn, turn) || (priorTurn.id === turn.id && priorTurn.status !== "inProgress" && turn.status === "inProgress"))) projection = { ...previous.projection, thread: candidate.thread };
    else if (turn?.status === "inProgress" && oldMessage && message && oldMessage.id === message.id && oldMessage.text.length > message.text.length) projection = { ...candidate, latestAssistantMessage: oldMessage };
    const fingerprint = JSON.stringify({ status: projection.thread.status, turnId: projection.latestTurn?.id ?? null, turnStatus: projection.latestTurn?.status ?? null, turnError: projection.latestTurn?.error?.message ?? null, assistant: projection.latestAssistantMessage, tool: projection.latestToolMarker });
    const entry = { generation: previous?.generation ?? this.generation(), revision: previous ? previous.revision + Number(previous.fingerprint !== fingerprint) : 1, fingerprint, ordinal, projection };
    this.entries.delete(key); this.entries.set(key, entry);
    if (this.entries.size > 256) this.entries.delete(this.entries.keys().next().value!);
    return this.project(entry, target.afterCursor);
  }
  private project(entry: CacheEntry, cursor: string | undefined): ThreadPoll {
    const revision = cursorRevision(cursor, entry.generation);
    const reset = cursor !== undefined && (revision === null || revision > entry.revision);
    const changed = reset || revision !== entry.revision;
    return { ...entry.projection, schemaVersion: 1, cursor: `${entry.generation}:${entry.revision}`, revision: entry.revision, changed, ...(reset ? { cursorReset: true } : {}), latestAssistantMessageId: entry.projection.latestAssistantMessage?.id ?? null, latestToolMarkerId: entry.projection.latestToolMarker?.id ?? null, latestAssistantMessage: changed ? entry.projection.latestAssistantMessage : null, latestToolMarker: changed ? entry.projection.latestToolMarker : null };
  }
}
export function statusPollWake(status: ThreadStatus): ThreadPollWake | null {
  if (status.type === "systemError" || status.type === "notLoaded") return { reason: "inactiveStatus" };
  if (status.type === "active" && status.activeFlags.length) return { reason: "actionableStatus" };
  return null;
}
export function unchangedTerminalPoll(poll: ThreadPoll): boolean { return !poll.changed && poll.thread.status.type === "idle" && poll.latestTurn !== null && poll.latestTurn.status !== "inProgress"; }
export function pollWake(poll: ThreadPoll): ThreadPollWake | null {
  const status = statusPollWake(poll.thread.status);
  if (status) return status.reason === "actionableStatus" && !poll.changed ? null : status;
  if (poll.thread.status.type !== "idle") return null;
  if (!poll.latestTurn) return { reason: "inactiveStatus" };
  return poll.latestTurn.status === "inProgress" || unchangedTerminalPoll(poll) ? null : { reason: "turnCompleted", turnId: poll.latestTurn.id };
}
