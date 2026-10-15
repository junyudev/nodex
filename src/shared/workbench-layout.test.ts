import { describe, expect, test } from "vite-plus/test";
import {
  createDefaultWorkbenchLayoutSnapshot,
  createDefaultWorkbenchLayoutSnapshotV3,
  getWorkbenchActiveSessionId,
  getWorkbenchPrimaryDestination,
  type WorkbenchLocation,
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

  test.each(["settings", "automations"] as const)(
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
  test.each<readonly [WorkbenchLocation, "home" | "space"]>([
    [{ kind: "pages" }, "space"],
    [{ kind: "empty" }, "home"],
    [{ kind: "project", projectId: "alpha" }, "home"],
    [{ kind: "session", sessionId: "session-a", projectContextId: null }, "home"],
    [{ kind: "inbox", returnTo: { kind: "pages" } }, "home"],
    [{ kind: "automations", path: "/automations/new", returnTo: { kind: "pages" } }, "home"],
    [
      { kind: "pending-worktree", clientThreadId: "pending-a", returnTo: { kind: "pages" } },
      "home",
    ],
    [{ kind: "settings", path: "/settings/general", returnTo: { kind: "pages" } }, "space"],
    [{ kind: "settings", path: "/settings/general", returnTo: { kind: "empty" } }, "home"],
    [
      {
        kind: "settings",
        path: "/settings/inbox",
        returnTo: { kind: "inbox", returnTo: { kind: "pages" } },
      },
      "home",
    ],
    [
      {
        kind: "settings",
        path: "/settings/general",
        returnTo: { kind: "automations", path: "/automations/edit/a", returnTo: { kind: "pages" } },
      },
      "home",
    ],
  ])("derives %s from the current route", (location, destination) => {
    expect(getWorkbenchPrimaryDestination(location)).toBe(destination);
  });
});
