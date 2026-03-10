import { describe, expect, test } from "bun:test";
import { spawn, write, resize, kill, killAll, isAlive } from "./pty-manager";

// node-pty is compiled for Electron's Node ABI. When running under Bun/Node
// (outside Electron), spawn will fail with "posix_spawnp failed". Tests that
// require a live PTY are guarded by a canSpawn check.
function trySpawn(id: string, opts = { cols: 80, rows: 24 }) {
  return spawn(id, opts, () => {}, () => {});
}

const canSpawn = (() => {
  const r = trySpawn("__probe__");
  kill("__probe__");
  return r.success;
})();

describe("pty-manager", () => {
  test("spawn returns a result object with success field", () => {
    const result = trySpawn("test-result");
    expect(typeof result.success).toBe("boolean");
    killAll();
  });

  test("write is safe for unknown session", () => {
    write("nonexistent", "data");
    expect(true).toBe(true);
  });

  test("kill is safe for unknown session", () => {
    kill("nonexistent");
    expect(true).toBe(true);
  });

  test("resize is safe for unknown session", () => {
    resize("nonexistent", 120, 40);
    expect(true).toBe(true);
  });

  test("killAll is safe when empty", () => {
    killAll();
    expect(true).toBe(true);
  });

  test("isAlive returns false for unknown session", () => {
    expect(isAlive("nonexistent")).toBe(false);
  });

  test("spawn gracefully handles success or ABI mismatch", () => {
    const result = trySpawn("test-graceful");
    if (result.success) {
      expect(isAlive("test-graceful")).toBe(true);
      kill("test-graceful");
      expect(isAlive("test-graceful")).toBe(false);
    } else {
      expect(typeof result.error).toBe("string");
    }
    killAll();
  });

  test("double spawn deduplicates when PTY is available", () => {
    if (!canSpawn) {
      expect(true).toBe(true);
      return;
    }
    trySpawn("test-dup");
    const second = trySpawn("test-dup");
    expect(second.success).toBe(true);
    killAll();
  });

  test("killAll removes all sessions when PTY is available", () => {
    if (!canSpawn) {
      expect(true).toBe(true);
      return;
    }
    trySpawn("k1");
    trySpawn("k2");
    expect(isAlive("k1")).toBe(true);
    expect(isAlive("k2")).toBe(true);
    killAll();
    expect(isAlive("k1")).toBe(false);
    expect(isAlive("k2")).toBe(false);
  });
});
