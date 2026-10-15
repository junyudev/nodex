import { describe, expect, test } from "vite-plus/test";
import path from "node:path";
import { resolveCodexThreadVisualizationDirectory } from "./codex-dynamic-first-turn-context";

describe("Codex dynamic first-turn context", () => {
  test("derives the exact UTC visualization directory from a UUIDv7 thread id", () => {
    const threadId = "0197f6e8-8c00-7000-8000-000000000000";

    const directory = resolveCodexThreadVisualizationDirectory("/home/.codex", threadId);

    expect(directory).toBe(`/home/.codex/visualizations/2025/07/11/${threadId}`);
    expect(resolveCodexThreadVisualizationDirectory("/home/.codex", "thread-test")).toBe(null);
  });

  test("supports second-based UUIDv8 identities and uses the selected host path grammar", () => {
    const seconds = Date.parse("2026-10-12T00:00:00Z") / 1_000;
    const threadId = `${seconds.toString(16)}-0004-8000-8000-000000000000`;
    expect(resolveCodexThreadVisualizationDirectory("/home/.codex", threadId, path.posix)).toBe(
      `/home/.codex/visualizations/2026/10/12/${threadId}`,
    );
    expect(resolveCodexThreadVisualizationDirectory("C:\\Codex", threadId, path.win32)).toBe(
      `C:\\Codex\\visualizations\\2026\\10\\12\\${threadId}`,
    );
    expect(
      resolveCodexThreadVisualizationDirectory(
        "/home/.codex",
        threadId.replace("-0004-", "-0001-"),
      ),
    ).toBeNull();
  });
});
