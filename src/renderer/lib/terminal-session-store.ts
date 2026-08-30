import { useSyncExternalStore } from "react";
import type {
  TerminalAttachRequest,
  TerminalAttachedEvent,
  TerminalCreateRequest,
  TerminalDataEvent,
  TerminalErrorEvent,
  TerminalExitEvent,
  TerminalInitLogEvent,
  TerminalRunActionRequest,
  TerminalSessionSnapshot,
  TerminalSize,
  TerminalTakeOverViewRequest,
  TerminalViewLeaseResult,
  TerminalViewLeaseRevokedEvent,
} from "../../shared/types";
import { appendTextTail } from "../../shared/bounded-text";
import {
  defineRendererCommand,
  invokePlainCommand,
  invokeRendererControl,
  invokeRendererQuery,
} from "./renderer-command";

export const TERMINAL_RENDERER_BUFFER_LIMIT = 16_000;

const createTerminalCommand = defineRendererCommand({
  key: "terminal.create",
  channel: "terminal-create",
  authority: "main",
  owner: "TerminalSessionStore",
  protocol: { kind: "returned_value" },
});

const runTerminalActionCommand = defineRendererCommand({
  key: "terminal.run_action",
  channel: "terminal-run-action",
  authority: "main",
  owner: "TerminalSessionStore",
  protocol: { kind: "pending_operation" },
});

const killTerminalCommand = defineRendererCommand({
  key: "terminal.kill",
  channel: "terminal-kill",
  authority: "main",
  owner: "TerminalSessionStore",
  protocol: { kind: "pending_operation" },
});

export type TerminalStoreEvent =
  | { type: "data"; sessionId: string; data: string }
  | { type: "init-log"; sessionId: string; data: string; snapshot: TerminalSessionSnapshot }
  | { type: "attached"; sessionId: string; snapshot: TerminalSessionSnapshot }
  | { type: "error"; sessionId: string; message: string }
  | {
      type: "lease-conflict";
      sessionId: string;
      generation: number;
      ownerWindowSessionId: string;
    }
  | { type: "lease-acquired"; sessionId: string; generation: number }
  | {
      type: "exit";
      sessionId: string;
      exitCode: number | null;
      reason: "exited" | "killed";
    };

type TerminalStoreListener = (event: TerminalStoreEvent) => void;
type TerminalExitListener = (event: { sessionId: string; exitCode: number | null }) => void;
type StoreVersionListener = () => void;

interface RendererTerminalRecord {
  snapshot: TerminalSessionSnapshot;
  attached: boolean;
  error: string | null;
  pendingWrites: string[];
  lastResize: TerminalSize | null;
  leaseConflict: {
    generation: number;
    ownerWindowSessionId: string;
  } | null;
}

function createEmptySnapshot(sessionId: string): TerminalSessionSnapshot {
  return {
    sessionId,
    conversationId: null,
    projectSessionId: null,
    osPid: null,
    cpuPercent: null,
    rssKb: null,
    childProcessCount: null,
    processMetricsSampledAtMs: null,
    cwd: null,
    shell: null,
    title: null,
    backendKind: "local",
    buffer: "",
    truncated: false,
    exited: false,
    exitCode: null,
    viewLease: null,
  };
}

function appendBoundedBuffer(
  current: string,
  incoming: string,
): { buffer: string; truncated: boolean } {
  const next = appendTextTail({
    current,
    delta: incoming,
    maxChars: TERMINAL_RENDERER_BUFFER_LIMIT,
  });
  return {
    buffer: next.text,
    truncated: next.didTruncate,
  };
}

function getPathBasename(pathname: string | null): string | null {
  const trimmed = pathname?.trim();
  if (!trimmed) return null;

  const normalized = trimmed.replace(/[\\/]+$/, "");
  const index = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  const basename = index >= 0 ? normalized.slice(index + 1) : normalized;
  return basename.length > 0 ? basename : null;
}

function hasApi(): boolean {
  return typeof window !== "undefined" && Boolean(window.api);
}

export class TerminalSessionStore {
  private readonly records = new Map<string, RendererTerminalRecord>();
  private readonly listenersBySession = new Map<string, Set<TerminalStoreListener>>();
  private readonly exitListeners = new Set<TerminalExitListener>();
  private readonly versionListeners = new Set<StoreVersionListener>();
  private readonly closingSessionIds = new Set<string>();
  private eventUnsubscribers: Array<() => void> = [];
  private eventSubscriptionsReady = false;
  private version = 0;

  ensureEventSubscriptions(): void {
    if (this.eventSubscriptionsReady || !hasApi()) return;
    this.eventSubscriptionsReady = true;

    this.eventUnsubscribers = [
      window.api!.on("terminal-data", (payload) => {
        this.handleData(payload as TerminalDataEvent);
      }),
      window.api!.on("terminal-init-log", (payload) => {
        this.handleInitLog(payload as TerminalInitLogEvent);
      }),
      window.api!.on("terminal-attached", (payload) => {
        this.handleAttached(payload as TerminalAttachedEvent);
      }),
      window.api!.on("terminal-error", (payload) => {
        this.handleError(payload as TerminalErrorEvent);
      }),
      window.api!.on("terminal-exit", (payload) => {
        this.handleExit(payload as TerminalExitEvent);
      }),
      window.api!.on("terminal-view-lease-revoked", (payload) => {
        this.handleLeaseRevoked(payload as TerminalViewLeaseRevokedEvent);
      }),
    ];
  }

  disposeEventSubscriptions(): void {
    for (const unsubscribe of this.eventUnsubscribers) {
      unsubscribe();
    }
    this.eventUnsubscribers = [];
    this.eventSubscriptionsReady = false;
  }

  getSnapshot(sessionId: string): TerminalSessionSnapshot {
    return this.getRecord(sessionId).snapshot;
  }

  getError(sessionId: string): string | null {
    return this.getRecord(sessionId).error;
  }

  getLeaseConflict(sessionId: string): {
    generation: number;
    ownerWindowSessionId: string;
  } | null {
    return this.getRecord(sessionId).leaseConflict;
  }

  getVersion(): number {
    return this.version;
  }

  subscribeAll(listener: StoreVersionListener): () => void {
    this.versionListeners.add(listener);
    return () => {
      this.versionListeners.delete(listener);
    };
  }

  subscribe(sessionId: string, listener: TerminalStoreListener): () => void {
    const listeners = this.listenersBySession.get(sessionId) ?? new Set<TerminalStoreListener>();
    listeners.add(listener);
    this.listenersBySession.set(sessionId, listeners);

    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.listenersBySession.delete(sessionId);
      }
    };
  }

  subscribeExit(listener: TerminalExitListener): () => void {
    this.exitListeners.add(listener);
    return () => {
      this.exitListeners.delete(listener);
    };
  }

  async createOrAttach(input: TerminalCreateRequest): Promise<TerminalViewLeaseResult | null> {
    this.closingSessionIds.delete(input.sessionId);
    this.ensureEventSubscriptions();
    this.mergeSnapshot(input.sessionId, {
      conversationId: input.conversationId ?? null,
      projectSessionId: input.projectSessionId ?? null,
      cwd: input.cwd ?? null,
      title: input.title ?? null,
      backendKind: input.backendKind ?? "local",
    });

    if (!hasApi()) return null;
    const result = await invokePlainCommand(createTerminalCommand, input);
    this.applyLeaseResult(input.sessionId, result);
    return result;
  }

  async attach(input: TerminalAttachRequest): Promise<TerminalViewLeaseResult | null> {
    this.closingSessionIds.delete(input.sessionId);
    this.ensureEventSubscriptions();
    this.mergeSnapshot(input.sessionId, {
      conversationId: input.conversationId ?? null,
      projectSessionId: input.projectSessionId ?? null,
      cwd: input.cwd ?? null,
    });

    if (!hasApi()) return null;
    const result = await invokeRendererControl("terminal-acquire-view", input);
    this.applyLeaseResult(input.sessionId, result);
    return result;
  }

  async takeOver(input: TerminalTakeOverViewRequest): Promise<TerminalViewLeaseResult | null> {
    this.ensureEventSubscriptions();
    if (!hasApi()) return null;
    const result = await invokeRendererControl("terminal-take-over-view", input);
    this.applyLeaseResult(input.sessionId, result);
    return result;
  }

  async runAction(input: TerminalRunActionRequest): Promise<void> {
    this.closingSessionIds.delete(input.sessionId);
    this.ensureEventSubscriptions();
    this.mergeSnapshot(input.sessionId, {
      conversationId: input.conversationId ?? null,
      projectSessionId: input.projectSessionId ?? null,
      cwd: input.cwd ?? null,
      title: input.title ?? null,
    });

    if (!hasApi()) return;
    await invokePlainCommand(runTerminalActionCommand, input);
  }

  async fetchSnapshot(sessionId: string): Promise<TerminalSessionSnapshot | null> {
    this.ensureEventSubscriptions();
    if (!hasApi()) return null;

    const snapshot = await invokeRendererQuery("terminal-session:snapshot", sessionId);
    if (!snapshot) return null;

    this.mergeSnapshot(sessionId, snapshot);
    return snapshot;
  }

  write(sessionId: string, data: string): void {
    const record = this.getRecord(sessionId);
    if (!record.attached) {
      record.pendingWrites.push(data);
      return;
    }

    if (!hasApi()) return;
    void invokeRendererControl("terminal-write", sessionId, data);
  }

  resize(sessionId: string, size: TerminalSize): void {
    const record = this.getRecord(sessionId);
    const cols = Math.max(2, Math.floor(size.cols));
    const rows = Math.max(1, Math.floor(size.rows));
    const previous = record.lastResize;
    if (previous?.cols === cols && previous.rows === rows) return;

    record.lastResize = { cols, rows };
    if (!hasApi()) return;
    void invokeRendererControl("terminal-resize", sessionId, { cols, rows });
  }

  release(sessionId: string): void {
    if (this.closingSessionIds.has(sessionId)) return;
    this.closingSessionIds.add(sessionId);
    if (hasApi()) {
      void invokeRendererControl("terminal-release-view", sessionId);
    }
    this.records.delete(sessionId);
    this.emitVersionChanged();
  }

  kill(sessionId: string): void {
    if (!hasApi()) return;
    void invokePlainCommand(killTerminalCommand, sessionId);
  }

  resolveTitle(sessionId: string, fallbackTitle: string | null | undefined, index: number): string {
    const snapshot = this.getSnapshot(sessionId);
    const fixedTitle = snapshot.title?.trim();
    if (fixedTitle) return fixedTitle;

    const cwdTitle = getPathBasename(snapshot.cwd);
    if (cwdTitle) return cwdTitle;

    const fallback = fallbackTitle?.trim();
    if (fallback && fallback !== "Terminal") return fallback;
    return `Terminal ${index}`;
  }

  private getRecord(sessionId: string): RendererTerminalRecord {
    const existing = this.records.get(sessionId);
    if (existing) return existing;

    const record: RendererTerminalRecord = {
      snapshot: createEmptySnapshot(sessionId),
      attached: false,
      error: null,
      pendingWrites: [],
      lastResize: null,
      leaseConflict: null,
    };
    this.records.set(sessionId, record);
    return record;
  }

  private mergeSnapshot(sessionId: string, partial: Partial<TerminalSessionSnapshot>): void {
    const record = this.getRecord(sessionId);
    record.snapshot = { ...record.snapshot, ...partial, sessionId };
    this.emitVersionChanged();
  }

  private handleData(payload: TerminalDataEvent): void {
    const record = this.getRecord(payload.sessionId);
    const nextBuffer = appendBoundedBuffer(record.snapshot.buffer, payload.data);
    record.snapshot = {
      ...record.snapshot,
      buffer: nextBuffer.buffer,
      truncated: record.snapshot.truncated || nextBuffer.truncated,
    };
    this.emitSession(payload.sessionId, {
      type: "data",
      sessionId: payload.sessionId,
      data: payload.data,
    });
  }

  private handleInitLog(payload: TerminalInitLogEvent): void {
    const record = this.getRecord(payload.sessionId);
    record.snapshot = payload.snapshot;
    record.error = null;
    this.emitSession(payload.sessionId, {
      type: "init-log",
      sessionId: payload.sessionId,
      data: payload.data,
      snapshot: payload.snapshot,
    });
    this.emitVersionChanged();
  }

  private handleAttached(payload: TerminalAttachedEvent): void {
    const record = this.getRecord(payload.sessionId);
    record.snapshot = payload.snapshot;
    record.attached = true;
    record.error = null;
    record.leaseConflict = null;
    this.flushPendingWrites(payload.sessionId, record);
    this.emitSession(payload.sessionId, {
      type: "attached",
      sessionId: payload.sessionId,
      snapshot: payload.snapshot,
    });
    this.emitVersionChanged();
  }

  private handleError(payload: TerminalErrorEvent): void {
    const record = this.getRecord(payload.sessionId);
    record.error = payload.message;
    this.emitSession(payload.sessionId, {
      type: "error",
      sessionId: payload.sessionId,
      message: payload.message,
    });
    this.emitVersionChanged();
  }

  private handleExit(payload: TerminalExitEvent): void {
    const record = this.getRecord(payload.sessionId);
    record.attached = false;
    record.snapshot = {
      ...record.snapshot,
      exited: true,
      exitCode: payload.exitCode,
    };
    this.emitSession(payload.sessionId, {
      type: "exit",
      sessionId: payload.sessionId,
      exitCode: payload.exitCode,
      reason: payload.reason,
    });
    this.records.delete(payload.sessionId);
    this.emitExit(payload);
    this.emitVersionChanged();
  }

  private handleLeaseRevoked(payload: TerminalViewLeaseRevokedEvent): void {
    const record = this.getRecord(payload.sessionId);
    record.attached = false;
    record.snapshot = {
      ...record.snapshot,
      viewLease: {
        windowSessionId: payload.ownerWindowSessionId,
        generation: payload.generation,
        size: record.snapshot.viewLease?.size ?? { cols: 80, rows: 24 },
      },
    };
    record.leaseConflict = {
      generation: payload.generation,
      ownerWindowSessionId: payload.ownerWindowSessionId,
    };
    this.emitSession(payload.sessionId, {
      type: "lease-conflict",
      sessionId: payload.sessionId,
      generation: payload.generation,
      ownerWindowSessionId: payload.ownerWindowSessionId,
    });
    this.emitVersionChanged();
  }

  private applyLeaseResult(sessionId: string, result: TerminalViewLeaseResult): void {
    const record = this.getRecord(sessionId);
    if (result.status === "not_found") {
      record.attached = false;
      record.error = "Terminal session does not exist.";
      this.emitVersionChanged();
      return;
    }
    record.snapshot = result.snapshot;
    if (result.status === "conflict" || result.status === "stale") {
      record.attached = false;
      record.leaseConflict = {
        generation: result.generation,
        ownerWindowSessionId: result.ownerWindowSessionId,
      };
      this.emitSession(sessionId, {
        type: "lease-conflict",
        sessionId,
        generation: result.generation,
        ownerWindowSessionId: result.ownerWindowSessionId,
      });
      this.emitVersionChanged();
      return;
    }
    record.attached = true;
    record.error = null;
    record.leaseConflict = null;
    this.emitSession(sessionId, {
      type: "lease-acquired",
      sessionId,
      generation: result.generation,
    });
    this.flushPendingWrites(sessionId, record);
    this.emitVersionChanged();
  }

  private flushPendingWrites(sessionId: string, record: RendererTerminalRecord): void {
    if (!hasApi() || record.pendingWrites.length === 0) return;

    const pendingWrites = record.pendingWrites.splice(0);
    for (const data of pendingWrites) {
      void invokeRendererControl("terminal-write", sessionId, data);
    }
  }

  private emitSession(sessionId: string, event: TerminalStoreEvent): void {
    const listeners = this.listenersBySession.get(sessionId);
    if (!listeners) return;

    for (const listener of listeners) {
      listener(event);
    }
  }

  private emitExit(event: { sessionId: string; exitCode: number | null }): void {
    for (const listener of this.exitListeners) {
      listener(event);
    }
  }

  private emitVersionChanged(): void {
    this.version += 1;
    for (const listener of this.versionListeners) {
      listener();
    }
  }
}

export const terminalSessionStore = new TerminalSessionStore();

export function isTerminalRuntimeAvailable(): boolean {
  return hasApi();
}

export function useTerminalSessionStoreVersion(): number {
  return useSyncExternalStore(
    (listener) => terminalSessionStore.subscribeAll(listener),
    () => terminalSessionStore.getVersion(),
    () => 0,
  );
}
