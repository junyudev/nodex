import { describe, expect, test } from "vitest";
import { sameWorkbenchLocation, type WorkbenchLocation } from "../../shared/workbench-layout";
import {
  decideWorkbenchFocus,
  panelTabFocusTarget,
  resolveWorkbenchLanding,
  workbenchFocusMoved,
} from "./workbench-focus-landing";

const chat = {
  kind: "session",
  sessionId: "chat",
  projectContextId: "project",
} satisfies WorkbenchLocation;
const project = { kind: "project", projectId: "project" } satisfies WorkbenchLocation;

describe("Workbench focus landings", () => {
  test("a rebuilt location is still the place a landing was requested for", () => {
    // Re-selecting or hydrating a chat rebuilds its location; that must not drop its landing.
    const rebuilt = {
      projectContextId: "project",
      sessionId: "chat",
      kind: "session",
    } satisfies WorkbenchLocation;
    expect(sameWorkbenchLocation(chat, rebuilt)).toBe(true);
    expect(sameWorkbenchLocation(chat, { ...chat, sessionId: "other" })).toBe(false);
    expect(sameWorkbenchLocation(chat, project)).toBe(false);
  });

  test("addresses the active chat or Inbox Home on an explicit composer landing", () => {
    expect(resolveWorkbenchLanding("composer", chat, false)).toEqual({
      kind: "session",
      sessionId: "chat",
    });
    expect(resolveWorkbenchLanding("composer", project, true)).toEqual({
      kind: "inbox",
      scopeKey: "project:project",
    });
    expect(resolveWorkbenchLanding("composer", { kind: "inbox" }, true)).toEqual({
      kind: "inbox",
      scopeKey: "all",
    });
    expect(resolveWorkbenchLanding("composer", project, false)).toBeNull();
    expect(resolveWorkbenchLanding("composer", { kind: "library" }, false)).toBeNull();
  });

  test("restores the recorded destination and leaves an entry with no descriptor alone", () => {
    const tab = panelTabFocusTarget("project:project", "right", "leaf", "page");
    expect(resolveWorkbenchLanding("restore", project, true, tab)).toEqual(tab);
    expect(resolveWorkbenchLanding("restore", chat, true)).toBeNull();
    expect(
      resolveWorkbenchLanding("restore", project, true, { kind: "session", sessionId: "chat" }),
    ).toBeNull();
    expect(
      resolveWorkbenchLanding("restore", project, true, {
        kind: "inbox",
        scopeKey: "project:other",
      }),
    ).toBeNull();
    expect(resolveWorkbenchLanding("none", chat, true, tab)).toBeNull();
  });

  test("accepts one overlay return to its trigger and yields to independent focus moves", () => {
    const released = { focusChanges: 1, interacted: false, returnedFromOverlay: true };
    expect(workbenchFocusMoved(released)).toBe(false);
    expect(workbenchFocusMoved({ ...released, focusChanges: 2 })).toBe(true);
    expect(workbenchFocusMoved({ ...released, interacted: true })).toBe(true);
    expect(workbenchFocusMoved({ ...released, focusChanges: 0, interacted: true })).toBe(true);
    expect(workbenchFocusMoved({ ...released, returnedFromOverlay: false })).toBe(true);
  });

  test("waits for readiness and closing overlays, and yields to intervening focus", () => {
    const ready = { moved: false, insideDestination: false, overlayOpen: false, ready: true };
    expect(decideWorkbenchFocus(ready)).toBe("land");
    expect(decideWorkbenchFocus({ ...ready, ready: false })).toBe("wait");
    expect(decideWorkbenchFocus({ ...ready, overlayOpen: true })).toBe("wait");
    expect(decideWorkbenchFocus({ ...ready, moved: true, overlayOpen: true })).toBe("cancel");
    expect(decideWorkbenchFocus({ ...ready, insideDestination: true })).toBe("cancel");
  });
});
