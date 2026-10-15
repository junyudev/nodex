import { describe, expect, test } from "vite-plus/test";
import type {
  PageCreateTarget,
  PageCreateTargetCapability,
  PageCreateTargetRegistryState,
} from "./page-create-target-registry";
import { resolvePageCreateTarget } from "./page-create-target-registry";

const target = (surfaceId: string, projectId: string): PageCreateTarget => ({
  surfaceId,
  panelTabId: `tab:${surfaceId}`,
  project: {
    id: projectId,
    name: projectId,
    appearance: { color: "blue", marker: { kind: "icon", icon: "terminal" } },
  },
  databaseViewId: `view:${surfaceId}`,
  clientSessionId: "session-test",
  routingContext: { kind: "project", projectId },
  properties: [],
  columns: [
    { id: "triage", name: "Triage" },
    { id: "plan", name: "Plan" },
  ],
});

const ready = (value: PageCreateTarget): PageCreateTargetCapability => ({
  status: "ready",
  target: value,
});

const state = (
  boardTargets: readonly PageCreateTarget[],
  activeSurfaceId: string | null,
  projectDefaults: Readonly<Record<string, PageCreateTargetCapability>> = {},
): PageCreateTargetRegistryState => ({
  activeSurfaceId,
  nextActivitySequence: boardTargets.length + 1,
  boardRegistrations: Object.fromEntries(
    boardTargets.map((item, index) => [
      item.surfaceId,
      {
        token: `token:${item.surfaceId}`,
        target: item,
        activeColumnId: item.surfaceId === activeSurfaceId ? "plan" : null,
        activitySequence: item.surfaceId === activeSurfaceId ? index + 1 : 0,
      },
    ]),
  ),
  projectDefaultRegistrations: Object.fromEntries(
    Object.entries(projectDefaults).map(([projectId, capability]) => [
      projectId,
      {
        token: `token:${projectId}`,
        projectId,
        capability,
      },
    ]),
  ),
});

describe("Page create target resolution", () => {
  test("prefers the exact active Board and its active column", () => {
    const resolution = resolvePageCreateTarget(
      state([target("left", "project:alpha"), target("right", "project:beta")], "right"),
      "project:alpha",
    );

    expect(resolution).toMatchObject({
      status: "resolved",
      target: { surfaceId: "right" },
      columnId: "plan",
    });
  });

  test("does not silently fall back when the exact active Board has no workflow columns", () => {
    const resolution = resolvePageCreateTarget(
      state([{ ...target("empty", "project:alpha"), columns: [] }], "empty", {
        "project:alpha": ready(target("ambient", "project:alpha")),
      }),
      "project:alpha",
    );

    expect(resolution).toEqual({
      status: "unavailable",
      reason: "This Database View has no workflow columns.",
    });
  });

  test("uses recent Board intent only within the active Project", () => {
    const previous = state(
      [target("alpha", "project:alpha"), target("beta", "project:beta")],
      null,
      {
        "project:alpha": ready(target("ambient", "project:alpha")),
      },
    );
    const resolution = resolvePageCreateTarget(
      {
        ...previous,
        boardRegistrations: {
          ...previous.boardRegistrations,
          alpha: { ...previous.boardRegistrations.alpha!, activitySequence: 4 },
          beta: { ...previous.boardRegistrations.beta!, activitySequence: 9 },
        },
        nextActivitySequence: 10,
      },
      "project:alpha",
    );

    expect(resolution).toMatchObject({
      status: "resolved",
      target: { surfaceId: "alpha" },
      columnId: "triage",
    });
  });

  test("falls back to the active Project default target without Board focus", () => {
    const resolution = resolvePageCreateTarget(
      state([target("beta", "project:beta")], null, {
        "project:alpha": ready(target("ambient", "project:alpha")),
      }),
      "project:alpha",
    );

    expect(resolution).toMatchObject({
      status: "resolved",
      target: { surfaceId: "ambient" },
      columnId: "triage",
    });
  });

  test("surfaces ambient loading and unavailable reasons", () => {
    expect(
      resolvePageCreateTarget(
        state([], null, {
          "project:alpha": {
            status: "loading",
            reason: "Preparing this Project’s default Database View…",
          },
        }),
        "project:alpha",
      ),
    ).toEqual({
      status: "unavailable",
      reason: "Preparing this Project’s default Database View…",
    });

    expect(
      resolvePageCreateTarget(
        state([], null, {
          "project:alpha": {
            status: "unavailable",
            reason: "This Project has no active default Database View.",
          },
        }),
        "project:alpha",
      ),
    ).toEqual({
      status: "unavailable",
      reason: "This Project has no active default Database View.",
    });
  });

  test("never guesses a target without an active Project or exact Board", () => {
    expect(resolvePageCreateTarget(state([target("alpha", "project:alpha")], null), null)).toEqual({
      status: "unavailable",
      reason: "Select a Project before creating a Page.",
    });
  });
});
