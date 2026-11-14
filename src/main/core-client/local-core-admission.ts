import { CORE_TRANSPORT_BUDGETS } from "@nodex/core-protocol";
import type { CoreRequestClass } from "./types";

export const DEFAULT_REQUEST_DEADLINES_MS: Readonly<Record<CoreRequestClass, number>> = {
  interactive: CORE_TRANSPORT_BUDGETS.interactive_request_deadline_ms,
  background: CORE_TRANSPORT_BUDGETS.background_request_deadline_ms,
  maintenance: CORE_TRANSPORT_BUDGETS.maintenance_request_deadline_ms,
};

// Leave room for other clients in Core's corresponding budgets of 128, 48, and 8.
const LOCAL_IN_FLIGHT_LIMITS: Readonly<Record<CoreRequestClass, number>> = {
  interactive: 64,
  background: 16,
  maintenance: 4,
};

type ReleaseSlot = () => void;
type SlotResult = ReleaseSlot | "aborted" | "expired";

interface AdmissionLane {
  active: number;
  readonly waiting: Set<() => void>;
}

// Independent transports to the same Core socket share capacity.
const lanes = new Map<string, AdmissionLane>();

export const acquireLocalCoreSlot = (
  socketPath: string,
  requestClass: CoreRequestClass,
  waitMs: number,
  signal?: AbortSignal,
): SlotResult | Promise<SlotResult> => {
  if (signal?.aborted) return "aborted";
  if (waitMs < 0) return "expired";

  const key = `${requestClass}:${socketPath}`;
  const lane = lanes.get(key) ?? { active: 0, waiting: new Set<() => void>() };
  lanes.set(key, lane);

  const release = (): void => {
    const next = lane.waiting.values().next().value;
    if (next) {
      next();
      return;
    }
    lane.active -= 1;
    if (lane.active === 0) lanes.delete(key);
  };
  if (lane.active < LOCAL_IN_FLIGHT_LIMITS[requestClass]) {
    lane.active += 1;
    return release;
  }

  return new Promise((resolve) => {
    const finish = (result: SlotResult): void => {
      lane.waiting.delete(grant);
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve(result);
    };
    const grant = (): void => finish(release);
    const abort = (): void => finish("aborted");
    const timer = setTimeout(() => finish("expired"), waitMs);
    lane.waiting.add(grant);
    signal?.addEventListener("abort", abort, { once: true });
  });
};

export const localCoreRetryDelay = (attempt: number, serverHintMs: number): number => {
  const clientBackoff = Math.round(25 * 2 ** attempt * (0.75 + Math.random() / 2));
  return Math.max(serverHintMs, Math.min(500, clientBackoff));
};

export const waitForLocalCoreRetry = (delayMs: number, signal?: AbortSignal): Promise<void> => {
  if (signal?.aborted) return Promise.resolve();

  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    signal?.addEventListener("abort", finish, { once: true });
  });
};
