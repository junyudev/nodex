import { describe, expect, it, vi } from "vitest";
import { createDictationMicrophoneLeaseClient } from "./dictation-microphone-lease-client";

const fixture = () => {
  const listeners = new Set<(sessionId: string) => void>();
  const released: string[] = [];
  const ports = {
    acquire: vi.fn(async () => true),
    release: vi.fn(async (sessionId: string) => void released.push(sessionId)),
    subscribeRelinquish: (listener: (sessionId: string) => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
  return {
    ports,
    lease: createDictationMicrophoneLeaseClient(ports),
    listeners,
    released,
    relinquish: (sessionId: string) => {
      for (const listener of [...listeners]) listener(sessionId);
    },
  };
};

describe("Dictation microphone relinquish", () => {
  it("addresses only the exact active capture and unsubscribes before release", async () => {
    const f = fixture();
    const cancel = vi.fn(() => void f.lease.release("actual"));
    await f.lease.acquire("actual", "composer", cancel);
    f.relinquish("foreign");
    expect(cancel).not.toHaveBeenCalled();
    f.relinquish("actual");
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledOnce();
    expect(f.released).toEqual(["actual"]);
    expect(f.listeners.size).toBe(0);
    f.relinquish("actual");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("removes denied capture callbacks and fences a reused session's old listener", async () => {
    const f = fixture();
    f.ports.acquire.mockResolvedValueOnce(false);
    const denied = vi.fn();
    expect(await f.lease.acquire("capture", "composer", denied)).toBe(false);
    expect(f.listeners.size).toBe(0);
    const first = vi.fn();
    const next = vi.fn();
    await f.lease.acquire("capture", "composer", first);
    const old = [...f.listeners][0];
    await f.lease.acquire("capture", "global", next);
    old?.("capture");
    expect(first).not.toHaveBeenCalled();
    f.relinquish("capture");
    expect(next).toHaveBeenCalledOnce();
  });
});
