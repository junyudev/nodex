import { expect, test, vi } from "vite-plus/test";
import type { AppComponentsState } from "../../../shared/app-components";
import type { AppComponentsRuntime } from "../../lib/app-components-runtime";
import { createAppComponentsOwner } from "./app-components-owner";

const snapshot = (revision: number): AppComponentsState => ({ revision, components: [] });

test("subscribes before reading, drops stale results, and detaches after the last observer", async () => {
  let answerRead!: (state: AppComponentsState) => void;
  const initial = new Promise<AppComponentsState>((resolve) => {
    answerRead = resolve;
  });
  const unsubscribe = vi.fn();
  let emit: ((state: AppComponentsState) => void) | undefined;
  const runtime = {
    read: vi.fn(() => {
      expect(emit).toBeDefined();
      return initial;
    }),
    subscribe: vi.fn((listener) => {
      emit = listener;
      return unsubscribe;
    }),
    setEnabled: vi.fn(() => Promise.resolve(snapshot(2))),
    request: vi.fn(() => Promise.resolve(snapshot(3))),
    retry: vi.fn(() => Promise.resolve(snapshot(4))),
  } satisfies AppComponentsRuntime;
  const owner = createAppComponentsOwner(runtime);
  expect(owner.getSnapshot()).toBeNull();
  expect(runtime.read).not.toHaveBeenCalled();
  const first = vi.fn();
  const second = vi.fn();
  const stopFirst = owner.subscribe(first);
  const stopSecond = owner.subscribe(second);
  emit?.(snapshot(3));
  answerRead(snapshot(1));
  await owner.setEnabled({ id: "desktop-tools", enabled: false });
  expect(first).toHaveBeenCalledOnce();
  expect(second).toHaveBeenCalledOnce();
  expect(owner.getSnapshot()).toEqual(snapshot(3));
  expect(runtime.read).toHaveBeenCalledOnce();

  stopFirst();
  expect(unsubscribe).not.toHaveBeenCalled();
  await owner.retry("desktop-tools");
  expect(first).toHaveBeenCalledOnce();
  expect(second).toHaveBeenCalledTimes(2);
  expect(owner.getSnapshot()).toEqual(snapshot(4));
  stopSecond();
  expect(unsubscribe).toHaveBeenCalledOnce();
});
