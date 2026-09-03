import { describe, expect, test } from "vite-plus/test";
import {
  createDefaultWorkbenchLayoutSnapshot,
  getWorkbenchActiveSessionId,
  type WorkbenchLayoutSnapshot,
} from "./workbench-layout";

function layoutWithLocation(
  location: WorkbenchLayoutSnapshot["location"],
): WorkbenchLayoutSnapshot {
  return { ...createDefaultWorkbenchLayoutSnapshot(), location };
}

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
