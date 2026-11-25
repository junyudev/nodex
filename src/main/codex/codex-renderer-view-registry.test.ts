import { describe, expect, test } from "vite-plus/test";
import { CodexRendererViewRegistry } from "./codex-renderer-view-registry";
import type { Config } from "@nodex/codex-app-server-protocol/v2/Config";
import { expandCodexDynamicCreateConfigProfile } from "./codex-dynamic-create-config";
import path from "node:path";
import { resolveCodexThreadVisualizationDirectory } from "./codex-dynamic-first-turn-context";

describe("CodexRendererViewRegistry", () => {
  test("routes presentation to the most recently presented renderer", () => {
    const registry = new CodexRendererViewRegistry();

    registry.setPresented("thread-1", "renderer-1", "surface-1", true);
    registry.setPresented("thread-1", "renderer-2", "surface-2", true);
    expect(registry.resolvePresentedSurfaceClient("thread-1")).toBe("renderer-2");

    registry.setPresented("thread-1", "renderer-1", "surface-1", false);
    registry.setPresented("thread-1", "renderer-1", "surface-3", true);
    expect(registry.resolvePresentedSurfaceClient("thread-1")).toBe("renderer-1");
  });

  test("falls back to another visible renderer when the latest client leaves", () => {
    const registry = new CodexRendererViewRegistry();
    registry.setPresented("thread-1", "renderer-1", "surface-1", true);
    registry.setPresented("thread-1", "renderer-2", "surface-2", true);

    registry.setPresented("thread-1", "renderer-2", "surface-2", false);

    expect(registry.resolvePresentedSurfaceClient("thread-1")).toBe("renderer-1");
  });

  test("removes every view owned by a disposed client without affecting peers", () => {
    const registry = new CodexRendererViewRegistry();
    registry.setPresented("thread-1", "renderer-1", "surface-1", true);
    registry.setPresented("thread-2", "renderer-1", "surface-2", true);
    registry.setPresented("thread-2", "renderer-2", "surface-3", true);

    expect(registry.removeClient("renderer-1")).toEqual(["thread-1", "thread-2"]);
    expect(registry.resolvePresentedSurfaceClient("thread-1")).toBeNull();
    expect(registry.resolvePresentedSurfaceClient("thread-2")).toBe("renderer-2");

    registry.clearConversation("thread-2");
  });

  test("requires a surface and a focused client for foreground presentation", () => {
    const registry = new CodexRendererViewRegistry();

    registry.setClientForegrounded("renderer-1", true);
    expect(registry.isPresentedInForeground("thread-1")).toBe(false);

    registry.setPresented("thread-1", "renderer-1", "surface-1", true);
    expect(registry.isPresentedInForeground("thread-1")).toBe(true);

    registry.setClientForegrounded("renderer-1", false);
    expect(registry.isPresentedInForeground("thread-1")).toBe(false);

    registry.setClientForegrounded("renderer-2", true);
    registry.setPresented("thread-1", "renderer-2", "surface-2", true);
    expect(registry.isPresentedInForeground("thread-1")).toBe(true);

    registry.removeClient("renderer-2");
    expect(registry.isPresentedInForeground("thread-1")).toBe(false);
  });

  test("keeps a conversation presented until every client surface leaves", () => {
    const registry = new CodexRendererViewRegistry();
    registry.setClientForegrounded("renderer-1", true);
    registry.setPresented("thread-1", "renderer-1", "surface-1", true);
    registry.setPresented("thread-1", "renderer-1", "surface-2", true);

    registry.setPresented("thread-1", "renderer-1", "surface-1", false);
    expect(registry.isClientPresenting("thread-1", "renderer-1")).toBe(true);
    expect(registry.isPresentedInForeground("thread-1")).toBe(true);

    registry.setPresented("thread-1", "renderer-1", "surface-2", false);
    expect(registry.isClientPresenting("thread-1", "renderer-1")).toBe(false);
    expect(registry.isPresentedInForeground("thread-1")).toBe(false);
  });

  test("repeated surface reports preserve the most recently presented client", () => {
    const registry = new CodexRendererViewRegistry();
    registry.setPresented("thread-1", "renderer-1", "surface-1", true);
    registry.setPresented("thread-1", "renderer-2", "surface-2", true);
    registry.setPresented("thread-1", "renderer-1", "surface-1", true);
    registry.setPresented("thread-1", "renderer-1", "surface-3", true);
    expect(registry.resolvePresentedSurfaceClient("thread-1")).toBe("renderer-2");

    registry.clearConversation("thread-1");
    expect(registry.resolvePresentedSurfaceClient("thread-1")).toBeNull();
    expect(registry.isClientPresenting("thread-1", "renderer-1")).toBe(false);
  });
});

describe("codex-dynamic-create-config", () => {
  describe("codex-dynamic-create-config", () => {
    describe("dynamic create config snapshot", () => {
      test("overlays only non-null selected-profile values", () => {
        const config = {
          profile: "delegated",
          model: "base-model",
          approval_policy: "on-request",
          approvals_reviewer: "user",
          profiles: {
            delegated: {
              model: "profile-model",
              approval_policy: null,
              approvals_reviewer: undefined,
              service_tier: "fast",
            },
          },
        } as unknown as Config;

        const expanded = expandCodexDynamicCreateConfigProfile(config) as unknown as Record<
          string,
          unknown
        >;
        expect(expanded.model).toBe("profile-model");
        expect(expanded.approval_policy).toBe("on-request");
        expect(expanded.approvals_reviewer).toBe("user");
        expect(expanded.service_tier).toBe("fast");
      });

      test("preserves identity without a valid selected profile", () => {
        const config = { model: "base-model" } as unknown as Config;
        expect(expandCodexDynamicCreateConfigProfile(config) === config).toBe(true);
      });
    });
  });

  describe("codex-dynamic-first-turn-context", () => {
    describe("Codex dynamic first-turn context", () => {
      test("derives the exact UTC visualization directory from a UUIDv7 thread id", () => {
        const threadId = "0197f6e8-8c00-7000-8000-000000000000";

        const directory = resolveCodexThreadVisualizationDirectory(
          path.resolve("/home/.codex"),
          threadId,
        );

        expect(directory).toBe(path.resolve("/home/.codex/visualizations/2025/07/11", threadId));
        expect(
          resolveCodexThreadVisualizationDirectory(path.resolve("/home/.codex"), "thread-test"),
        ).toBe(null);
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
            path.resolve("/home/.codex"),
            threadId.replace("-0004-", "-0001-"),
          ),
        ).toBeNull();
      });
    });
  });
});
