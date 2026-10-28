import { useSyncExternalStore } from "react";
import { todayIsoDate } from "../../../shared/rich-text/date-mention";

type DateMentionClockListener = () => void;
type DateMentionClockTimer = unknown;

export interface DateMentionClockEnvironment {
  now: () => Date;
  setTimeout: (callback: () => void, delayMs: number) => DateMentionClockTimer;
  clearTimeout: (timer: DateMentionClockTimer) => void;
  addDocumentEventListener?: (type: string, listener: DateMentionClockListener) => () => void;
  addWindowEventListener?: (type: string, listener: DateMentionClockListener) => () => void;
  isDocumentVisible?: () => boolean;
}

export interface DateMentionClockStore {
  getTodayIsoSnapshot: () => string;
  getMinuteEpochSnapshot: () => number;
  subscribeToday: (listener: DateMentionClockListener) => () => void;
  subscribeMinute: (listener: DateMentionClockListener) => () => void;
  refresh: () => void;
  destroy: () => void;
}

const DAY_BOUNDARY_GUARD_MS = 1_000;
const MINUTE_BOUNDARY_GUARD_MS = 250;
const MAX_TIMEOUT_DELAY_MS = 2_147_483_647;
const NULL_SNAPSHOT = null;

function subscribeNull() {
  return () => undefined;
}

function getNullSnapshot() {
  return NULL_SNAPSHOT;
}

export function getDateMentionMinuteEpoch(now: Date): number {
  return Math.floor(now.getTime() / 60_000) * 60_000;
}

export function getDelayUntilNextLocalDay(now: Date): number {
  const nextDay = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1,
    0,
    0,
    0,
    DAY_BOUNDARY_GUARD_MS,
  );
  return clampTimerDelay(nextDay.getTime() - now.getTime());
}

export function getDelayUntilNextMinute(now: Date): number {
  const nextMinute = new Date(now);
  nextMinute.setMinutes(nextMinute.getMinutes() + 1, 0, MINUTE_BOUNDARY_GUARD_MS);
  return clampTimerDelay(nextMinute.getTime() - now.getTime());
}

export function createDateMentionClockStore(
  environment: DateMentionClockEnvironment = createBrowserDateMentionClockEnvironment(),
): DateMentionClockStore {
  const todaySubscribers = new Set<DateMentionClockListener>();
  const minuteSubscribers = new Set<DateMentionClockListener>();
  let todayIsoSnapshot = todayIsoDate(environment.now());
  let minuteEpochSnapshot = getDateMentionMinuteEpoch(environment.now());
  let todayTimer: DateMentionClockTimer | null = null;
  let minuteTimer: DateMentionClockTimer | null = null;
  let lifecycleCleanups: Array<() => void> = [];

  const hasSubscribers = () => todaySubscribers.size > 0 || minuteSubscribers.size > 0;

  const emit = (subscribers: Set<DateMentionClockListener>) => {
    subscribers.forEach((listener) => listener());
  };

  const clearTodayTimer = () => {
    if (todayTimer === null) return;
    environment.clearTimeout(todayTimer);
    todayTimer = null;
  };

  const clearMinuteTimer = () => {
    if (minuteTimer === null) return;
    environment.clearTimeout(minuteTimer);
    minuteTimer = null;
  };

  const refreshToday = () => {
    const nextTodayIso = todayIsoDate(environment.now());
    if (nextTodayIso === todayIsoSnapshot) return;
    todayIsoSnapshot = nextTodayIso;
    emit(todaySubscribers);
  };

  const refreshMinute = () => {
    const nextMinuteEpoch = getDateMentionMinuteEpoch(environment.now());
    if (nextMinuteEpoch === minuteEpochSnapshot) return;
    minuteEpochSnapshot = nextMinuteEpoch;
    emit(minuteSubscribers);
  };

  const refreshVisibleSnapshots = () => {
    if (environment.isDocumentVisible?.() === false) return;
    refreshToday();
    refreshMinute();
  };

  const syncTodaySnapshotWithoutNotify = () => {
    todayIsoSnapshot = todayIsoDate(environment.now());
  };

  const syncMinuteSnapshotWithoutNotify = () => {
    minuteEpochSnapshot = getDateMentionMinuteEpoch(environment.now());
  };

  const scheduleTodayTimer = () => {
    clearTodayTimer();
    if (todaySubscribers.size === 0) return;
    todayTimer = environment.setTimeout(() => {
      todayTimer = null;
      refreshToday();
      scheduleTodayTimer();
    }, getDelayUntilNextLocalDay(environment.now()));
  };

  const scheduleMinuteTimer = () => {
    clearMinuteTimer();
    if (minuteSubscribers.size === 0) return;
    minuteTimer = environment.setTimeout(() => {
      minuteTimer = null;
      refreshMinute();
      scheduleMinuteTimer();
    }, getDelayUntilNextMinute(environment.now()));
  };

  const ensureLifecycleListeners = () => {
    if (lifecycleCleanups.length > 0) return;
    lifecycleCleanups = [
      environment.addDocumentEventListener?.("visibilitychange", refreshVisibleSnapshots),
      environment.addWindowEventListener?.("focus", refreshVisibleSnapshots),
      environment.addWindowEventListener?.("pageshow", refreshVisibleSnapshots),
    ].filter((cleanup): cleanup is () => void => Boolean(cleanup));
  };

  const cleanupLifecycleListeners = () => {
    lifecycleCleanups.forEach((cleanup) => cleanup());
    lifecycleCleanups = [];
  };

  const cleanupIfInactive = () => {
    if (hasSubscribers()) return;
    clearTodayTimer();
    clearMinuteTimer();
    cleanupLifecycleListeners();
  };

  const subscribeToday = (listener: DateMentionClockListener) => {
    if (todaySubscribers.size === 0) {
      syncTodaySnapshotWithoutNotify();
    } else {
      refreshToday();
    }
    todaySubscribers.add(listener);
    ensureLifecycleListeners();
    scheduleTodayTimer();

    return () => {
      todaySubscribers.delete(listener);
      scheduleTodayTimer();
      cleanupIfInactive();
    };
  };

  const subscribeMinute = (listener: DateMentionClockListener) => {
    if (minuteSubscribers.size === 0) {
      syncMinuteSnapshotWithoutNotify();
    } else {
      refreshMinute();
    }
    minuteSubscribers.add(listener);
    ensureLifecycleListeners();
    scheduleMinuteTimer();

    return () => {
      minuteSubscribers.delete(listener);
      scheduleMinuteTimer();
      cleanupIfInactive();
    };
  };

  return {
    getTodayIsoSnapshot: () => {
      if (todaySubscribers.size === 0) todayIsoSnapshot = todayIsoDate(environment.now());
      return todayIsoSnapshot;
    },
    getMinuteEpochSnapshot: () => {
      if (minuteSubscribers.size === 0) {
        minuteEpochSnapshot = getDateMentionMinuteEpoch(environment.now());
      }
      return minuteEpochSnapshot;
    },
    subscribeToday,
    subscribeMinute,
    refresh: refreshVisibleSnapshots,
    destroy: () => {
      todaySubscribers.clear();
      minuteSubscribers.clear();
      clearTodayTimer();
      clearMinuteTimer();
      cleanupLifecycleListeners();
    },
  };
}

let activeDateMentionClockStore = createDateMentionClockStore();

export function setDateMentionClockStoreForTest(store: DateMentionClockStore): () => void {
  const previousStore = activeDateMentionClockStore;
  activeDateMentionClockStore = store;

  return () => {
    if (activeDateMentionClockStore === store) {
      activeDateMentionClockStore = previousStore;
    }
    store.destroy();
  };
}

export function useDateMentionTodayIso(enabled: boolean): string | null {
  const store = activeDateMentionClockStore;
  return useSyncExternalStore(
    enabled ? store.subscribeToday : subscribeNull,
    enabled ? store.getTodayIsoSnapshot : getNullSnapshot,
    enabled ? store.getTodayIsoSnapshot : getNullSnapshot,
  );
}

export function useDateMentionMinuteEpoch(enabled: boolean): number | null {
  const store = activeDateMentionClockStore;
  return useSyncExternalStore(
    enabled ? store.subscribeMinute : subscribeNull,
    enabled ? store.getMinuteEpochSnapshot : getNullSnapshot,
    enabled ? store.getMinuteEpochSnapshot : getNullSnapshot,
  );
}

function createBrowserDateMentionClockEnvironment(): DateMentionClockEnvironment {
  return {
    now: () => new Date(),
    setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimeout: (timer) =>
      globalThis.clearTimeout(timer as ReturnType<typeof globalThis.setTimeout>),
    addDocumentEventListener:
      typeof document === "undefined"
        ? undefined
        : (type, listener) => {
            document.addEventListener(type, listener);
            return () => document.removeEventListener(type, listener);
          },
    addWindowEventListener:
      typeof window === "undefined"
        ? undefined
        : (type, listener) => {
            window.addEventListener(type, listener);
            return () => window.removeEventListener(type, listener);
          },
    isDocumentVisible:
      typeof document === "undefined" ? undefined : () => document.visibilityState !== "hidden",
  };
}

function clampTimerDelay(delayMs: number): number {
  if (!Number.isFinite(delayMs) || delayMs < 0) return 0;
  return Math.min(delayMs, MAX_TIMEOUT_DELAY_MS);
}
