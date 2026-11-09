import { expect, test, vi } from "vite-plus/test";
import {
  createElectronRendererTransport,
  type ElectronRendererBridge,
} from "./electron-renderer-transport";
import { rendererSpaceId } from "./renderer-space";
import type { ReadbackEvent } from "../../shared/readback";

const show = {
  type: "show",
  readback: {
    id: "readback:chat:run",
    sessionId: "chat",
    threadId: "root",
    runId: "run",
    itemId: "opening",
    title: "Title",
    text: "**Opening**",
    createdAt: 123,
    navigation: {
      hostId: "local",
      conversationId: "root",
      navigationPath: "session:chat/thread:root",
      activateTabId: null,
    },
  },
} satisfies ReadbackEvent;

test("delivers validated Readback events only to the bound Space and releases the subscription", () => {
  let receive: ((...args: unknown[]) => void) | undefined;
  const release = vi.fn();
  const bridge = {
    on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
      expect(channel).toBe("readback:event");
      receive = listener;
      return release;
    }),
  } as unknown as ElectronRendererBridge;
  const listener = vi.fn();
  const unsubscribe = createElectronRendererTransport(bridge).subscribeReadbackEvents(listener);
  receive?.({ ...show, spaceId: "other-space" });
  receive?.(show);
  expect(listener).not.toHaveBeenCalled();
  receive?.({ ...show, spaceId: rendererSpaceId() });
  expect(listener).toHaveBeenLastCalledWith(show);
  for (const reason of ["seen", "ended", "disabled", "removed"] as const) {
    const event = { type: "withdraw", id: show.readback.id, reason };
    receive?.({ ...event, spaceId: rendererSpaceId() });
    expect(listener).toHaveBeenLastCalledWith(event);
  }
  expect(listener).toHaveBeenCalledTimes(5);
  unsubscribe();
  expect(release).toHaveBeenCalledOnce();
});

test("rejects malformed Readbacks, navigation, timestamps and withdrawal reasons", () => {
  let receive: ((...args: unknown[]) => void) | undefined;
  const bridge = {
    on: (_channel: string, listener: (...args: unknown[]) => void) => {
      receive = listener;
      return () => {};
    },
  } as unknown as ElectronRendererBridge;
  const listener = vi.fn();
  createElectronRendererTransport(bridge).subscribeReadbackEvents(listener);
  const payload = { ...show, spaceId: rendererSpaceId() };
  const malformed = [
    null,
    [],
    "show",
    { ...payload, type: "hide" },
    { ...payload, readback: null },
    { ...payload, readback: { ...show.readback, runId: 1 } },
    { ...payload, readback: { ...show.readback, itemId: "" } },
    { ...payload, readback: { ...show.readback, createdAt: NaN } },
    { ...payload, readback: { ...show.readback, createdAt: Infinity } },
    {
      ...payload,
      readback: { ...show.readback, navigation: { ...show.readback.navigation, hostId: " " } },
    },
    {
      ...payload,
      readback: { ...show.readback, navigation: { ...show.readback.navigation, activateTabId: 9 } },
    },
    { spaceId: rendererSpaceId(), type: "withdraw", id: "id", reason: "timeout" },
    { spaceId: rendererSpaceId(), type: "withdraw", id: "id" },
  ];
  for (const value of malformed) receive?.(value);
  expect(listener).not.toHaveBeenCalled();
});
