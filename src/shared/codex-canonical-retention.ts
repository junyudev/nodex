import { classifyCanonicalDynamicInteractiveRequest } from "./codex-canonical-pending-request";
import { normalizeCodexCanonicalMcpElicitation } from "./codex-conversation-state/codex-server-request-lifecycle";
import { mergeCodexCanonicalTurnStates } from "./codex-conversation-state/codex-conversation-state";
import type { Draft } from "immer";
import { hasCompleteCanonicalConversationHistory } from "./codex-conversation-state/codex-complete-history-loader";
import { replaceCanonicalHistoryDraft } from "./codex-conversation-state/codex-canonical-history-loader";
import type { CodexCanonicalConversationState } from "./codex-conversation-state/codex-conversation-state";
import { residentConversationTurns } from "./codex-conversation-state/codex-turn-mutation";

export const CANONICAL_OWNER_RETENTION_MS = 10_800_000;
export const CANONICAL_OWNER_RETRY_MS = 15_000;
export const CANONICAL_MAX_INACTIVE_OWNERS = 10;

export interface CanonicalConversationRetentionOptions {
  readonly getConversation: (id: string) => CodexCanonicalConversationState | null | undefined;
  readonly getRole: (id: string) => "owner" | "follower" | null;
  readonly ownsHistory: (id: string) => boolean;
  readonly hasActiveView: (id: string) => boolean;
  readonly hasFollowers: (id: string) => boolean;
  readonly shouldKeepLoaded: (state: CodexCanonicalConversationState) => boolean;
  readonly isEphemeralSide: (state: CodexCanonicalConversationState) => boolean;
  readonly unsubscribe: (id: string) => Promise<unknown>;
  readonly releaseHistory: (id: string) => void;
  readonly completeUnsubscribe: (
    id: string,
    options: { readonly retainHistory: boolean; readonly ephemeral: boolean },
  ) => void;
  readonly clearOwnership: (id: string) => void;
  readonly now: () => number;
  readonly schedule: (callback: () => void, delayMs: number) => () => void;
  readonly scheduleMicrotask: (callback: () => void) => void;
}

/** Each manager retires only its own native history subscriptions. */
export class CanonicalConversationRetention {
  private readonly inactiveSince = new Map<string, number>();
  private readonly retryAt = new Map<string, number>();
  private readonly keptLoaded = new Set<string>();
  private readonly unsubscribing = new Set<string>();
  private readonly watchedPassiveHydrations = new WeakSet<object>();
  private readonly passiveHydrations = new Set<string>();
  private cancelTimer: (() => void) | null = null;
  private nextCheckAt: number | null = null;
  private disposed = false;

  constructor(private readonly options: CanonicalConversationRetentionOptions) {}

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    this.passiveHydrations.clear();
  }

  activityChanged(id: string, active: boolean): void {
    this.reconcile(id);
    if (!active) this.notificationHandled(id);
  }

  notificationHandled(id: string): void {
    this.options.scheduleMicrotask(() => this.releasePassive(id));
  }

  reconcile(id: string): void {
    if (this.disposed) return;
    const state = this.options.getConversation(id);
    if (!state) {
      this.inactiveSince.delete(id);
      this.retryAt.delete(id);
      this.keptLoaded.delete(id);
      this.passiveHydrations.delete(id);
      this.scheduleCheck();
      return;
    }
    if (this.passiveHydrations.has(id) && state.turnsPagination?.isLoadingOlder !== true) {
      this.passiveHydrations.delete(id);
      this.notificationHandled(id);
    }
    if (
      this.options.ownsHistory(id) &&
      state.resumeState === "resumed" &&
      !this.options.hasActiveView(id) &&
      !this.hasOwnedFollowers(id)
    ) {
      const previous = this.inactiveSince.get(id);
      const keep = this.keepLoaded(state);
      const wasKept = this.keptLoaded.has(id);
      if (keep) this.keptLoaded.add(id);
      else this.keptLoaded.delete(id);
      this.inactiveSince.set(
        id,
        previous === undefined || (wasKept && !keep) ? this.options.now() : previous,
      );
    } else {
      this.inactiveSince.delete(id);
      this.retryAt.delete(id);
      this.keptLoaded.delete(id);
    }
    this.scheduleCheck();
  }

  remove(id: string): void {
    this.inactiveSince.delete(id);
    this.retryAt.delete(id);
    this.keptLoaded.delete(id);
    this.unsubscribing.delete(id);
    this.passiveHydrations.delete(id);
    this.options.clearOwnership(id);
    this.scheduleCheck();
  }

  private keepLoaded(state: CodexCanonicalConversationState): boolean {
    return this.options.getRole(state.id) !== "follower" && this.options.shouldKeepLoaded(state);
  }

  private hasOwnedFollowers(id: string): boolean {
    return this.options.getRole(id) === "owner" && this.options.hasFollowers(id);
  }

  private releasePassive(id: string): void {
    if (this.disposed) return;
    const state = this.options.getConversation(id);
    const pagination = state?.turnsPagination;
    if (
      !state ||
      state.resumeState === "resuming" ||
      this.options.getRole(id) !== null ||
      this.options.hasActiveView(id) ||
      this.options.isEphemeralSide(state) ||
      state.requests.length > 0 ||
      this.keepLoaded(state)
    )
      return;
    if (
      state.resumeState === "needs_resume" &&
      (pagination?.hasLoadedOldest !== false ||
        pagination.olderCursor !== null ||
        pagination.oldestLoadedTurnId !== null)
    )
      return;
    if (
      !residentConversationTurns(state).some((turn) =>
        turn.items.some((item) => item.type !== "forkedFromConversation"),
      )
    )
      return;
    if (pagination?.isLoadingOlder === true) {
      if (this.watchedPassiveHydrations.has(pagination)) return;
      this.watchedPassiveHydrations.add(pagination);
      this.passiveHydrations.add(id);
      return;
    }
    this.options.releaseHistory(id);
  }

  private eligible(id: string): CodexCanonicalConversationState | null {
    const state = this.options.getConversation(id);
    if (
      !state ||
      state.resumeState !== "resumed" ||
      !this.options.ownsHistory(id) ||
      this.options.hasActiveView(id) ||
      this.hasOwnedFollowers(id) ||
      this.unsubscribing.has(id) ||
      this.keepLoaded(state)
    )
      return null;
    return state;
  }

  private ready(now: number): string[] {
    const candidates: Array<{ id: string; since: number; ephemeral: boolean; expired: boolean }> =
      [];
    for (const [id, since] of this.inactiveSince) {
      const state = this.eligible(id);
      if (!state || (this.retryAt.get(id) ?? 0) > now) continue;
      candidates.push({
        id,
        since,
        ephemeral: this.options.isEphemeralSide(state),
        expired: now - since >= CANONICAL_OWNER_RETENTION_MS,
      });
    }
    candidates.sort((a, b) => a.since - b.since);
    const ordinary = candidates.filter((candidate) => !candidate.ephemeral);
    const excess = new Set(
      ordinary.slice(0, Math.max(0, ordinary.length - CANONICAL_MAX_INACTIVE_OWNERS)),
    );
    return candidates
      .filter((candidate) => candidate.expired || excess.has(candidate))
      .map((candidate) => candidate.id);
  }

  private nextCheck(now: number): number | null {
    let next: number | null = null;
    for (const [id, since] of this.inactiveSince) {
      if (!this.eligible(id)) continue;
      const retry = this.retryAt.get(id);
      const time =
        retry !== undefined && retry > now ? retry : since + CANONICAL_OWNER_RETENTION_MS;
      if (next === null || time < next) next = time;
    }
    return next;
  }

  private clearTimer(): void {
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.nextCheckAt = null;
  }

  private scheduleCheck(): void {
    if (this.disposed) return;
    const now = this.options.now();
    const ready = this.ready(now);
    if (ready.length) {
      this.clearTimer();
      this.cancelTimer = this.options.schedule(() => {
        this.cancelTimer = null;
        void Promise.all(ready.map((id) => this.unsubscribe(id))).finally(() =>
          this.scheduleCheck(),
        );
      }, 0);
      return;
    }
    const next = this.nextCheck(now);
    if (next === null) {
      this.clearTimer();
      return;
    }
    if (this.cancelTimer && this.nextCheckAt === next) return;
    this.clearTimer();
    this.nextCheckAt = next;
    this.cancelTimer = this.options.schedule(
      () => {
        this.cancelTimer = null;
        this.nextCheckAt = null;
        this.scheduleCheck();
      },
      Math.max(0, next - now),
    );
  }

  private async unsubscribe(id: string): Promise<void> {
    if (this.unsubscribing.has(id)) return;
    const state = this.options.getConversation(id);
    if (state?.resumeState !== "resumed" || !this.options.ownsHistory(id)) return;
    this.unsubscribing.add(id);
    try {
      await this.options.unsubscribe(id);
      const current = this.options.getConversation(id);
      this.retryAt.delete(id);
      const ephemeral = current ? this.options.isEphemeralSide(current) : false;
      if (current && (ephemeral || current.resumeState !== "needs_resume")) {
        const retainHistory =
          ephemeral ||
          this.options.hasActiveView(id) ||
          this.hasOwnedFollowers(id) ||
          this.keepLoaded(current);
        this.options.completeUnsubscribe(id, { retainHistory, ephemeral });
      }
      this.options.clearOwnership(id);
    } catch {
      this.retryAt.set(id, this.options.now() + CANONICAL_OWNER_RETRY_MS);
    } finally {
      this.unsubscribing.delete(id);
      this.reconcile(id);
    }
  }
}

export type CanonicalRetentionRequestKind =
  | "approval"
  | "mcpServerElicitation"
  | "permissionRequest"
  | "userInput"
  | "optionPicker"
  | "setupCodexStep"
  | "implementPlan"
  | null;

/** The request selector is shared with the owner UI; a pending reply can leave an inactive Turn releasable. */
export function shouldKeepCanonicalConversationLoaded(
  state: CodexCanonicalConversationState,
  primaryRequest: CanonicalRetentionRequestKind,
  ephemeralSide: boolean,
): boolean {
  const turns = residentConversationTurns(state);
  if (
    state.rolloutPath.length === 0 &&
    hasCompleteCanonicalConversationHistory(state) &&
    turns.length === 0
  )
    return true;
  if (state.threadRuntimeStatus.type === "active") return true;
  const history = state.turnHistory?.history;
  const tail = history?.islands.at(-1);
  const key = tail?.entries.at(-1)?.value;
  const latest = tail?.newerBoundary.status === "exhausted" ? (key ? history?.entitiesByKey[key] : null) : turns.at(-1);
  if (latest?.status === "inProgress" && (primaryRequest === null || ephemeralSide))
    return true;
  return turns.some((turn) =>
    turn.items.some(
      (item) => item.type === "steeringUserMessage" && item.serverUserMessageId == null,
    ),
  );
}

export function releaseCanonicalConversationHistoryDraft(
  state: Draft<CodexCanonicalConversationState>,
): void {
  if (state.turnHistory) replaceCanonicalHistoryDraft(state, [], false);
  else state.turns = [];
  state.turnsPagination = {
    olderCursor: null,
    oldestLoadedTurnId: null,
    isLoadingOlder: false,
    hasLoadedOldest: false,
  };
  state.resumeState = "needs_resume";
}

export function completeCanonicalConversationUnsubscribeDraft(
  state: Draft<CodexCanonicalConversationState>,
  options: {
    readonly retainHistory: boolean;
    readonly ephemeral: boolean;
    readonly primaryRequest: CanonicalRetentionRequestKind;
  },
): void {
  if (state.resumeState === "needs_resume" && !options.ephemeral) return;
  if (!options.retainHistory && !options.ephemeral) releaseCanonicalConversationHistoryDraft(state);
  state.resumeState = "needs_resume";
  if (options.ephemeral) {
    state.threadRuntimeStatus = { type: "notLoaded" };
    return;
  }
  const request = options.primaryRequest;
  if (request === null || request === "implementPlan") {
    state.threadRuntimeStatus = { type: "idle" };
    return;
  }
  state.threadRuntimeStatus = {
    type: "active",
    activeFlags: [
      request === "approval" ||
      request === "mcpServerElicitation" ||
      request === "permissionRequest"
        ? "waitingOnApproval"
        : "waitingOnUserInput",
    ],
  };
}

/** Selects pending native requests from resident history and live overlays. */
export function selectCanonicalRetentionRequestKind(
  state: CodexCanonicalConversationState | null,
): CanonicalRetentionRequestKind {
  if (!state) return null;
  const turns = mergeCodexCanonicalTurnStates(residentConversationTurns(state), state.turns);
  const requests = [...state.requests].reverse();
  const byTurn = new Map<string, typeof requests>();
  for (const request of requests) {
    if (!("turnId" in request.params) || typeof request.params.turnId !== "string") continue;
    const id = request.params.turnId;
    const bucket = byTurn.get(id);
    if (bucket) bucket.push(request);
    else byTurn.set(id, [request]);
  }
  const validElicitation = (request: (typeof requests)[number]) =>
    request.method === "mcpServer/elicitation/request" &&
    !("completed" in request && request.completed === true) &&
    normalizeCodexCanonicalMcpElicitation(request.params, true) !== null;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]!;
    const plan = turn.items.findLast((item) => item.type === "planImplementation");
    const implementPlan = plan?.type === "planImplementation" && !plan.isCompleted;
    if (turn.turnId === null) {
      if (implementPlan) return "implementPlan";
      continue;
    }
    const pending = byTurn.get(turn.turnId) ?? [];
    const interactive = pending.map((request) =>
      request.method === "item/tool/requestUserInput"
        ? "userInput"
        : request.method === "item/tool/requestOptionPicker"
          ? "optionPicker"
          : request.method === "item/tool/call"
            ? classifyCanonicalDynamicInteractiveRequest(request)
            : null,
    );
    if (interactive.includes("userInput")) return "userInput";
    if (interactive.includes("optionPicker")) return "optionPicker";
    if (interactive.includes("setupCodexStep")) return "setupCodexStep";
    if (turn.items.some((item) => item.type === "userInputResponse" && !item.completed))
      return "userInput";
    if (
      pending.some(
        (request) =>
          request.method === "item/commandExecution/requestApproval" ||
          (request.method === "item/fileChange/requestApproval" &&
            turn.items.some(
              (item) =>
                item.type === "fileChange" &&
                item.id === request.params.itemId &&
                item.changes.some((change) => change.kind.type !== "delete"),
            )),
      )
    )
      return "approval";
    if (pending.some((request) => request.method === "item/permissions/requestApproval"))
      return "permissionRequest";
    if (pending.some(validElicitation)) return "mcpServerElicitation";
    if (implementPlan) return "implementPlan";
  }
  return requests.some(
    (request) =>
      validElicitation(request) &&
      request.method === "mcpServer/elicitation/request" &&
      !request.params.turnId,
  )
    ? "mcpServerElicitation"
    : null;
}
