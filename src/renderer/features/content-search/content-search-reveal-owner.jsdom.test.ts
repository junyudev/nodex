import { describe, expect, test, vi } from "vite-plus/test";
import {
  registerContentSearchRevealOwner,
  revealContentSearchUnit,
} from "./content-search-reveal-owner";

describe("mounted content search reveal ownership", () => {
  test("reveals only disclosure owners inside the addressed content unit", () => {
    const unit = document.createElement("div");
    const clip = document.createElement("div");
    const peer = document.createElement("div");
    unit.append(clip);
    const reveal = vi.fn();
    const revealPeer = vi.fn();
    const release = registerContentSearchRevealOwner(clip, reveal);
    const releasePeer = registerContentSearchRevealOwner(peer, revealPeer);
    expect(revealContentSearchUnit(unit)).toBe(true);
    expect(reveal).toHaveBeenCalledOnce();
    expect(revealPeer).not.toHaveBeenCalled();
    release();
    releasePeer();
    expect(revealContentSearchUnit(unit)).toBe(false);
  });

  test("a retired registration cannot remove its replacement owner", () => {
    const unit = document.createElement("div");
    const old = vi.fn();
    const current = vi.fn();
    const releaseOld = registerContentSearchRevealOwner(unit, old);
    const releaseCurrent = registerContentSearchRevealOwner(unit, current);
    releaseOld();
    expect(revealContentSearchUnit(unit)).toBe(true);
    expect(current).toHaveBeenCalledOnce();
    expect(old).not.toHaveBeenCalled();
    releaseCurrent();
    expect(revealContentSearchUnit(unit)).toBe(false);
  });
});
