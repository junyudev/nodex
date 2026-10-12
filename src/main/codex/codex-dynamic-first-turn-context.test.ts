import { describe, expect, test } from "vite-plus/test";
import path from "node:path";
import {
  augmentCodexDynamicFirstTurnPermissionContext,
  resolveCodexThreadVisualizationDirectory,
} from "./codex-dynamic-first-turn-context";

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

  test("adds retained, cwd, and visualization roots to a profile selection", () => {
    const context = augmentCodexDynamicFirstTurnPermissionContext({
      context: {
        activePermissionProfile: { id: ":workspace", extends: null },
        runtimeWorkspaceRoots: ["/workspace"],
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: ["/workspace"],
          networkAccess: false,
          excludeSlashTmp: false,
          excludeTmpdirEnvVar: false,
        },
      },
      cwd: "/workspace",
      retainedWritableRoots: ["/retained"],
      visualizationDirectory: "/home/.codex/visualizations/day/thread",
    });

    expect(JSON.stringify(context.runtimeWorkspaceRoots)).toBe(
      JSON.stringify(["/workspace", "/retained", "/home/.codex/visualizations/day/thread"]),
    );
    expect(
      JSON.stringify(
        context.sandboxPolicy.type === "workspaceWrite" ? context.sandboxPolicy.writableRoots : [],
      ),
    ).toBe(JSON.stringify(["/workspace", "/retained", "/home/.codex/visualizations/day/thread"]));
  });

  test("keeps runtime roots absent for an explicit sandbox selection", () => {
    const context = augmentCodexDynamicFirstTurnPermissionContext({
      context: {
        activePermissionProfile: null,
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: ["/workspace"],
          networkAccess: false,
          excludeSlashTmp: false,
          excludeTmpdirEnvVar: false,
        },
      },
      cwd: "/workspace",
      retainedWritableRoots: ["/retained"],
      visualizationDirectory: null,
    });

    expect(context.runtimeWorkspaceRoots).toBe(undefined);
    expect(
      JSON.stringify(
        context.sandboxPolicy.type === "workspaceWrite" ? context.sandboxPolicy.writableRoots : [],
      ),
    ).toBe(JSON.stringify(["/workspace", "/retained"]));
  });
});
