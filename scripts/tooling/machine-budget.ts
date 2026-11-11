import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolvePrimaryCheckoutRoot } from "../immutable-artifact-cache.ts";

/**
 * One CPU budget shared by every checkout on this computer.
 *
 * Each heavy development command claims a weight before it starts and waits its turn when the
 * computer is full, so parallel Agents queue instead of overloading each other into timeouts.
 * Waiting happens before the command runs and therefore never counts against a test timeout.
 */

/** `off` disables the budget; a positive integer overrides the detected capacity. */
export const MACHINE_BUDGET_ENV = "NODEX_MACHINE_BUDGET";
/** Overrides the shared state directory. */
export const MACHINE_BUDGET_DIRECTORY_ENV = "NODEX_MACHINE_BUDGET_DIR";
/** Set for children of a holder so that nested commands share their parent's claim. */
export const MACHINE_BUDGET_HELD_ENV = "NODEX_MACHINE_BUDGET_HELD";

const POLL_INTERVAL_MS = 500;
const STATUS_REPEAT_MS = 60_000;
/** The critical section is a few synchronous file operations; an older lock was abandoned. */
const STALE_LOCK_MS = 10_000;

export interface BudgetTicket {
  readonly id: string;
  readonly pid: number;
  readonly weight: number;
  readonly label: string;
  readonly cwd: string;
  readonly enqueuedAt: number;
  readonly grantedAt: number | null;
}

export interface BudgetRequest {
  /** Roughly the number of busy cores the command needs. Larger than capacity means exclusive. */
  readonly weight: number;
  readonly label: string;
}

export interface BudgetLease {
  /** Merge into the environment of child commands so they do not claim again. */
  readonly env: Readonly<Record<string, string>>;
  readonly waitedMs: number;
  readonly release: () => void;
}

export interface BudgetContext {
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly signal?: AbortSignal;
  readonly log?: (line: string) => void;
  readonly directory?: string;
  readonly capacity?: number;
  readonly pid?: number;
  readonly isAlive?: (pid: number) => boolean;
  readonly pollIntervalMs?: number;
}

const inactiveLease = (env: Readonly<Record<string, string>> = {}): BudgetLease => ({
  env,
  waitedMs: 0,
  release: () => undefined,
});

const isErrno = (error: unknown, ...codes: readonly string[]): boolean =>
  error instanceof Error && "code" in error && codes.includes(String(error.code));

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrno(error, "ESRCH");
  }
}

function detectCapacity(): number {
  if (process.platform === "darwin") {
    try {
      // Efficiency cores stay free for the desktop and the Agents' own processes.
      const performanceCores = Number(
        execFileSync("sysctl", ["-n", "hw.perflevel0.logicalcpu"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 2_000,
        }).trim(),
      );
      if (Number.isSafeInteger(performanceCores) && performanceCores > 0) return performanceCores;
    } catch {
      // Intel Macs have a single performance level.
    }
  }
  return Math.max(1, os.availableParallelism() - 1);
}

/** The budget is a local-development courtesy; CI runners are already isolated. */
export function machineBudgetCapacity(env: NodeJS.ProcessEnv): number | null {
  const setting = env[MACHINE_BUDGET_ENV]?.trim();
  if (setting === "off" || env[MACHINE_BUDGET_HELD_ENV]) return null;
  if (setting) {
    const capacity = Number(setting);
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new Error(`${MACHINE_BUDGET_ENV} must be "off" or a positive integer.`);
    }
    return capacity;
  }
  if (env.CI === "true" || env.CI === "1") return null;
  return detectCapacity();
}

const queueOrder = (left: BudgetTicket, right: BudgetTicket): number =>
  left.enqueuedAt - right.enqueuedAt || left.id.localeCompare(right.id);

/**
 * Waiting tickets that may start now. Admission is strictly first-come, first-served: a small
 * command never overtakes a large one, so an exclusive claim cannot starve.
 */
export function admittedTickets(
  tickets: readonly BudgetTicket[],
  capacity: number,
): ReadonlySet<string> {
  const claim = (ticket: BudgetTicket) => Math.min(ticket.weight, capacity);
  let used = tickets
    .filter((ticket) => ticket.grantedAt !== null)
    .reduce((sum, ticket) => sum + claim(ticket), 0);
  const admitted = new Set<string>();
  for (const ticket of tickets.filter((ticket) => ticket.grantedAt === null).sort(queueOrder)) {
    if (used + claim(ticket) > capacity) break;
    used += claim(ticket);
    admitted.add(ticket.id);
  }
  return admitted;
}

const formatDuration = (durationMs: number): string => {
  const seconds = Math.round(durationMs / 1_000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60}s`;
};

function describeQueue(
  tickets: readonly BudgetTicket[],
  own: BudgetTicket,
  capacity: number,
  now: number,
): { readonly state: string; readonly line: string } {
  const holders = tickets.filter((ticket) => ticket.grantedAt !== null);
  const ahead = tickets.filter(
    (ticket) => ticket.grantedAt === null && queueOrder(ticket, own) < 0,
  ).length;
  const used = holders.reduce((sum, ticket) => sum + Math.min(ticket.weight, capacity), 0);
  const name = (ticket: BudgetTicket) => `${ticket.label} in ${path.basename(ticket.cwd)}`;
  const state = `${holders.map((ticket) => ticket.id).join(",")}|${ahead}`;
  const running = holders
    .map((ticket) => `${name(ticket)} (${formatDuration(now - (ticket.grantedAt ?? now))})`)
    .join(", ");
  return {
    state,
    line:
      `${used}/${capacity} cores in use by ${running || "claims that are starting"}` +
      (ahead ? `; ${ahead} ahead in the queue` : ""),
  };
}

class BudgetStore {
  private readonly tickets: string;
  private readonly lock: string;

  constructor(
    directory: string,
    private readonly isAlive: (pid: number) => boolean,
  ) {
    this.tickets = path.join(directory, "tickets");
    this.lock = path.join(directory, "lock");
    mkdirSync(this.tickets, { recursive: true });
  }

  private ticketPath(id: string): string {
    return path.join(this.tickets, `${id}.json`);
  }

  /** Runs `action` alone across processes, or returns `undefined` when another holds the lock. */
  transact<Result>(action: () => Result): Result | undefined {
    try {
      mkdirSync(this.lock);
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
      this.reclaimAbandonedLock();
      return undefined;
    }
    try {
      return action();
    } finally {
      rmdirSync(this.lock);
    }
  }

  private reclaimAbandonedLock(): void {
    try {
      if (Date.now() - statSync(this.lock).mtimeMs < STALE_LOCK_MS) return;
      const abandoned = `${this.lock}.abandoned-${randomUUID()}`;
      renameSync(this.lock, abandoned);
      rmSync(abandoned, { force: true, recursive: true });
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
  }

  write(ticket: BudgetTicket): void {
    const temporary = path.join(this.tickets, `.${ticket.id}.${randomUUID()}.tmp`);
    writeFileSync(temporary, JSON.stringify(ticket));
    renameSync(temporary, this.ticketPath(ticket.id));
  }

  remove(id: string): void {
    rmSync(this.ticketPath(id), { force: true });
  }

  /** Live tickets; claims of processes that died are dropped so a killed Agent frees its share. */
  read(): BudgetTicket[] {
    const live: BudgetTicket[] = [];
    for (const name of readdirSync(this.tickets)) {
      if (!name.endsWith(".json")) continue;
      let ticket: BudgetTicket;
      try {
        ticket = JSON.parse(readFileSync(path.join(this.tickets, name), "utf8")) as BudgetTicket;
      } catch (error) {
        if (isErrno(error, "ENOENT")) continue;
        throw error;
      }
      if (this.isAlive(ticket.pid)) live.push(ticket);
      else this.remove(ticket.id);
    }
    return live;
  }
}

const heldTickets = new Map<string, BudgetStore>();
let exitHookInstalled = false;

function releaseOnExit(id: string, store: BudgetStore): void {
  heldTickets.set(id, store);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    for (const [ticket, owner] of heldTickets) owner.remove(ticket);
  });
}

const sleep = (durationMs: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, durationMs);
    signal?.addEventListener("abort", finish, { once: true });
  });

/**
 * Claims a share of the computer, waiting in line while it is full. The claim ends on
 * `release()` or when this process exits, however it exits.
 */
export async function acquireMachineBudget(
  request: BudgetRequest,
  context: BudgetContext,
): Promise<BudgetLease> {
  const capacity = context.capacity ?? machineBudgetCapacity(context.env);
  if (capacity === null) return inactiveLease();
  const log = context.log ?? ((line: string) => process.stderr.write(line + "\n"));
  let store: BudgetStore;
  try {
    store = new BudgetStore(
      context.directory ??
        (context.env[MACHINE_BUDGET_DIRECTORY_ENV]?.trim() ||
          path.join(resolvePrimaryCheckoutRoot(context.cwd), "cache.local", "machine-budget")),
      context.isAlive ?? isProcessAlive,
    );
  } catch (error) {
    // A sandbox that cannot reach the shared directory must still be able to run its tests.
    if (!isErrno(error, "EACCES", "EPERM", "EROFS")) throw error;
    log(`[machine-budget] Shared state is not writable; running without a claim. ${String(error)}`);
    return inactiveLease();
  }

  let own: BudgetTicket = {
    id: randomUUID(),
    pid: context.pid ?? process.pid,
    weight: Math.max(1, Math.round(request.weight)),
    label: request.label,
    cwd: context.cwd,
    enqueuedAt: 0,
    grantedAt: null,
  };
  const startedAt = Date.now();
  let enqueued = false;
  let reportedState: string | undefined;
  let reportedAt = 0;
  try {
    while (true) {
      if (context.signal?.aborted) throw new Error("Cancelled while waiting for the computer.");
      const queue = store.transact(() => {
        const now = Date.now();
        const others = store.read().filter((ticket) => ticket.id !== own.id);
        if (!enqueued) {
          // Queue positions are assigned under the lock, so they are unique and ordered.
          own = { ...own, enqueuedAt: Math.max(now, ...others.map((t) => t.enqueuedAt + 1)) };
          enqueued = true;
          releaseOnExit(own.id, store);
        }
        if (admittedTickets([...others, own], capacity).has(own.id)) {
          own = { ...own, grantedAt: now };
        }
        store.write(own);
        return others;
      });
      if (own.grantedAt !== null) break;
      if (queue) {
        const now = Date.now();
        const status = describeQueue(queue, own, capacity, now);
        if (status.state !== reportedState || now - reportedAt >= STATUS_REPEAT_MS) {
          reportedState = status.state;
          reportedAt = now;
          log(
            `[machine-budget] ${own.label} is waiting ${formatDuration(now - startedAt)} for ` +
              `${Math.min(own.weight, capacity)} cores: ${status.line}. ` +
              "Queueing is expected; it does not count against test timeouts.",
          );
        }
      }
      // A busy lock clears within milliseconds; only a full computer is worth a slow poll.
      await sleep(queue ? (context.pollIntervalMs ?? POLL_INTERVAL_MS) : 20, context.signal);
    }
  } catch (error) {
    heldTickets.delete(own.id);
    store.remove(own.id);
    throw error;
  }
  const waitedMs = Date.now() - startedAt;
  if (reportedState !== undefined) {
    log(`[machine-budget] ${own.label} starts after waiting ${formatDuration(waitedMs)}.`);
  }
  return {
    env: { [MACHINE_BUDGET_HELD_ENV]: own.id },
    waitedMs,
    release: () => {
      heldTickets.delete(own.id);
      store.remove(own.id);
    },
  };
}
