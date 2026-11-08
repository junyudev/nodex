import { describe, expect, it } from "vitest";
import type { WorkbenchLocation } from "../../shared/workbench-layout";
import {
  formatWorkbenchWindowTitle,
  resolveWorkbenchWindowTitleParts,
  type WorkbenchWindowTitleInput,
} from "./workbench-window-title";

const sessionLocation: WorkbenchLocation = {
  kind: "session",
  sessionId: "session-1",
  projectContextId: "project-1",
};

const titleFor = (
  input: Partial<WorkbenchWindowTitleInput> & Pick<WorkbenchWindowTitleInput, "location">,
  os: "darwin" | "win32" | "linux" = "darwin",
): string =>
  formatWorkbenchWindowTitle(
    resolveWorkbenchWindowTitleParts({ chat: null, project: null, spaceTrail: [], ...input }),
    os,
  );

describe("workbench window title", () => {
  it("names a chat before the Project it belongs to", () => {
    expect(
      titleFor({
        location: sessionLocation,
        chat: { sessionId: "session-1", title: "Fix flaky E2E", projectName: "nodex" },
      }),
    ).toBe("Fix flaky E2E — nodex");
    expect(
      titleFor({
        location: sessionLocation,
        chat: { sessionId: "session-1", title: "Plan the offsite", projectName: null },
      }),
    ).toBe("Plan the offsite");
  });

  it("never names a chat or Project the window has moved away from", () => {
    expect(
      titleFor({
        location: sessionLocation,
        chat: { sessionId: "session-0", title: "Previous chat", projectName: "nodex" },
      }),
    ).toBe("Nodex");
    expect(
      titleFor({
        location: { kind: "project", projectId: "project-2" },
        project: { id: "project-1", name: "nodex" },
      }),
    ).toBe("Nodex");
    expect(
      titleFor({
        location: { kind: "project", projectId: "project-1" },
        project: { id: "project-1", name: "nodex" },
      }),
    ).toBe("nodex");
  });

  it("names Space by its active surface, most specific first", () => {
    expect(titleFor({ location: { kind: "library" }, spaceTrail: ["Ship v1", "Tasks"] })).toBe(
      "Ship v1 — Tasks",
    );
    expect(titleFor({ location: { kind: "library" }, spaceTrail: ["Q4 roadmap"] })).toBe(
      "Q4 roadmap",
    );
    expect(titleFor({ location: { kind: "library" } })).toBe("Space");
  });

  it("names every other destination", () => {
    const returnTo = { kind: "empty" } as const;
    const cases: ReadonlyArray<readonly [WorkbenchLocation, string]> = [
      [{ kind: "empty" }, "New chat"],
      [{ kind: "pending-worktree", clientThreadId: "client-1", returnTo }, "New chat"],
      [{ kind: "inbox" }, "Inbox"],
      [{ kind: "automations", path: "/", returnTo }, "Scheduled"],
      [{ kind: "plugins", path: "/", returnTo }, "Plugins"],
      [{ kind: "insights", path: "/", returnTo }, "Insights"],
      [{ kind: "settings", path: "/general", returnTo }, "Settings"],
    ];
    for (const [location, title] of cases) expect(titleFor({ location })).toBe(title);
  });

  it("ends the title with Nodex outside macOS", () => {
    const chat = { sessionId: "session-1", title: "Fix flaky E2E", projectName: "nodex" };
    expect(titleFor({ location: sessionLocation, chat }, "win32")).toBe(
      "Fix flaky E2E — nodex — Nodex",
    );
    expect(titleFor({ location: { kind: "inbox" } }, "linux")).toBe("Inbox — Nodex");
    expect(titleFor({ location: sessionLocation }, "win32")).toBe("Nodex");
  });

  it("presents each part on one line and drops empty parts", () => {
    expect(
      formatWorkbenchWindowTitle(["  Draft\n  release\tnotes ", "   ", "nodex"], "darwin"),
    ).toBe("Draft release notes — nodex");
    expect(formatWorkbenchWindowTitle([], "darwin")).toBe("Nodex");
  });
});
