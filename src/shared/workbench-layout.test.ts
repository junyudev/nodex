import { describe, expect, test } from "vite-plus/test";
import {
  createDefaultWorkbenchLayoutSnapshot,
  createDefaultWorkbenchLayoutSnapshotV3,
  getWorkbenchActiveSessionId,
  getWorkbenchPrimaryDestination,
  type WorkbenchLocation,
  type WorkbenchPrimaryDestination,
  type WorkbenchLayoutSnapshot,
} from "./workbench-layout";

function layoutWithLocation(
  location: WorkbenchLayoutSnapshot["location"],
): WorkbenchLayoutSnapshot {
  return { ...createDefaultWorkbenchLayoutSnapshot(), location };
}

test("default layout sidebar geometry matches a fresh contextual sidebar", () => {
  expect(createDefaultWorkbenchLayoutSnapshotV3().sidebar.width).toBe(288);
});

describe("getWorkbenchActiveSessionId", () => {
  test("derives the selected Session without consulting the renderer URL", () => {
    expect(
      getWorkbenchActiveSessionId(
        layoutWithLocation({
          kind: "session",
          projectContextId: "project-1",
          sessionId: "session-1",
        }),
      ),
    ).toBe("session-1");
    expect(getWorkbenchActiveSessionId(layoutWithLocation({ kind: "empty" }))).toBeNull();
  });

  test.each(["settings", "automations", "plugins"] as const)(
    "uses the canonical return location while %s is presented",
    (kind) => {
      expect(
        getWorkbenchActiveSessionId(
          layoutWithLocation({
            kind,
            path: "/appearance",
            returnTo: {
              kind: "session",
              projectContextId: null,
              sessionId: `session-behind-${kind}`,
            },
          }),
        ),
      ).toBe(`session-behind-${kind}`);
    },
  );
});

describe("getWorkbenchPrimaryDestination", () => {
  test.each<readonly [WorkbenchLocation, WorkbenchPrimaryDestination]>([
    [{ kind: "library" }, "space"],
    [{ kind: "empty" }, "home"],
    [{ kind: "project", projectId: "alpha" }, "home"],
    [{ kind: "session", sessionId: "session-a", projectContextId: null }, "home"],
    [{ kind: "inbox" }, "home"],
    [{ kind: "automations", path: "/automations/new", returnTo: { kind: "library" } }, "scheduled"],
    [{ kind: "plugins", path: "/plugins", returnTo: { kind: "library" } }, "plugins"],
    [
      {
        kind: "settings",
        path: "/settings/general",
        returnTo: { kind: "plugins", path: "/skills", returnTo: { kind: "empty" } },
      },
      "plugins",
    ],
    [
      { kind: "pending-worktree", clientThreadId: "pending-a", returnTo: { kind: "library" } },
      "home",
    ],
    [{ kind: "settings", path: "/settings/general", returnTo: { kind: "library" } }, "space"],
    [{ kind: "settings", path: "/settings/general", returnTo: { kind: "empty" } }, "home"],
    [
      {
        kind: "settings",
        path: "/settings/inbox",
        returnTo: { kind: "inbox" },
      },
      "home",
    ],
    [
      {
        kind: "settings",
        path: "/settings/general",
        returnTo: {
          kind: "automations",
          path: "/automations/edit/a",
          returnTo: { kind: "library" },
        },
      },
      "scheduled",
    ],
  ])("derives %s from the current route", (location, destination) => {
    expect(getWorkbenchPrimaryDestination(location)).toBe(destination);
  });
});
