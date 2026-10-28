import { describe, expect, test } from "vite-plus/test";
import {
  createDateMentionClockStore,
  getDelayUntilNextMinute,
  type DateMentionClockEnvironment,
} from "./date-mention-clock";

type Listener = () => void;

interface ScheduledTimer {
  id: number;
  callback: Listener;
  delayMs: number;
}

function createManualClock(start: string) {
  let currentNow = new Date(start);
  let nextTimerId = 1;
  let visible = true;
  const timers = new Map<number, ScheduledTimer>();
  const listeners = {
    document: new Map<string, Set<Listener>>(),
    window: new Map<string, Set<Listener>>(),
  };

  const addListener = (target: "document" | "window", type: string, listener: Listener) => {
    const targetListeners = listeners[target];
    const typeListeners = targetListeners.get(type) ?? new Set<Listener>();
    typeListeners.add(listener);
    targetListeners.set(type, typeListeners);
    return () => {
      typeListeners.delete(listener);
      if (typeListeners.size === 0) targetListeners.delete(type);
    };
  };

  const emit = (target: "document" | "window", type: string) => {
    Array.from(listeners[target].get(type) ?? []).forEach((listener) => listener());
  };

  const environment: DateMentionClockEnvironment = {
    now: () => new Date(currentNow.getTime()),
    setTimeout: (callback, delayMs) => {
      const id = nextTimerId;
      nextTimerId += 1;
      timers.set(id, { id, callback, delayMs });
      return id;
    },
    clearTimeout: (timer) => {
      timers.delete(timer as number);
    },
    addDocumentEventListener: (type, listener) => addListener("document", type, listener),
    addWindowEventListener: (type, listener) => addListener("window", type, listener),
    isDocumentVisible: () => visible,
  };

  return {
    environment,
    setNow: (value: string) => {
      currentNow = new Date(value);
    },
    setVisible: (value: boolean) => {
      visible = value;
    },
    emitDocument: (type: string) => emit("document", type),
    emitWindow: (type: string) => emit("window", type),
    runNextTimer: () => {
      const timer = Array.from(timers.values())[0];
      if (!timer) throw new Error("No scheduled timer");
      timers.delete(timer.id);
      timer.callback();
    },
    timerCount: () => timers.size,
    listenerCount: () => countListeners(listeners.document) + countListeners(listeners.window),
    firstTimerDelay: () => Array.from(timers.values())[0]?.delayMs ?? null,
  };
}

describe("date mention clock store", () => {
  test("notifies today subscribers only when the local day changes", () => {
    const clock = createManualClock("2026-06-28T12:00:00");
    const store = createDateMentionClockStore(clock.environment);
    const notifications: string[] = [];

    const unsubscribe = store.subscribeToday(() => {
      notifications.push(store.getTodayIsoSnapshot());
    });

    expect(store.getTodayIsoSnapshot()).toBe("2026-06-28");
    clock.setNow("2026-06-28T23:59:30");
    store.refresh();
    expect(notifications.length).toBe(0);

    clock.setNow("2026-06-29T00:00:02");
    store.refresh();
    expect(notifications.length).toBe(1);
    expect(notifications[0]).toBe("2026-06-29");

    unsubscribe();
    store.destroy();
  });

  test("schedules minute subscribers at the next minute boundary with a guard", () => {
    const clock = createManualClock("2026-06-28T12:34:10");
    const store = createDateMentionClockStore(clock.environment);
    const notifications: number[] = [];

    const unsubscribe = store.subscribeMinute(() => {
      notifications.push(store.getMinuteEpochSnapshot());
    });

    expect(clock.firstTimerDelay()).toBe(getDelayUntilNextMinute(new Date("2026-06-28T12:34:10")));

    clock.setNow("2026-06-28T12:35:00.250");
    clock.runNextTimer();

    expect(notifications.length).toBe(1);
    expect(notifications[0]).toBe(new Date("2026-06-28T12:35:00").getTime());
    expect(clock.timerCount()).toBe(1);

    unsubscribe();
    store.destroy();
  });

  test("uses visibility and page lifecycle events to catch up delayed timers", () => {
    const clock = createManualClock("2026-06-28T23:58:00");
    const store = createDateMentionClockStore(clock.environment);
    const notifications: string[] = [];

    const unsubscribe = store.subscribeToday(() => {
      notifications.push(store.getTodayIsoSnapshot());
    });

    clock.setNow("2026-06-29T00:04:00");
    clock.emitDocument("visibilitychange");
    expect(notifications.length).toBe(1);
    expect(notifications[0]).toBe("2026-06-29");

    clock.setVisible(false);
    clock.setNow("2026-06-30T00:04:00");
    clock.emitWindow("focus");
    expect(notifications.length).toBe(1);

    clock.setVisible(true);
    clock.emitWindow("pageshow");
    expect(notifications.length).toBe(2);
    expect(notifications[1]).toBe("2026-06-30");

    unsubscribe();
    store.destroy();
  });

  test("does not silently advance an active lane when another lane subscribes", () => {
    const clock = createManualClock("2026-06-28T23:58:00");
    const store = createDateMentionClockStore(clock.environment);
    const todayNotifications: string[] = [];

    const unsubscribeToday = store.subscribeToday(() => {
      todayNotifications.push(store.getTodayIsoSnapshot());
    });
    clock.setNow("2026-06-29T00:04:00");

    const unsubscribeMinute = store.subscribeMinute(() => undefined);
    expect(store.getTodayIsoSnapshot()).toBe("2026-06-28");

    store.refresh();
    expect(todayNotifications.length).toBe(1);
    expect(todayNotifications[0]).toBe("2026-06-29");

    unsubscribeMinute();
    unsubscribeToday();
    store.destroy();
  });

  test("cleans timers and global listeners after the final unsubscribe", () => {
    const clock = createManualClock("2026-06-28T12:00:00");
    const store = createDateMentionClockStore(clock.environment);

    const unsubscribeToday = store.subscribeToday(() => undefined);
    const unsubscribeMinute = store.subscribeMinute(() => undefined);

    expect(clock.timerCount()).toBe(2);
    expect(clock.listenerCount()).toBe(3);

    unsubscribeToday();
    expect(clock.timerCount()).toBe(1);
    expect(clock.listenerCount()).toBe(3);

    unsubscribeMinute();
    expect(clock.timerCount()).toBe(0);
    expect(clock.listenerCount()).toBe(0);

    store.destroy();
  });
});

function countListeners(listeners: Map<string, Set<Listener>>): number {
  let count = 0;
  listeners.forEach((typeListeners) => {
    count += typeListeners.size;
  });
  return count;
}
