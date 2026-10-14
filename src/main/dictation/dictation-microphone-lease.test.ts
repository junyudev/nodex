import { describe, expect, it, vi } from "vitest";
import { DictationMicrophoneLease } from "./dictation-microphone-lease";

const owner = (webContentsId: number, sessionId: string) => ({
  kind: "dictation" as const,
  webContentsId,
  sessionId,
  surface: "composer" as const,
});

describe("DictationMicrophoneLease", () => {
  it("admits one owner and uses compare-and-release semantics", () => {
    const lease = new DictationMicrophoneLease();
    const changed = vi.fn();
    lease.subscribe(changed);

    expect(lease.acquire(owner(1, "first"))).toBe(true);
    expect(lease.acquire(owner(1, "first"))).toBe(true);
    expect(lease.acquire(owner(2, "second"))).toBe(false);
    expect(lease.release(2, "second")).toBe(false);
    expect(lease.getOwner()).toEqual(owner(1, "first"));
    expect(lease.release(1, "first")).toBe(true);
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("releases a crashed renderer without affecting another owner", () => {
    const lease = new DictationMicrophoneLease();
    lease.acquire(owner(7, "active"));

    expect(lease.releaseOwner(8)).toBe(false);
    expect(lease.releaseOwner(7)).toBe(true);
    expect(lease.getOwner()).toBeNull();
  });
});
