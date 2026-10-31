import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import {
  createMaitaiStore,
  createScopeHandle,
  disposeMaitaiStore,
  getMaitaiRootView,
  type MaitaiStore,
  type ScopeHandle,
} from "./maitai/maitai-store";
import {
  getPageCreateTarget,
  registerPageCreateTarget,
  unregisterPageCreateTarget,
  type PageCreateTarget,
} from "./page-create-target-registry";

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

describe("Page create target registration", () => {
  let store: MaitaiStore;
  let appHandle: ScopeHandle;

  beforeEach(() => {
    store = createMaitaiStore();
    appHandle = createScopeHandle(getMaitaiRootView(store));
  });

  afterEach(() => disposeMaitaiStore(store));

  test("keeps mounted View targets separate and removes only the unmounted View", () => {
    const left = target("left", "project:alpha");
    const right = target("right", "project:alpha");
    registerPageCreateTarget(appHandle, "left-token", left);
    registerPageCreateTarget(appHandle, "right-token", right);

    expect(getPageCreateTarget(appHandle, left.surfaceId)).toBe(left);
    expect(getPageCreateTarget(appHandle, right.surfaceId)).toBe(right);

    unregisterPageCreateTarget(appHandle, left.surfaceId, "left-token");

    expect(getPageCreateTarget(appHandle, left.surfaceId)).toBeNull();
    expect(getPageCreateTarget(appHandle, right.surfaceId)).toBe(right);
  });

  test("returns the latest target and ignores cleanup from an earlier mount", () => {
    const original = target("view", "project:alpha");
    const updated = { ...original, clientSessionId: "replacement-session" };
    registerPageCreateTarget(appHandle, "original-token", original);
    registerPageCreateTarget(appHandle, "replacement-token", updated);

    unregisterPageCreateTarget(appHandle, original.surfaceId, "original-token");
    expect(getPageCreateTarget(appHandle, original.surfaceId)).toBe(updated);

    unregisterPageCreateTarget(appHandle, original.surfaceId, "replacement-token");
    expect(getPageCreateTarget(appHandle, original.surfaceId)).toBeNull();
  });
});
