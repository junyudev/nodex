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
import type { AlternateScreenMode, TerminalRenderer } from "./terminal-renderer";
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
interface TerminalRegistration {
  onAttach?: (cwd: string | null, shell: string | null) => void;
  onDetach?: () => void;
}

export type TerminalWriteSource = "user" | "terminal-generated";
type TerminalExitListener = (event: { sessionId: string; exitCode: number | null }) => void;
type StoreVersionListener = () => void;

interface RendererTerminalRecord {
  snapshot: TerminalSessionSnapshot;
  attached: boolean;
  leaseRequest: number;
  replayBuffer: string | null;
  clearOffsets: number[];
  alternateMode: AlternateScreenMode | null;
  partialDecMode: string | undefined;
  interacted: boolean;
  fixedTitle: string | null;
  rawShellTitle: string | null;
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
    buffer:
      Math.max(incoming.length, current.length) > TERMINAL_RENDERER_BUFFER_LIMIT * 2
        ? structuredClone(next.text)
        : next.text,
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

function stripControls(text: string): string {
  return text.replace(/[\u0000-\u001F\u007F]/g, "").trim();
}

function deriveTitle(raw: string, cwd: string | null): string | null {
  const title = stripControls(raw);
  if (!title) return null;
  const path = stripControls(cwd ?? "");
  if (!path) return title;
  const base = getPathBasename(path);
  if (title === path || title === base) return null;
  for (const separator of [": ", " — ", " - ", " | "]) {
    if (title.startsWith(path + separator))
      return title.slice(path.length + separator.length).trim();
    if (base && title.startsWith(base + separator))
      return title.slice(base.length + separator.length).trim();
  }
  return title;
}

const DEC = /\x1b\[\?([0-9;]+)([hl])/g;
const PARTIAL_DEC = /\x1b(?:\[(?:\?[0-9;]*)?)?$/;

function updateAlternate(
  record: RendererTerminalRecord,
  data: string,
  source: "stream" | "init-log",
): void {
  if (source === "init-log") record.partialDecMode = undefined;
  const pending = record.partialDecMode;
  const escape = data.lastIndexOf("\x1b");
  const hasPartial = escape !== -1 && PARTIAL_DEC.test(data.slice(escape));
  if (pending === undefined && !data.includes("\x1b[?") && !data.includes("\x1bc") && !hasPartial)
    return;

  const joined = (pending ?? "") + data;
  let mode: AlternateScreenMode | null = null;
  let matchIndex = -1;
  for (const match of joined.matchAll(DEC)) {
    for (const param of match[1]?.split(";") ?? []) {
      if (param !== "47" && param !== "1047" && param !== "1049") continue;
      mode = match[2] === "h" ? (Number(param) as AlternateScreenMode) : null;
      matchIndex = match.index;
    }
  }
  if (joined.lastIndexOf("\x1bc") > matchIndex) record.alternateMode = null;
  else if (matchIndex !== -1) record.alternateMode = mode;

  const ending = joined.match(PARTIAL_DEC)?.[0];
  record.partialDecMode = ending !== undefined && ending.length <= 1_024 ? ending : undefined;
}

function hasApi(): boolean {
  return typeof window !== "undefined" && Boolean(window.api);
}

export class TerminalSessionStore {
  private readonly records = new Map<string, RendererTerminalRecord>();
  private readonly renderers = new Map<string, TerminalRenderer>();
  private readonly registrations = new Map<string, TerminalRegistration>();
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
    return this.records.get(sessionId)?.snapshot ?? createEmptySnapshot(sessionId);
  }

  getError(sessionId: string): string | null {
    return this.records.get(sessionId)?.error ?? null;
  }

  getLeaseConflict(sessionId: string): {
    generation: number;
    ownerWindowSessionId: string;
  } | null {
    return this.records.get(sessionId)?.leaseConflict ?? null;
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

  getOrCreateRenderer(sessionId: string, factory: () => TerminalRenderer): TerminalRenderer {
    const existing = this.renderers.get(sessionId);
    if (existing) return existing;

    const record = this.getRecord(sessionId);
    const renderer = factory();
    this.renderers.set(sessionId, renderer);
    renderer.terminal.onTitleChange((title) => {
      if (this.renderers.get(sessionId) !== renderer || record.rawShellTitle === title) return;
      record.rawShellTitle = title;
      this.emitVersionChanged();
    });
    if (record.replayBuffer || record.clearOffsets.length) {
      renderer.replaceOutput(record.replayBuffer ?? "", record.clearOffsets);
    }
    return renderer;
  }

  releaseRenderer(sessionId: string, renderer: TerminalRenderer): void {
    if (this.renderers.get(sessionId) === renderer) this.renderers.delete(sessionId);
    renderer.dispose();
  }

  register(sessionId: string, listener: TerminalRegistration): () => void {
    this.registrations.set(sessionId, listener);
    const record = this.getRecord(sessionId);
    if (record.attached) listener.onAttach?.(record.snapshot.cwd, record.snapshot.shell);
    this.flushPendingWrites(sessionId, record);
    return () => {
      if (this.registrations.get(sessionId) === listener) this.registrations.delete(sessionId);
    };
  }

  clearSession(sessionId: string): void {
    const renderer = this.renderers.get(sessionId);
    const record = this.records.get(sessionId);
    if (!renderer || !record) return;
    const offset = record.replayBuffer?.length ?? 0;
    if (record.clearOffsets.at(-1) !== offset) {
      record.clearOffsets = [...record.clearOffsets, offset];
    }
    renderer.clear();
  }

  preserveAlternateScreen(sessionId: string, active: boolean): void {
    const record = this.records.get(sessionId);
    if (!record) return;
    record.alternateMode = active ? (record.alternateMode ?? 1049) : null;
  }

  getPreservedAlternateScreenMode(sessionId: string): AlternateScreenMode | null {
    return this.records.get(sessionId)?.alternateMode ?? null;
  }

  recordUserInteraction(sessionId: string): void {
    const record = this.records.get(sessionId);
    if (!record || record.interacted) return;
    record.interacted = true;
    this.emitVersionChanged();
  }

  async createOrAttach(input: TerminalCreateRequest): Promise<TerminalViewLeaseResult | null> {
    return await this.requestLease(
      input.sessionId,
      () => invokePlainCommand(createTerminalCommand, input),
      {
        conversationId: input.conversationId ?? null,
        projectSessionId: input.projectSessionId ?? null,
        cwd: input.cwd ?? null,
        ...(input.title !== undefined ? { title: input.title } : {}),
        backendKind: input.backendKind ?? "local",
      },
    );
  }

  async attach(input: TerminalAttachRequest): Promise<TerminalViewLeaseResult | null> {
    return await this.requestLease(
      input.sessionId,
      () => invokeRendererControl("terminal-acquire-view", input),
      {
        conversationId: input.conversationId ?? null,
        projectSessionId: input.projectSessionId ?? null,
        cwd: input.cwd ?? null,
      },
    );
  }

  async takeOver(input: TerminalTakeOverViewRequest): Promise<TerminalViewLeaseResult | null> {
    return await this.requestLease(input.sessionId, () =>
      invokeRendererControl("terminal-take-over-view", input),
    );
  }

  async runAction(input: TerminalRunActionRequest): Promise<void> {
    this.closingSessionIds.delete(input.sessionId);
    this.ensureEventSubscriptions();
    const record = this.getRecord(input.sessionId);
    record.rawShellTitle = null;
    record.alternateMode = null;
    record.partialDecMode = undefined;
    record.interacted = true;
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

    if (!snapshot.exited && !this.closingSessionIds.has(sessionId)) {
      this.updateLeaseSnapshot(this.getRecord(sessionId), snapshot);
      this.emitVersionChanged();
    }
    return snapshot;
  }

  write(sessionId: string, data: string, source: TerminalWriteSource): void {
    const record = this.records.get(sessionId);
    if (!record || record.error !== null) return;
    if (source === "user") this.recordUserInteraction(sessionId);
    if (!record.attached || !this.registrations.has(sessionId)) {
      record.pendingWrites.push(data);
      return;
    }

    if (!hasApi()) return;
    void invokeRendererControl("terminal-write", sessionId, data);
  }

  resize(sessionId: string, size: TerminalSize, repaint = false): void {
    const record = this.records.get(sessionId);
    if (!record?.attached || record.error !== null || !hasApi()) return;
    const cols = Math.max(2, Math.floor(size.cols));
    const rows = Math.max(1, Math.floor(size.rows));
    const previous = record.lastResize;
    if (!repaint && previous?.cols === cols && previous.rows === rows) return;

    record.lastResize = { cols, rows };
    void invokeRendererControl("terminal-resize", sessionId, { cols, rows }, repaint);
  }

  release(sessionId: string): void {
    const renderer = this.renderers.get(sessionId);
    if (renderer) this.releaseRenderer(sessionId, renderer);
    if (this.closingSessionIds.has(sessionId)) return;
    this.closingSessionIds.add(sessionId);
    const record = this.records.get(sessionId);
    if (record) {
      record.leaseRequest++;
      record.pendingWrites.length = 0;
      record.lastResize = null;
      record.error = null;
      record.leaseConflict = null;
      if (record.attached) record.snapshot = { ...record.snapshot, viewLease: null };
      this.detachRecord(sessionId, record);
    }
    if (hasApi()) void invokeRendererControl("terminal-release-view", sessionId);
    this.emitVersionChanged();
  }

  kill(sessionId: string): void {
    if (!hasApi()) return;
    const record = this.records.get(sessionId);
    const isCurrent = () => record && this.records.get(sessionId) === record;
    void invokePlainCommand(killTerminalCommand, sessionId).then(
      () => {
        // An exit event can retire the record before the command acknowledges completion.
        if (!isCurrent()) return;
        this.closingSessionIds.add(sessionId);
        this.deleteSession(sessionId);
        this.emitVersionChanged();
      },
      (reason: unknown) => {
        if (!isCurrent()) return;
        this.handleError({
          sessionId,
          message: reason instanceof Error ? reason.message : "Failed to kill terminal.",
        });
      },
    );
  }

  resolveTitle(sessionId: string, fallbackTitle: string | null | undefined, index: number): string {
    const record = this.records.get(sessionId);
    const cwd = record?.snapshot.cwd ?? null;
    const fixedTitle = record?.fixedTitle?.trim();
    if (fixedTitle) return fixedTitle;
    const shellTitle =
      record?.rawShellTitle == null ? null : deriveTitle(record.rawShellTitle, cwd);
    if (shellTitle) return shellTitle;

    const cwdTitle = getPathBasename(cwd);
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
      leaseRequest: 0,
      replayBuffer: null,
      clearOffsets: [],
      alternateMode: null,
      partialDecMode: undefined,
      interacted: false,
      fixedTitle: null,
      rawShellTitle: null,
      error: null,
      pendingWrites: [],
      lastResize: null,
      leaseConflict: null,
    };
    this.records.set(sessionId, record);
    return record;
  }

  private async requestLease(
    sessionId: string,
    request: () => Promise<TerminalViewLeaseResult>,
    metadata?: Partial<TerminalSessionSnapshot>,
  ): Promise<TerminalViewLeaseResult | null> {
    this.closingSessionIds.delete(sessionId);
    this.ensureEventSubscriptions();
    const record = this.getRecord(sessionId);
    const epoch = ++record.leaseRequest;
    if (metadata) this.mergeSnapshot(sessionId, metadata);
    if (!hasApi()) return null;

    const isCurrent = () => this.records.get(sessionId) === record && record.leaseRequest === epoch;
    try {
      const result = await request();
      if (isCurrent()) this.applyLeaseResult(sessionId, record, result);
      return result;
    } catch (reason) {
      if (isCurrent()) {
        this.handleError({
          sessionId,
          message: reason instanceof Error ? reason.message : "Failed to attach terminal.",
        });
      }
      return null;
    }
  }

  private mergeSnapshot(sessionId: string, partial: Partial<TerminalSessionSnapshot>): void {
    const record = this.getRecord(sessionId);
    this.updateSnapshot(record, partial);
    this.emitVersionChanged();
  }

  private updateSnapshot(
    record: RendererTerminalRecord,
    partial: Partial<TerminalSessionSnapshot>,
  ): void {
    if (partial.title !== undefined) record.fixedTitle = partial.title;
    record.snapshot = { ...record.snapshot, ...partial };
  }

  private updateLeaseSnapshot(
    record: RendererTerminalRecord,
    snapshot: TerminalSessionSnapshot,
  ): void {
    // Lease metadata includes the process output snapshot. Only PTY events can seed a live renderer.
    this.updateSnapshot(record, {
      ...snapshot,
      buffer: record.replayBuffer ?? snapshot.buffer,
      truncated: record.replayBuffer === null ? snapshot.truncated : record.snapshot.truncated,
    });
  }

  private handleData({ sessionId, data }: TerminalDataEvent): void {
    if (this.closingSessionIds.has(sessionId)) return;
    const record = this.getRecord(sessionId);
    updateAlternate(record, data, "stream");
    const previous = record.replayBuffer ?? "";
    const next = appendBoundedBuffer(previous, data);
    const shift = next.buffer.length - previous.length - data.length;
    if (shift !== 0 && record.clearOffsets.length) {
      record.clearOffsets = record.clearOffsets
        .map((offset) => offset + shift)
        .filter((offset) => offset >= 0);
    }
    const output =
      record.snapshot.buffer === previous
        ? next
        : appendBoundedBuffer(record.snapshot.buffer, data);
    record.replayBuffer = next.buffer;
    record.snapshot = { ...record.snapshot, ...output };
    this.renderers.get(sessionId)?.write(data);
    this.emitSession(sessionId, { type: "data", sessionId, data });
  }

  private handleInitLog({ sessionId, data, snapshot }: TerminalInitLogEvent): void {
    if (this.closingSessionIds.has(sessionId)) return;
    const record = this.getRecord(sessionId);
    const restoreMode = record.alternateMode;
    updateAlternate(record, data, "init-log");
    const output = appendBoundedBuffer("", data);
    if (output.buffer !== (record.replayBuffer ?? "")) record.clearOffsets = [];
    record.replayBuffer = output.buffer;
    record.error = null;
    this.updateSnapshot(record, {
      ...snapshot,
      ...output,
      truncated: output.truncated || snapshot.truncated,
    });
    this.renderers
      .get(sessionId)
      ?.replaceOutput(output.buffer, record.clearOffsets, restoreMode ?? undefined);
    this.emitSession(sessionId, { type: "init-log", sessionId, data, snapshot: record.snapshot });
    this.emitVersionChanged();
  }

  private handleAttached({ sessionId, snapshot }: TerminalAttachedEvent): void {
    if (this.closingSessionIds.has(sessionId)) return;
    const record = this.getRecord(sessionId);
    this.updateLeaseSnapshot(record, snapshot);
    this.attachRecord(sessionId, record);
    this.emitSession(sessionId, { type: "attached", sessionId, snapshot: record.snapshot });
    this.emitVersionChanged();
  }

  private attachRecord(sessionId: string, record: RendererTerminalRecord): void {
    const wasAttached = record.attached;
    record.attached = true;
    record.error = null;
    record.leaseConflict = null;
    if (!wasAttached) {
      this.registrations.get(sessionId)?.onAttach?.(record.snapshot.cwd, record.snapshot.shell);
    }
    this.flushPendingWrites(sessionId, record);
  }

  private detachRecord(sessionId: string, record: RendererTerminalRecord): void {
    if (!record.attached) return;
    record.attached = false;
    this.registrations.get(sessionId)?.onDetach?.();
  }

  private handleError({ sessionId, message }: TerminalErrorEvent): void {
    if (this.closingSessionIds.has(sessionId)) return;
    const record = this.getRecord(sessionId);
    record.error = message;
    record.pendingWrites.length = 0;
    this.detachRecord(sessionId, record);
    this.emitSession(sessionId, { type: "error", sessionId, message });
    this.emitVersionChanged();
  }

  private handleExit(payload: TerminalExitEvent): void {
    const { sessionId, exitCode, reason } = payload;
    this.closingSessionIds.add(sessionId);
    this.emitSession(sessionId, { type: "exit", sessionId, exitCode, reason });
    this.deleteSession(sessionId);
    this.emitExit(payload);
    this.emitVersionChanged();
  }

  private deleteSession(sessionId: string): void {
    const record = this.records.get(sessionId);
    if (record) this.detachRecord(sessionId, record);
    const renderer = this.renderers.get(sessionId);
    if (renderer) {
      this.renderers.delete(sessionId);
      // A mounted view still owns its cleanup, including xterm listener teardown.
      if (!this.registrations.has(sessionId)) renderer.dispose();
    }
    this.records.delete(sessionId);
  }

  private handleLeaseRevoked({
    sessionId,
    ownerWindowSessionId,
    generation,
  }: TerminalViewLeaseRevokedEvent): void {
    if (this.closingSessionIds.has(sessionId)) return;
    const record = this.getRecord(sessionId);
    if ((record.snapshot.viewLease?.generation ?? 0) > generation) return;
    record.leaseRequest++;
    record.snapshot = {
      ...record.snapshot,
      viewLease: {
        windowSessionId: ownerWindowSessionId,
        generation,
        size: record.snapshot.viewLease?.size ?? { cols: 80, rows: 24 },
      },
    };
    this.setConflict(sessionId, record, generation, ownerWindowSessionId);
  }

  private setConflict(
    sessionId: string,
    record: RendererTerminalRecord,
    generation: number,
    ownerWindowSessionId: string,
  ): void {
    this.detachRecord(sessionId, record);
    record.error = null;
    record.lastResize = null;
    record.leaseConflict = { generation, ownerWindowSessionId };
    this.emitSession(sessionId, {
      type: "lease-conflict",
      sessionId,
      generation,
      ownerWindowSessionId,
    });
    this.emitVersionChanged();
  }

  private applyLeaseResult(
    sessionId: string,
    record: RendererTerminalRecord,
    result: TerminalViewLeaseResult,
  ): void {
    if (result.status === "not_found") {
      this.handleError({ sessionId, message: "Terminal session does not exist." });
      return;
    }
    this.updateLeaseSnapshot(record, result.snapshot);
    if (result.status === "conflict" || result.status === "stale") {
      this.setConflict(sessionId, record, result.generation, result.ownerWindowSessionId);
      return;
    }
    this.attachRecord(sessionId, record);
    this.emitSession(sessionId, {
      type: "lease-acquired",
      sessionId,
      generation: result.generation,
    });
    this.emitVersionChanged();
  }

  private flushPendingWrites(sessionId: string, record: RendererTerminalRecord): void {
    if (!hasApi() || !record.attached || !this.registrations.has(sessionId)) return;

    for (const data of record.pendingWrites.splice(0)) {
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
