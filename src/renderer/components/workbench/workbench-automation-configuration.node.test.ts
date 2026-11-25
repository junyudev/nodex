import { describe, expect, test } from "vite-plus/test";
import type { Project } from "@/lib/types";
import {
  buildWorkbenchAutomationProjectOptions,
  formatWorkbenchAutomationProjectTriggerLabel,
  resolveWorkbenchAutomationProjectForRoot,
  toggleWorkbenchAutomationProjectRoot,
  selectWorkbenchAutomationProjectRoot,
} from "./workbench-automation-project-options";
import {
  buildWorkbenchAutomationScheduleRrule,
  formatWorkbenchAutomationScheduleLabel,
  resolveWorkbenchAutomationScheduleConfig,
  updateWorkbenchAutomationScheduleConfig,
} from "./workbench-automation-schedule";
import {
  WORKBENCH_AUTOMATION_TEMPLATES,
  createWorkbenchAutomationDraftFromTemplate,
} from "./workbench-automation-templates";

describe("workbench automation project options", () => {
  function makeProject(input: {
    id: string;
    name?: string;
    roots?: string[];
    primaryWorkspaceRoot?: string | null;
  }): Project {
    const roots = input.roots ?? [];
    return {
      id: input.id,
      libraryId: "library:test",
      databaseId: "database:test:primary",
      defaultDatabaseViewId: "view:test:primary",
      lifecycle: "active",
      bindingRevision: 1,
      name: input.name ?? input.id,
      description: "",
      appearance: { color: "black", marker: { kind: "icon", icon: "folder" } },
      sources: roots.map((root, order) => ({ kind: "directory" as const, path: root, order })),
      primaryWorkspaceRoot: input.primaryWorkspaceRoot ?? roots[0] ?? null,
      pinned: false,
      pinnedOrder: null,
      created: new Date("2026-07-09T00:00:00.000Z"),
      updated: new Date("2026-07-09T00:00:00.000Z"),
    };
  }

  describe("workbench automation project options", () => {
    test("uses local project roots as selectable cwd values", () => {
      const options = buildWorkbenchAutomationProjectOptions({
        selectedProjectId: "nodex",
        projects: [
          makeProject({ id: "nodex", name: "Nodex", roots: ["/Users/asc/repo/nodex"] }),
          makeProject({ id: "scratch", name: "Scratch", roots: [] }),
        ],
        selectedRoots: [],
      });

      expect(options.length).toBe(1);
      expect(options[0]?.value).toBe("/Users/asc/repo/nodex");
      expect(options[0]?.label).toBe("Nodex");
      expect(options[0]?.description).toBe("/Users/asc/repo/nodex");
    });

    test("keeps unmatched selected roots visible for existing Automations", () => {
      const options = buildWorkbenchAutomationProjectOptions({
        selectedProjectId: "nodex",
        projects: [makeProject({ id: "nodex", name: "Nodex", roots: ["/Users/asc/repo/nodex"] })],
        selectedRoots: ["/tmp/legacy"],
      });

      expect(options.length).toBe(2);
      expect(options[1]?.value).toBe("/tmp/legacy");
      expect(options[1]?.label).toBe("/tmp/legacy");
      expect(options[1]?.isFallback).toBe(true);
    });

    test("formats trigger labels for empty, single, and multi-root selections", () => {
      const options = buildWorkbenchAutomationProjectOptions({
        selectedProjectId: "nodex",
        projects: [makeProject({ id: "nodex", name: "Nodex", roots: ["/Users/asc/repo/nodex"] })],
        selectedRoots: [],
      });

      expect(
        formatWorkbenchAutomationProjectTriggerLabel({
          selectedProjectId: "nodex",
          selectedRoots: [],
          options,
        }),
      ).toBe("Select project");
      expect(
        formatWorkbenchAutomationProjectTriggerLabel({
          selectedProjectId: "nodex",
          selectedRoots: ["/Users/asc/repo/nodex"],
          options,
        }),
      ).toBe("Nodex");
      expect(
        formatWorkbenchAutomationProjectTriggerLabel({
          selectedProjectId: "nodex",
          selectedRoots: ["/Users/asc/repo/nodex", "/tmp/legacy"],
          options,
        }),
      ).toBe("Nodex · 2 folders");
    });

    test("toggles selected roots without duplicating cwd values", () => {
      const selected = toggleWorkbenchAutomationProjectRoot({
        selectedRoots: ["/Users/asc/repo/nodex"],
        root: "/Users/asc/repo/devtools-codex",
      });
      expect(JSON.stringify(selected)).toBe(
        JSON.stringify(["/Users/asc/repo/nodex", "/Users/asc/repo/devtools-codex"]),
      );

      const nextSelected = toggleWorkbenchAutomationProjectRoot({
        selectedRoots: selected,
        root: "/Users/asc/repo/nodex",
      });
      expect(JSON.stringify(nextSelected)).toBe(JSON.stringify(["/Users/asc/repo/devtools-codex"]));
    });

    test("resolves a selected cwd back to its owning project", () => {
      const projects = [
        makeProject({ id: "alpha", name: "Alpha", roots: ["/repo/alpha"] }),
        makeProject({
          id: "beta",
          name: "Beta",
          roots: ["/repo/beta", "/repo/beta-extra"],
          primaryWorkspaceRoot: "/repo/beta",
        }),
      ];

      expect(
        resolveWorkbenchAutomationProjectForRoot({
          projectId: "beta",
          projects,
          root: "/repo/beta-extra",
        })?.id,
      ).toBe("beta");
      expect(
        resolveWorkbenchAutomationProjectForRoot({
          projectId: "beta",
          projects,
          root: "/repo/missing",
        }),
      ).toBe(null);
    });
  });

  test("keeps Projects sharing a directory distinct and clears folders when switching Project", () => {
    const projects = [
      makeProject({ id: "a", roots: ["/shared"] }),
      makeProject({ id: "b", roots: ["/shared"] }),
    ];
    const options = buildWorkbenchAutomationProjectOptions({
      projects,
      selectedProjectId: "b",
      selectedRoots: ["/shared"],
    });
    expect(options.map((option) => option.projectId)).toEqual(["a", "b"]);
    expect(
      resolveWorkbenchAutomationProjectForRoot({ projects, projectId: "b", root: "/shared" })?.id,
    ).toBe("b");
    expect(
      selectWorkbenchAutomationProjectRoot({
        projectId: "b",
        selectedProjectId: "a",
        selectedRoots: ["/only-a", "/shared"],
        root: "/shared",
      }),
    ).toEqual({ projectId: "b", cwds: ["/shared"] });
    expect(
      formatWorkbenchAutomationProjectTriggerLabel({
        selectedProjectId: null,
        selectedRoots: [],
        options,
      }),
    ).toBe("No project");
  });
});

describe("workbench automation schedule", () => {
  test("resolves daily wall-clock schedules with display labels", () => {
    const config = resolveWorkbenchAutomationScheduleConfig({
      rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
      intervalStyle: "default",
    });

    expect(config.mode).toBe("daily");
    expect(config.time).toBe("09:00");
    expect(formatWorkbenchAutomationScheduleLabel(config)).toBe("Daily at 9:00 AM");
  });

  test("updates weekly schedules and preserves Nodex RRULE payload format", () => {
    const config = resolveWorkbenchAutomationScheduleConfig({
      rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
      intervalStyle: "default",
    });
    const weekly = updateWorkbenchAutomationScheduleConfig({
      config,
      intervalStyle: "default",
      patch: {
        mode: "weekly",
        time: "10:30",
      },
    });

    expect(weekly.mode).toBe("weekly");
    expect(weekly.time).toBe("10:30");
    expect(
      buildWorkbenchAutomationScheduleRrule({
        config: weekly,
        intervalStyle: "default",
      }),
    ).toBe("FREQ=WEEKLY;BYDAY=SU;BYHOUR=10;BYMINUTE=30");
    expect(formatWorkbenchAutomationScheduleLabel(weekly)).toBe("Sundays at 10:30 AM");
  });

  test("names schedules it cannot express as custom", () => {
    const config = resolveWorkbenchAutomationScheduleConfig({
      rrule: "FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=9;BYMINUTE=0",
      intervalStyle: "default",
    });
    expect(formatWorkbenchAutomationScheduleLabel(config)).toBe("Custom schedule");
  });

  test("uses minutely RRULEs for heartbeat intervals", () => {
    const config = resolveWorkbenchAutomationScheduleConfig({
      rrule: "FREQ=MINUTELY;INTERVAL=15",
      intervalStyle: "heartbeat",
    });

    expect(config.mode).toBe("hourly");
    expect(config.intervalMinutes).toBe(15);
    expect(formatWorkbenchAutomationScheduleLabel(config)).toBe("Every 15 minutes");
  });

  test("keeps unknown schedules editable as custom rules", () => {
    const config = resolveWorkbenchAutomationScheduleConfig({
      rrule: "FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=9;BYMINUTE=0",
      intervalStyle: "default",
    });

    expect(config.mode).toBe("custom");
    expect(config.customRrule).toBe("FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=9;BYMINUTE=0");
    expect(
      buildWorkbenchAutomationScheduleRrule({
        config,
        intervalStyle: "default",
      }),
    ).toBe("FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=9;BYMINUTE=0");
  });
});

describe("workbench automation templates", () => {
  test("creates a manual draft from a selected template", () => {
    const template = WORKBENCH_AUTOMATION_TEMPLATES[0];
    if (!template) throw new Error("Expected a template");

    const draft = createWorkbenchAutomationDraftFromTemplate(template);

    expect(draft.kind).toBe("cron");
    expect(draft.executionEnvironment).toBe("local");
    expect(draft.projectId).toBeNull();
    expect(draft.name).toBe("Daily bug scan");
    expect(draft.prompt.includes("Scan recent commits")).toBe(true);
    expect(draft.trigger).toMatchObject({ kind: "clock", rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0" });
    expect(draft.cwds.length).toBe(0);
  });

  test("work that changes the repository asks in the Inbox first; reports run on their own", () => {
    const launchOf = (id: string) => {
      const template = WORKBENCH_AUTOMATION_TEMPLATES.find((candidate) => candidate.id === id);
      if (!template) throw new Error(`Expected template ${id}`);
      return createWorkbenchAutomationDraftFromTemplate(template).mode;
    };
    expect(launchOf("bump-dependency-versions")).toBe("ask_first");
    expect(launchOf("security-check")).toBe("run");
    expect(launchOf("daily-bug-scan")).toBe("run");
  });
});
