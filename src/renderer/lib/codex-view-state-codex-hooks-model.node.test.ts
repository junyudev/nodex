import { describe, expect, test } from "vite-plus/test";
import type { HookMetadata } from "@nodex/codex-app-server-protocol/v2/HookMetadata";
import type { HooksListEntry } from "@nodex/codex-app-server-protocol/v2/HooksListEntry";
import {
  groupCodexHooksListEntries,
  isCodexHookActive,
  resolveSelectedCodexHooksEntry,
  summarizeCodexHookEvents,
} from "./codex-hooks-model";
import {
  buildCodexHooksSettingsPath,
  parseCodexHooksSettingsSelection,
  replaceCodexHooksSettingsSelection,
} from "./codex-hooks-route";
import {
  CODEX_SIDEBAR_DISCLOSURE_TRANSITION,
  CODEX_SUMMARY_SHIFT_X,
  clampCodexPanelProgress,
  resolveCodexAnimatedPanelSize,
  resolveCodexHeaderEdgeScroll,
  resolveCodexMainContentTargetWidth,
  resolveCodexSummaryContentShift,
  resolveCodexSummaryPanelLayoutMode,
  shouldSnapCodexMotion,
} from "./codex-panel-motion";
import {
  resolveCodexSidebarMotionMounted,
  resolveCodexSidebarMotionSetOpen,
  shouldCommitCodexSidebarMotionCompletion,
} from "./codex-sidebar-motion";
import { clampCodexSidebarExtraPages } from "./codex-sidebar-pagination";

describe("codex hooks model", () => {
  type CommandHookMetadata = Extract<HookMetadata, { handlerType: "command" }>;

  function hook(
    overrides: Partial<CommandHookMetadata> & Pick<CommandHookMetadata, "key" | "source">,
  ): CommandHookMetadata {
    return {
      eventName: "stop",
      handlerType: "command",
      matcher: null,
      command: "echo done",
      async: false,
      timeoutSec: 10n,
      statusMessage: null,
      sourcePath: "/tmp/hooks.json",
      pluginId: null,
      environmentId: null,
      displayOrder: 0n,
      enabled: true,
      isManaged: false,
      currentHash: "hash",
      trustStatus: "trusted",
      ...overrides,
      additionalContextLimit: overrides.additionalContextLimit ?? null,
    };
  }

  test("managed hooks are active while review-needed hooks are not", () => {
    expect(
      isCodexHookActive(
        hook({ key: "managed", source: "mdm", trustStatus: "managed", enabled: false }),
      ),
    ).toBe(true);
    expect(isCodexHookActive(hook({ key: "new", source: "user", trustStatus: "untrusted" }))).toBe(
      false,
    );
  });

  test("summarizes interrupt hooks as a first-class event", () => {
    const summaries = summarizeCodexHookEvents([
      hook({ key: "interrupt", source: "user", eventName: "interrupt" }),
    ]);

    expect(summaries.at(-1)).toEqual({
      eventName: "interrupt",
      active: 1,
      installed: 1,
      needsReview: 0,
    });
  });

  test("includes model request hooks in event summaries", () => {
    const summaries = summarizeCodexHookEvents([
      hook({ key: "before-model", source: "user", eventName: "preModelRequest" }),
      hook({
        key: "after-model",
        source: "user",
        eventName: "postModelRequest",
        trustStatus: "untrusted",
      }),
    ]);

    expect(summaries.slice(0, 2)).toEqual([
      { eventName: "preModelRequest", active: 1, installed: 1, needsReview: 0 },
      { eventName: "postModelRequest", active: 0, installed: 1, needsReview: 1 },
    ]);
  });

  describe("Codex Hooks source grouping", () => {
    test("dedupes global hooks, keeps project roots separate, and groups plugins by protocol id", () => {
      const entries: HooksListEntry[] = [
        {
          cwd: "/workspace/a",
          hooks: [
            hook({ key: "user", source: "user" }),
            hook({ key: "admin", source: "cloudManagedConfig" }),
            hook({ key: "project-a", source: "project" }),
            hook({ key: "plugin-z", source: "plugin", pluginId: "zeta" }),
            hook({ key: "plugin-unknown", source: "plugin", pluginId: null }),
          ],
          warnings: [],
          errors: [],
        },
        {
          cwd: "/workspace/b",
          hooks: [
            hook({ key: "user", source: "user" }),
            hook({ key: "project-b", source: "project" }),
            hook({ key: "plugin-a", source: "plugin", pluginId: "alpha" }),
          ],
          warnings: [],
          errors: [],
        },
      ];

      const sections = groupCodexHooksListEntries(entries);
      expect(sections.map((section) => section.source)).toEqual([
        "plugin",
        "user",
        "admin",
        "project",
      ]);
      expect(
        sections[0]?.pluginEntries?.map((entry) =>
          entry.selection.source === "plugin" ? entry.selection.pluginId : undefined,
        ),
      ).toEqual(["alpha", "zeta", null]);
      expect(sections[1]?.entry?.hooks.map((entry) => entry.key)).toEqual(["user"]);
      expect(sections[3]?.projectEntries?.map((entry) => entry.cwd)).toEqual([
        "/workspace/a",
        "/workspace/b",
      ]);
      expect(
        resolveSelectedCodexHooksEntry(sections, {
          source: "project",
          projectRoot: "/workspace/b",
        })?.hooks.map((entry) => entry.key),
      ).toEqual(["project-b"]);
    });

    test("surfaces warning-only roots under Unknown source", () => {
      const sections = groupCodexHooksListEntries([
        {
          cwd: "/workspace/a",
          hooks: [],
          warnings: ["Could not parse hooks"],
          errors: [],
        },
      ]);

      expect(sections).toHaveLength(1);
      expect(sections[0]?.source).toBe("unknown");
      expect(sections[0]?.entry?.warnings).toEqual(["Could not parse hooks"]);
    });
  });
});

describe("Codex Hooks settings routes", () => {
  test("preserves the exact host, source, project, and plugin query contract", () => {
    expect(
      buildCodexHooksSettingsPath({
        hostId: "remote-1",
        selection: { source: "project", projectRoot: "/workspace/nodex" },
      }),
    ).toBe(
      "/settings/plugins-settings/hooks?hostId=remote-1&source=project&projectRoot=%2Fworkspace%2Fnodex",
    );

    expect(
      buildCodexHooksSettingsPath({
        hostId: "local",
        selection: { source: "plugin", pluginId: null },
      }),
    ).toBe("/settings/plugins-settings/hooks?hostId=local&source=plugin&pluginId=__unknown__");

    expect(
      buildCodexHooksSettingsPath({
        hostId: "local",
        selection: { source: "plugin" },
      }),
    ).toBe("/settings/plugins-settings/hooks?hostId=local&source=plugin");
  });

  test("parses only valid project roots and preserves aggregate versus unknown plugins", () => {
    const roots = ["/workspace/nodex"];
    expect(
      parseCodexHooksSettingsSelection(
        "/settings/plugins-settings/hooks?source=project&projectRoot=%2Fworkspace%2Fnodex",
        roots,
      ),
    ).toEqual({ source: "project", projectRoot: "/workspace/nodex" });
    expect(
      parseCodexHooksSettingsSelection(
        "/settings/plugins-settings/hooks?source=project&projectRoot=%2Fworkspace%2Fmissing",
        roots,
      ),
    ).toBeNull();
    expect(
      parseCodexHooksSettingsSelection("/settings/plugins-settings/hooks?source=plugin", roots),
    ).toEqual({ source: "plugin" });
    expect(
      parseCodexHooksSettingsSelection(
        "/settings/plugins-settings/hooks?source=plugin&pluginId=__unknown__",
        roots,
      ),
    ).toEqual({ source: "plugin", pluginId: null });
  });

  test("replaces only Hook routing fields while retaining unrelated query state", () => {
    expect(
      replaceCodexHooksSettingsSelection(
        "/settings/plugins-settings/hooks?tab=all&hostId=old&source=plugin&pluginId=old",
        {
          hostId: "local",
          selection: { source: "project", projectRoot: "/workspace/nodex" },
        },
      ),
    ).toBe(
      "/settings/plugins-settings/hooks?tab=all&hostId=local&source=project&projectRoot=%2Fworkspace%2Fnodex",
    );

    expect(
      replaceCodexHooksSettingsSelection(
        "/settings/plugins-settings/hooks?tab=all&hostId=local&source=user",
        { hostId: "local", selection: null },
      ),
    ).toBe("/settings/plugins-settings/hooks?tab=all");
  });
});

describe("Codex panel motion helpers", () => {
  test("matches the Codex sidebar disclosure transition", () => {
    expect(CODEX_SIDEBAR_DISCLOSURE_TRANSITION.duration).toBe(0.3);
    expect(
      Array.isArray(CODEX_SIDEBAR_DISCLOSURE_TRANSITION.ease)
        ? CODEX_SIDEBAR_DISCLOSURE_TRANSITION.ease.join(",")
        : "",
    ).toBe("0.19,1,0.22,1");
  });

  test("clamps panel progress to the Codex 0..1 range", () => {
    expect(clampCodexPanelProgress(-0.5)).toBe(0);
    expect(clampCodexPanelProgress(0.42)).toBe(0.42);
    expect(clampCodexPanelProgress(1.5)).toBe(1);
    expect(clampCodexPanelProgress(Number.NaN)).toBe(0);
  });

  test("derives animated size from clamped progress and target size", () => {
    expect(resolveCodexAnimatedPanelSize(0, 600)).toBe(0);
    expect(resolveCodexAnimatedPanelSize(0.5, 600)).toBe(300);
    expect(resolveCodexAnimatedPanelSize(2, 600)).toBe(600);
    expect(resolveCodexAnimatedPanelSize(0.5, -1)).toBe(0);
  });

  test("matches Codex summary display breakpoints", () => {
    expect(resolveCodexSummaryPanelLayoutMode(1095)).toBe("overlay");
    expect(resolveCodexSummaryPanelLayoutMode(1096)).toBe("shift");
    expect(resolveCodexSummaryPanelLayoutMode(1535)).toBe("shift");
    expect(resolveCodexSummaryPanelLayoutMode(1536)).toBe("gutter");
    expect(resolveCodexSummaryPanelLayoutMode(736 + 179 * 2)).toBe("overlay");
    expect(resolveCodexSummaryPanelLayoutMode(736 + 180 * 2)).toBe("shift");
    expect(resolveCodexSummaryPanelLayoutMode(736 + 399 * 2)).toBe("shift");
    expect(resolveCodexSummaryPanelLayoutMode(736 + 400 * 2)).toBe("gutter");
  });

  test("derives Codex main content target width from shell panel reservations", () => {
    expect(
      resolveCodexMainContentTargetWidth({
        shellWidth: 1800,
        leftSidebarOpen: false,
        leftSidebarWidth: 300,
        rightPanelOpen: false,
        rightPanelWidth: 600,
      }),
    ).toBe(1800);
    expect(
      resolveCodexMainContentTargetWidth({
        shellWidth: 1800,
        leftSidebarOpen: true,
        leftSidebarWidth: 300,
        rightPanelOpen: true,
        rightPanelWidth: 500,
      }),
    ).toBe(1000);
    expect(
      resolveCodexMainContentTargetWidth({
        shellWidth: 1800,
        leftSidebarOpen: true,
        leftSidebarWidth: 300,
        rightPanelOpen: true,
        rightPanelWidth: 500,
        rightPanelFullWidth: true,
      }),
    ).toBe(0);
  });

  test("matches Codex thread edge-scroll guards", () => {
    expect(
      resolveCodexHeaderEdgeScroll({
        layout: "thread-edge-scroll",
        mainContentWidth: 1535,
      }),
    ).toBe(false);
    expect(
      resolveCodexHeaderEdgeScroll({
        layout: "thread-edge-scroll",
        mainContentWidth: 1536,
      }),
    ).toBe(true);
    expect(
      resolveCodexHeaderEdgeScroll({
        layout: "thread-edge-scroll",
        mainContentWidth: 1536,
        rightPanelFullWidth: true,
      }),
    ).toBe(false);
    expect(
      resolveCodexHeaderEdgeScroll({
        layout: "full-bleed",
        mainContentWidth: 1536,
      }),
    ).toBe(false);
  });

  test("applies Codex shift only for pinned shift mode", () => {
    expect(CODEX_SUMMARY_SHIFT_X).toBe(-154);
    expect(resolveCodexSummaryContentShift({ layoutMode: "shift", pinnedOpen: true })).toBe(-154);
    expect(resolveCodexSummaryContentShift({ layoutMode: "shift", pinnedOpen: false })).toBe(0);
    expect(resolveCodexSummaryContentShift({ layoutMode: "overlay", pinnedOpen: true })).toBe(0);
    expect(resolveCodexSummaryContentShift({ layoutMode: "gutter", pinnedOpen: true })).toBe(0);
  });

  test("snaps panel motion for reduced motion or explicit non-animated updates", () => {
    expect(shouldSnapCodexMotion(true, true)).toBe(true);
    expect(shouldSnapCodexMotion(false, false)).toBe(true);
    expect(shouldSnapCodexMotion(null, true)).toBe(false);
    expect(shouldSnapCodexMotion(false, true)).toBe(false);
  });
});

describe("Codex sidebar motion controller helpers", () => {
  test("keeps the inline sidebar mounted while closing progress is still visible", () => {
    expect(resolveCodexSidebarMotionMounted({ logicalOpen: true, progress: 0 })).toBe(true);
    expect(resolveCodexSidebarMotionMounted({ logicalOpen: false, progress: 0.25 })).toBe(true);
    expect(resolveCodexSidebarMotionMounted({ logicalOpen: false, progress: 0 })).toBe(false);
  });

  test("snaps reduced-motion and animate false updates to the target progress", () => {
    const reducedMotionResolution = resolveCodexSidebarMotionSetOpen({
      nextOpen: true,
      animate: true,
      reducedMotion: true,
    });
    expect(reducedMotionResolution.targetProgress).toBe(1);
    expect(reducedMotionResolution.shouldAnimate).toBe(false);

    const nonAnimatedResolution = resolveCodexSidebarMotionSetOpen({
      nextOpen: false,
      animate: false,
      reducedMotion: false,
    });
    expect(nonAnimatedResolution.targetProgress).toBe(0);
    expect(nonAnimatedResolution.shouldAnimate).toBe(false);
  });

  test("ignores stale animation completions after a newer toggle generation starts", () => {
    expect(
      shouldCommitCodexSidebarMotionCompletion({
        completionGeneration: 3,
        currentGeneration: 4,
      }),
    ).toBe(false);
    expect(
      shouldCommitCodexSidebarMotionCompletion({
        completionGeneration: 4,
        currentGeneration: 4,
      }),
    ).toBe(true);
  });
});

describe("clampCodexSidebarExtraPages", () => {
  test("stops Show more at the step that reaches the reveal limit", () => {
    expect(clampCodexSidebarExtraPages(9, 10, 30)).toBe(4);
    expect(clampCodexSidebarExtraPages(2, 10, 30)).toBe(2);
    // A limit between steps reveals the step that covers it.
    expect(clampCodexSidebarExtraPages(9, 10, 27)).toBe(4);
    expect(clampCodexSidebarExtraPages(9, 10, undefined)).toBe(9);
    expect(clampCodexSidebarExtraPages(9, null, 30)).toBe(9);
  });
});
